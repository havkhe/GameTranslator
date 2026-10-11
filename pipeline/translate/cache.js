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
  return "";
}

function makeCache(file) {
  const byText = Object.create(null);
  let loadedFromDisk = 0;
  let purgedEcho = 0;
  let purgedDegenerate = 0;
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
          if (why === "echo") purgedEcho++; else purgedDegenerate++;
        }
        loadedFromDisk = Object.keys(byText).length;
      }
    } catch (e) {
      console.log("CACHE_UNREADABLE", e.message);
    }
    if (purgedEcho) console.log("CACHE_PURGED_ECHO", purgedEcho);
    if (purgedDegenerate) console.log("CACHE_PURGED_DEGENERATE", purgedDegenerate);
  }

  return {
    byText,
    get size() { return Object.keys(byText).length; },
    get loaded() { return loadedFromDisk; },
    get purgedEcho() { return purgedEcho; },
    get purgedDegenerate() { return purgedDegenerate; },
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
