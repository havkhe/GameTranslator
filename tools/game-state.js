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
//   node tools/game-state.js [--roots "<游戏库根目录>" ...] [--depth 5] [--cache <games-cache.json>]
//                            [--outdir <dir>] [--out <name.json>] [--quiet]
"use strict";
const fs = require("fs");
const path = require("path");
const mv = require("../pipeline/extract/mv.js");
const resources = require("../pipeline/extract/resources.js");
const text2frame = require("../pipeline/extract/text2frame.js");
const rgssad = require("../pipeline/archive/rgssad.js");
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
  // An archive wins over loose files: measured on one game, whose loose Data folder is Japanese
  // (59.5 % kana) while the game plays in Chinese, i.e. the Chinese lives inside Game.rgss3a and the
  // loose files are not what the player sees. The loose folder is still reported, so the ambiguity is
  // visible instead of silently resolved.
  let loose = null;
  for (const rel of ["www/data", "data", "Data"]) {
    const d = subdir(game, rel);
    if (!d) continue;
    if (A.jsonNames(d).length) { loose = { kind: "json", live: d }; break; }
    let files = [];
    try { files = fs.readdirSync(d); } catch (e) { }
    if (files.some((f) => /\.rvdata2$/i.test(f))) { loose = { kind: "vxace", live: d }; break; }
    if (files.some((f) => /\.(rvdata|rxdata)$/i.test(f))) { loose = { kind: "vx", live: d }; break; }
  }
  for (const n of ["Game.rgss3a", "Game.rgss2a", "Game.rgssad"]) {
    try { if (isFile(child(game, n))) return { kind: "packed", archive: n, loose: loose }; } catch (e) { }
  }
  return loose;
}

function findBackup(game) {
  for (const rel of ["data_原版备份", "Data_原版备份", "www/data_原版备份"]) {
    const d = subdir(game, rel);
    if (d && A.jsonNames(d).length) return d;
  }
  return null;
}

const profile = (dir) => { try { return mv.languageProfile(dir); } catch (e) { return null; } };

/**
 * Kana vs Han vs Latin over the raw bytes of a folder.
 *
 * For VX/VX Ace (`.rvdata2`, Ruby Marshal) and for an unpacked archive there is no JSON to parse, and
 * loading them needs the portable Ruby. Counting the UTF-8 characters directly is crude but enough to
 * tell "this data is Japanese" from "this data is Chinese", which is the question the state answers.
 *
 * `latin` is counted for a different reason: the CJK share is a ratio INSIDE the CJK characters, so on a
 * game whose text is English it is a ratio of a handful of characters against 6.4 million Latin letters
 * and means nothing at all. Measured on Detective Girl of the Steam City (an English release): 6,605 kana
 * and 13,531 Han against 6,413,398 Latin letters — kana was 32.8 % of the CJK and the game was read as
 * 自带中文 (the pristine copy judged Chinese), so the window skipped a game whose 13,900 dialogue lines
 * were 100 % English. `latinPct` is what says "this folder is not CJK text at all".
 */
function byteProfile(dir, exts) {
  let kana = 0, han = 0, latin = 0, files = 0;
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return null; }
  for (const n of names) {
    if (!exts.test(n)) continue;
    let buf;
    try { buf = fs.readFileSync(child(dir, n)); } catch (e) { continue; }
    files++;
    const s = buf.toString("utf8");
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      if ((cp >= 0x3040 && cp <= 0x30ff) || cp === 0x30fc) kana++;
      else if (cp >= 0x3400 && cp <= 0x9fff) han++;
      else if ((cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122)) latin++;
    }
  }
  const total = kana + han;
  const letters = total + latin;
  return { files: files, kana: kana, han: han, latin: latin, total: total, letters: letters,
    kanaPct: total ? 100 * kana / total : 0,
    latinPct: letters ? 100 * latin / letters : 0 };
}

// A data folder that is already Chinese still carries kana in names and sfx; raw Japanese sits at
// 60-80 % of all CJK characters, a translated one at 5-30 %. These are the byte-scale cut-offs
// (measured: one archive at 22.1 % and still Chinese; another at 73 % and raw Japanese).
const CN_MAX = 35, JP_MIN = 55;
// A folder that is this much Latin letters is not CJK text, whatever its kana-vs-Han ratio says.
const LATIN_TEXT_PCT = 70;
// Below this many characters the ratio is noise rather than a measurement: 22 characters can sit at
// any percentage at all. Both the 自带中文 verdict and its refutation rest on the ratio, so both need it.
const CJK_MIN = 200;
const RV_EXT = /\.(rvdata2?|rxdata)$/i;
const JSON_EXT = /\.json$/i;

