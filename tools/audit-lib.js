// Audit logic for one game, shared by tools/audit-game.js and tools/audit-all.js.
//
// Kept separate from the CLI so both entry points run exactly the same checks: a sweep that
// disagreed with the single-game report would be worse than no sweep.
//
// What it judges, and why each one can break a game:
//
//   resource refs   a file name the engine resolves on disk (characterName, faceName, battlerName,
//                   parallaxName, audio .name, tilesetNames) — translating one makes the game fail
//                   to load that asset, which is invisible until it is played
//   control codes   backslash sequences (\N[1], \V[1] …) whose multiset differs from the original:
//                   a lost code drops a value, an invented one renders a name the author never wrote
//   prompt echo     instruction text that reached the data — shown to the player as a menu label
//   parse errors    a data file the engine can no longer read
//   audio resolve   a reference no file on disk satisfies — reported only when the ORIGINAL resolves
//                   it, because a game may ship with missing audio of its own
//
// Informational, never a defect: editor labels (CommonEvents[N].name, Map event names) are shown only
// in the editor, and kana left inside script blobs is text the extractor never targets.
"use strict";
const fs = require("fs");
const path = require("path");
const { promptEchoMatches, promptFragments, degenerationMatches } = require("../pipeline/translate/quality.js");
const { DEFAULT_TEMPLATE } = require("../pipeline/translate/index.js");
// The audit and the pipeline must agree on where dialogue lives, so the pipeline's own locator is
// used rather than a second implementation that can drift from it.
const { dialogueFiles } = require("../pipeline/extract/resources.js");
const text2frame = require("../pipeline/extract/text2frame.js");

const KANA = /[\u3040-\u309f\u30a0-\u30ff\uff66-\uff9f]/;
const BACKUP_NAMES = ["data_原版备份", "Data_原版备份", "www/data_原版备份"];
const DATA_NAMES = ["data", "Data", "www/data"];

// Confined file access: every name used for I/O is a single directory entry appended to a directory
// this module resolved itself, and the result must stay inside it.
const BASENAME_RE = /^[A-Za-z0-9_.\-()\[\] \u3000-\u9fff\uff00-\uffef\u3040-\u30ff]{1,255}$/s;
function child(root, name) {
  if (typeof name !== "string" || !BASENAME_RE.test(name) || name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new Error("refusing unsafe name: " + JSON.stringify(name));
  }
  const base = path.resolve(root);
  const target = path.resolve(base, name);
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error("outside root: " + name);
  return target;
}
function subdir(root, rel) {
  let cur = path.resolve(root);
  for (const part of String(rel).split(/[\\/]+/).filter(Boolean)) cur = child(cur, part);
  try { return fs.statSync(cur).isDirectory() ? cur : null; } catch (e) { return null; }
}
function jsonNames(dir) {
  let ents;
  try { ents = fs.readdirSync(path.resolve(dir)); } catch (e) { return []; }
  return ents.filter((n) => /\.json$/i.test(n)).sort();
}

function findDataDir(game) {
  for (const rel of DATA_NAMES) {
    const d = subdir(game, rel);
    if (d && jsonNames(d).length) return d;
  }
  return null;
}
function findBackupDir(game) {
  for (const rel of BACKUP_NAMES) {
    const d = subdir(game, rel);
    if (d && jsonNames(d).length) return d;
  }
  return null;
}

/** Every string in a parsed tree, arrays and `note` included, as [path, value].
 *  Direct array elements count — the earlier walker only counted object properties and therefore
 *  missed parameters[0] and terms.commands[i] forms entirely. */
function* strings(node, at) {
  if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) yield* strings(node[i], at + "[" + i + "]"); return; }
  if (node && typeof node === "object") { for (const k of Object.keys(node)) yield* strings(node[k], at + "." + k); return; }
  if (typeof node === "string") yield [at, node];
}
function flatten(node, at, m) {
  if (Array.isArray(node)) { node.forEach((v, i) => flatten(v, at + "[" + i + "]", m)); return m; }
  if (node && typeof node === "object") { for (const k of Object.keys(node)) flatten(node[k], at + "." + k, m); return m; }
  m.set(at, typeof node === "string" ? node : "<" + typeof node + ">");
  return m;
}
function parseJson(text) {
  // Strip a UTF-8 BOM first. Some builds ship data files with one, and the engine's own loader
  // removes it (XHR decodes UTF-8 and strips the mark), so a BOM is not damage — without this,
  // nine healthy files of one library game were reported as unparsable.
  const t = String(text).charCodeAt(0) === 0xFEFF ? String(text).slice(1) : String(text);
  return JSON.parse(t);
}

