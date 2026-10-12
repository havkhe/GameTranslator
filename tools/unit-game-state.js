// The language verdict, on synthetic data: an English release must NOT read as Chinese.
//
// tools/game-state.js decides whether a game is Chinese, Japanese or English from the characters in its
// data. The bug this covers: the verdict compared kana against Han and ignored Latin completely, so an
// English release whose 6.4 million Latin letters outweighed 20k CJK characters by 300:1 was judged by a
// ratio between two minorities — 32.8 %, under the 35 % cut-off — and reported as 自带中文 (the pristine
// copy already Chinese). The window skips 自带中文, so Detective Girl of the Steam City, whose 13,900
// dialogue lines are all English, was never translated.
//
// Fixture note: mv.languageProfile only counts strings held in OBJECT properties — a string sitting in an
// array (which is where MV keeps dialogue, parameters[0]) is walked past. So the fixtures put the text in
// named fields; that is how the real profile sees 3,681 strings of a game with 9,946 dialogue entries.
//
//   node tools/unit-game-state.js
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const G = require("../tools/game-state.js");

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (ok) { pass++; console.log("  pass  " + name); }
  else { fail++; console.log("  FAIL  " + name + "   得到 " + JSON.stringify(got) + "，应为 " + JSON.stringify(want)); }
};

