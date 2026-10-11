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
// The shipped template asks for numbered output now (that is what anchors the pairing), so the
// fragments that identify the instruction come from those lines.
check("fragments include 保持每行开头的行号", fragments.includes("保持每行开头的行号"));
check("fragments include 不要解释", fragments.includes("不要解释"));
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
console.log("=== a cache whose value carries the wrong control codes is dropped ===");
{
  // Real pairs from one game's cache, where a value was written onto the wrong source: the reply is a
  // correct translation of a DIFFERENT line, so its variable codes do not match this source's.
  const fs = require("fs");
  const os = require("os");
  const C = require("../pipeline/translate/cache.js");
  const tmp = fs.mkdtempSync(require("path").join(os.tmpdir(), "gt-codes-"));
  const file = require("path").join(tmp, "cache.json");
  const src = "\u300c\\n[2]\u3055\u3093\u3001\u6cb9\u65ad\u306f\u3060\u3081\u3067\u3059\u3088\u3002";   // 「\n[2]さん、油断はだめですよ。
  const good = "\u300c\\n[2]\u5148\u751f\uff0c\u4e0d\u80fd\u6389\u4ee5\u8f7b\u5fc3\u3002";             // 「\n[2]先生，不能掉以轻心。
  const wrong = "\u201c\\n[3]\u3055\u3093\uff0c\u4e0d\u8981\u6389\u4ee5\u8f7b\u5fc3\u54e6\u3002";      // “\n[3]さん，不要掉以轻心哦。
  const seeded = {
    version: 3,
    byText: {
      [src]: wrong,                                                        // codes differ -> drop
      "\u30ed\u30fc\u30c9": "\u8bfb\u53d6",                                 // no codes either side -> keep
      "\u300c\\n[1]\u3055\u3093\u300d": "\u300c\\n[1]\u5148\u751f\u300d",   // same code -> keep
    },
  };
  fs.writeFileSync(file, JSON.stringify(seeded), "utf8");
  const c = C.makeCache(file);
  check("one code-mismatched entry purged", c.purgedCodes === 1, "purgedCodes=" + c.purgedCodes);
  check("the mismatched key is gone", !c.has(src));
  check("a code-free pair survives", c.lookup("\u30ed\u30fc\u30c9") === "\u8bfb\u53d6");
  check("a matching-code pair survives", c.lookup("\u300c\\n[1]\u3055\u3093\u300d") === "\u300c\\n[1]\u5148\u751f\u300d");
  check("set() refuses a code mismatch", c.set("\u300c\\n[3]\u3061\u3083\u3093\u300d", "\u300c\\n[2]\u5c0f\u59d0\u300d") === false);
  check("set() accepts a matching code", c.set("\u300c\\n[3]\u3061\u3083\u3093\u300d", "\u300c\\n[3]\u5c0f\u59d0\u300d") === true);
  check("lookup falls back to the original for a dropped entry", c.lookup(src) === undefined);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("");
console.log("=== a stored value identical to its source is dropped ===");
{
  // A no-op "translation" changes nothing on disk yet counts as a replacement in the patch report and
  // hides the string from every later run. Measured on one batch of five games: 202 / 71 / 5 / 83 / 59
  // stored values were identical to their source, and one game's report read "replaced 8, files 0".
  // The real pairs below are from that batch (爪/物理 etc. are kana-free Japanese terms).
  const fs = require("fs");
  const os = require("os");
  const C = require("../pipeline/translate/cache.js");
  const tmp = fs.mkdtempSync(require("path").join(os.tmpdir(), "gt-identity-"));
  const file = require("path").join(tmp, "cache.json");
  const identical = "\u722a/\u7269\u7406";                 // 爪/物理
  const seeded = {
    version: 3,
    byText: {
      [identical]: identical,                                                    // drop
      "\u30ed\u30fc\u30c9": "\u8bfb\u53d6",                                       // keep
      "\u6b4c": "\u6b4c\u66f2",                                                   // keep (a real change)
    },
  };
  fs.writeFileSync(file, JSON.stringify(seeded), "utf8");
  const c = C.makeCache(file);
  check("one identity entry purged", c.purgedIdentity === 1, "purgedIdentity=" + c.purgedIdentity);
  check("the identity key is gone", !c.has(identical));
  check("a real translation survives", c.lookup("\u30ed\u30fc\u30c9") === "\u8bfb\u53d6");
  check("a one-character change is enough to keep", c.lookup("\u6b4c") === "\u6b4c\u66f2");
  check("set() refuses an identical value", c.set("\u8352\u5ec3", "\u8352\u5ec3") === false);
  check("set() accepts a changed value", c.set("\u8352\u5ec3", "\u5e9f\u589f") === true);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("");
console.log("  pass " + pass + "   fail " + fail);
process.exit(fail ? 1 : 0);
