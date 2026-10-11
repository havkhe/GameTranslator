// Import a translation map that MTool already produced, instead of translating the same text again.
//
// MTool keeps its translations in TrsData.bin, which is obfuscated — but the same data is plain JSON in
// two forms it reads and writes itself:
//
//   ManualTransFile.json                  the export for outside translators: source -> "" (to translate)
//   A翻译.json / AI翻译文件.json           a loaded translation file: source -> Chinese
//
// and MTool records which one is in use in `lastLoadedTrsFile`. Measured on one library game,
// A翻译.json holds 28,917 pairs, 27,296 of which this project would translate. Those are translations
// already paid for; this module puts them into the project's cache so the patch step can apply them.
//
// An imported value goes through the cache's own guards, so an instruction echo, word salad, or a value
// whose control codes do not match its source is refused exactly as if the model had produced it.
//
// Usage:
//   node tools/import-mtool.js <gameDir> [--file <name.json>] [--work <dir>] [--apply] [--top N]
//
// Without --apply nothing is written; the summary still reports what would be imported.
"use strict";
const fs = require("fs");
const path = require("path");
const { makeCache } = require("../pipeline/translate/cache.js");
const { isTranslatable } = require("../pipeline/extract/rules.js");

const NAME_RE = /^[^\\/:*?"<>|]{1,160}$/;
/** One directory entry appended to a directory, asserted to stay inside it. */
function child(root, name) {
  if (typeof name !== "string" || !NAME_RE.test(name) || name === "." || name === "..") throw new Error("refusing unsafe name: " + JSON.stringify(name));
  const base = path.resolve(root);
  const t = path.resolve(base, name);
  if (t !== base && !t.startsWith(base + path.sep)) throw new Error("outside root: " + name);
  return t;
}
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } };

const KANA = /[\u3040-\u309f\u30a0-\u30ff\uff66-\uff9f]/;
const HAN = /[\u3400-\u9fff]/;

/** The cache file name the pipeline would use for this game, so an import lands where a run looks. */
const sanitize = (name) => name.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_").slice(0, 60);

/** Pick the work directory: the caller's, or the one beside this script (the install layout). */
function defaultWork(explicit) {
  if (explicit) return path.resolve(explicit);
  const beside = path.resolve(__dirname, "..", "work");
  return isDir(beside) ? beside : null;
}

