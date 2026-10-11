// Story data kept outside the data folder: a `scenario/` folder of event-command JSON.
//
// Games built with a scenario plugin (one measured title uses the Nore_* family, another ships the same
// layout) hold the WHOLE script in scenario/Scenario.json — one object keyed by scenario
// name, each value an array of MV/MZ event commands, referenced from the data only by a plugin parameter
// ("ファイル名 = オープニング_3行で_01"). The event data therefore contains a few strings and the game's
// actual text is in this file.
//
// Measured on that game: 2 kana-bearing fields in its event parameters and 42,757 extractable
// entries in scenario/Scenario.json, 42,654 of them Japanese. Pointing the pipeline at data/ alone is
// why such a game translated to a two-line patch report and stayed Japanese in play.
//
// The schema is identical to data/*.json, so this module adds no parsing of its own: it locates the
// folder, keeps a pristine copy beside it (the same convention as data_原版备份 and text_原版备份) and
// hands it to the MV extractor/patcher that is already trusted for that shape.
//
// Only a folder literally named `scenario` is used. A wider rule ("any folder holding command JSON")
// would also sweep MTool_MapDataCache and the data_* backup folders, which must not be translated.
"use strict";
const fs = require("fs");
const path = require("path");
const mv = require("./mv.js");

const FOLDER = "scenario";
const BACKUP_FOLDER = "scenario_原版备份";
const NAME_RE = /^[A-Za-z0-9_.\-()\[\] \u3000-\u9fff\uff00-\uffef\u3040-\u30ff]{1,200}$/s;

/** A single directory entry appended to a directory already resolved here. */
function child(root, name) {
  if (typeof name !== "string" || !NAME_RE.test(name) || name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new Error("refusing unsafe name: " + JSON.stringify(name));
  }
  const base = path.resolve(root);
  const t = path.resolve(base, name);
  if (t !== base && !t.startsWith(base + path.sep)) throw new Error("outside root: " + name);
  return t;
}
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } }

/**
 * Where a game keeps its scenario folder.
 *
 * Both layouts occur: beside the game root (data at `<game>/data`) and inside the web root of an MZ game
 * (`<game>/www/scenario`, data at `<game>/www/data`). The data folder's parent is checked as well, so the
 * two never have to be guessed from the engine kind.
 */
function scenarioRoots(gameDir, dataDir) {
  const out = [];
  const seen = new Set();
  const candidates = [];
  if (gameDir) candidates.push([gameDir, FOLDER], [path.join(gameDir, "www"), "www/" + FOLDER]);
  if (dataDir) {
    const parent = path.dirname(dataDir);
    candidates.push([parent, path.basename(parent) === "www" ? "www/" + FOLDER : FOLDER]);
  }
  for (const [c, rel] of candidates) {
    const dir = path.join(c, FOLDER);
    if (!isDir(dir)) continue;
    let key;
    try { key = fs.realpathSync(dir).toLowerCase(); } catch (e) { key = dir.toLowerCase(); }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ dir, backup: path.join(c, BACKUP_FOLDER), rel });
  }
  return out;
}

/** Is this file shaped like an event-command list? Keeps a stray config JSON in the folder untouched. */
function looksLikeCommands(full) {
  let text;
  try { text = fs.readFileSync(full, "utf8"); } catch (e) { return false; }
  return /"code"\s*:\s*\d/.test(text) && /"parameters"\s*:/.test(text);
}
/** Accept only command files, and only the JSON ones. */
function accept(rel, full) {
  return /\.json$/i.test(rel) && looksLikeCommands(full);
}

/** Make sure a pristine copy of each scenario folder exists before anything is written. */
function ensureBackup(gameDir, dataDir) {
  const made = [];
  for (const root of scenarioRoots(gameDir, dataDir)) {
    if (isDir(root.backup)) continue;
    try {
      fs.cpSync(root.dir, root.backup, { recursive: true });
      made.push(root.backup);
    } catch (e) { /* reported by the caller's counts, not fatal here */ }
  }
  return made;
}

/**
 * Extract the story lines from the scenario folder.
 *
 * Reads the pristine copy when one exists, exactly like the data extractor, so a second run never sends a
 * previous translation back through the model.
 *
 * @returns {{entries: Array, skipped: number, files: number}}
 */
function extract(gameDir, dataDir) {
  const entries = [];
  let skipped = 0, files = 0;
  for (const root of scenarioRoots(gameDir, dataDir)) {
    const pristine = isDir(root.backup) ? root.backup : root.dir;
    const r = mv.extract(pristine, root.dir, { accept });
    skipped += r.skipped;
    files += mv.listJsonFiles(pristine, accept).length;
    // The location must not collide with a data file of the same name, so the folder is part of the path.
    for (const e of r.entries) {
      entries.push({ id: entries.length, file: root.rel + "/" + e.file, path: e.path, text: e.text });
    }
  }
  return { entries, skipped, files };
}

/**
 * Write the translations back into the live scenario files.
 *
 * Only files that look like command lists are opened, so anything else in the folder is left alone.
 */
function patch(gameDir, dataDir, cache, reportFile) {
  let replaced = 0, missing = 0, files = 0;
  for (const root of scenarioRoots(gameDir, dataDir)) {
    const r = mvPatch().patch(root.dir, cache, null, { accept });
    replaced += r.replaced;
    missing += r.missing;
    files += r.files;
  }
  const report = { engine: "scenario", replaced, missing, files };
  if (reportFile) {
    try { fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), "utf8"); } catch (e) { }
  }
  return report;
}

/** Required lazily: patch/mv.js is only needed when a patch actually runs. */
function mvPatch() { return require("../patch/mv.js"); }

module.exports = { extract, patch, scenarioRoots, ensureBackup, looksLikeCommands, FOLDER, BACKUP_FOLDER, accept };
