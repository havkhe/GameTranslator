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

const SHRINK_GUARD = parseFloat(process.env.GT_CACHE_SHRINK_GUARD || "0.5");

const normText = (s) => String(s).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/^\s+|\s+$/g, "");

function makeCache(file) {
  const byText = Object.create(null);
  let loadedFromDisk = 0;

  if (file && fs.existsSync(file)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (raw && raw.byText && typeof raw.byText === "object") {
        for (const k of Object.keys(raw.byText)) {
          if (typeof raw.byText[k] === "string") byText[k] = raw.byText[k];
        }
        loadedFromDisk = Object.keys(byText).length;
      }
    } catch (e) {
      console.log("CACHE_UNREADABLE", e.message);
    }
  }

  return {
    byText,
    get size() { return Object.keys(byText).length; },
    get loaded() { return loadedFromDisk; },
    has(text) { return typeof byText[normText(text)] === "string"; },
    lookup(text) { return byText[normText(text)]; },
    set(text, value) { byText[normText(text)] = value; },
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
