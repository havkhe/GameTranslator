// Assertions for the prompt-echo gate.
//
// Every "polluted" pair below is a real entry taken from the moralist game's cache; every
// "legitimate" pair is a real translation from the same cache. A gate that misses the first set
// re-poisons the game, and one that rejects the second set throws away good work, so both halves
// are checked.
//
// Run:  node tools/unit-prompt-echo.js
"use strict";
const Q = require("../pipeline/translate/quality.js");
const T = require("../pipeline/translate/index.js");

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  ok    " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "   " + detail : "")); }
};

const fragments = Q.promptFragments(T.DEFAULT_TEMPLATE);
console.log("=== fragments derived from the shipped template (" + fragments.length + ") ===");
console.log("  " + fragments.join(" | "));

console.log("");
console.log("=== the fragments must identify the instruction ===");
check("fragments include 每行输出一条译文", fragments.includes("每行输出一条译文"));
check("fragments include 不要编号", fragments.includes("不要编号"));
check("fragments include 不要JSON", fragments.includes("不要JSON"), JSON.stringify(fragments.filter((f) => f.includes("JSON"))));
check("fragments include 必须原样保留", fragments.includes("必须原样保留"));
check("fragments include 行数必须与输入完全相同", fragments.includes("行数必须与输入完全相同"));
check("generic words are excluded", !fragments.includes("颜色") && !fragments.includes("图标等") && !fragments.includes("角色名"));

console.log("");
console.log("=== the five polluted cache entries must all be rejected ===");
const polluted = [
  ["チェストウッド", "每行输出一条译文，不要编号、不要JSON、"],
  ["ァ゜――……♪♥", "每行输出一条译文，不要编号、不要JSON、――……♪♥"],
  ["…………っ♥", "…………每行输出一条译文，不要编号、不要JSON、♥"],
  ["みぞほね", "每行输出一条译文，不要编号、不要JSON、"],
  ["ロード", "每行输出一条译文，不要编号、不要JSON、"],
  // the older template's wording, still present in historical backups
  ["ソード", "每行输出一条译文，不要编号、不要JSON、不要解释。"],
  ["こんにちは", "こんにちは\\N[1] 必须原样保留 \\N[1]。"],
];
for (const [src, dst] of polluted) {
  const q = Q.qualityCheck(src, dst, { promptFragments: fragments });
  check("rejected: " + JSON.stringify(src), q.fatal.some((f) => f.startsWith("prompt-echo")),
    "fatal=" + JSON.stringify(q.fatal));
}

console.log("");
console.log("=== real translations must still pass ===");
const legit = [
  ["239 チェストウッド市の地図家具イベント", "239 查斯特伍德市地图家具事件"],
  ["本日のチェストウッド市は晴れのち曇り。雨の心配はありません。", "今天的chestwood市晴转多云。不用担心下雨。"],
  ["ロード", "读取"],
  ["セーブ", "存档"],
  ["みぞほね", "沟骨"],
  ["さくら", "樱"],
  ["プラグインテストHELP", "插件测试HELP"],
  ["レベルアップ！", "升级！"],
];
for (const [src, dst] of legit) {
  const q = Q.qualityCheck(src, dst, { promptFragments: fragments });
  check("accepted: " + JSON.stringify(src) + " -> " + JSON.stringify(dst),
    !q.fatal.some((f) => f.startsWith("prompt-echo")), "fatal=" + JSON.stringify(q.fatal));
}

console.log("");
console.log("=== a game string that legitimately contains the wording is kept ===");
{
  const src = "不要编号";
  const dst = "不要编号";
  const q = Q.qualityCheck(src, dst, { promptFragments: fragments });
  check("source-side match is not treated as an echo",
    !q.fatal.some((f) => f.startsWith("prompt-echo")), "fatal=" + JSON.stringify(q.fatal));
}
{
  const src = "カードのロード画面";
  const dst = "卡片的读取画面";
  const q = Q.qualityCheck(src, dst, { promptFragments: fragments });
  check("a translation merely mentioning 读取 passes",
    !q.fatal.some((f) => f.startsWith("prompt-echo")), "fatal=" + JSON.stringify(q.fatal));
}

console.log("");
console.log("=== the exact historical echo in the game data is caught ===");
{
  const src = "チェストウッド";
  const dst = "每行输出一条译文，不要编号、不要JSON、不要解释。";
  const q = Q.qualityCheck(src, dst, { promptFragments: fragments });
  check("Tilesets.json[6].name value rejected", q.fatal.some((f) => f.startsWith("prompt-echo")));
}

console.log("");
console.log("=== a cache holding echoes purges them at load ===");
{
  const fs = require("fs");
  const os = require("os");
  const C = require("../pipeline/translate/cache.js");
  const tmp = fs.mkdtempSync(require("path").join(os.tmpdir(), "gt-echo-"));
  const file = require("path").join(tmp, "cache.json");
  const seeded = {
    version: 3,
    byText: {
      "\u30c1\u30a7\u30b9\u30c8\u30a6\u30c3\u30c9": "每行输出一条译文，不要编号、不要JSON、",
      "\u30ed\u30fc\u30c9": "读取",
      "\u30bb\u30fc\u30d6": "存档",
    },
  };
  fs.writeFileSync(file, JSON.stringify(seeded), "utf8");
  const c = C.makeCache(file);
  check("one echo entry purged", c.purgedEcho === 1, "purgedEcho=" + c.purgedEcho);
  check("the echo key is gone", !c.has("\u30c1\u30a7\u30b9\u30c8\u30a6\u30c3\u30c9"));
  check("good entries survive", c.has("\u30ed\u30fc\u30c9") && c.lookup("\u30ed\u30fc\u30c9") === "读取");
  check("set() refuses an echo", c.set("\u30bd\u30fc\u30c9", "不要解释") === false);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("");
console.log("  pass " + pass + "   fail " + fail);
process.exit(fail ? 1 : 0);
