// Assertions for plugin-command arguments (rules.splitPluginArg / pluginArgValueTranslatable, and the
// extract + patch paths that use them).
//
// A plugin command stores each argument as `key = value`. The key is the plugin's own parameter name and
// almost always Japanese; the value is the author's data — text, a number, a boolean, or a file name.
// Only the value may be translated, and only when it really is text. Every pair below is a real one taken
// from the four games measured, so a rule that is too loose (it renames a file) or too tight (it leaves
// player-facing text alone) fails here.
//
// Run:  node tools/unit-plugin-args.js
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const R = require("../pipeline/extract/rules.js");
const mv = require("../pipeline/extract/mv.js");
const patch = require("../pipeline/patch/mv.js");

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  ok    " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "   " + detail : "")); }
};
const under = (root, ...parts) => {
  const base = path.resolve(root);
  const t = path.join(base, ...parts);
  if (t !== base && !t.startsWith(base + path.sep)) throw new Error("outside " + base);
  return t;
};

console.log("=== 拆分 `键 = 值`，保留作者的空格与全角等号 ===");
const S1 = R.splitPluginArg("\u5bfe\u8c61\u30ad\u30e3\u30e9\u540d = \u7435\u7436\u4e43");       // 対象キャラ名 = 琵琶乃
check("普通形式", S1 && S1.key === "\u5bfe\u8c61\u30ad\u30e3\u30e9\u540d" && S1.value === "\u7435\u7436\u4e43",
  JSON.stringify(S1));
check("prefix 原样保留（键 + 等号 + 空格）", S1 && S1.prefix === "\u5bfe\u8c61\u30ad\u30e3\u30e9\u540d = ", JSON.stringify(S1 && S1.prefix));
check("无空格形式", (() => { const s = R.splitPluginArg("key=value"); return s && s.key === "key" && s.value === "value"; })());
check("全角等号", (() => { const s = R.splitPluginArg("\u30ad\u30fc\uff1d\u5024\u3042\u308a"); return s && s.value === "\u5024\u3042\u308a"; })());
check("尾随空格进入 suffix", (() => { const s = R.splitPluginArg("k = v  "); return s && s.value === "v" && s.suffix === "  "; })());
check("值里再有等号：只切第一个", (() => { const s = R.splitPluginArg("k = a = b"); return s && s.value === "a = b"; })());
check("没有等号（编辑器标签）返回 null", R.splitPluginArg("\u6587\u7ae0\u306e\u8868\u793a") === null);
check("插件名返回 null", R.splitPluginArg("AdvExtention") === null);

console.log("");
console.log("=== 该翻的值（实测：真的是玩家可见文本）===");
const KEEP = [
  ["\u30ad\u30e3\u30e9\u540d", "\u30d2\u30ed\u30ab"],                                  // キャラ名 = ヒロカ
  ["\u30d7\u30ea\u30bb\u30c3\u30c8\u306e\u767b\u9332\u540d", "\u6012\u308a(\u767a\u60c5)"],  // プリセットの登録名 = 怒り(発情)
  ["text", "\u30ec\u30f3\u306e\u8abf\u6559"],                                          // text = レンの調教
  ["\u5bfe\u8c61\u30ad\u30e3\u30e9\u540d", "\u30da\u30fc\u30bf\u30fc\u3055\u3093"],       // 琵琶乃 style
];
for (const [k, v] of KEEP) check("翻：" + k + " = " + v, R.pluginArgValueTranslatable(k, v));

console.log("");
console.log("=== 必须拒绝的值（实测：翻了就坏 / 没意义）===");
const REFUSE = [
  ["\u30d5\u30a1\u30a4\u30eb\u540d", "\u30aa\u30fc\u30d7\u30cb\u30f3\u30b0_3\u884c\u3067_01", "文件名（含假名，只能靠键拦下）"],
  ["\u30ea\u30bd\u30fc\u30b9\u30e9\u30d9\u30eb", "Hiroka_Prologue_000", "资源标签"],
  ["\u53d6\u308a\u8fbc\u307f\u5143\u30d5\u30a1\u30a4\u30eb\u540d", "message.txt", "正文文件名"],
  ["\u7d50\u679c\u53d7\u3051\u53d6\u308a\u5909\u6570", "15", "数字"],
  ["\u30ad\u30e3\u30f3\u30bb\u30eb\u8a31\u53ef", "false", "布尔"],
  ["\u521d\u671f\u30ab\u30fc\u30bd\u30eb\u4f4d\u7f6e", "1", "数字"],
  ["\u9078\u629e\u80a2\u30ea\u30b9\u30c8", "[{\"label\":\"Still sleepy\"}]", "JSON 结构"],
  ["\u5bfe\u8c61\u30ad\u30e3\u30e9\u540d", "\u7435\u7436\u4e43", "无假名的人名（中文里字形不变）"],
  ["\u5bfe\u8c61\u30ad\u30e3\u30e9", "0", "数字"],
  ["\u753b\u50cf", "\u30ad\u30e3\u30e9\u7acb\u3061\u7d75", "画像键（即使值有假名也不用翻）"],
];
for (const [k, v, why] of REFUSE) check("拒绝（" + why + "）：" + k + " = " + v, !R.pluginArgValueTranslatable(k, v));

