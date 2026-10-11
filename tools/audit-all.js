// Audit every game under the library roots. This is the standard closing step: run it after a
// translation session to see which games still carry a defect, instead of trusting one game's
// report.
//
// The checks run in this process, through the same module the single-game tool uses, so a sweep
// cannot disagree with the per-game report. Each game is wrapped in try/catch: an unreadable folder
// is recorded as an error row and the sweep continues.
//
// Usage:
//   node tools/audit-all.js [root ...] [--depth N] [--json] [--quiet]
//
// Defaults: root J:\game, depth 5. With --json the per-game rows are printed as JSON at the end, so
// the caller decides where they land (redirect it); this script writes no file of its own.
"use strict";
const fs = require("fs");
const path = require("path");
const { auditGame } = require("./audit-lib.js");

const argv = process.argv.slice(2);
const roots = argv.filter((a) => !a.startsWith("--"));
let depth = 5, asJson = false, quiet = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--depth") depth = parseInt(argv[++i], 10) || 5;
  else if (argv[i] === "--json") asJson = true;
  else if (argv[i] === "--quiet") quiet = true;
}
if (!roots.length) roots.push("J:\\game");

/** Is this directory a game? Same signals the pipeline's detectEngine uses. */
function looksLikeGame(dir) {
  const isDir = (d) => { try { return fs.statSync(d).isDirectory(); } catch (e) { return false; } };
  const hasIn = (d, re) => { try { return fs.readdirSync(d).some((f) => re.test(f)); } catch (e) { return false; } };
  for (const rel of ["data", "Data", path.join("www", "data")]) {
    const d = path.join(dir, rel);
    if (isDir(d) && hasIn(d, /\.(json|rvdata2?|rxdata)$/i)) return true;
  }
  for (const n of ["Game.rgss3a", "Game.rgss2a", "Game.rgssad"]) if (fs.existsSync(path.join(dir, n))) return true;
  return false;
}

const games = [];
function scan(dir, remaining) {
  if (remaining < 0) return;
  if (looksLikeGame(dir)) { games.push(dir); return; }   // do not descend into a game
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    if (/^\$RECYCLE|^System Volume Information/i.test(e.name)) continue;
    scan(path.join(dir, e.name), remaining - 1);
  }
}
for (const r of roots) scan(path.resolve(r), depth);

console.log("games found: " + games.length + "  (roots: " + roots.join(", ") + ", depth " + depth + ")");
console.log("");

const rows = [];
for (let i = 0; i < games.length; i++) {
  const game = games[i];
  let row;
  try {
    const { report, defects, nodata } = auditGame(game);
    row = {
      game, nodata: !!nodata, defects: defects || 0,
      counts: nodata ? {} : {
        "unparsable data files": report.unparsable.length,
        "prompt-instruction residue": report.promptEcho.length,
        "resource refs changed": report.resourceChanged.length,
        "non-string values changed": report.nonStringChanged.length,
        "control-code pollution": report.codePollution.length,
        "audio broken by translation": report.audioBrokenByTranslation.length,
      },
      dialogue: report.dialogue,
    };
  } catch (e) {
    row = { game, nodata: false, defects: -1, error: String((e && e.message) || e), counts: {} };
  }
  rows.push(row);
  if (!quiet) {
    const rest = row.nodata ? "no JSON data (VX Ace or packed)"
      : row.error ? "ERROR " + row.error
        : row.defects ? "DEFECTS " + row.defects : "clean";
    console.log(String(i + 1).padStart(3) + "/" + games.length + "  " + rest.padEnd(46) + path.basename(game).slice(0, 70));
  }
}

const bad = rows.filter((r) => !r.nodata && (r.defects > 0 || r.error));
console.log("");
console.log("=== summary ===");
console.log("  games scanned      : " + games.length);
console.log("  clean              : " + rows.filter((r) => !r.nodata && !r.error && r.defects === 0).length);
console.log("  with defects       : " + rows.filter((r) => !r.nodata && !r.error && r.defects > 0).length);
console.log("  unreadable         : " + rows.filter((r) => r.error).length);
console.log("  no JSON data       : " + rows.filter((r) => r.nodata).length);
if (bad.length) {
  console.log("");
  console.log("  games needing attention:");
  for (const r of bad) {
    const detail = Object.entries(r.counts || {}).filter(([, n]) => n > 0).map(([k, n]) => k + "=" + n).join("  ");
    console.log("    " + path.basename(r.game));
    console.log("        " + r.game);
    console.log("        " + (r.error ? "ERROR " + r.error : detail));
  }
}
if (asJson) {
  console.log("");
  console.log("=== json ===");
  console.log(JSON.stringify(rows, null, 2));
}
