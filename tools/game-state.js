// Per-game state: is this game already Chinese, already translated by us, or still Japanese?
//
// The UI needs to know which games it should not translate, and the only trustworthy answer comes
// from looking at the game rather than at any earlier claim:
//
//   * the live data folder    — is its translatable text Chinese or Japanese?
//   * data_原版备份            — if it exists and is Japanese, the live data was translated FROM it,
//                               i.e. this project (or an earlier pass of it) did the work
//   * resources/<locale>/     — dialogue coverage, the text the player actually reads
//   * the install's own files — 一键恢复汉化.bat / 一键还原汉化前.bat mean we installed here
//
// The measurement is pipeline/extract/mv.js languageProfile, the same profile the pipeline uses to
// decide whether it is safe to snapshot a game, so this verdict and the pipeline's guard agree.
//
// Usage:
//   node tools/game-state.js [--roots "J:\\game" ...] [--depth 5] [--cache <games-cache.json>]
//                            [--outdir <dir>] [--out <name.json>] [--quiet]
"use strict";
const fs = require("fs");
const path = require("path");
const mv = require("../pipeline/extract/mv.js");
const resources = require("../pipeline/extract/resources.js");
const A = require("./audit-lib.js");

const argv = process.argv.slice(2);
let roots = [], depth = 5, cacheFile = "", outDir = "", outName = "", quiet = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--roots") { while (argv[i + 1] && !argv[i + 1].startsWith("--")) roots.push(argv[++i]); }
  else if (argv[i] === "--depth") depth = parseInt(argv[++i], 10) || 5;
  else if (argv[i] === "--cache") cacheFile = argv[++i] || "";
  else if (argv[i] === "--outdir") outDir = argv[++i] || "";
  else if (argv[i] === "--out") outName = argv[++i] || "";
  else if (argv[i] === "--quiet") quiet = true;
}

const KANA = /[\u3040-\u309f\u30a0-\u30ff\uff66-\uff9f]/;
const NAME_RE = /^[A-Za-z0-9_.\-()\[\] \u3000-\u9fff\uff00-\uffef\u3040-\u30ff]{1,255}$/s;

/** A plain directory entry appended to a directory already resolved here. */
function child(root, name) {
  if (typeof name !== "string" || !NAME_RE.test(name) || name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new Error("refusing unsafe name: " + JSON.stringify(name));
  }
  const base = path.resolve(root);
  const t = path.resolve(base, name);
  if (t !== base && !t.startsWith(base + path.sep)) throw new Error("outside root: " + name);
  return t;
}
function subdir(root, rel) {
  let cur = path.resolve(root);
  for (const part of String(rel).split(/[\\/]+/).filter(Boolean)) cur = child(cur, part);
  try { return fs.statSync(cur).isDirectory() ? cur : null; } catch (e) { return null; }
}
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };

/** Where this game's data lives, or why it cannot be read. */
function locate(game) {
  for (const rel of ["www/data", "data", "Data"]) {
    const d = subdir(game, rel);
    if (!d) continue;
    if (A.jsonNames(d).length) return { kind: "json", live: d };
    let files = [];
    try { files = fs.readdirSync(d); } catch (e) { }
    if (files.some((f) => /\.rvdata2$/i.test(f))) return { kind: "vxace" };
    if (files.some((f) => /\.rvdata$/i.test(f))) return { kind: "vx" };
  }
  for (const n of ["Game.rgss3a", "Game.rgss2a", "Game.rgssad"]) {
    try { if (isFile(child(game, n))) return { kind: "packed", archive: n }; } catch (e) { }
  }
  return null;
}

function findBackup(game) {
  for (const rel of ["data_原版备份", "Data_原版备份", "www/data_原版备份"]) {
    const d = subdir(game, rel);
    if (d && A.jsonNames(d).length) return d;
  }
  return null;
}

const profile = (dir) => { try { return mv.languageProfile(dir); } catch (e) { return null; } };

/** Dialogue strings, and how many still carry kana — live, and in the pristine original. */
function dialogueCounts(dataDir, backupDataDir) {
  try {
    const liveFiles = resources.dialogueFiles(dataDir);
    if (!liveFiles.length) return null;
    let total = 0, kanaLive = 0, kanaBackup = 0;
    for (const f of liveFiles) {
      let j;
      try { j = JSON.parse(A.readTextInside(dataDir, f.full)); } catch (e) { continue; }
      for (const v of Object.values(j)) { if (typeof v === "string" && v.trim()) { total++; if (KANA.test(v)) kanaLive++; } }
    }
    if (backupDataDir) {
      for (const f of resources.dialogueFiles(backupDataDir)) {
        let j;
        try { j = JSON.parse(A.readTextInside(backupDataDir, f.full)); } catch (e) { continue; }
        for (const v of Object.values(j)) if (typeof v === "string" && v.trim() && KANA.test(v)) kanaBackup++;
      }
    }
    return { total, kanaLive, kanaBackup, files: liveFiles.length };
  } catch (e) { return null; }
}