console.log("");
console.log("=== 端到端：提取只取值、回填只换值 ===");
const VALUE = "\u30d2\u30ed\u30ab";                    // ヒロカ
const RESOURCE = "\u30aa\u30fc\u30d7\u30cb\u30f3\u30b0_3\u884c\u3067_01";
const TMP = path.resolve(path.join(os.tmpdir(), "unit-plugin-args-" + process.pid));
try {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(under(TMP, "data"), { recursive: true });
  const list = [
    { code: 657, parameters: ["\u5bfe\u8c61\u30ad\u30e3\u30e9\u540d = " + VALUE] },        // 対象キャラ名 = ヒロカ
    { code: 657, parameters: ["\u30d5\u30a1\u30a4\u30eb\u540d = " + RESOURCE] },            // ファイル名 = …
    { code: 657, parameters: ["\u7d50\u679c\u53d7\u3051\u53d6\u308a\u5909\u6570 = 15"] },   // 数字
    { code: 657, parameters: ["\u9078\u629e\u80a2\u30ea\u30b9\u30c8 = [{\"label\":\"x\"}]"] },
    { code: 357, parameters: ["AdvExtention", "message", "\u6587\u7ae0\u306e\u8868\u793a", { a: 1 }] },   // 编辑器标签
    { code: 401, parameters: ["\u300c\u3053\u3093\u306b\u3061\u306f\u300d"] },              // 普通对白，原路径
  ];
  fs.writeFileSync(under(TMP, "data", "CommonEvents.json"),
    JSON.stringify([{ id: 1, list }]), "utf8");

  const r = mv.extract(under(TMP, "data"), under(TMP, "data"));
  const texts = r.entries.map((e) => e.text);
  check("提取到插件参数的值", texts.includes(VALUE), JSON.stringify(texts));
  check("没有提取资源文件名", !texts.includes(RESOURCE));
  check("没有提取数字", !texts.includes("15"));
  check("没有提取 JSON 结构", !texts.some((t) => t.startsWith("[{")));
  check("没有提取编辑器标签", !texts.includes("\u6587\u7ae0\u306e\u8868\u793a"));
  check("对白仍按原路径提取", texts.includes("\u300c\u3053\u3093\u306b\u3061\u306f\u300d"), JSON.stringify(texts));
  check("合计 2 条（值 + 对白）", r.entries.length === 2, "entries=" + r.entries.length + " " + JSON.stringify(texts));

  // A cache that claims to know BOTH the value and the resource name.
  const map = new Map([[VALUE, "\u5f18\u9999"], [RESOURCE, "\u5e8f\u7ae0"], ["15", "\u5341\u4e94"]]);
  const rep = patch.patch(under(TMP, "data"), { lookup: (t) => map.get(t) }, null);
  const live = JSON.parse(fs.readFileSync(under(TMP, "data", "CommonEvents.json"), "utf8"));
  const p = live[0].list;
  check("只换掉值，键与原空格保留", p[0].parameters[0] === "\u5bfe\u8c61\u30ad\u30e3\u30e9\u540d = \u5f18\u9999",
    JSON.stringify(p[0].parameters[0]));
  check("资源文件名即使缓存里有译文也不动", p[1].parameters[0] === "\u30d5\u30a1\u30a4\u30eb\u540d = " + RESOURCE,
    JSON.stringify(p[1].parameters[0]));
  check("数字不动", p[2].parameters[0] === "\u7d50\u679c\u53d7\u3051\u53d6\u308a\u5909\u6570 = 15", JSON.stringify(p[2].parameters[0]));
  check("JSON 结构不动", p[3].parameters[0] === "\u9078\u629e\u80a2\u30ea\u30b9\u30c8 = [{\"label\":\"x\"}]", JSON.stringify(p[3].parameters[0]));
  check("编辑器标签不动", p[4].parameters[2] === "\u6587\u7ae0\u306e\u8868\u793a", JSON.stringify(p[4].parameters[2]));
  check("只有 1 处被替换", rep.replaced === 1, "replaced=" + rep.replaced);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log("");
console.log("  pass " + pass + "   fail " + fail);
process.exit(fail ? 1 : 0);