/** Candidate maps: a named file, or every root-level JSON big enough to be one. */
function candidateFiles(game, fileArg) {
  if (fileArg) return [child(game, fileArg)];
  const out = [];
  let ents;
  try { ents = fs.readdirSync(game, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of ents) {
    if (e.isDirectory() || !/\.json$/i.test(e.name)) continue;
    const p = child(game, e.name);
    let st;
    try { st = fs.statSync(p); } catch (err) { continue; }
    if (st.size < 2000 || st.size > 60 * 1048576) continue;
    out.push(p);
  }
  return out;
}

/**
 * Merge every readable MTool translation map in a game into that game's cache.
 *
 * @param {object} o
 * @param {string} o.game     the game folder
 * @param {string} [o.work]   the work directory holding the caches
 * @param {string} [o.file]   import only this JSON instead of scanning
 * @param {boolean} [o.apply] write the cache (otherwise a dry run)
 * @param {number} [o.top]    how many sample pairs to return
 * @returns {object} counts, the cache path, and sample pairs
 */
function importFromGame(o) {
  const game = path.resolve(o.game);
  const work = defaultWork(o.work);
  if (!work) throw new Error("找不到 work 目录：请用 --work <dir> 指定管线的工作目录");
  const cacheFile = path.resolve(work, sanitize(path.basename(game)) + "-translations.json");
  if (!cacheFile.startsWith(work + path.sep)) throw new Error("refusing cache path outside the work dir");

  const files = candidateFiles(game, o.file);
  const cache = makeCache(cacheFile);
  const stats = {
    game, work, cacheFile, files: files.map((f) => path.basename(f)),
    loadedFromCache: cache.size, purgedEcho: cache.purgedEcho, purgedDegenerate: cache.purgedDegenerate, purgedCodes: cache.purgedCodes,
    readPairs: 0, skippedNotText: 0, skippedNoKana: 0, skippedValue: 0, already: 0, added: 0, refused: 0,
    perFile: [], samples: [], applied: false, saved: false, cacheSize: cache.size,
  };
  for (const p of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { continue; }
    if (!j || typeof j !== "object" || Array.isArray(j)) continue;
    const keys = Object.keys(j);
    if (keys.length < 200) continue;
    let used = 0;
    for (const k of keys) {
      const v = j[k];
      if (typeof v !== "string" || !v) continue;
      stats.readPairs++;
      // Keep only what this project would translate: the source must pass the extractor's own
      // predicate (so ids, numbers, filenames and resource names never enter), it must carry kana, and
      // the value must be Chinese rather than a copy of the source or another kana line.
      if (!isTranslatable(k)) { stats.skippedNotText++; continue; }
      if (!KANA.test(k)) { stats.skippedNoKana++; continue; }
      if (v === k || !HAN.test(v) || KANA.test(v)) { stats.skippedValue++; continue; }
      if (cache.has(k)) { stats.already++; continue; }
      if (cache.set(k, v)) {
        stats.added++; used++;
        if (stats.samples.length < (o.top || 10)) stats.samples.push([k, v]);
      } else stats.refused++;
    }
    stats.perFile.push({ file: path.basename(p), keys: keys.length, used });
  }
  if (o.apply && stats.added) {
    // Keep a copy of the cache before overwriting it, so an import can be undone.
    try {
      const bak = cacheFile + ".bak-import";
      if (fs.existsSync(cacheFile) && !fs.existsSync(bak)) fs.copyFileSync(cacheFile, bak);
      stats.backup = fs.existsSync(bak) ? bak : null;
    } catch (e) { stats.backupError = e.message; }
    stats.applied = true;
    stats.saved = cache.save();
  }
  stats.cacheSize = cache.size;
  return stats;
}

module.exports = { importFromGame, sanitize };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opts = { apply: false, top: 10 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--file") opts.file = argv[++i] || "";
    else if (argv[i] === "--work") opts.work = argv[++i] || "";
    else if (argv[i] === "--top") opts.top = parseInt(argv[++i], 10) || 10;
    else if (argv[i] === "--apply") opts.apply = true;
    else if (!argv[i].startsWith("--")) { if (!opts.game) opts.game = argv[i]; }
  }
  if (!opts.game) {
    console.log("USAGE: node tools/import-mtool.js <gameDir> [--file <name.json>] [--work <dir>] [--apply] [--top N]");
    process.exit(2);
  }
  let s;
  try { s = importFromGame(opts); } catch (e) { console.log(String(e.message || e)); process.exit(1); }
  console.log("游戏   " + s.game);
  console.log("工作   " + s.work);
  console.log("缓存   " + s.cacheFile);
  console.log("");
  console.log("缓存现有 " + s.loadedFromCache + " 条（加载时清除 echo " + s.purgedEcho + " / 退化 " + s.purgedDegenerate + " / 代码不符 " + s.purgedCodes + "）");
  console.log("");
  for (const f of s.perFile) console.log("  " + f.file + "  键 " + f.keys + "  本次采用 " + f.used);
  console.log("");
  console.log("读到的对照       " + s.readPairs);
  console.log("排除·非文本串     " + s.skippedNotText + "  （数字 id、文件名、资源名、配置值等）");
  console.log("排除·原文无假名   " + s.skippedNoKana);
  console.log("排除·译文不合格   " + s.skippedValue + "  （与原文相同 / 无中文 / 仍含假名）");
  console.log("缓存已有          " + s.already);
  console.log("新增              " + s.added);
  console.log("被缓存规则拒收    " + s.refused + "  （指令回显 / 退化 / 控制代码不符）");
  console.log("");
  if (s.samples.length) {
    console.log("样本：");
    for (const [k, v] of s.samples) console.log("  " + JSON.stringify(k.slice(0, 40)) + "  ->  " + JSON.stringify(v.slice(0, 40)));
    console.log("");
  }
  if (!s.applied) console.log("dry run：加 --apply 才写入缓存。");
  else if (!s.saved) console.log("没有新增，缓存未改动。");
  else console.log("已写入 " + s.cacheFile + "  共 " + s.cacheSize + " 条" + (s.backup ? "（原缓存备份为 " + path.basename(s.backup) + "）" : ""));
}
