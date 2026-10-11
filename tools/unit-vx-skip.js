// The VX skip rule: which kana-free kanji strings may be dropped as "already Chinese"?
//
// A kana-free run of kanji is ambiguous — 剣 / 回復魔法 / 斬撃/必殺技2 are Japanese words written with
// characters Chinese also uses, while a title translated by another tool really does hold Chinese. The
// rule drops only PROSE (>= CHINESE_PROSE_MIN); short terms go to the model. The MV side has worked
// that way since the 汉字术语 fix; the VX side dropped every kana-free string, which on a real game
// discarded 226 of 905 collected strings — skill, item and enemy names, i.e. every menu (docs/P25).
//
//   node tools/unit-vx-skip.js
"use strict";
const vx = require("../pipeline/extract/vxace.js");

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (ok) { pass++; console.log("  pass  " + name); }
  else { fail++; console.log("  FAIL  " + name + "   得到 " + got + "，应为 " + want); }
};

const skip = (s) => vx.isChineseLike(s, vx.CHINESE_PROSE_MIN);

console.log("=== 日文名（不含假名）必须送去翻译，不能被当成中文跳过 ===");
check("剣", skip("剣"), false);
check("盾", skip("盾"), false);
check("薬", skip("薬"), false);
check("回復魔法", skip("回復魔法"), false);
check("斬撃/必殺技2", skip("斬撃/必殺技2"), false);
check("格闘/物理", skip("格闘/物理"), false);
check("敵ダメージ", skip("敵ダメージ"), false);
check("必殺技1", skip("必殺技1"), false);

console.log("");
console.log("=== 真·中文长句仍要跳过（否则让模型中译中会拒答、级联失败）===");
check("……正式比赛结束后再谈……", skip("……正式比赛结束后再谈……"), true);
check("你已经获得了三个药剂，请小心使用它们。", skip("你已经获得了三个药剂，请小心使用它们。"), true);
check("这是一把传说中的退魔刀，可以封印邪恶。", skip("这是一把传说中的退魔刀，可以封印邪恶。"), true);

console.log("");
console.log("=== 有假名的一律不跳过（假名就是日文的证据）===");
check("やくそう", skip("やくそう"), false);
check("剣を手に入れた", skip("剣を手に入れた"), false);

console.log("");
console.log("=== 边界：短句即使很像中文也照送（长度 < " + vx.CHINESE_PROSE_MIN + "）===");
check("药水（2 字）", skip("药水"), false);
check("三把剑（3 字）", skip("三把剑"), false);
check("十二个字以内的中文短句", skip("十二个字以内的中文短句"), false);

console.log("");
console.log("=== 非中文文本不受影响 ===");
check("HP", skip("HP"), false);
check("12345", skip("12345"), false);
check("", skip(""), false);

console.log("");
console.log("pass " + pass + "   fail " + fail);
process.exit(fail ? 1 : 0);
