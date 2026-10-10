// MV / MZ extraction.
//
// Source of truth is the pristine backup when one exists: once a game is translated
// its live files hold Chinese, so re-reading them would miss the cache and ask the
// model to translate Chinese into Chinese (the failure that produced 9841
// request-failed records in the old pipeline). The live folder is still scanned for
// content a game update added, with already-translated text skipped.
"use strict";
const fs = require("fs");
const path = require("path");
const R = require("./rules.js");

const normText = (s) => String(s).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/^\s+|\s+$/g, "");

/** Refuse to queue text that is already Chinese (kanji-dominant, no kana). */
function isChineseLike(s) {
  const t = String(s);
  if (R.KANA_RE.test(t)) return false;
  const han = (t.match(/[\u3400-\u9fff]/g) || []).length;
  return han >= 2 && han * 2 >= t.replace(/\s/g, "").length;
}

/**
 * Language statistics for a data folder, used to decide whether it is safe to snapshot.
 *
 * `chineseLike` asks whether the translatable text is mostly already Chinese. It only counts strings
 * that would be extracted in the first place (kana or kanji, not numbers or file paths), and requires
 * a clear majority so that a Japanese game with a handful of Chinese-looking labels is not mistaken
 * for a translated one.
 */
function languageProfile(dir) {
  let total = 0, kana = 0, chinese = 0, other = 0;
  const consider = (s) => {
    if (typeof s !== "string") return;
    const t = s.trim();
    if (!t || t.length < 2) return;
    // Ignore things that are not natural language: paths, keys, single Latin words.
    if (/^[A-Za-z0-9_\-./\\ ]+$/.test(t)) return;
    total++;
    if (R.KANA_RE.test(t)) kana++;
    else if (/[\u3400-\u9fff]/.test(t)) { if (isChineseLike(t)) chinese++; else other++; }
  };

  const walk = (o) => {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (!o || typeof o !== "object") return;
    for (const k of Object.keys(o)) {
      if (k === "note") continue;
      const v = o[k];
      if (typeof v === "string") consider(v);
      else walk(v);
    }
  };

  for (const f of listJsonFiles(dir)) {
    try { walk(JSON.parse(fs.readFileSync(f.full, "utf8"))); } catch (e) { }
  }
  return { total, kana, chinese, other, chineseLike: total > 0 && chinese / total > 0.5 };
}

function listJsonFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) { if (!isIgnoredDir(e.name)) walk(p, r); }
      else if (/\.json$/i.test(e.name)) out.push({ full: p, rel: r });
    }
  };
  walk(root, "");
  return out;
}

// Backup folders and editor leftovers: translating them would duplicate work or
// resurrect an older translation.
const IGNORE_DIR_RE = /(バックアップ|バツクアツプ|予備|退避|备份|備份|存档|存檔|_bak$|^bak_)/i;
const isIgnoredDir = (name) => IGNORE_DIR_RE.test(name);

/**
 * Extract translatable strings from an MV/MZ data tree.
 *
 * @param {string} pristineDir  primary source (backup, or the live folder on a first run)
 * @param {string} liveDir      live folder, scanned for additions only
 * @returns {{entries: Array, skipped: number}}
 */
function extract(pristineDir, liveDir) {
  const entries = [];
  const seen = new Map();
  let skipped = 0;
  let id = 0;

  const add = (file, at, text, skipTranslated) => {
    const t = String(text);
    if (!R.isTranslatable(t)) return;
    if (skipTranslated && isChineseLike(t)) { skipped++; return; }
    const key = normText(t);
    if (seen.has(key)) return;
    seen.set(key, id);
    entries.push({ id: id++, file, path: at, text: t });
  };

  // --- event command lists -----------------------------------------------------
  const processEventList = (file, list, at, skipTranslated) => {
    if (!Array.isArray(list)) return;
    list.forEach((cmd, idx) => {
      if (!cmd || typeof cmd.code !== "number") return;
      const params = cmd.parameters || [];
      const slots = R.EVENT_TEXT_CODES.get(cmd.code);
      if (!slots) return;
      const here = at + "[" + idx + "]";
      for (const slot of slots) {
        const v = params[slot];
        if (typeof v === "string") add(file, here, v, skipTranslated);
        else if (Array.isArray(v)) v.forEach((x) => add(file, here, x, skipTranslated));
      }
    });
  };

  // --- generic walk ------------------------------------------------------------
  const walk = (file, node, at, skipTranslated) => {
    if (Array.isArray(node)) {
      // An array of command objects is an event command list.
      if (node.length && node[0] && typeof node[0] === "object" && typeof node[0].code === "number") {
        processEventList(file, node, at, skipTranslated);
        return;
      }
      node.forEach((v, i) => walk(file, v, at + "[" + i + "]", skipTranslated));
      return;
    }
    if (node && typeof node === "object") {
      if (Array.isArray(node.list) && node.list.length && node.list[0] && typeof node.list[0].code === "number") {
        processEventList(file, node.list, at + ".list", skipTranslated);
      }
      for (const k of Object.keys(node)) {
        if (R.META_KEYS.has(k)) continue;
        const v = node[k];
        const here = at + "." + k;
        if (typeof v === "string") {
          if (R.TEXT_FIELDS.has(k)) add(file, here, v, skipTranslated);
        } else {
          walk(file, v, here, skipTranslated);
        }
      }
      return;
    }
  };

  const readTree = (root, skipTranslated) => {
    if (!root || !fs.existsSync(root)) return;
    for (const f of listJsonFiles(root)) {
      let data;
      try { data = JSON.parse(fs.readFileSync(f.full, "utf8")); } catch (e) { continue; }
      const base = path.basename(f.rel).toLowerCase();
      // System.json terms live in one place and are display text.
      if (base === "system.json" && data && data.terms && typeof data.terms === "object") {
        for (const k of Object.keys(data.terms)) {
          if (!R.TERMS_KEYS.includes(k)) continue;
          const arr = data.terms[k];
          if (Array.isArray(arr)) arr.forEach((v, i) => add(f.rel, "$terms." + k + "[" + i + "]", v, skipTranslated));
        }
      }
      walk(f.rel, data, "$", skipTranslated);
    }
  };

  readTree(pristineDir, false);
  if (liveDir && path.resolve(liveDir) !== path.resolve(pristineDir)) readTree(liveDir, true);

  return { entries, skipped };
}

module.exports = { extract, isChineseLike, normText, listJsonFiles, languageProfile };
