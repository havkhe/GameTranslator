// MV / MZ patch: write the translations back into the live data files.
//
// Symmetry with extraction is the property that matters here. The patcher walks the
// same nodes the extractor collected, using the same tables from rules.js, so it can
// only ever replace text that was queued for translation. In particular it does not
// touch resource-name fields (characterName, faceName, battlerName, audio name) or
// `note`, which plugins parse as metadata — translating those breaks the game, and
// the damage is not obvious until the plugin misbehaves.
//
// The lookup is by NORMALISED text, because the cache keys are normalised (line
// endings unified). Looking up the raw file text directly missed every entry whose
// text contained CRLF, which is the same mismatch that made multi-line entries appear
// uncached.
"use strict";
const fs = require("fs");
const path = require("path");
const R = require("../extract/rules.js");
const { normText, listJsonFiles } = require("../extract/mv.js");

/**
 * @param {string} liveDir  the folder to rewrite (the game's own data dir)
 * @param {object} cache    from translate/cache.js
 * @param {string} reportFile  where to write the JSON report
 */
function patch(liveDir, cache, reportFile) {
  let replaced = 0;
  let missing = 0;
  const errors = [];
  const fileStats = [];

  // Translation for a piece of file text, or the original when we have none.
  const swap = (text) => {
    if (typeof text !== "string") return text;
    const tr = cache.lookup(text);
    if (typeof tr === "string") { replaced++; return tr; }
    if (R.isTranslatable(text)) missing++;
    return text;
  };

  const patchEventList = (list) => {
    if (!Array.isArray(list)) return;
    for (const cmd of list) {
      if (!cmd || typeof cmd !== "object" || !Array.isArray(cmd.parameters)) continue;
      const params = cmd.parameters;
      const slots = R.EVENT_TEXT_CODES.get(cmd.code);
      if (!slots) continue;
      for (const slot of slots) {
        const v = params[slot];
        if (typeof v === "string") params[slot] = swap(v);
        else if (Array.isArray(v)) params[slot] = v.map((x) => swap(x));
      }
    }
  };

  const walk = (node) => {
    if (Array.isArray(node)) {
      if (node.length && node[0] && typeof node[0] === "object" && typeof node[0].code === "number") {
        patchEventList(node);
        return;
      }
      node.forEach(walk);
      return;
    }
    if (node && typeof node === "object") {
      if (Array.isArray(node.list) && node.list.length && node.list[0] && typeof node.list[0].code === "number") {
        patchEventList(node.list);
      }
      for (const k of Object.keys(node)) {
        if (R.META_KEYS.has(k)) continue;
        const v = node[k];
        if (typeof v === "string") {
          if (R.TEXT_FIELDS.has(k)) node[k] = swap(v);
        } else walk(v);
      }
      return;
    }
  };

  for (const f of listJsonFiles(liveDir)) {
    let data;
    const raw = fs.readFileSync(f.full, "utf8");
    try { data = JSON.parse(raw); } catch (e) {
      errors.push({ file: f.rel, err: "parse: " + e.message });
      continue;
    }
    const before = JSON.stringify(data);
    const base = path.basename(f.rel).toLowerCase();
    if (base === "system.json" && data && data.terms && typeof data.terms === "object") {
      for (const k of Object.keys(data.terms)) {
        if (!R.TERMS_KEYS.includes(k)) continue;
        const arr = data.terms[k];
        if (Array.isArray(arr)) data.terms[k] = arr.map((x) => swap(x));
      }
    }
    walk(data);
    const after = JSON.stringify(data);
    if (after !== before) {
      // Keep the original formatting (indentation) so the file still looks edit-made
      // by the game's own tooling; RPG Maker writes pretty-printed JSON.
      const indent = /\n\s+"/.test(raw) ? 2 : 0;
      fs.writeFileSync(f.full, JSON.stringify(data, null, indent), "utf8");
      fileStats.push({ file: f.rel, changed: true });
    }
  }

  const report = { engine: "MV", replaced, missing, files: fileStats.length, errors };
  if (reportFile) {
    try { fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), "utf8"); } catch (e) {}
  }
  return report;
}

module.exports = { patch };