/**
 * Read a text file, asserting first that it lies inside `root`.
 *
 * Callers hand back absolute paths built elsewhere (the dialogue locator, a walk of the tree), so the
 * boundary is re-checked at the moment of the read rather than assumed.
 */
function readTextInside(root, p) {
  const base = path.resolve(root);
  // A relative name is resolved against the root, so the caller may pass either an absolute path
  // produced elsewhere or a plain file name; an absolute path must still land inside the root.
  const target = path.isAbsolute(p) ? path.resolve(p) : path.resolve(base, p);
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error("refusing read outside " + base + ": " + p);
  return fs.readFileSync(target, "utf8");
}

/** Write a JSON file as `<dir>/<name>`, with the name and the resulting path both checked. */
function writeJsonInside(dir, name, data) {
  if (typeof name !== "string" || !/^[A-Za-z0-9_.\-]{1,120}\.json$/.test(name)) throw new Error("refusing unsafe file name: " + JSON.stringify(name));
  const base = path.resolve(dir);
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) throw new Error("not a directory: " + base);
  const target = path.resolve(base, path.basename(name));
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error("refusing write outside " + base + ": " + name);
  // Write, then move into place, and retry a few times.
  //
  // On Windows a plain write onto a file another process is holding raises EPERM, and that happens
  // for real: clicking 刷新状态 twice, or while a second instance is open, puts two writers on this
  // one file. Without the retry the loser dumps an EPERM stack trace into the UI log instead of the
  // summary, which is how this was noticed.
  const tmp = target + "." + process.pid + ".tmp";
  let lastErr = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      fs.writeFileSync(tmp, data, "utf8");
      fs.renameSync(tmp, target);
      return target;
    } catch (e) {
      lastErr = e;
      try { fs.unlinkSync(tmp); } catch (e2) { }
      const until = Date.now() + 150 * attempt;
      while (Date.now() < until) { /* brief backoff, synchronously: this tool is short-lived */ }
    }
  }
  throw new Error("无法写入 " + target + "（另一进程正在占用？）：" + (lastErr && lastErr.code ? lastErr.code : lastErr));
}

/** Write a text file as `<dir>/<name>`, same guards as writeJsonInside but for any .js/.json name. */
function writeTextInside(dir, name, text) {
  if (typeof name !== "string" || !/^[A-Za-z0-9_.\-]{1,120}\.(js|json|txt)$/.test(name)) throw new Error("refusing unsafe file name: " + JSON.stringify(name));
  const base = path.resolve(dir);
  fs.mkdirSync(base, { recursive: true });
  const target = path.resolve(base, path.basename(name));
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error("refusing write outside " + base + ": " + name);
  fs.writeFileSync(target, text, "utf8");
  return target;
}

/**
 * Identity of one backslash code, with a NON-numeric argument folded away.
 *
 * `\N[1]` must keep its number: 1 indexes the actor table, so 1 -> 2 is a real defect. `\n<犬>`
 * holds display text — a game writes the speaker's name there and translating it is the point —
 * so folding the argument to `\n<>` stops a correct translation from being reported as a changed
 * code. Measured: one library game produced 2312 "changes" that were all translated name brackets.
 */
function codeKey(m) {
  const mm = m.match(/^\\([A-Za-z]?)([\[<])([^\]>]{0,16})([\]>])$/);
  if (!mm) return m;
  const letter = mm[1], open = mm[2], arg = mm[3], close = mm[4];
  return /^\d+$/.test(arg) ? "\\" + letter + open + arg + close : "\\" + letter + open + close;
}
function codeCounts(s) {
  const out = Object.create(null);
  for (const c of String(s).match(/\\[A-Za-z]?[\[<][^\]>]{0,16}[\]>]|\\./g) || []) {
    const k = codeKey(c);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}