/**
 * Language over the text the extractor would translate — NOT over raw bytes.
 *
 * This distinction is the whole difference between a working rule and a broken one. Counting raw bytes
 * measures the game's plumbing: RPG Maker's JSON is mostly keys and structure ("events", "pages", "list",
 * "parameters") and a VX Ace archive embeds whole Ruby scripts, so a Japanese or Chinese game measures
 * 89-95 % Latin that way. Measured: with a byte-based Latin rule, 14 games changed verdict — including
 * a 汉化组 release, whose dialogue is Chinese and whose own resources/zh-CN folder says so.
 *
 * What does describe the language of a game is the text a player reads, so the strings are taken through
 * the project's own extraction (rules.isTranslatable decides what counts) and the letters inside THEM are
 * counted. English dialogue is then 99 % Latin; Chinese dialogue is not.
 */
function textProfile(dataDir) {
  let entries = [];
  try { entries = mv.extract(dataDir, dataDir).entries; } catch (e) { return null; }
  if (!entries.length) return null;
  let kana = 0, han = 0, latin = 0;
  for (const e of entries) {
    for (const ch of String(e.text)) {
      const cp = ch.codePointAt(0);
      if ((cp >= 0x3040 && cp <= 0x30ff) || cp === 0x30fc) kana++;
      else if (cp >= 0x3400 && cp <= 0x9fff) han++;
      else if ((cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122)) latin++;
    }
  }
  const total = kana + han;
  const letters = total + latin;
  return { strings: entries.length, kana: kana, han: han, latin: latin, total: total, letters: letters,
    kanaPct: total ? 100 * kana / total : 0,
    latinPct: letters ? 100 * latin / letters : 0 };
}

/** Is the game's own text English/another Latin script, rather than Chinese or Japanese? */
function isLatinText(p) { return !!p && p.letters >= CJK_MIN && p.latinPct >= LATIN_TEXT_PCT; }

/** Did this project leave artifacts for the game (its cache or a run report)? */
function ourArtifacts(gameDir) {
  const stem = path.basename(gameDir).replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_").slice(0, 60);
  const dir = path.resolve(__dirname, "..", "work");
  for (const suffix of ["-translations.json", "-translate-report.json"]) {
    try { if (fs.existsSync(path.join(dir, stem + suffix))) return true; } catch (e) { }
  }
  return false;
}

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

/**
 * Text2Frame message text: the script of a game that keeps dialogue in text/*.txt.
 *
 * The data folder can measure fully translated while every message line is still Japanese, because the
 * extractor never reads these files. Measured on one such game: 24 of 24 translatable data fields in
 * Chinese and 67 of 67 message lines still Japanese, so the game read as translated and played as
 * Japanese. Counted here so the state cannot be reported from the data alone.
 */
function text2frameCounts(gameDir, dataDir) {
  const out = { files: 0, lines: 0, kanaPristine: 0, kanaLive: 0 };
  const count = (dir) => {
    let kana = 0, lines = 0, files = 0;
    for (const f of text2frame.textFilesIn(dir)) {
      files++;
      let text;
      try { text = fs.readFileSync(f.full, "utf8"); } catch (e) { continue; }
      for (const l of text.split(/\r?\n/)) { if (!l.trim()) continue; lines++; if (KANA.test(l)) kana++; }
    }
    return { files, lines, kana };
  };
  try {
    for (const root of text2frame.textRoots(gameDir, dataDir)) {
      const pristine = isDir(root.backup) ? root.backup : root.dir;
      const src = count(pristine);
      const live = count(root.dir);
      out.files += live.files;
      out.lines += live.lines;
      out.kanaPristine += src.kana;
      out.kanaLive += live.kana;
    }
  } catch (e) { /* a game we cannot read is reported by the other checks */ }
  return out;
}

/** The pristine .rvdata2/.rvdata files, if this project made a backup before touching the game. */
function vxBackupProfile(game) {
  for (const rel of ["data_原版备份\\Data", "data_原版备份", "Data_原版备份"]) {
    const d = subdir(game, rel);
    if (!d) continue;
    const p = byteProfile(d, RV_EXT);
    if (p && p.files) return p;
  }
  return null;
}

