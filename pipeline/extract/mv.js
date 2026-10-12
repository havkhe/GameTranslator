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

/**
 * Read a game JSON file, tolerating a leading UTF-8 BOM.
 *
 * RPG Maker MV writes some of its own data files with a BOM — measured: `System.json` in one game starts
 * with EF BB BF — and `JSON.parse` refuses that ("Unexpected token '\uFEFF'"). Every read site used to
 * swallow the error and skip the file, so `System.json` was neither extracted nor patched: the entire
 * terms block (menu labels, the messages for 保存/读档, the names of skill types and elements) stayed
 * English while the run reported "244 strings missing" with no reason given. One reader, used by the
 * extractor and the patcher both, so the two can never disagree about which files are readable.
 */
function readJsonFile(full) {
  return JSON.parse(fs.readFileSync(full, "utf8").replace(/^\uFEFF/, ""));
}

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
    try { walk(readJsonFile(f.full)); } catch (e) { }
  }
  return { total, kana, chinese, other, chineseLike: total > 0 && chinese / total > 0.5 };
}

/**
 * Every .json under a root, or only those an `accept(rel, full)` predicate allows.
 *
 * The predicate exists for folders that hold more than data: a game's `scenario/` folder can contain the
 * command-list JSON the walker understands *and* a config file it must not touch (see extract/scenario.js).
 */
function listJsonFiles(root, accept) {
  const out = [];
  const walk = (dir, rel) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) { if (!isIgnoredDir(e.name)) walk(p, r); }
      else if (/\.json$/i.test(e.name)) {
        if (accept && !accept(r, p)) continue;
        out.push({ full: p, rel: r });
      }
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
 * @param {object} [opts]       `accept(rel, full)` — restrict which .json files are read
 * @returns {{entries: Array, skipped: number}}
 */
function extract(pristineDir, liveDir, opts) {
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
      const here = at + "[" + idx + "]";
      // Plugin-command arguments: each parameter is a `key = value` line, and only the value can be text.
      // Handled before the table lookup below, because these codes are not in it at all — the whole line
      // must never be translated. See rules.PLUGIN_ARG_CODES for what the filters refuse and why.
      if (R.PLUGIN_ARG_CODES.has(cmd.code)) {
        params.forEach((v, i) => {
          if (typeof v !== "string") return;
          const arg = R.splitPluginArg(v);
          if (arg && R.pluginArgValueTranslatable(arg.key, arg.value)) {
            add(file, here + ".parameters[" + i + "]", arg.value, skipTranslated);
          }
        });
      }
      const slots = R.EVENT_TEXT_CODES.get(cmd.code);
      if (!slots) return;
      for (const slot of slots) {
        const v = params[slot];
        if (typeof v === "string") add(file, here, v, skipTranslated);
        else if (Array.isArray(v)) v.forEach((x) => add(file, here, x, skipTranslated));
      }
    });
  };

  // --- generic walk ------------------------------------------------------------
  // `inAudio` marks being inside an audio container (bgm / bgs / me / se / sounds / titleBgm …), where
  // `name` is the file the engine loads rather than display text. See rules.AUDIO_CONTAINER_KEYS.
  const walk = (file, node, at, skipTranslated, inAudio) => {
    if (Array.isArray(node)) {
      // An array of command objects is an event command list.
      if (node.length && node[0] && typeof node[0] === "object" && typeof node[0].code === "number") {
        processEventList(file, node, at, skipTranslated);
        return;
      }
      node.forEach((v, i) => walk(file, v, at + "[" + i + "]", skipTranslated, inAudio));
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
          if (R.TEXT_FIELDS.has(k) && !(inAudio && k === "name")) add(file, here, v, skipTranslated);
        } else {
          walk(file, v, here, skipTranslated, inAudio || R.AUDIO_CONTAINER_KEYS.has(k));
        }
      }
      return;
    }
  };

  const readTree = (root, skipTranslated) => {
    if (!root || !fs.existsSync(root)) return;
    const accept = opts && typeof opts.accept === "function" ? opts.accept : undefined;
    for (const f of listJsonFiles(root, accept)) {
      let data;
      try { data = readJsonFile(f.full); } catch (e) { continue; }
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

module.exports = { extract, isChineseLike, normText, listJsonFiles, languageProfile, readJsonFile };