function codesEqual(a, b) {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

// `name` is a resource only inside one of these containers (System.json titleBgm / battleBgm /
// sounds[] / battlebacks …). Everywhere else `name` is an editor label or a display name.
const RESOURCE_CONTAINER_RE = /(^|\.)(titleBgm|battleBgm|victoryMe|defeatMe|gameoverMe|bgm|bgs|me|se|sound)$/i;
const RESOURCE_FIELD_RE = /(^|\.)(characterName|faceName|battlerName|parallaxName|animation1Name|animation2Name)$/;
const RESOURCE_ARRAY_FIELD_RE = /(^|\.)(tilesetNames)$/;

function resourceRefs(tree) {
  const found = new Map();
  const walk = (node, at) => {
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, at + "[" + i + "]")); return; }
    if (!node || typeof node !== "object") return;
    for (const k of Object.keys(node)) {
      if (k === "note") continue;
      const v = node[k];
      const here = at + "." + k;
      if (typeof v === "string") {
        if (RESOURCE_FIELD_RE.test(here)) found.set(here, v);
        else if (k === "name" && RESOURCE_CONTAINER_RE.test(at)) found.set(here, v);
      } else if (Array.isArray(v) && RESOURCE_ARRAY_FIELD_RE.test(here)) {
        v.forEach((x, i) => { if (typeof x === "string" && x) found.set(here + "[" + i + "]", x); });
      } else walk(v, here);
    }
  };
  walk(tree, "");
  return found;
}

const AUDIO_EXT = /\.(ogg|m4a|wav|mp3|aac|flac|opus)_?$/i;
function audioBasenamesOnDisk(game) {
  const out = new Set();
  for (const rel of ["audio", "Audio", "www/audio", "img", "Img", "www/img"]) {
    const dir = subdir(game, rel);
    if (!dir) continue;
    (function index(d, depth) {
      if (depth < 0) return;
      let ents;
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      for (const e of ents) {
        if (e.isDirectory()) { index(path.join(d, e.name), depth - 1); continue; }
        out.add(e.name.replace(AUDIO_EXT, "").replace(/\.[^.]+$/, "").toLowerCase());
      }
    })(dir, 6);
  }
  return out;
}
function audioRefs(tree) {
  const out = [];
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== "object") return;
    if (typeof node.name === "string" && node.name && (node.volume !== undefined || node.pitch !== undefined || node.pan !== undefined)) {
      out.push(node.name);
    }
    for (const k of Object.keys(node)) { if (k !== "note") walk(node[k]); }
  };
  walk(tree);
  return out;
}

