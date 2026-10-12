// The language verdict, on synthetic data: an English release must NOT read as Chinese — and a Chinese
// release must not read as English either.
//
// tools/game-state.js decides whether a game is Chinese, Japanese or English. Two opposite mistakes are
// possible, and both were made here:
//
//   1. The original verdict compared kana against Han and ignored Latin completely, so Detective Girl of
//      the Steam City (English, 6.4 M Latin letters, 13,900 English dialogue lines) measured 32.8 % kana —
//      under the 35 % cut-off — and was reported 自带中文. The window skips 自带中文, so the game was never
//      translated.
//   2. The first fix for that judged the Latin share of the folder's BYTES. That measures the plumbing:
//      RPG Maker's JSON is mostly keys and structure and a VX Ace archive embeds whole Ruby scripts, so
//      【御光盟国汉化组】露出女子校生2 — whose dialogue is Chinese and which ships its own resources/zh-CN —
//      came out 91 % Latin and turned into 未汉化（英文原版）. 14 of 14 games changed verdict.
//
// The rule that works is over the TEXT the extractor would translate (a player reads text, not bytes), and
// the cases below pin all of it down: each language, plus a Latin-heavy-structure fixture whose text is
// Chinese (the shape that broke fix 2), plus a documented limitation for the VX/archive path.
//
// Fixture note: mv.languageProfile only counts strings held in OBJECT properties — a string in an array
// (where MV keeps dialogue, parameters[0]) is walked past — so these fixtures put text in both places.
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

/** The kind of file an MV game is full of: keys, ids, paths and flags — thousands of Latin letters, no prose. */
function structure(entries) {
  const plugins = [];
  for (let i = 0; i < entries; i++) {
    plugins.push({ name: "Plugin" + i + "Name", status: true,
      parameters: { configurationKeyName: String(i * 1000), assetPathValue: "img/pictures/face" + i + ".png" } });
  }
  return { plugins: plugins };
}

/** A game folder: live www/data plus (optionally) a pristine data_原版备份. */
function makeGame(live, backup, extra) {
  const dir = path.join(root, "game" + (++seq));
  const data = at(path.join(dir, "www"), "data");
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(at(data, "Map001.json"), JSON.stringify(dialogue(live)), "utf8");
  fs.writeFileSync(at(data, "Actors.json"), JSON.stringify(fields(live)), "utf8");
  if (extra) fs.writeFileSync(at(data, "Plugins.json"), JSON.stringify(extra), "utf8");
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
  check("证据里记下了可译文本的拉丁占比", c.Evidence.textLatinPct > 99, true);
}

console.log("");
console.log("=== 英文原版 + 英文的原版备份：仍不是自带中文 ===");
{
  // The shape of Detective Girl: the pristine folder is English too, and its kana share of the CJK
  // characters is the ratio the old rule used.
  check("英文备份不会被读成中文原版", G.classify(makeGame(repeat(EN, 120), repeat(EN, 120))).State, "未汉化（英文原版）");
}

console.log("");
console.log("=== 汉化组发行的中文原版：仍然判成自带中文 ===");
{
  check("中文即原版", G.classify(makeGame(repeat(ZH, 120), repeat(ZH, 120))).State, "自带中文");
}

console.log("");
console.log("=== 中文数据但没有原版备份：外置汉化 ===");
{
  check("判成已是中文（非本工具所译）", G.classify(makeGame(repeat(ZH, 120), null)).State, "已是中文");
}

console.log("");
console.log("=== 日文原版：未汉化 ===");
{
  check("日文原版未汉化", G.classify(makeGame(repeat(JA, 120), null)).State, "未汉化");
}

console.log("");
console.log("=== 回归：字节里全是拉丁，但玩家读的是中文（露出女子校生2 的形状）===");
{
  const dir = makeGame(repeat(ZH, 120), null, structure(300));
  const dataDir = at(path.join(dir, "www"), "data");
  // The trap: judged by bytes the game looks like an English release...
  const byBytes = G.byteProfile(dataDir, /\.json$/i);
  check("按字节算，这个中文游戏确实像英文（这就是上一版判错的原因）", G.isLatinText(byBytes), true);
  check("字节拉丁占比 > 70%", byBytes.latinPct > 70, true);
  // ...while judged by the text the extractor would translate it is plainly Chinese.
  const byText = G.textProfile(dataDir);
  check("按可译文本算，拉丁占比很低（" + Math.round(byText.latinPct) + "%）", byText.latinPct < 20, true);
  check("因此不会被判成英文原版", G.classify(dir).State === "未汉化（英文原版）", false);
  check("判定保持「已是中文」", G.classify(dir).State, "已是中文");
}