/** Unpack the pristine archive into a scratch folder and profile the data inside it. */
function packedProfile(game, archiveName) {
  const stem = path.basename(game).replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_").slice(0, 60);
  const scratch = path.join(path.resolve(__dirname, "..", "work"), "_state-unpack", stem);
  // The pristine archive if we kept one, otherwise the live archive (read-only either way).
  let src = null;
  for (const rel of ["data_原版备份", "Data_原版备份"]) {
    const d = subdir(game, rel);
    if (d) {
      const a = path.join(d, archiveName);
      if (isFile(a)) { src = a; break; }
    }
  }
  if (!src) { try { src = child(game, archiveName); } catch (e) { src = null; } }
  if (!src || !isFile(src)) return null;
  try {
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.mkdirSync(scratch, { recursive: true });
    rgssad.unpack(src, scratch);
  } catch (e) { return null; }
  // rgssad.unpack lays the archive out as <scratch>/unpacked/Data/*.rvdata2 plus its own manifest.
  for (const rel of ["unpacked/Data", "Data", "unpacked", "."]) {
    const d = rel === "." ? scratch : path.join(scratch, rel);
    if (!isDir(d)) continue;
    const p = byteProfile(d, RV_EXT);
    if (p && p.files) return p;
  }
  return null;
}

/** Verdict for a game whose data is not JSON: VX / VX Ace, or an archive. */
function verdictFromBytes(game, live, backup, kind, archiveName, looseProf, viaArchive) {
  const label = kind === "packed"
    ? (archiveName + (viaArchive === false ? " 归档读不出，按松散数据判断" : " 归档"))
    : (kind === "vxace" ? "VX Ace" : "VX");
  if (!live || live.total < 20) {
    return { State: "无文本", Note: label + "（数据读不出来或文本太少）", Evidence: {} };
  }
  const ours = ourArtifacts(game);
  const bakPct = backup && backup.total > 20 ? backup.kanaPct : null;
  const evidence = { liveKanaPct: +live.kanaPct.toFixed(1), backupKanaPct: bakPct === null ? null : +bakPct.toFixed(1),
    liveHan: live.han, liveKana: live.kana, engine: label, ours: ours };
  const loose = looseProf && looseProf.total > 20
    ? "；同目录松散数据假名 " + looseProf.kanaPct.toFixed(1) + "%（游戏读的是归档）" : "";
  const fig = "假名占比 " + (bakPct === null ? "" : bakPct.toFixed(1) + "% → ") + live.kanaPct.toFixed(1) + "%" + loose;

  // No Latin rule here, deliberately. An English verdict has to come from the text a player reads, and for
  // VX/VX Ace and archives that means running the Ruby extractor per game — a byte-level Latin share is
  // useless: a .rvdata2 file embeds whole Ruby scripts, so a Japanese game measures ~89 % Latin
  // (measured on one game, whose archive plays in Chinese). Byte counts answer the kana-vs-Han question
  // only, so only that question is asked here. The MV/MZ path below does measure the game's text.

  // The pristine copy is Chinese too: the game shipped Chinese (a 汉化组 release, or the folder claim).
  if (bakPct !== null && bakPct < CN_MAX) {
    return { State: "自带中文", Note: label + "，原版数据即中文（" + fig + "）", Evidence: evidence };
  }
  if (live.kanaPct < CN_MAX) {
    if (ours) return { State: "已汉化（本项目）", Note: label + "，" + fig, Evidence: evidence };
    return { State: "已是中文", Note: label + "，外置汉化（非本项目所译；" + fig + "）", Evidence: evidence };
  }
  // Japanese in the archive but Chinese in the loose files (or the reverse) is worth saying out loud:
  // the player sees whichever one the engine loads, and this tool can only edit what it can read.
  if (looseProf && looseProf.total > 20 && looseProf.kanaPct < CN_MAX && live.kanaPct >= JP_MIN) {
    return { State: "已是中文", Note: label + "，松散数据是中文而归档是日文（" + fig + "）", Evidence: evidence };
  }
  // "The data still equals the backup" is checked BEFORE the partial-coverage band: a game that was
  // translated and then restored (data identical to the pristine copy) is not "partially translated"
  // just because its kana share sits under the Japanese cut-off.
  if (bakPct !== null && live.kanaPct >= bakPct * 0.9 && ours) {
    return { State: "未汉化（已还原）", Note: label + "，数据与备份一致（" + fig + "）", Evidence: evidence };
  }
  if (live.kanaPct < JP_MIN && ours) return { State: "部分汉化", Note: label + "，" + fig, Evidence: evidence };
  if (live.kanaPct >= CN_MAX && live.kanaPct < JP_MIN && !ours) {
    return { State: "未汉化", Note: label + "，可能含外置汉化（MTool 等），本工具未处理（" + fig + "）", Evidence: evidence };
  }
  return { State: "未汉化", Note: label + "，" + fig, Evidence: evidence };
}