const NAME_RE = /^[A-Za-z0-9_.\-()\[\] \u3000-\u9fff\uff00-\uffef\u3040-\u30ff]{1,64}$/;
/** A path under a folder this test owns, refused unless every segment is a plain name. */
function at(root, name) {
  if (typeof name !== "string" || !NAME_RE.test(name) || name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new Error("refusing unsafe name: " + JSON.stringify(name));
  }
  const base = path.resolve(root);
  const t = path.resolve(base, name);
  if (t !== base && !t.startsWith(base + path.sep)) throw new Error("outside root: " + name);
  return t;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gt-state-"));
let seq = 0;
const fields = (arr) => { const o = {}; arr.forEach((s, i) => { o["f" + i] = s; }); return o; };
const dialogue = (lines) => ({ events: [{ pages: [{ list: lines.map((t) => ({ code: 401, parameters: [t] })) }] }] });
const repeat = (s, n) => Array.from({ length: n }, (_, i) => s + " " + i);

/** A game folder: live www/data plus (optionally) a Chinese/Japanese data_原版备份. */
function makeGame(live, backup) {
  const dir = path.join(root, "game" + (++seq));
  const data = at(path.join(dir, "www"), "data");
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(at(data, "Map001.json"), JSON.stringify(dialogue(live)), "utf8");
  fs.writeFileSync(at(data, "Actors.json"), JSON.stringify(fields(live)), "utf8");
  fs.writeFileSync(at(dir, "package.json"), "{}", "utf8");     // the MV marker locate() looks for
  if (backup) {
    const bak = at(dir, "data_原版备份");
    fs.mkdirSync(bak, { recursive: true });
    fs.writeFileSync(at(bak, "Map001.json"), JSON.stringify(dialogue(backup)), "utf8");
    fs.writeFileSync(at(bak, "Actors.json"), JSON.stringify(fields(backup)), "utf8");
  }
  return dir;
}

const EN = "I never expected you to use a method like that to see through his trick, detective.";
const ZH = "我从没想过你会用那样的方法看穿他的把戏，侦探。";
const JA = "そんな方法で彼のトリックを見破るとは思いませんでした、探偵さん。";

console.log("=== 英文原版：不能判成中文 ===");
{
  const c = G.classify(makeGame(repeat(EN, 120), null));
  check("不判为「自带中文」", c.State === "自带中文" || c.State === "已是中文", false);
  check("判定是「未汉化（英文原版）」", c.State, "未汉化（英文原版）");
  check("证据里带上了拉丁字母占比", c.Evidence.liveLatinPct > 99, true);
}

console.log("");
console.log("=== 英文原版 + 英文的原版备份：仍然不是自带中文 ===");
{
  // The exact shape of Detective Girl: the pristine folder is English too, so its kana share of the CJK
  // characters is the ratio that used to decide the verdict.
  const c = G.classify(makeGame(repeat(EN, 120), repeat(EN, 120)));
  check("英文备份不会被读成中文原版", c.State, "未汉化（英文原版）");
}

console.log("");
console.log("=== 汉化组发行的中文原版：仍然判成自带中文 ===");
{
  const c = G.classify(makeGame(repeat(ZH, 120), repeat(ZH, 120)));
  check("中文即原版", c.State, "自带中文");
}

console.log("");
console.log("=== 中文数据但没有原版备份：外置汉化 ===");
{
  const c = G.classify(makeGame(repeat(ZH, 120), null));
  check("判成已是中文（非本工具所译）", c.State, "已是中文");
}

console.log("");
console.log("=== 日文原版：未汉化 ===");
{
  const c = G.classify(makeGame(repeat(JA, 120), null));
  check("日文原版未汉化", c.State, "未汉化");
}

console.log("");
console.log("=== 回归：Detective Girl 的实测字节数（byte 路径）===");
{
  const prof = (kana, han, latin) => ({ files: 1, kana, han, latin, total: kana + han, letters: kana + han + latin,
    kanaPct: 100 * kana / (kana + han), latinPct: 100 * latin / (kana + han + latin) });
  // Measured on the game itself: live 2,494 kana / 16,226 Han / 6,413,460 Latin; pristine 6,605 / 13,531 / 6,413,398.
  const live = prof(2494, 16226, 6413460);
  const bak = prof(6605, 13531, 6413398);
  check("旧判据的输入确实是 32.8%（< CN_MAX 35）", Math.round(bak.kanaPct * 10) / 10, 32.8);
  const v = G.verdictFromBytes("Detective", live, bak, "vxace", null, null, true);
  check("现在判成「未汉化（英文原版）」", v.State, "未汉化（英文原版）");
  check("证据里记下了拉丁占比", v.Evidence.liveLatinPct, 99.7);
  // And the same numbers with the Latin dimension removed keep their old meaning: the guard must not
  // change anything for CJK games.
  const zhLive = prof(300, 17000, 0);      // 1.7 % kana: Chinese
  const jaBak = prof(12000, 6000, 0);      // 67 % kana: Japanese
  check("纯 CJK、原版是日文 → 未汉化", G.verdictFromBytes("X", jaBak, prof(12000, 6000, 0), "vxace", null, null, true).State, "未汉化");
  check("纯 CJK、原版就是中文 → 自带中文", G.verdictFromBytes("X", zhLive, zhLive, "vxace", null, null, true).State, "自带中文");
  check("纯 CJK、live 已中文但没有本项目痕迹 → 已是中文（他处所译）",
    G.verdictFromBytes("X", zhLive, jaBak, "vxace", null, null, true).State, "已是中文");
}

console.log("");
console.log("=== byteProfile 的三分量与 isLatinText 判据 ===");
{
  const dir = path.join(root, "bytes");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(at(dir, "a.rvdata2"), "London detective agency office " + "あいうえお" + "漢字漢字", "utf8");
  const p = G.byteProfile(dir, /\.rvdata2$/i);
  check("统计到拉丁字母", p.latin > 20, true);
  check("统计到假名与汉字", p.kana > 0 && p.han > 0, true);
  check("kanaPct 仍是 CJK 内部比例（5 假名 / 9 CJK）", Math.round(p.kanaPct), 56);
  check("latinPct 是字母内的比例（27 拉丁 / 36 字母）", Math.round(p.latinPct), 75);
  check("letters = CJK + 拉丁", p.letters, p.total + p.latin);
}

console.log("");
console.log("=== LATIN_TEXT_PCT / CJK_MIN 边界 ===");
{
  const mk = (kana, han, latin) => ({ files: 1, kana, han, latin, total: kana + han, letters: kana + han + latin,
    kanaPct: (kana + han) ? 100 * kana / (kana + han) : 0,
    latinPct: (kana + han + latin) ? 100 * latin / (kana + han + latin) : 0 });
  check("99.7% 拉丁 → 英文", G.isLatinText(mk(6605, 13531, 6413398)), true);
  check("恰好 70% 拉丁 → 英文", G.isLatinText(mk(300, 300, 1400)), true);
  check("69% 拉丁 → 仍按 CJK 判", G.isLatinText(mk(310, 310, 1400)), false);
  check("字母总量太少 → 不做语言判断", G.isLatinText(mk(2, 2, 6)), false);
  // CJK_MIN is the other gate: a real game's worth of CJK characters is what makes a kana ratio usable.
  check("CJK_MIN 是一个真实游戏的数量级", G.CJK_MIN >= 100 && G.CJK_MIN <= 1000, true);
  check("CJK 数量少于 CJK_MIN 时，字节路径的 kana 比例不参与判定", G.CJK_MIN > mk(50, 50, 0).total, true);
}

fs.rmSync(root, { recursive: true, force: true });
console.log("");
console.log("pass " + pass + "   fail " + fail);
try { process.exit(fail ? 1 : 0); } catch (e) { /* a runner that stubs exit throws instead */ }
