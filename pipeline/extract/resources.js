// Localization resource files: the actual dialogue of games that use a text plugin.
//
// Games built with a localization plugin (this one uses "AdvExtention") do not put dialogue in
// event commands. The event stores only a resource label —
//     357 AdvExtention / message / 文章の表示    →  リソースラベル = Hiroka_Prologue_000
// — and the text lives in data/resources/<locale>/<Name>.json, keyed by that label:
//     { "Hiroka_Prologue_000": "SQ商業特区、チェストウッドブリッジより速報です！…" }
//
// Measured on 凍堂ヒロカの隷雄譚: 5797 strings in 29 files, 5550 of them Japanese. The event data
// holds only 9 dialogue lines, so without this module almost the whole game goes untranslated —
// which is exactly what happened: the data was patched and the game still read as Japanese.
//
// Only the ja-JP files are touched. en-US holds the same keys in English and is used when the game
// runs in English; translating it would replace that translation with ours.
"use strict";
const fs = require("fs");
const path = require("path");
const R = require("./rules.js");

/**
 * Locale folder holding the Japanese source text.
 *
 * One name only: Windows paths are case-insensitive, so listing variants ("ja-JP", "ja-jp",
 * "Ja-JP") resolves to the same folder each time and multiplies the reported file count. The
 * filesystem already matches the real name whatever its case, so no variant list is needed.
 */
const SOURCE_LOCALES = ["ja-JP"];

/** Keys that describe the file rather than hold dialogue. */
const META_KEYS = new Set(["metadata", "version", "language", "game", "locale", "name"]);

function isChineseLike(s) {
  const t = String(s);
  if (/[\u3040-\u309f\u30a0-\u30ff]/.test(t)) return false;
  const han = (t.match(/[\u3400-\u9fff]/g) || []).length;
  return han >= 2 && han * 2 >= t.replace(/\s/g, "").length;
}

/** Every <resources>/<source locale>/*.json under a data folder. */
function dialogueFiles(dataDir) {
  const out = [];
  const seen = new Set();
  for (const res of ["resources", "Resources"]) {
    const root = path.join(dataDir, res);
    if (!fs.existsSync(root)) continue;
    for (const loc of SOURCE_LOCALES) {
      const dir = path.join(root, loc);
      if (!fs.existsSync(dir)) continue;
      // On Windows the filesystem is case-insensitive, so pairing "resources" with "Resources", or
      // "ja-JP" with "ja-jp", finds the same files twice. Deduplicating by resolved path keeps the
      // reported file count honest (an earlier run reported 240 files for a game with 30).
      let key;
      try { key = fs.realpathSync(dir).toLowerCase(); } catch (e) { key = dir.toLowerCase(); }
      if (seen.has(key)) continue;
      seen.add(key);
      for (const f of fs.readdirSync(dir)) {
        if (!f.toLowerCase().endsWith(".json")) continue;
        out.push({ full: path.join(dir, f), rel: res + "/" + loc + "/" + f, locale: loc });
      }
    }
  }
  return out;
}

/**
 * Extract dialogue from the localization files.
 *
 * @param {string} pristineData  data folder to read (the backup when there is one)
 * @param {string} liveData      data folder the game runs from
 */
function extract(pristineData, liveData) {
  const entries = [];
  const seen = new Set();
  let skipped = 0, filtered = 0, files = 0;

  const read = (dataDir, skipTranslated) => {
    if (!dataDir || !fs.existsSync(dataDir)) return;
    for (const f of dialogueFiles(dataDir)) {
      files++;
      let data;
      try { data = JSON.parse(fs.readFileSync(f.full, "utf8")); } catch (e) { continue; }
      for (const [key, value] of Object.entries(data)) {
        if (META_KEYS.has(key)) continue;
        if (typeof value !== "string") continue;
        // One prompt line per entry, so embedded breaks become spaces.
        const t = String(value).replace(/\r\n|\n|\r/g, " ");
        if (!R.isTranslatable(t)) { filtered++; continue; }
        // A file whose text is already Chinese means a previous localization pass; skipping it
        // is what stops the model being asked to translate Chinese into Chinese.
        if (skipTranslated && isChineseLike(t)) { skipped++; continue; }
        if (seen.has(t)) continue;
        seen.add(t);
        entries.push({ id: entries.length, file: f.rel, path: "$." + key, text: t });
      }
    }
  };

  read(pristineData, false);
  if (liveData && path.resolve(liveData) !== path.resolve(pristineData)) read(liveData, true);
  return { entries, skipped, filtered, files };
}

/**
 * Write translations back into the localization files.
 *
 * Keyed by the source text, like the rest of the pipeline: the cache maps Japanese source to
 * Chinese, and this finds every key whose value has a translation. Written into the LIVE data
 * folder, because that is what the game loads.
 */
function patch(liveData, cache, reportFile) {
  let replaced = 0, missing = 0;
  const files = [];
  for (const f of dialogueFiles(liveData)) {
    let data;
    const raw = fs.readFileSync(f.full, "utf8");
    try { data = JSON.parse(raw); } catch (e) { continue; }
    let changed = 0;
    for (const [key, value] of Object.entries(data)) {
      if (META_KEYS.has(key) || typeof value !== "string" || !value.trim()) continue;
      const tr = cache.lookup(value);
      if (typeof tr === "string") {
        data[key] = tr;
        replaced++; changed++;
      } else if (R.isTranslatable(value)) missing++;
    }
    if (changed) {
      // Keep the file's own formatting: these are pretty-printed with 4 spaces, and matching that
      // keeps a diff readable if one is ever taken.
      const indent = /\n\s{4}"/.test(raw) ? 4 : (/\n\s{2}"/.test(raw) ? 2 : 0);
      fs.writeFileSync(f.full, JSON.stringify(data, null, indent), "utf8");
      files.push(f.rel + " (" + changed + ")");
    }
  }
  const report = { engine: "resources", replaced, missing, files: files.length };
  if (reportFile) {
    try { fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), "utf8"); } catch (e) { }
  }
  return report;
}

module.exports = { extract, patch, dialogueFiles, isChineseLike, META_KEYS };