/** Is this folder an MV/MZ game whose app is packed into an executable ("boxed" build)? */
function packedAppExe(game) {
  // Only saves are left beside the exe: .rpgsave files are written by RPG Maker MV/MZ alone, so their
  // presence identifies the engine even when there is no data folder to read. The launcher itself is
  // whatever .exe is not a tool (measured: Game_boxed.exe, 1.0 GB, an Enigma Virtual Box container holding
  // the whole game — www/data, js/, img/, audio/ — inside).
  let hasSave = false;
  const save = subdir(game, "www/save");
  if (save) {
    try { hasSave = fs.readdirSync(save).some((f) => /\.rpgsave$/i.test(f)); } catch (e) { }
  }
  if (!hasSave) return null;
  let best = null, size = -1;
  try {
    for (const f of fs.readdirSync(game)) {
      if (!/\.exe$/i.test(f)) continue;
      if (/^(unins|vcredist|nw|node|ruby|mtool|一键|启动器)/i.test(f)) continue;
      const p = child(game, f);
      const st = fs.statSync(p);
      if (st.size > size) { size = st.size; best = f; }
    }
  } catch (e) { }
  return best ? { exe: best, size: size } : { exe: "(未找到 .exe)", size: 0 };
}

function classify(game) {  const loc = locate(game);
  if (!loc) {
    // Not "this is not an MV/MZ game" when the evidence says otherwise: an MV/MZ save folder beside a big
    // executable means the app is packed INTO that executable, and the honest answer is why we cannot read
    // it and what to do about it — not a bare 非 MV/MZ that reads like "wrong engine".
    const packed = packedAppExe(game);
    if (packed) {
      return {
        State: "未汉化（已打包）",
        Note: "MV/MZ 数据被打包进 " + packed.exe + "（" + (packed.size / 1048576).toFixed(0) +
          " MB，虚拟文件系统），本工具读不到里面的 www\\data，需先用解包工具把它还原成普通文件夹才能翻译",
        Evidence: { packedExe: packed.exe, packedSizeMB: Math.round(packed.size / 1048576) },
      };
    }
    return { State: "非 MV/MZ", Note: "无 JSON 数据，本工具不支持", Evidence: {} };
  }

  // Packed and VX/VX Ace games ARE supported (the pipeline unpacks the archive from its pristine copy
  // and repacks it; VX/VX Ace is driven through the portable Ruby), so "not supported / needs
  // unpacking" was simply untrue and made translated games look untouchable. Both are measured here
  // instead: the archive is unpacked to a scratch folder, and the kana/Han ratio of the data is read
  // straight from the bytes, which works for Marshal as well as JSON.
  if (loc.kind !== "json") {
    let held = loc.kind === "packed" ? packedProfile(game, loc.archive) : byteProfile(loc.live || "", RV_EXT);
    const bak = vxBackupProfile(game);
    const looseProf = loc.loose && loc.loose.live && loc.loose.live !== loc.live
      ? byteProfile(loc.loose.live, /\.(json|rvdata2?|rxdata)$/i) : null;
    // An archive we cannot open must not turn a readable game into "no text": fall back to the loose
    // data and say which one the figures come from.
    let viaArchive = true;
    if (!held && looseProf && looseProf.total > 20) { held = looseProf; viaArchive = false; }
    return verdictFromBytes(game, held, bak, loc.kind, loc.archive, viaArchive ? looseProf : null, viaArchive);
  }

  const live = profile(loc.live);
  const backup = findBackup(game);
  const bakProfile = backup ? profile(backup) : null;
  const dialogue = dialogueCounts(loc.live, backup);
  const t2f = text2frameCounts(game, loc.live);
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
  // The 自带/外置 verdicts need the share of ALL Japanese-looking characters, not the share inside the
  // strings the extractor would translate: 露出女子校生2 是御光盟国汉化组的汉化版，它的对白全是中文，
  // 只有道具/技能名还是日文 —— 按"可译字符串"算是 36.6% 假名（看着像没翻），按全部字符算只有 5%
  // （正确反映"游戏本身是中文的"）。
  const liveBytes = byteProfile(loc.live, JSON_EXT);
  const bakBytesDirs = backup ? byteProfile(backup, JSON_EXT) : null;
  // CJK_MIN, not 20: see the "noise" note above. A ratio computed from 22 characters is not a measurement,
  // and both the 自带中文 verdict and its refutation are ratios.
  const liveBytePct = liveBytes && liveBytes.total >= CJK_MIN ? liveBytes.kanaPct : null;
  const bakBytePct = bakBytesDirs && bakBytesDirs.total >= CJK_MIN ? bakBytesDirs.kanaPct : null;
  // The language of the game as the player sees it: over the strings the extractor would translate, not over
  // the folder's bytes (which are mostly keys and structure — see textProfile).
  const text = textProfile(loc.live);
  const evidence = {
    liveStrings: live ? live.total : 0, liveKanaPct: +liveKanaPct.toFixed(1),
    backup: !!backup, backupStrings: bakProfile ? bakProfile.total : 0, backupKanaPct: +bakKanaPct.toFixed(1),
    dialogue, text2frame: t2f, locales, dataDiff, installedByUs: installed,
    textStrings: text ? text.strings : 0,
    textKanaPct: text ? +text.kanaPct.toFixed(1) : null,
    textLatinPct: text ? +text.latinPct.toFixed(1) : null,
  };

  if (!live || live.total < 20) {
    // Not 无文本 if the game's text is Latin: "too little text" would be a lie about a game with 13,900
    // English dialogue lines in it. (The profile above only counts scalar string fields, so it can be blind
    // to dialogue that lives in arrays — which is where MV keeps it.)
    if (!isLatinText(text)) return { State: "无文本", Note: "可译文本太少", Evidence: evidence };
  }

  // A Chinese release ships Chinese in its own locale folder while ja-JP stays Japanese, so that is
  // checked before anything is said about the ja-JP text.
  const zhLocale = locales.find((l) => /^(zh|cn|chs|cht|zh-cn|zh-hans|zh-hant|sc|tc)/i.test(l.locale) && l.hanOnly > l.kana);
  // Our own passes write Chinese into ja-JP itself.
  const jaLocale = locales.find((l) => /^ja/i.test(l.locale));
  const jaIsChinese = jaLocale && jaLocale.strings > 20 && jaLocale.kana < jaLocale.strings * 0.1;

  // Whose work it is: a pristine backup we made, or a cache/report we left. The 一键还原汉化前.bat
  // scripts do NOT count — those ship with other people's 汉化 releases (御光盟国汉化组 ships one), so
  // counting them credited their work to this project.
  const ours = !!backup || ourArtifacts(game);

  // An English (or other Latin-script) release. This is the redesign: the branches below both judge
  // "Chinese" from a kana-vs-Han ratio, and on a game written in Latin letters that ratio compares a
  // minority against the rest and lands anywhere — measured on Detective Girl of the Steam City, 32.8 %
  // (under CN_MAX 35), which declared the pristine copy Chinese and made the window skip a game whose
  // 13,900 dialogue lines were all English. The measure is the game's own text (textProfile), and the check
  // sits after the locale folder — direct evidence of a Chinese release — and before every ratio verdict.
  if (isLatinText(text)) {
    return { State: "未汉化（英文原版）", Note: "原版是英文（可译文本的字母里拉丁占 " + text.latinPct.toFixed(1) +
      "%，" + text.latin + " 个字母，共 " + text.strings + " 条文本；假名占比 " + text.kanaPct.toFixed(1) +
      "% 只是 CJK 内部比例）" + (ours ? "，本工具曾处理过" : ""), Evidence: evidence };
  }
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

  // The message text of a Text2Frame game is part of what the player reads, so it caps the verdict:
  // whatever share of that script is still Japanese is untranslated text, and reporting the data
  // figure alone would call such a game finished. The weaker of the two measures wins.
  let t2fNote = "";
  if (t2f.kanaLive > 0) {
    const textCov = t2f.kanaPristine > 0 ? 1 - t2f.kanaLive / t2f.kanaPristine : 0;
    coverage = coverage === null ? textCov : Math.min(coverage, textCov);
    fromDialogue = false;
    t2fNote = "（text/*.txt 还有 " + t2f.kanaLive + " 行日文，共 " + t2f.lines + " 行）";
  }

  // Every verdict carries the gap in the message script, so it is never hidden by a good data figure.
  const note = (s) => s + t2fNote;

  if (zhLocale && !jaIsChinese) {
    return { State: "自带中文", Note: note("resources/" + zhLocale.locale + "（" + zhLocale.hanOnly + " 串中文）"), Evidence: evidence };
  }
  // The pristine copy is Chinese too: the game arrived translated (a 汉化 release, or the folder's
  // own claim), so nothing here was translated by this project and nothing needs translating.
  // Measured over ALL characters, not over the strings the extractor targets — see liveBytes above.
  if (bakBytePct !== null && bakBytePct < CN_MAX) {
    return { State: "自带中文", Note: note("原版数据即中文（假名占比 " + bakBytePct.toFixed(1) + "% → " + (liveBytePct === null ? "?" : liveBytePct.toFixed(1)) + "%）"
      + (installed ? "，含其他汉化组的还原脚本" : "")), Evidence: evidence };
  }
  // Chinese in the data, Japanese in the original, and none of our artifacts: someone else's work —
  // an external translation (MTool etc.) or a 汉化 patch applied before this tool ever saw the game.
  // The state name stays exactly 已是中文 because the window skips those games (Skip = 已是中文/自带中文);
  // "外置汉化" belongs in the note, not in the name.
  if (liveBytePct !== null && liveBytePct < CN_MAX && !ours && !backup) {
    return { State: "已是中文", Note: note("外置汉化（非本项目所译；假名占比 " + liveBytePct.toFixed(1) + "%）"
      + (installed ? "，含汉化组的还原脚本" : "")), Evidence: evidence };
  }
  if (coverage !== null && coverage >= 0.9) {
    // Whose work it is needs evidence, not just coverage: a game whose data is Chinese but which has
    // neither a pristine backup nor our install scripts was already Chinese when it arrived. Without
    // this check every such game was credited to this project (金色complex 慰安騎士 is one: the
    // pipeline itself skips it as 已是中文).
    if (ours) return { State: "已汉化（本项目）", Note: note(noteFrom(coverage, fromDialogue)), Evidence: evidence };
    return { State: "已是中文", Note: note(noteFrom(coverage, fromDialogue)), Evidence: evidence };
  }
  if (coverage !== null && coverage >= 0.3) return { State: "部分汉化", Note: note(noteFrom(coverage, fromDialogue)), Evidence: evidence };
  // Little or no Chinese found: with a pristine original present, a translation existed here and was
  // uninstalled — the backup and the pipeline's cache still hold the work.
  //
  // A folder that claims to be an official Chinese release while its data still measures Japanese is
  // reported as such rather than silently believed or silently dismissed: the name is a claim, the
  // data is evidence, and the two disagreeing is worth seeing.
  const mismatch = official ? "（目录名标着官方中文，但数据仍是日文）" : "";
  // Some work exists but it is not yet most of the text: call that 部分汉化 rather than "untouched",
  // because the difference decides whether translating it again is a small job or a full one. A single
  // translated string is enough evidence: the measure is already scoped to what the extractor targets,
  // so a non-zero figure means a real pass ran here — and a game whose data is done while its message
  // script is not (measured on one game: 17 of 17 data strings, 0 of 67 message lines) must not read
  // as "restored".
  const pct = Math.round(coverage * 100);
  if (dataDiff && dataDiff.translated >= 1) {
    return { State: "部分汉化", Note: note((pct >= 1 ? "已译 " + pct + "%" : "已译 " + dataDiff.translated + " 串") + mismatch), Evidence: evidence };
  }
  if (backup) return { State: "未汉化（已还原）", Note: note("有原版备份与缓存，可快速重译" + mismatch), Evidence: evidence };
  return { State: "未汉化", Note: note(mismatch), Evidence: evidence };
}

// The measurement and the verdicts are exported so they can be tested on synthetic data
// (tools/unit-game-state.js) — the whole point of the redesign is a judgement about language, and that has
// to be checkable without a library of games on disk. The CLI below only runs when this file IS the entry
// point, so requiring it in a test does not start a scan of a whole library.
module.exports = { classify, byteProfile, textProfile, isLatinText, verdictFromBytes, locate, findBackup, CN_MAX, JP_MIN, LATIN_TEXT_PCT, CJK_MIN };

// --- which games -------------------------------------------------------------------------
if (require.main === module) {
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
    // No root given: scan the current directory. The window always passes --cache or --roots, so this is
    // only the command-line default, and defaulting to a fixed drive would tie the tool to one machine.
    if (!roots.length) roots = [process.cwd()];
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
}
