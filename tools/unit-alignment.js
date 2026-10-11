// Line numbering and pairing: the anchor that keeps a batch reply aligned with its input.
//
//   node tools/unit-alignment.js
"use strict";
const B = require("../pipeline/translate/batcher.js");

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log("  pass  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "   " + detail : "")); }
};

const group = (texts) => texts.map((t, i) => ({ id: i, text: t }));
const TEMPLATE_OLD = "将下列每行日文翻译成简体中文。\n每行输出一条译文，不要编号、不要JSON、不要解释。\n{lines}";
const TEMPLATE_NEW = "将下列每行日文翻译成简体中文。\n保持每行开头的行号，逐行输出「行号. 译文」，不要JSON、不要解释。\n{lines}";

console.log("=== 输入加编号 ===");
{
  const g = group(["打撃/物理", "斬撃/炎", "「こんにちは」"]);
  const p = B.buildPrompt(g, TEMPLATE_OLD);
  ok(/^1\. 打撃\/物理$/m.test(p), "第一行编号为 1.");
  ok(/^2\. 斬撃\/炎$/m.test(p), "第二行编号为 2.");
  ok(/^3\. 「こんにちは」$/m.test(p), "第三行编号为 3.");
  ok(!/不要编号/.test(p), "模板里「不要编号」被改写成要求保留行号");
  ok(/保留行号|逐行输出并保留行号/.test(p), "提示词里出现了保留行号的要求");
  const q = B.buildPrompt(g, TEMPLATE_NEW);
  ok(/^2\. 斬撃\/炎$/m.test(q), "新模板同样编号");
  ok(!/不要编号/.test(q), "新模板没有冲突指令");
}

console.log("");
console.log("=== 回包是否带编号 ===");
{
  ok(B.hasNumbering("1. 打击/物理\n2. 斩击/炎"), "两行带编号 → true");
  ok(!B.hasNumbering("打击/物理\n斩击/炎"), "两行不带编号 → false");
  ok(!B.hasNumbering("12:10 [葛谷ダイスケ] 早く買ってこい"), "只有一行像编号 → false（单行不算）");
  ok(B.hasNumbering("3. 甲\n1. 乙\n2. 丙"), "编号乱序但存在 → true");
}

console.log("");
console.log("=== 按编号配对（数字在前？不管顺序，按号码落位）===");
{
  const reply = "1. 打击/物理\n2. 斩击/效果\n3. 斩击/炎";
  const lines = B.normalizeResult(B.parseResult(reply), 3);
  ok(!!lines && lines[0] === "打击/物理" && lines[1] === "斩击/效果" && lines[2] === "斩击/炎",
    "顺序编号按位置配对", JSON.stringify(lines));

  const shuffled = "2. 第二条\n1. 第一条\n3. 第三条";
  const l2 = B.normalizeResult(B.parseResult(shuffled), 3);
  ok(!!l2 && l2[0] === "第一条" && l2[1] === "第二条" && l2[2] === "第三条",
    "乱序编号按号码配对，不会错位", JSON.stringify(l2));

  const missing = "1. 第一条\n3. 第三条";
  ok(B.normalizeResult(B.parseResult(missing), 3) === null, "缺号 → 拒绝（本批重试拆分）");

  const junk = "1. 第一条\n2. 第二条\nfreighter";
  const l3 = B.normalizeResult(B.parseResult(junk), 3);
  ok(l3 === null || l3[2] !== "freighter", "多出来的垃圾行不会被当成第三条译文", JSON.stringify(l3));
}

console.log("");
console.log("=== 空槽不能被当译文 ===");
{
  ok(B.normalizeResult(["甲", undefined, "丙"], 3) === null, "有空洞 → 拒绝（不会把 undefined 存成译文）");
  ok(B.normalizeResult(["甲", "", "丙"], 3) === null, "空串 → 拒绝");
  ok(B.normalizeResult(["甲", "乙", "丙"], 3) !== null, "正常三行 → 通过");
  ok(B.normalizeResult(["甲", "乙"], 3) === null, "行数不足 → 拒绝");
}

console.log("");
console.log("=== 不带编号的多行回包：能解析，但调用方要按严格模式拒收 ===");
{
  const g = group(["あ", "い", "う"]);
  const plain = B.parseResult("甲\n乙\n丙");
  ok(plain.length === 3, "仍然解析出 3 行（宽松模式下可用）", JSON.stringify(plain));
  ok(!B.hasNumbering("甲\n乙\n丙"), "但它不带编号 → 严格模式会拒收本批");
  ok(B.buildPrompt(g, TEMPLATE_OLD).includes("行号必须和输入完全一致"), "提示词明确要求行号一致");
}

console.log("");
console.log("pass " + pass + "   fail " + fail);
process.exit(fail ? 1 : 0);