/** Dialogue in resources/<locale>/, live and pristine, counted the way the pipeline locates it. */
function auditDialogue(liveData, backupData, report, fragments) {
  const out = { files: 0, total: 0, kanaLive: 0, kanaBackup: 0, otherFiles: 0 };
  const liveVals = [], bakVals = [];
  for (const f of dialogueFiles(liveData)) {
    let data;
    let raw;
    try { raw = fs.readFileSync(f.full, "utf8"); } catch (e) { continue; }
    try { data = parseJson(raw); } catch (e) { report.unparsable.push({ file: f.rel, err: e.message }); continue; }
    out.files++;
    for (const [k, v] of Object.entries(data)) {
      if (typeof v !== "string" || !v.trim()) continue;
      liveVals.push(v);
      const echo = promptEchoMatches(v, "", fragments);
      if (echo) report.promptEcho.push({ file: f.rel, key: k, echo, value: v.slice(0, 160) });
    }
  }
  if (backupData) {
    for (const f of dialogueFiles(backupData)) {
      let data;
      try { data = parseJson(fs.readFileSync(f.full, "utf8")); } catch (e) { continue; }
      for (const [, v] of Object.entries(data)) if (typeof v === "string" && v.trim()) bakVals.push(v);
    }
  }

  // Everything else under resources/: not a locale folder, so the pipeline neither extracts nor
  // patches it — but it is game data all the same. One game keeps its in-game social feed in
  // resources/hiroka_tweet_list.json, and an older pass had translated it and left ten word-salad
  // values behind. Pollution there is reported; coverage is not, because the pipeline cannot
  // translate it yet.
  const resRoot = subdir(liveData, "resources") || subdir(liveData, "Resources");
  if (resRoot) {
    const seen = new Set(dialogueFiles(liveData).map((f) => path.resolve(f.full)));
    (function walk(dir, depth) {
      if (depth < 0) return;
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const e of ents) {
        // child() is the only path builder here: a plain directory entry, asserted to stay inside
        // the directory it was found in.
        let p;
        try { p = child(dir, e.name); } catch (err) { continue; }
        if (e.isDirectory()) { walk(p, depth - 1); continue; }
        if (!/\.json$/i.test(e.name) || seen.has(path.resolve(p))) continue;
        let j;
        try { j = parseJson(fs.readFileSync(p, "utf8")); } catch (e2) { continue; }
        out.otherFiles++;
        const rel = "resources/" + path.relative(resRoot, p).replace(/\\/g, "/");
        for (const [at, v] of strings(j, "")) {
          const echo = promptEchoMatches(v, "", fragments);
          if (echo) report.promptEcho.push({ file: rel, key: at, echo, value: v.slice(0, 160), uncovered: true });
          const degen = degenerationMatches(v);
          if (degen) report.degradation.push({ file: rel, key: at, bigrams: degen, value: v.slice(0, 160), editorLabel: false, uncovered: true });
        }
      }
    })(resRoot, 4);
  }

  out.total = bakVals.length || liveVals.length;
  out.kanaLive = liveVals.filter((v) => KANA.test(v)).length;
  out.kanaBackup = bakVals.filter((v) => KANA.test(v)).length;

  // Text2Frame message files: dialogue kept in text/*.txt beside the data folder rather than in the
  // data files or resources/. Without this the audit reports a game whose whole script is Japanese as
  // having no dialogue at all (measured on one such game: 67 of 67 message lines still Japanese,
  // reported as "files 0 total 0"), so both the counts and the pollution checks cover them here.
  const t2f = { files: 0, lines: 0, kanaLive: 0, kanaBackup: 0 };
  const dirExists = (p) => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } };
  try {
    for (const root of text2frame.textRoots(null, liveData)) {
      const pristine = dirExists(root.backup) ? root.backup : root.dir;
      for (const f of text2frame.textFilesIn(root.dir)) {
        let text;
        try { text = fs.readFileSync(f.full, "utf8"); } catch (e) { continue; }
        t2f.files++;
        for (const line of text.split(/\r?\n/)) {
          if (!line.trim()) continue;
          t2f.lines++;
          if (KANA.test(line)) t2f.kanaLive++;
          const echo = promptEchoMatches(line, "", fragments);
          if (echo) report.promptEcho.push({ file: root.rel + "/" + f.rel, key: line.slice(0, 40), echo, value: line.slice(0, 160), text2frame: true });
          const degen = degenerationMatches(line);
          if (degen) report.degradation.push({ file: root.rel + "/" + f.rel, key: line.slice(0, 40), bigrams: degen, value: line.slice(0, 160), editorLabel: false, text2frame: true });
        }
      }
      for (const f of text2frame.textFilesIn(pristine)) {
        let text;
        try { text = fs.readFileSync(f.full, "utf8"); } catch (e) { continue; }
        for (const line of text.split(/\r?\n/)) if (line.trim() && KANA.test(line)) t2f.kanaBackup++;
      }
    }
  } catch (e) { /* an unreadable text folder is not itself a defect */ }
  if (t2f.files) {
    out.text2frame = t2f;
    out.kanaLive += t2f.kanaLive;
    out.kanaBackup += t2f.kanaBackup;
  }
  return out;
}

/**
 * Audit one game folder.
 * @returns {{report: object, defects: number}}
 */
