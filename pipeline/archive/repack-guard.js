// Safety guard for the RGSSAD repack path.
//
// What the guard is for: the repack path rebuilds the whole archive, so a container bug would damage
// Graphics/Audio members the translator never touched. A game is far more valuable than the convenience of
// skipping the check, so the archive is only replaced once a no-change round-trip has been shown to
// preserve it.
//
// Why it judges CONTENT, not bytes (2026-10-13): the first version compared whole-file SHA-256 of the
// untouched round-trip. On a real archive (a 54 MB, 999-entry RGSSAD v3 game) that test refuses a repack
// that is in fact perfect: RGSSAD v3 derives each member's key by advancing through the stream, so a
// container-layout difference of **12 bytes** re-keys every later byte — 99.6 % of the file differs while
// every extracted member is byte-identical (measured: 447/447 members, names+sizes+SHA-256). The
// byte test therefore refused archives that would have been safe, and the game stayed Japanese.
//
// So the check now compares every entry by name and by the bytes the codec extracts for it
// (`contentFingerprint`), which is the property that actually matters, and keeps the whole-file digest
// only as reporting. Both failure modes stay caught: a member whose bytes change, and an entry that
// disappears or appears (entry count is compared too).
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
 * What an archive holds, independent of how its container is laid out: every entry as
 * "<name>\0<sha256 of the bytes the codec extracts>", sorted. Sorted so member order and duplicate names
 * cannot fake a difference, and the count is kept separately so an entry that vanishes is caught even when
 * the surviving names all match.
 *
 * @returns {{count: number, rows: string[]}}
 */
function contentFingerprint(archiveFile) {
  const arch = A.codec.readArchive(fs.readFileSync(archiveFile));
  const rows = arch.entries.map((e) =>
    String(e.name) + "\u0000" + crypto.createHash("sha256").update(A.codec.extractFile(arch, e)).digest("hex"));
  rows.sort();
  return { count: arch.entries.length, rows: rows };
}

/** Do two fingerprints describe the same content? */
function sameContent(a, b) {
  if (a.count !== b.count) return { same: false, reason: "条目数 " + a.count + " → " + b.count };
  for (let i = 0; i < a.rows.length; i++) {
    if (a.rows[i] !== b.rows[i]) {
      const name = a.rows[i].split("\u0000")[0];
      return { same: false, reason: "成员内容不一致：" + name };
    }
  }
  return { same: true };
}

/**
 * Repack only when it is provably lossless *in content*.
 *
 * Procedure: copy the archive, unpack it, repack it untouched, then compare the content fingerprints of
 * the original and the round-tripped copy. Only when they match is the real repack attempted.
 *
 * @returns {{ok: boolean, reason?: string, entries?: number, bytesChanged?: boolean}}
 */
function repackSafely(archiveFile, workDir) {
  const scratch = path.join(workDir, "repack-guard");
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });

  const probe = path.join(scratch, path.basename(archiveFile));
  fs.copyFileSync(archiveFile, probe);

  try {
    if (FORCE) {
      console.log("REPACK_GUARD  GT_FORCE_REPACK=1：跳过检查，直接写回");
    } else {
      const beforeBytes = digest(probe);
      const before = contentFingerprint(probe);

      A.unpack(probe, scratch);
      A.repack(probe, scratch);

      const after = contentFingerprint(probe);
      const verdict = sameContent(before, after);
      const afterBytes = digest(probe);
      const bytesChanged = beforeBytes !== afterBytes;

      if (!verdict.same) {
        return {
          ok: false,
          reason: "RGSSAD 重打包会改变归档内容（" + verdict.reason + "），已拒绝写入以免损坏游戏。" +
            "这是容器/编解码的问题，不是译文的问题：数据目录里的译文仍然有效。",
        };
      }
      console.log("REPACK_GUARD  原样往返：内容一致（" + before.count + " 个成员）" +
        (bytesChanged ? "，字节不同（容器排版差异，v3 会因此整体重新加密；内容已逐个成员核对）" : "，字节也一致"));
    }

    // Content round-trips, so the container handling is faithful for this archive.
    A.unpack(archiveFile, workDir);
    A.repack(archiveFile, workDir);
    return { ok: true, entries: contentFingerprint(archiveFile).count };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

module.exports = { repackSafely, digest, contentFingerprint, sameContent };
