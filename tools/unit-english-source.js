// English-source support: does the rule accept the game's English lines and still reject ids/filenames?
//
// Reads real strings out of an English release's pristine data (NTR Sisters), so the assertions are
// about this library rather than about invented examples.
//
//   node tools/unit-english-source.js
"use strict";
const fs = require("fs");
const path = require("path");
const R = require("../pipeline/extract/rules.js");
const Q = require("../pipeline/translate/quality.js");

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (ok) { pass++; console.log("  pass  " + name); }
  else { fail++; console.log("  FAIL  " + name + "   得到 " + got + "，应为 " + want); }
};

console.log("=== 英文正文必须被抽取 ===");
const PROSE = [
  "You found a Potion!",
  "Are you sure you want to leave?",
  "The door is locked from the inside.",
  "I'll never forgive you for this...",
  "Take this and go north.",
  "What's the matter?",
];
for (const s of PROSE) check(JSON.stringify(s.slice(0, 34)), R.isTranslatable(s), true);

console.log("");
console.log("=== id / 文件名 / 路径 / 单字标识符仍然排除 ===");
const NOT_TEXT = [
  "K-02",
  "Actor1",
  "EV001",
  "Window_Base",
  "RPG::Actor",
  "img/pictures/face.png",
  "https://example.com/x",
  "HP",
  "",
  "   ",
];
for (const s of NOT_TEXT) check(JSON.stringify(s), R.isTranslatable(s), false);

console.log("");
console.log("=== 单个英文单词按 id 处理（不发）===");
check("Potion", R.isTranslatable("Potion"), false);
check("Continue?", R.isTranslatable("Continue?"), true);     // 带句末标点 = 一句台词
check("Yes.", R.isTranslatable("Yes."), true);

console.log("");
console.log("=== 日文规则不受影响 ===");
check("日文对白", R.isTranslatable("「こんにちは」"), true);
check("汉字段落", R.isTranslatable("回復魔法"), true);
check("日文文件名", R.isTranslatable("face.png"), false);

console.log("");
console.log("=== 英文源的译文必须是中文（否则会被当成英文回显丢掉）===");
check("英文源 + 英文回显 → 判为英文", Q.looksLikeEnglish("You found a Potion!", "You found a Potion!"), true);
check("英文源 + 英文改写 → 判为英文", Q.looksLikeEnglish("You got a Potion!", "You found a Potion!"), true);
check("英文源 + 中文译文 → 正常", Q.looksLikeEnglish("你找到了一个药水！", "You found a Potion!"), false);
check("日文源 + 英文输出 → 判为英文", Q.looksLikeEnglish("I am fine.", "私は元気です"), true);
check("日文源 + 中文输出 → 正常", Q.looksLikeEnglish("我很好。", "私は元気です"), false);

console.log("");
console.log("=== 英文源也要有 unchanged 检查（回显英文不能入库）===");
check("英文正文算可译源", Q.translatableSource("You found a Potion!"), true);
check("id 不算可译源", Q.translatableSource("K-02"), false);
check("中文长句仍算", Q.translatableSource("你已经获得了三个药剂，请小心使用它们。"), true);

// 真实语料统计：只有当环境变量 GT_CORPUS 指向一个英文版游戏的原版数据目录时才跑，没有就整段跳过。
// 写死本机某个游戏的路径，会让这条断言在别的机器上失败，也会把作者的游戏名带进发行产物。
const GAME = String(process.env.GT_CORPUS || "");
const BAK = GAME ? path.join(GAME, "data_原版备份") : "";
if (BAK && fs.existsSync(BAK)) {
  let latin = 0, accepted = 0;
  for (const f of fs.readdirSync(BAK)) {
    if (!/\.json$/i.test(f)) continue;
    let j; try { j = JSON.parse(fs.readFileSync(path.join(BAK, f), "utf8")); } catch (e) { continue; }
    const walk = (n) => {
      if (typeof n === "string") {
        if (!/[\u3040-\u30ff\u3400-\u9fff]/.test(n) && /[A-Za-z]{3,}/.test(n)) { latin++; if (R.isTranslatable(n)) accepted++; }
        return;
      }
      if (Array.isArray(n)) { for (const v of n) walk(v); return; }
      if (n && typeof n === "object") { for (const k of Object.keys(n)) walk(n[k]); }
    };
    walk(j);
  }
  console.log("");
  console.log("=== 真实语料（GT_CORPUS 指定的原版数据）===");
  console.log("   非中日文、含英文的字符串: " + latin + " 条，其中规则接受: " + accepted + " 条（" +
    (latin ? Math.round(100 * accepted / latin) : 0) + "%）");
  check("真实语料里至少接受了一部分英文", accepted > 100, true);
}

console.log("");
console.log("pass " + pass + "   fail " + fail);
process.exit(fail ? 1 : 0);