function classify(game) {
  const loc = locate(game);
  if (!loc) return { State: "非 MV/MZ", Note: "无 JSON 数据，本工具不支持", Evidence: {} };
  if (loc.kind === "packed") return { State: "打包归档", Note: loc.archive + "，需先解包", Evidence: {} };
  if (loc.kind === "vxace") return { State: "VX Ace", Note: ".rvdata2，本工具不支持", Evidence: {} };
  if (loc.kind === "vx") return { State: "VX", Note: ".rvdata，本工具不支持", Evidence: {} };

  const live = profile(loc.live);
  const backup = findBackup(game);
  const bakProfile = backup ? profile(backup) : null;
  const dialogue = dialogueCounts(loc.live, backup);
  const locales = A.resourceLocaleProfile(loc.live);
  // Fields whose Japanese original became Chinese — the direct evidence that a translation pass ran
  // here, and the only usable coverage figure for games with no dialogue folder.
  const dataDiff = backup ? A.translatedCount(loc.live, backup) : null;
  const installed = ["一键恢复汉化.bat", "一键还原汉化前.bat"].some((n) => {
    try { return fs.existsSync(child(game, n)); } catch (e) { return false; }
  });
  // The folder name is a claim (whoever packaged the release wrote it); the data is evidence. When
  // the two disagree the disagreement is shown rather than resolved silently.
  const official = /官方中文|官方汉化|官中|official\s*chinese|中文版/i.test(game);

  const liveKanaPct = live && live.total ? 100 * live.kana / live.total : 0;
  const bakKanaPct = bakProfile && bakProfile.total ? 100 * bakProfile.kana / bakProfile.total : 0;
  const evidence = {
    liveStrings: live ? live.total : 0, liveKanaPct: +liveKanaPct.toFixed(1),
    backup: !!backup, backupStrings: bakProfile ? bakProfile.total : 0, backupKanaPct: +bakKanaPct.toFixed(1),
    dialogue, locales, dataDiff, installedByUs: installed,
  };

  if (!live || live.total < 20) return { State: "无文本", Note: "可译文本太少", Evidence: evidence };

  // A Chinese release ships Chinese in its own locale folder while ja-JP stays Japanese, so that is
  // checked before anything is said about the ja-JP text.
  const zhLocale = locales.find((l) => /^(zh|cn|chs|cht|zh-cn|zh-hans|zh-hant|sc|tc)/i.test(l.locale) && l.hanOnly > l.kana);
  // Our own passes write Chinese into ja-JP itself.
  const jaLocale = locales.find((l) => /^ja/i.test(l.locale));
  const jaIsChinese = jaLocale && jaLocale.strings > 20 && jaLocale.kana < jaLocale.strings * 0.1;

  const ours = !!backup || installed;
  // "对话" only when the figure really comes from the dialogue folder; otherwise it is the share of
  // translatable data fields that became Chinese.
  const noteFrom = (pct, fromDialogue) => {
    if (pct !== null && pct !== undefined) return (fromDialogue ? "对话 " : "已译 ") + Math.round(pct * 100) + "%";
    return ours ? "有汉化痕迹" : "";
  };

  // Coverage of the player-visible text.
  //
  // With a dialogue folder, that folder is the text the player reads, and the pristine original gives
  // the denominator. Without one, the data is compared field by field against the original: how many
  // translatable fields became Chinese, against how many are still kana. The data folder's own kana
  // share is NOT a measure — the extractor deliberately leaves kana inside script and plugin blobs,
  // so a game that is 95 % translated still measures high there (凍堂ヒロカの隷雄譚: 77 % by that
  // count, 97 % by dialogue; メアリ: 10.6 % of all strings but 95 % of the translatable ones).
  let coverage = null;
  let fromDialogue = false;
  if (dialogue && dialogue.kanaBackup > 0) { coverage = 1 - dialogue.kanaLive / dialogue.kanaBackup; fromDialogue = true; }
  else if (dataDiff && dataDiff.translated + dataDiff.remaining > 0) {
    coverage = dataDiff.translated / (dataDiff.translated + dataDiff.remaining);
  } else if (liveKanaPct < 5) coverage = 1;

  if (zhLocale && !jaIsChinese) {
    return { State: "自带中文", Note: "resources/" + zhLocale.locale + "（" + zhLocale.hanOnly + " 串中文）", Evidence: evidence };
  }
  if (coverage !== null && coverage >= 0.9) {
    // Whose work it is needs evidence, not just coverage: a game whose data is Chinese but which has
    // neither a pristine backup nor our install scripts was already Chinese when it arrived. Without
    // this check every such game was credited to this project (金色complex 慰安騎士 is one: the
    // pipeline itself skips it as 已是中文).
    if (ours) return { State: "已汉化（本项目）", Note: noteFrom(coverage, fromDialogue), Evidence: evidence };
    return { State: "已是中文", Note: noteFrom(coverage, fromDialogue), Evidence: evidence };
  }
  if (coverage !== null && coverage >= 0.3) return { State: "部分汉化", Note: noteFrom(coverage, fromDialogue), Evidence: evidence };
  // Little or no Chinese found: with a pristine original present, a translation existed here and was
  // uninstalled — the backup and the pipeline's cache still hold the work.
  //
  // A folder that claims to be an official Chinese release while its data still measures Japanese is
  // reported as such rather than silently believed or silently dismissed: the name is a claim, the
  // data is evidence, and the two disagreeing is worth seeing.
  const mismatch = official ? "（目录名标着官方中文，但数据仍是日文）" : "";
  // Some work exists but it is not yet most of the text: call that 部分汉化 rather than "untouched",
  // because the difference decides whether translating it again is a small job or a full one.
  const pct = Math.round(coverage * 100);
  if (dataDiff && dataDiff.translated >= 20) {
    return { State: "部分汉化", Note: (pct >= 1 ? "已译 " + pct + "%" : "已译 " + dataDiff.translated + " 串") + mismatch, Evidence: evidence };
  }
  if (backup) return { State: "未汉化（已还原）", Note: "有原版备份与缓存，可快速重译" + mismatch, Evidence: evidence };
  return { State: "未汉化", Note: mismatch, Evidence: evidence };
}