console.log("");
console.log("=== textProfile 只统计可译文本（走的是抽取器自己的判据）===");
{
  // Dialogue lives in 401 commands; a made-up field name ("f0") is never extracted, which is the point:
  // what counts is what the pipeline would actually send.
  const dir = at(root, "textprofile");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(at(dir, "Map001.json"), JSON.stringify(dialogue(repeat(EN, 40))), "utf8");
  const p = G.textProfile(dir);
  check("统计到 40 条英文", p.strings, 40);
  check("英文文本 → isLatinText", G.isLatinText(p), true);

  const dir2 = at(root, "textprofile2");
  fs.mkdirSync(dir2, { recursive: true });
  fs.writeFileSync(at(dir2, "Map001.json"), JSON.stringify(dialogue(repeat(ZH, 40))), "utf8");
  const q = G.textProfile(dir2);
  check("中文文本 → 不是 isLatinText", G.isLatinText(q), false);
  check("中文文本的假名占比为 0", Math.round(q.kanaPct), 0);

  const dir3 = at(root, "textprofile3");
  fs.mkdirSync(dir3, { recursive: true });
  fs.writeFileSync(at(dir3, "Actors.json"), JSON.stringify({ a: { name: "K-02" }, b: { name: "HP" } }), "utf8");
  check("没有可译文本时返回 null，而不是瞎猜", G.textProfile(dir3), null);
}

console.log("");
console.log("=== byteProfile 仍然是 kana/CJK 比例（byte 路径不做语言判决）===");
{
  const dir = at(root, "bytes");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(at(dir, "a.rvdata2"), "London detective agency office " + "あいうえお" + "漢字漢字", "utf8");
  const p = G.byteProfile(dir, /\.rvdata2$/i);
  check("统计到假名与汉字", p.kana > 0 && p.han > 0, true);
  check("kanaPct 仍是 CJK 内部比例（5 假名 / 9 CJK）", Math.round(p.kanaPct), 56);
  check("letters = CJK + 拉丁", p.letters, p.total + p.latin);
}

console.log("");
console.log("=== 已知限制：VX/VX Ace 与归档仍然没有拉丁判据 ===");
{
  const prof = (kana, han, latin) => ({ files: 1, kana, han, latin, total: kana + han, letters: kana + han + latin,
    kanaPct: 100 * kana / (kana + han), latinPct: 100 * latin / (kana + han + latin) });
  // Detective Girl's own byte counts. The byte path has no Latin rule on purpose: a .rvdata2 embeds whole
  // Ruby scripts, so its Latin share says nothing (莉娜的金钱探索's archive is 89 % Latin and plays in
  // Chinese). This assertion documents the gap rather than pretending it is closed.
  const live = prof(2494, 16226, 6413460);
  const bak = prof(6605, 13531, 6413398);
  check("旧判据的输入确实是 32.8%（< CN_MAX 35）", Math.round(bak.kanaPct * 10) / 10, 32.8);
  check("byte 路径仍会判成「自带中文」（VX 英文版属已知未修）",
    G.verdictFromBytes("X", live, bak, "vxace", null, null, true).State, "自带中文");
  // The CJK path keeps its old behaviour exactly.
  check("纯 CJK、原版是日文 → 未汉化",
    G.verdictFromBytes("X", prof(12000, 6000, 0), prof(12000, 6000, 0), "vxace", null, null, true).State, "未汉化");
  check("纯 CJK、原版就是中文 → 自带中文",
    G.verdictFromBytes("X", prof(300, 17000, 0), prof(300, 17000, 0), "vxace", null, null, true).State, "自带中文");
  check("纯 CJK、live 已中文但没有本项目痕迹 → 已是中文（他处所译）",
    G.verdictFromBytes("X", prof(300, 17000, 0), prof(12000, 6000, 0), "vxace", null, null, true).State, "已是中文");
}

console.log("");
console.log("=== LATIN_TEXT_PCT / CJK_MIN 边界 ===");
{
  const mk = (kana, han, latin) => ({ strings: 100, kana, han, latin, total: kana + han, letters: kana + han + latin,
    kanaPct: (kana + han) ? 100 * kana / (kana + han) : 0,
    latinPct: (kana + han + latin) ? 100 * latin / (kana + han + latin) : 0 });
  check("99.7% 拉丁 → 英文", G.isLatinText(mk(6605, 13531, 6413398)), true);
  check("恰好 70% 拉丁 → 英文", G.isLatinText(mk(300, 300, 1400)), true);
  check("69% 拉丁 → 仍按 CJK 判", G.isLatinText(mk(310, 310, 1400)), false);
  check("字母总量太少 → 不做语言判断", G.isLatinText(mk(2, 2, 6)), false);
  check("没有文本画像（null）→ 不做判断", G.isLatinText(null), false);
  check("CJK_MIN 是一个真实游戏的数量级", G.CJK_MIN >= 100 && G.CJK_MIN <= 1000, true);
}

fs.rmSync(root, { recursive: true, force: true });
console.log("");
console.log("pass " + pass + "   fail " + fail);
try { process.exit(fail ? 1 : 0); } catch (e) { /* a runner that stubs exit throws instead */ }
