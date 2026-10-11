// Translation cache with overwrite protection.
//
// The cache maps normalized source text to its Chinese translation. It is what makes
// a re-run cheap and what feeds the patch step.
//
// Protection added in v3 (the v2 defect it fixes): saving used to overwrite the file
// unconditionally, so a run that failed to load the previous cache wrote a nearly
// empty one. Measured: a game's cache went from 5945 entries to 112 with no error
// anywhere, and the work behind those entries had to be redone. A save that would
// shrink the stored set drastically is now refused and reported.
"use strict";
const fs = require("fs");
const { promptEchoMatches, degenerationMatches } = require("./quality.js");

const SHRINK_GUARD = parseFloat(process.env.GT_CACHE_SHRINK_GUARD || "0.5");

const normText = (s) => String(s).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/^\s+|\s+$/g, "");

/** Is a stored value unfit to keep? */
function badValue(value, source) {
  if (promptEchoMatches(value, source)) return "echo";
  if (degenerationMatches(value)) return "degenerate";
  // Identical to the source is not a translation: it changes nothing on disk, yet it counts as a
  // replacement in the patch report and hides the string from every later run. Measured on one batch of
  // five games: 202 / 71 / 5 / 83 / 59 stored values were identical to their source, and one game's patch
  // report read "replaced 8, files 0" — the replacements were all no-ops. The quality gate rejects these
  // as `unchanged`; this is the same refusal at the one place a bad value would survive across runs.
  if (String(value) === String(source)) return "identity";
  // The control codes must be the same multiset as the source's, which is what the quality gate's
  // rules 1 and 6b require before a value is ever cached. Re-checked here because a cache file that
  // already holds a mismatch is never re-validated, and the mismatch is the signature of a value that
  // belongs to a DIFFERENT source: one game's stored "「\n[2]さん、油断はだめですよ。" came back as
  // "“\n[3]さん，不要掉以轻心哦。" — a correct translation of some other line, written onto this one.
  // 363 of that game's 2555 pairs were of that kind, and the patch step had already put them in the
  // game. Dropping them at load makes the next run re-translate those sources instead of keeping text
  // that was meant for a different line.
  if (!codesAgree(value, source)) return "codes";
  return "";
}

/** Same backslash sequences, same counts — the comparison rules 1 and 6b make at the gate. */
function codesAgree(value, source) {
  const tokenize = (x) => {
    const out = Object.create(null);
    for (const c of String(x).match(/\\[A-Za-z]?[\[<][^\]>]{0,16}[\]>]|\\./g) || []) out[c] = (out[c] || 0) + 1;
    return out;
  };
  const a = tokenize(source), b = tokenize(value);
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

function makeCache(file) {
  const byText = Object.create(null);
  let loadedFromDisk = 0;
  let purgedEcho = 0;
  let purgedDegenerate = 0;
  let purgedCodes = 0;
  let purgedIdentity = 0;
  const refused = [];              // values set() refused; kept for the report, not written

  if (file && fs.existsSync(file)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (raw && raw.byText && typeof raw.byText === "object") {
        for (const k of Object.keys(raw.byText)) {
          if (typeof raw.byText[k] === "string") byText[k] = raw.byText[k];
        }
        // Drop stored values unfit to keep rather than trusting them.
        //
        // An instruction echo is worse than a missing entry: the patch step writes it into the game
        // (measured: the load-menu label became "每行输出一条译文，不要编号、不要JSON、"), and
        // because has() then reports the text as cached, no later run ever replaces it. A value from
        // the degeneration cycle is the same story with worse text: 85 player-visible strings of one
        // game held word salad, including every skill description. Removing them at load makes the
        // next run re-translate those sources and lets lookup() fall back to the original text.
        for (const k of Object.keys(byText)) {
          const why = badValue(byText[k], k);
          if (!why) continue;
          delete byText[k];
          if (why === "echo") purgedEcho++;
          else if (why === "degenerate") purgedDegenerate++;
          else if (why === "identity") purgedIdentity++;
          else purgedCodes++;
        }
        loadedFromDisk = Object.keys(byText).length;
      }
    } catch (e) {
      console.log("CACHE_UNREADABLE", e.message);
    }
    if (purgedEcho) console.log("CACHE_PURGED_ECHO", purgedEcho);
    if (purgedDegenerate) console.log("CACHE_PURGED_DEGENERATE", purgedDegenerate);
    if (purgedCodes) console.log("CACHE_PURGED_CODES", purgedCodes, "（译文与原文的控制代码不一致，视为串行写入，已丢弃待重译）");
    if (purgedIdentity) console.log("CACHE_PURGED_IDENTITY", purgedIdentity, "（译文与原文完全相同，等于没有翻译，已丢弃待重译）");
  }

  return {
    byText,
    get size() { return Object.keys(byText).length; },
    get loaded() { return loadedFromDisk; },
    get purgedEcho() { return purgedEcho; },
    get purgedDegenerate() { return purgedDegenerate; },
    get purgedCodes() { return purgedCodes; },
    get purgedIdentity() { return purgedIdentity; },
    get refused() { return refused.length; },
    has(text) { return typeof byText[normText(text)] === "string"; },
    lookup(text) { return byText[normText(text)]; },
    set(text, value) {
      // Defence in depth: a value that passed the quality gate cannot be unfit, but the cache is
      // the one place a bad value would persist across runs, so it refuses one outright.
      const why = badValue(value, text);
      if (why) { refused.push(why); return false; }
      byText[normText(text)] = value;
      return true;
    },
    remove(text) { delete byText[normText(text)]; },
    save() {
      if (!file) return true;
      const now = Object.keys(byText).length;
      // Refuse a save that throws away most of what the file already holds: that
      // only happens when the previous content was not loaded (a read error, a
      // changed work directory, or a fresh process racing another one).
      if (loadedFromDisk >= 50 && now < loadedFromDisk * SHRINK_GUARD) {
        console.log("CACHE_SAVE_REFUSED 现有文件有 " + loadedFromDisk + " 条，本次只有 " + now +
          " 条（不足一半），已拒绝覆盖以免丢失进度。请检查是否有另一个翻译进程正在运行。");
        return false;
      }
      fs.writeFileSync(file, JSON.stringify({ version: 3, byText }, null, 0), "utf8");
      return true;
    },
  };
}

module.exports = { makeCache, normText, SHRINK_GUARD };
