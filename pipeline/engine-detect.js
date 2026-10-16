// Which engine is this game, and where does its data live?
//
// Its own module so the decision can be unit-tested without running the pipeline (tools/unit-engine-detect.js):
// a wrong answer here is SILENT — the run reports success, replaces hundreds of thousands of strings, and the
// game keeps displaying Japanese. That is exactly what happened to a VX Ace title whose owner had unpacked it
// by hand: Game.rgss3a and Data/*.rvdata2 both present, the loose folder chosen, the archive never touched.
"use strict";
const fs = require("fs");
const path = require("path");
const rgssad = require("./archive/rgssad.js");

const ARCHIVE_NAMES = ["Game.rgss3a", "Game.rgss2a", "Game.rgssad"];

function has(dir, re) {
  try { return fs.readdirSync(dir).some((f) => re.test(f)); } catch (e) { return false; }
}
function isDir(d) {
  try { return fs.statSync(d).isDirectory(); } catch (e) { return false; }
}

/**
 * @returns {null | {kind: string, dataDir: string|null, live: string, packed?: boolean,
 *                   archive?: string, archiveVersion?: number}}
 */
function detectEngine(dir) {
  const candidates = [
    { dataDir: path.join(dir, "www", "data") },
    { dataDir: path.join(dir, "data") },
  ];
  for (const c of candidates) {
    if (!isDir(c.dataDir)) continue;
    const hasJson = has(c.dataDir, /\.json$/i);
    // A VX Ace game may also carry a "data" folder; .rvdata2 wins. Trusting the folder name
    // alone made VX Ace titles whose Data/ holds only .rvdata2 report as MV with zero
    // strings (measured on two games: 0 and 22 entries instead of 143 and 935).
    if (hasJson && !has(c.dataDir, /\.rvdata2$/i) && !has(c.dataDir, /\.rvdata$/i)) {
      return { kind: "MV", dataDir: c.dataDir, live: c.dataDir };
    }
  }
  // Packed FIRST, before the loose folders: when a game carries an RGSSAD container, the engine loads its
  // data from the container and ignores the loose Data/ folder sitting beside it, so patching the loose
  // files changes nothing in the game.
  //
  // Measured on a VX Ace title whose owner had unpacked it by hand with a third-party tool, leaving both
  // Game.rgss3a and Data/*.rvdata2 in place: the pair was taken as loose, 248,400 strings were replaced in
  // Data\, the run reported success — and the game still displayed Japanese. The version byte decides the
  // engine, not the filename.
  for (const n of ARCHIVE_NAMES) {
    const a = path.join(dir, n);
    if (!fs.existsSync(a)) continue;
    let version = 0;
    try { version = rgssad.archiveVersion(a); } catch (e) { }
    // Only a real container counts (1 = VX, 3 = VX Ace). A file that merely carries the name — a leftover
    // or a stray copy — must not drag a loose game down the packed path, where the unpack would fail.
    if (version !== 1 && version !== 3) continue;
    return { kind: version === 3 ? "VXAce" : "VX", dataDir: null, live: dir, packed: true, archive: a, archiveVersion: version };
  }
  // VX / VX Ace loose, with no container anywhere: a Data folder holding .rvdata2 (Ace) or .rvdata (VX).
  for (const name of ["Data", "data"]) {
    const d = path.join(dir, name);
    if (!isDir(d)) continue;
    if (has(d, /\.rvdata2$/i)) return { kind: "VXAce", dataDir: d, live: d, packed: false };
    if (has(d, /\.rvdata$/i)) return { kind: "VX", dataDir: d, live: d, packed: false };
  }
  return null;
}

module.exports = { detectEngine, ARCHIVE_NAMES };
