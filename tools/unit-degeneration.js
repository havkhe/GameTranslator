// Assertions for the degeneration gate.
//
// Every "degenerate" value below is taken from the game that exposed the defect; every "ordinary"
// value is a real translation from the same game's cache or a plausible label. The gate has to
// reject the first set and keep the second, because rejecting a good translation costs an entry
// while accepting word salad puts nonsense in front of the player.
//
// Run:  node tools/unit-degeneration.js
"use strict";
const Q = require("../pipeline/translate/quality.js");

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  ok    " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "   " + detail : "")); }
};

console.log("=== values from the degeneration cycle are rejected (" + Q.DEGENERATE_BIGRAMS.length + " bigrams known) ===");
const bad = [
  "段法汉例",                 // the window that straddles the cycle join
  "构方容翻",                 // 最大ＭＰ
  "汉例语子",                 // 水母041
  "句构方容",                 // グル・フォビィ
  "义文明文",                 // 姦ぱにー (the value kept a trailing ー)
  "文明文落",
  "汉例语子语式示译句",
  "本解学篇义文明文",
  "内释词章表本解学篇义文明",
  "汇结达内释词章表本解学篇义文明文落语译说言段法汉例语子语式",
];
for (const v of bad) check("rejected: " + v.slice(0, 18), Q.degenerationMatches(v) !== null, JSON.stringify(Q.degenerationMatches(v)));

console.log("");
console.log("=== ordinary values are kept ===");
const good = [
  "攻击力", "防御力", "敏捷性", "命中率", "回避率",       // the same terms.params row
  "最大HP", "最大MP",
  "古鲁・弗比", "垃圾咪咪・咪咪咪咪", "户川英治 -eiji togawa-",
  "今天的切斯特伍德市晴转多云。不用担心下雨。",
  "中华文明", "明文规定", "文明", "义文", "语法", "例句",
  "上级市民D", "章鱼仙人", "石原", "里奥塔索",
  "读档", "存档", "切斯特伍德", "沟骨",
  "…………唔♥", "――……♪♥",
  "哎呀，真是的……", "加载中", "第3章 中央大街",
];
for (const v of good) check("kept: " + v.slice(0, 18), Q.degenerationMatches(v) === null, "matched " + JSON.stringify(Q.degenerationMatches(v)));

console.log("");
console.log("=== it must not fire on text with punctuation, function words or kana ===");
for (const v of ["文明，明文。", "这是什么文明", "文明の例", "ABC汉例语", "汉例 语子"]) {
  check("kept: " + JSON.stringify(v), Q.degenerationMatches(v) === null, "matched " + JSON.stringify(Q.degenerationMatches(v)));
}

console.log("");
console.log("=== qualityCheck reports it as fatal ===");
{
  const q = Q.qualityCheck("最大ＭＰ", "构方容翻", {});
  check("fatal contains degenerate", q.fatal.some((f) => f.startsWith("degenerate")), JSON.stringify(q.fatal));
  const ok = Q.qualityCheck("最大ＭＰ", "最大MP", {});
  check("a correct answer passes", ok.fatal.length === 0, JSON.stringify(ok.fatal));
}

console.log("");
console.log("  pass " + pass + "   fail " + fail);
process.exit(fail ? 1 : 0);