// --- which games -------------------------------------------------------------------------
const games = [];
if (cacheFile) {
  try {
    const arr = JSON.parse(A.readTextInside(path.dirname(path.resolve(cacheFile)), path.basename(cacheFile)));
    for (const g of arr) {
      const d = g.Dir || g.dir;
      if (d) games.push(d);
    }
  } catch (e) { console.error("读取 games-cache.json 失败：" + e.message); }
}
if (!games.length) {
  if (!roots.length) roots = ["J:\\game"];
  const looksLikeGame = (dir) => {
    for (const rel of ["data", "Data", path.join("www", "data")]) {
      const d = path.join(dir, rel);
      try { if (fs.readdirSync(d).some((f) => /\.(json|rvdata2?|rxdata)$/i.test(f))) return true; } catch (e) { }
    }
    return ["Game.rgss3a", "Game.rgss2a", "Game.rgssad"].some((n) => fs.existsSync(path.join(dir, n)));
  };
  const scan = (dir, remaining) => {
    if (remaining < 0) return;
    if (looksLikeGame(dir)) { games.push(dir); return; }
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (!e.isDirectory() || /^\$RECYCLE|^System Volume Information/i.test(e.name)) continue;
      scan(path.join(dir, e.name), remaining - 1);
    }
  };
  for (const r of roots) scan(path.resolve(r), depth);
}

// --- classify ---------------------------------------------------------------------------
const rows = [];
for (let i = 0; i < games.length; i++) {
  const g = games[i];
  let r;
  try { r = classify(g); } catch (e) { r = { State: "读取失败", Note: String(e.message).slice(0, 60), Evidence: {} }; }
  rows.push({ Dir: g, Name: path.basename(g), State: r.State, Note: r.Note, Evidence: r.Evidence });
  if (!quiet) console.log(String(i + 1).padStart(3) + "/" + games.length + "  " + r.State.padEnd(14) +
    (r.Note || "").padEnd(22) + path.basename(g).slice(0, 60));
}

const tally = new Map();
for (const r of rows) tally.set(r.State, (tally.get(r.State) || 0) + 1);
console.log("");
console.log("=== 汇总（" + rows.length + " 个游戏）===");
for (const [k, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) console.log("  " + String(n).padStart(4) + "  " + k);

if (outDir && outName) {
  try {
    const target = A.writeJsonInside(outDir, outName, JSON.stringify(rows, null, 1));
    console.log("");
    console.log("已写出 " + target);
  } catch (e) {
    // One readable line rather than a Node stack trace in the UI log.
    console.error("写出状态文件失败：" + (e && e.message ? e.message : e));
    process.exit(1);
  }
}