function auditGame(game) {
  const report = {
    game: path.resolve(game), live: null, backup: null,
    files: 0, unparsable: [], promptEcho: [], degradation: [], codePollution: [],
    resourceChanged: [], nonStringChanged: [],
    editorLabels: 0, kanaStrings: 0, totalStrings: 0,
    audioUnresolvedLive: 0, audioUnresolvedBackup: 0, audioBrokenByTranslation: [],
    audioAttributionSkipped: false,
    missingInBackup: [], dialogue: null,
  };
  const live = findDataDir(report.game);
  if (!live) return { report, defects: 0, nodata: true };
  const bak = findBackupDir(report.game);
  report.live = live;
  report.backup = bak;

  const fragments = promptFragments(DEFAULT_TEMPLATE);
  const onDisk = audioBasenamesOnDisk(report.game);
  const liveAudio = new Set(), bakAudio = new Set();

  for (const name of jsonNames(live)) {
    const lp = child(live, name);
    let L, raw;
    try { raw = fs.readFileSync(lp, "utf8"); } catch (e) { continue; }
    try { L = parseJson(raw); } catch (e) { report.unparsable.push({ file: name, err: e.message }); continue; }
    report.files++;

    for (const [at, v] of strings(L, "")) {
      report.totalStrings++;
      if (KANA.test(v)) report.kanaStrings++;
      const echo = promptEchoMatches(v, "", fragments);
      if (echo) report.promptEcho.push({ file: name, key: at, echo, value: v.slice(0, 160) });
      const degen = degenerationMatches(v);
      if (degen) {
        // A value produced by the model's degeneration cycle. Player-visible when it sits in an
        // event parameter; an editor label when it sits in a `.name`.
        const label = /(^|\.)name$/.test(at) && /^(CommonEvents|Map\d*|MapInfos|Tilesets|Troops)\./.test(name + ".");
        report.degradation.push({ file: name, key: at, bigrams: degen, value: v.slice(0, 160), editorLabel: label });
      }
    }
    for (const ref of audioRefs(L)) liveAudio.add(ref.toLowerCase());

    if (!bak) continue;
    const bp = child(bak, name);
    if (!fs.existsSync(bp)) { report.missingInBackup.push(name); continue; }
    let B;
    try { B = parseJson(fs.readFileSync(bp, "utf8")); } catch (e) { continue; }
    for (const ref of audioRefs(B)) bakAudio.add(ref.toLowerCase());

    const lr = resourceRefs(L), br = resourceRefs(B);
    for (const [k, bv] of br) {
      const lv = lr.get(k);
      if (lv !== undefined && lv !== bv) report.resourceChanged.push({ file: name, key: k, from: bv, to: lv });
    }

    const lm = flatten(L, "", new Map()), bm = flatten(B, "", new Map());
    for (const [k, bv] of bm) {
      const lv = lm.get(k);
      if (lv === undefined || lv === bv) continue;
      if (bv.startsWith("<") || lv.startsWith("<")) {
        report.nonStringChanged.push({ file: name, key: k, from: bv, to: lv });
        continue;
      }
      const cb = codeCounts(bv), cl = codeCounts(lv);
      if (!codesEqual(cb, cl)) {
        const lost = Object.keys(cb).filter((c) => (cl[c] || 0) < cb[c]);
        const added = Object.keys(cl).filter((c) => (cb[c] || 0) < cl[c]);
        report.codePollution.push({ file: name, key: k, lost, added, from: bv.slice(0, 120), to: lv.slice(0, 120) });
      }
      if (/(^|\.)name$/.test(k) && !RESOURCE_FIELD_RE.test(k) && !RESOURCE_CONTAINER_RE.test(k.replace(/\.name$/, ""))) report.editorLabels++;
    }
  }

  const uniqLive = new Set([...liveAudio].filter((n) => !onDisk.has(String(n).split("/").pop())));
  const uniqBak = new Set([...bakAudio].filter((n) => !onDisk.has(String(n).split("/").pop())));
  report.audioUnresolvedLive = uniqLive.size;
  report.audioUnresolvedBackup = uniqBak.size;
  // Attribution needs the original: without a backup every unresolved reference would look like
  // damage this pass caused, when the game may simply ship with audio it never had. Measured on a
  // sweep: a game with no backup reported "audio broken by translation 70" purely from that.
  report.audioAttributionSkipped = !bak;
  report.audioBrokenByTranslation = bak ? [...uniqLive].filter((n) => !uniqBak.has(n)) : [];

  report.dialogue = auditDialogue(live, bak, report, fragments);

  const defects = report.promptEcho.length + report.resourceChanged.length +
    report.nonStringChanged.length + report.codePollution.length +
    report.unparsable.length + report.audioBrokenByTranslation.length + report.degradation.length;
  return { report, defects, nodata: false };
}

