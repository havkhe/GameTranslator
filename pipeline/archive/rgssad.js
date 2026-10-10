// RGSSAD archive codec for v3.
//
// PORTED, NOT REWRITTEN. The crypto lives in codec.js (copied verbatim from the v2
// rgss3a.js module, which v2 itself kept separate). It was validated in v2 by byte-level
// comparison: a 400 MB synthetic v3 archive round-tripped byte-identically, and 436 +
// 1297 real archives decrypted to exactly the data already on disk and repacked
// byte-identically. Re-deriving that on the one code path that can destroy a game would
// trade proven behaviour for guesses, so this file only adds the v3 orchestration on
// top: version detection, unpack into a work folder, and repack from that folder.
//
// v1/v2 (VX / XP: Game.rgss2a, Game.rgssad) and v3 (VX Ace: Game.rgss3a) share the
// reader; the key schedule and header differ, which the codec handles.
"use strict";
const fs = require("fs");
const path = require("path");
const codec = require("./codec.js");

const RGSSAD_MAGIC = 0x52475753;   // "RGSS"

/** Archive version from the header byte: 1, 2 or 3 (0 = not an archive). */
function archiveVersion(file) {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(8);
    fs.readSync(fd, head, 0, 8, 0);
    if (head.readUInt32LE(0) !== RGSSAD_MAGIC) return 0;
    return head.readUInt8(7);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Unpack every Data/ member into <workDir>\unpacked, remembering the rest in a manifest
 * so repacking can copy them through untouched.
 */
function unpack(archiveFile, workDir) {
  const outDir = path.join(workDir, "unpacked");
  const manifestPath = path.join(workDir, "manifest.json");
  if (fs.existsSync(path.join(outDir, "Data")) && fs.existsSync(manifestPath)) {
    return { outDir, manifestPath, cached: true };
  }
  console.log("UNPACKING", archiveFile);
  const arch = codec.readArchive(fs.readFileSync(archiveFile));
  const manifest = [];
  fs.mkdirSync(outDir, { recursive: true });
  for (const e of arch.entries) {
    const rel = e.name.replace(/\\/g, "/");
    manifest.push({ name: e.name, size: e.size });
    if (!rel.startsWith("Data/")) continue;
    const data = codec.extractFile(arch, e);
    const fp = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, data);
  }
  fs.writeFileSync(path.join(workDir, "archive.json"),
    JSON.stringify({ name: path.basename(archiveFile), version: arch.version }));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  console.log("UNPACKED", arch.entries.length, "entries, version", arch.version);
  return { outDir, manifestPath, version: arch.version };
}

/**
 * Rebuild the archive from <workDir>\unpacked, replacing the Data/ members with the
 * translated files and copying everything else through byte-for-byte.
 *
 * The pass-through matters: Graphics and Audio are hundreds of megabytes, and for v1/v2
 * the whole archive shares ONE key stream, so an already-encrypted member cannot be
 * re-encrypted without double-encrypting it.
 */
function repack(archiveFile, workDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(workDir, "manifest.json"), "utf8"));
  const outDir = path.join(workDir, "unpacked");
  const origBuf = fs.readFileSync(archiveFile);
  const arch = codec.readArchive(origBuf);
  const byName = new Map();
  for (const e of arch.entries) byName.set(e.name, e);

  const entries = [];
  for (const m of manifest) {
    const orig = byName.get(m.name);
    if (!orig) throw new Error("manifest entry missing in original archive: " + m.name);
    const rel = m.name.replace(/\\/g, "/");
    if (rel.startsWith("Data/")) {
      const fp = path.join(outDir, rel);
      entries.push({ name: m.name, size: fs.statSync(fp).size, file: fp });
    } else if (arch.version === 1 || arch.version === 2) {
      const raw = Buffer.from(origBuf.subarray(orig.offset, orig.offset + orig.size));
      entries.push({ name: m.name, size: orig.size, buf: raw, raw: true });
    } else {
      const raw = origBuf.subarray(orig.offset, orig.offset + orig.size);
      entries.push({ name: m.name, size: orig.size, buf: raw });
    }
  }

  const outTmp = archiveFile + ".new";
  console.log("REPACKING", archiveFile);
  if (arch.version === 1 || arch.version === 2) codec.writeArchiveV1To(entries, outTmp, arch.version);
  else codec.writeArchiveTo(entries, outTmp);
  fs.renameSync(outTmp, archiveFile);
  console.log("REPACKED", entries.length, "entries");
  return arch.version;
}

module.exports = { archiveVersion, unpack, repack, RGSSAD_MAGIC, codec };
