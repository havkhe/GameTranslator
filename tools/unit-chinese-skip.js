// Assertions for the "already Chinese" skip.
//
// The skip exists so Chinese text is not sent back through the model, which makes it refuse. It used to be
// driven by `isChineseLike` alone, and that rule calls any kana-free Han-dominant string Chinese — which
// is exactly what a Japanese game's skill, element, status and enemy names look like. Every one of them
// was skipped, so those menu entries stayed Japanese in an otherwise translated game.
//
// The real examples below are the ones that were skipped in a measured batch, taken from the failure
// records of four games.
//
// Run:  node tools/unit-chinese-skip.js
"use strict";
const T = require("../pipeline/translate/index.js");

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  ok    " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "   " + detail : "")); }
};

console.log("=== 实测被误判为「已中文」的日文术语，必须改送模型 ===");
// From the already-chinese records of NTR Police / NTR Sisters / deadbunny_1001 / 静かな北国.
const TERMS = [
  "\u65ac\u6483/\u5fc5\u6bba\u62803",     // 斬撃/必殺技3
  "\u523a\u7a81/\u5fc5\u6bba\u62801",     // 刺突/必殺技1
  "\u722a/\u5fc5\u6bba\u6280",           // 爪/必殺技
  "\u6c7a\u5165\u826f\u3044\u3060\u308d" , // placeholder, replaced below
];
TERMS[3] = "\u56de\u5fa9/\u5358\u4f531";  // 回復/単体1
const MORE = [
  "\u8607\u751f1",                        // 蘇生1
  "\u5f37\u53161",                        // 強化1
  "\u602a\u4eba\u738b",                   // 怪人王
  "\u795e\u7236",                         // 神父
  "\u8d85\u97f3\u6ce2",                   // 超音波
  "\u6b4c",                               // 歌
  "\u5486\u54ee",                         // 咆哮
  "\u7537",                               // 男
];
for (const t of [...TERMS, ...MORE]) {
  check("不再跳过：" + t, !T.mayBeChineseAlready(t), "len=" + t.length);
}

console.log("");
console.log("=== 真正的中文段落仍然跳过 ===");
const PROSE = [
  "\u4f60\u771f\u7684\u5f88\u53ef\u7231\uff0c\u6211\u5f88\u559c\u6b22\u4f60\u3002\u8bf7\u4f60\u4eca\u665a\u7559\u4e0b\u6765\u5427\u3002",          // 30 chars
  "\u8fd9\u662f\u4e00\u4e2a\u6d4b\u8bd5\u7528\u7684\u4e2d\u6587\u53e5\u5b50\uff0c\u957f\u5ea6\u8d85\u8fc7\u9608\u503c\u3002",              // 25 chars
];
for (const t of PROSE) check("仍然跳过：" + t.slice(0, 12) + "…", T.mayBeChineseAlready(t), "len=" + t.length);

console.log("");
console.log("=== 有假名的一律不跳过（含假名就是日文）===");
check("短但有假名", !T.mayBeChineseAlready("\u306f\u3044"),
  "isChineseLike=" + T.isChineseLike("\u306f\u3044"));
check("长句有假名", !T.mayBeChineseAlready("\u3053\u308c\u306f\u9577\u3044\u65e5\u672c\u8a9e\u306e\u6587\u3067\u3059\u3002\u3069\u3046\u305e\u3088\u308d\u3057\u304f\u304a\u9858\u3044\u3057\u307e\u3059\u3002"));

console.log("");
console.log("=== 阈值边界 ===");
const eleven = "\u4e2d\u6587\u4e2d\u6587\u4e2d\u6587\u4e2d\u6587\u4e2d\u6587\u4e2d";     // 11 chars, Chinese-like
check("11 字：仍送去翻译（短）", !T.mayBeChineseAlready(eleven), "len=" + eleven.length);
check("阈值常量为 12", T.CHINESE_PROSE_MIN === 12, "CHINESE_PROSE_MIN=" + T.CHINESE_PROSE_MIN);
check("isChineseLike 本身没变（仍是原来的宽判据）", T.isChineseLike("\u65ac\u6483/\u5fc5\u6bba\u62803"),
  "它必须仍返回 true —— 它是被新判据包起来的，不是被改掉的");

console.log("");
console.log("  pass " + pass + "   fail " + fail);
process.exit(fail ? 1 : 0);