/**
 * How much of a game's data was translated, measured against its pristine original.
 *
 * Both sides are produced by the extractor itself, so this cannot measure something the pipeline would
 * not translate. The earlier version decided by field name — any `...parameters[N]` counted as text
 * whatever the command code — and that counted fields the extractor never targets and must never
 * translate: a show-picture name (code 231 slot 1, a file on disk), a jump label (118 / 119), and the
 * argument lines of plugin commands (357 / 657), which are `key = value` pairs mixing text with image
 * names. Measured on one game: 13,564 of 13,614 kana-bearing fields were of that kind, so its coverage
 * was reported as a fraction of a number that had little to do with its text.
 *
 * The measure is by unique source text, which is also how the pipeline keys its cache: a Japanese
 * source string still present verbatim in the live data has not been translated, and one that is no
 * longer there was replaced.
 *
 *   translated  a Japanese source string that is no longer present in the live data
 *   remaining   a Japanese source string still present verbatim
 *   comparable  the distinct Japanese source strings the extractor found, i.e. the denominator
 */
function translatedCount(liveDir, backupDir) {
  const mv = require("../pipeline/extract/mv.js");
  const norm = (s) => String(s).replace(/\r\n|\n|\r/g, " ").replace(/\\n/g, " ");
  let src, cur;
  try { src = mv.extract(backupDir, backupDir); } catch (e) { return null; }
  try { cur = mv.extract(liveDir, liveDir); } catch (e) { return null; }
  const liveKeys = new Set(cur.entries.map((e) => norm(e.text)));
  const seen = new Set();
  let translated = 0, remaining = 0, comparable = 0;
  for (const e of src.entries) {
    const k = norm(e.text);
    if (seen.has(k)) continue;
    seen.add(k);
    if (!KANA.test(e.text)) continue;      // the source carries no kana, so nothing to translate
    comparable++;
    if (liveKeys.has(k)) remaining++; else translated++;
  }
  return { translated, remaining, comparable };
}

/**
 * What language each resources/<locale>/ folder holds.
 *
 * A game's own Chinese release keeps Japanese in ja-JP and puts Chinese somewhere else (zh-CN,
 * zh-Hans, …), so "is ja-JP Chinese?" is not the same question as "does this game ship Chinese?".
 * Sampling each locale folder answers the second one.
 */
function resourceLocaleProfile(dataDir) {
  const root = subdir(dataDir, "resources") || subdir(dataDir, "Resources");
  if (!root) return [];
  const out = [];
  let locales = [];
  try { locales = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch (e) { return []; }
  for (const locale of locales) {
    let dir;
    try { dir = child(root, locale); } catch (e) { continue; }
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /\.json$/i.test(f)); } catch (e) { continue; }
    let strings = 0, kana = 0, hanOnly = 0;
    for (const f of files.slice(0, 6)) {
      let j;
      try { j = parseJson(readTextInside(dir, child(dir, f))); } catch (e) { continue; }
      for (const v of Object.values(j)) {
        if (typeof v !== "string" || !v.trim()) continue;
        strings++;
        if (KANA.test(v)) kana++;
        else if (/[\u3400-\u9fff]/.test(v)) hanOnly++;
      }
    }
    out.push({ locale, files: files.length, strings, kana, hanOnly });
  }
  return out;
}

module.exports = {
  auditGame, findDataDir, findBackupDir, jsonNames, strings, parseJson, codeCounts, codeKey, KANA,
  readTextInside, writeJsonInside, writeTextInside, translatedCount, resourceLocaleProfile,
};
