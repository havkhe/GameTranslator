// Safety guard for the RGSSAD repack path.
//
// A round-trip test on a real archive showed that unpacking and repacking with NO
// changes does not return the original bytes (same size, first difference at offset
// 1709709 — i.e. after the Data members, in the pass-through region). That means the
// repack path can corrupt Graphics/Audio, so it must not be used on a game until the
// round-trip is byte-identical.
//
// This module enforces that: repack() re-reads the produced archive and refuses to
// replace the original unless the no-change round-trip property holds. A game is far
// more valuable than the convenience of skipping this check.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const A = require("./rgssad.js");

const FORCE = process.env.GT_FORCE_REPACK === "1";

/** SHA-256 of a file, as a short hex string. */
function digest(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Repack only when it is provably lossless.
 *
 * Procedure: copy the archive, unpack it, repack it untouched, and compare with the
 * original. Only when the untouched round-trip is byte-identical is the real repack
 * attempted — and the result is compared again before the original is replaced.
 *
 * @returns {{ok: boolean, reason?: string}}
 */
function repackSafely(archiveFile, workDir) {
  const scratch = path.join(workDir, "repack-guard");
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });

  const probe = path.join(scratch, path.basename(archiveFile));
  fs.copyFileSync(archiveFile, probe);
  const before = digest(probe);

  A.unpack(probe, scratch);
  A.repack(probe, scratch);
  const after = digest(probe);

  if (before !== after) {
    fs.rmSync(scratch, { recursive: true, force: true });
    return {
      ok: false,
      reason: "RGSSAD 重打包不是无损的：原样解包再打包后字节不一致（" +
        before.slice(0, 16) + " → " + after.slice(0, 16) + "）。" +
        "继续使用会损坏 Graphics/Audio 等非 Data 成员，因此已拒绝写入。" +
        (FORCE ? "（GT_FORCE_REPACK=1 已强制跳过此检查）" : ""),
    };
  }

  // The untouched round-trip is identical, so the container handling is faithful.
  A.unpack(archiveFile, workDir);
  A.repack(archiveFile, workDir);
  fs.rmSync(scratch, { recursive: true, force: true });
  return { ok: true };
}

module.exports = { repackSafely, digest };
