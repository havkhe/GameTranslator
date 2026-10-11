// Text2Frame text files: the dialogue of games that keep their script outside the data files.
//
// The Text2Frame plugin (and its MZ line, TextScriptBase) reads the message text from plain .txt files
// in a `text/` folder beside the data folder, not from event commands. The event data then holds only a
// short label, so the extractor sees almost nothing:
//
//   NTR Gyaru      data holds 24 translatable fields; text/message.txt holds 67 more lines of dialogue,
//                  every one of them still Japanese. The game read as "partly translated" while its
//                  whole story was untouched.
//   牧场Ver1.1     102 kana lines in text/*.txt, none of them reachable by the data extractor.
//
// mtool's own list for these games is the same story from the other side: its key set contains the raw
// source strings, and the strings that matter to the player here are the event lines and the text file,
// which is why a data-only pass leaves the game unreadable.
//
// Format: one message per line, CRLF, no control codes. A speaker line is a full-width space, the name
// and a full-width colon ("　夢前和漢："); a dialogue block is a run of consecutive non-empty lines. Line
// count must be preserved exactly — the plugin replays the file by line — so this translates line by
// line and never merges or splits.
"use strict";
const fs = require("fs");
const path = require("path");
const R = require("./rules.js");

const FOLDER = "text";
const BACKUP_FOLDER = "text_原版备份";
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
 * Where a game keeps its `text/` folder.
 *
 * Both layouts occur: beside the game root (`<game>/text`, the data folder is `<game>/data`) and inside
 * the web root of an MZ game (`<game>/www/text`, data at `<game>/www/data`). The data folder's parent is
 * checked as well so the two never have to be guessed from the engine kind.
 */
function textRoots(gameDir, dataDir) {
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

/** Every .txt under a text folder, one level deep (Text2Frame allows subfolders for large scripts). */
function textFilesIn(dir) {
  const out = [];
  const collect = (d, rel) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const here = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) { collect(child(d, e.name), here); continue; }
      if (!/\.txt$/i.test(e.name)) continue;
      out.push({ full: child(d, e.name), rel: here });
    }
  };
  collect(dir, "");
  return out;
}

/**
 * Make sure a pristine copy of each text folder exists before anything is written.
 *
 * Without it the first run translates the only Japanese copy and every later run reads Chinese back out
 * of the live file — the same failure the data folder's `data_原版备份` was added to prevent. The copy is
 * made once and reused.
 */
function ensureBackup(gameDir, dataDir) {
  const made = [];
  for (const root of textRoots(gameDir, dataDir)) {
    if (isDir(root.backup)) continue;
    try {
      fs.cpSync(root.dir, root.backup, { recursive: true });
      made.push(root.backup);
    } catch (e) { /* a folder we cannot copy is reported by the caller's counts, not fatal here */ }
  }
  return made;
}

function readLines(full) {
  const raw = fs.readFileSync(full, "utf8");
  return { raw, lines: raw.split(/\r?\n/), crlf: /\r\n/.test(raw) };
}

/**
 * Extract the message lines that still carry Japanese.
 *
 * Reads the pristine copy when one exists, exactly like the data extractor, so a second run never sends
 * a previous translation back through the model.
 *
 * @returns {{entries: Array, skipped: number, filtered: number, files: number}}
 */
function extract(gameDir, dataDir) {
  const entries = [];
  const seen = new Set();
  let skipped = 0, filtered = 0, files = 0;

  const read = (dir, relPrefix, skipTranslated) => {
    for (const f of textFilesIn(dir)) {
      files++;
      let lines;
      try { lines = readLines(f.full).lines; } catch (e) { continue; }
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!R.isTranslatable(line)) { if (line.trim()) filtered++; continue; }
        // A line that is already Chinese means a previous pass wrote here; asking the model to
        // translate Chinese into Chinese is what this avoids.
        if (skipTranslated && isChineseLike(line)) { skipped++; continue; }
        if (seen.has(line)) continue;
        seen.add(line);
        entries.push({
          id: entries.length,
          // File plus line number: the plugin addresses the message by its position, so the location
          // is the identity. `$[n]` matches the shape the other extractors use for array slots.
          file: relPrefix + "/" + f.rel,
          path: "$[" + i + "]",
          text: line,
        });
      }
    }
  };

  for (const root of textRoots(gameDir, dataDir)) {
    const pristine = isDir(root.backup) ? root.backup : root.dir;
    read(pristine, root.rel, false);
    if (path.resolve(pristine) !== path.resolve(root.dir)) read(root.dir, root.rel, true);
  }
  return { entries, skipped, filtered, files };
}

/** Chinese-like test, same rule resources.js uses: no kana, and Han makes up most of the line. */
function isChineseLike(s) {
  const t = String(s);
  if (/[\u3040-\u309f\u30a0-\u30ff]/.test(t)) return false;
  const han = (t.match(/[\u3400-\u9fff]/g) || []).length;
  return han >= 2 && han * 2 >= t.replace(/\s/g, "").length;
}

/**
 * Write the translations back into the live text files.
 *
 * Line by line, keyed by the source line like the rest of the pipeline. A line whose translation is
 * absent is left exactly as it is, so a partial cache still produces a playable file.
 */
function patch(gameDir, dataDir, cache, reportFile) {
  let replaced = 0, missing = 0;
  const files = [];
  for (const root of textRoots(gameDir, dataDir)) {
    for (const f of textFilesIn(root.dir)) {
      let doc;
      try { doc = readLines(f.full); } catch (e) { continue; }
      let changed = 0;
      const out = doc.lines.map((line) => {
        if (!line.trim()) return line;
        const tr = cache.lookup(line);
        if (typeof tr === "string" && tr && tr !== line) { replaced++; changed++; return tr; }
        if (R.isTranslatable(line)) missing++;
        return line;
      });
      if (changed) {
        fs.writeFileSync(f.full, out.join(doc.crlf ? "\r\n" : "\n"), "utf8");
        files.push(f.rel + " (" + changed + ")");
      }
    }
  }
  const report = { engine: "text2frame", replaced, missing, files: files.length };
  if (reportFile) {
    try { fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), "utf8"); } catch (e) { }
  }
  return report;
}

module.exports = { extract, patch, textFilesIn, textRoots, ensureBackup, isChineseLike, FOLDER, BACKUP_FOLDER };
