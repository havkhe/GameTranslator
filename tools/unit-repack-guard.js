// The repack guard, and the property it must judge: CONTENT, not bytes.
//
// Why this test exists: the guard originally required the untouched unpack→repack round-trip to be
// byte-identical. RGSSAD v3 derives each member's key by advancing through the stream, so a container
// layout difference of a few bytes re-encrypts everything after it — on a real game archive that made
// 99.6 % of the bytes differ while every member was identical, so the guard refused a patch that was in
// fact safe and the game stayed Japanese. These cases pin the new rule: bytes may differ, content may not.
//
//   node tools/unit-repack-guard.js
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const G = require("../pipeline/archive/repack-guard.js");
const codec = require("../pipeline/archive/codec.js");

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (ok) { pass++; console.log("  pass  " + name); }
  else { fail++; console.log("  FAIL  " + name + "   得到 " + JSON.stringify(got) + "，应为 " + JSON.stringify(want)); }
};

const dir = path.join(os.tmpdir(), "gt-guard-" + Date.now());
fs.mkdirSync(dir, { recursive: true });

/** Build a small v3 archive: two members, one under Data/ (the part a translation touches), one outside. */
function build(file, dataBytes, extraBytes) {
  codec.writeArchiveTo([
    { name: "Data/Test.rvdata2", size: dataBytes.length, buf: dataBytes },
    { name: "Graphics/pic.png", size: extraBytes.length, buf: extraBytes },
  ], file);
  return file;
}

try {
  const a = build(path.join(dir, "a.rgss3a"), Buffer.from("DATA-AAAA"), Buffer.from("PIC-1111"));
  const fpA = G.contentFingerprint(a);
  check("小归档内容指纹：成员数", fpA.count, 2);

  // Same content, different container bytes: pad the file. The codec reads members by their recorded
  // offsets, so trailing bytes change the digest but not a single member.
  const b = path.join(dir, "b.rgss3a");
  fs.copyFileSync(a, b);
  fs.appendFileSync(b, Buffer.from("padding-12by"));
  check("两份归档的整文件摘要不同（模拟 v3 的排版差异）", G.digest(a) !== G.digest(b), true);
  check("但内容指纹判定为一致", G.sameContent(G.contentFingerprint(a), G.contentFingerprint(b)).same, true);

  // A member whose bytes changed must be caught, and the message must name it.
  const c = build(path.join(dir, "c.rgss3a"), Buffer.from("DATA-BBBB"), Buffer.from("PIC-1111"));
  const vc = G.sameContent(G.contentFingerprint(a), G.contentFingerprint(c));
  check("成员内容变了 → 不一致", vc.same, false);
  check("原因里点名了成员", /Test\.rvdata2/.test(vc.reason), true);

  // A member that disappeared must be caught by the count.
  const d = path.join(dir, "d.rgss3a");
  codec.writeArchiveTo([{ name: "Data/Test.rvdata2", size: 9, buf: Buffer.from("DATA-AAAA") }], d);
  const vd = G.sameContent(G.contentFingerprint(a), G.contentFingerprint(d));
  check("少了成员 → 不一致", vd.same, false);
  check("原因里说明了条目数变化", /条目数/.test(vd.reason), true);

  // And the whole guard still runs end to end on a real archive: it must accept this one.
  const work = path.join(dir, "work");
  fs.mkdirSync(work, { recursive: true });
  const ok = G.repackSafely(a, work);
  check("repackSafely 接受一个内容可无损往返的归档", ok.ok, true);
  check("并且报告了成员数", ok.entries, 2);
  check("写回后成员还在", G.contentFingerprint(a).count, 2);

  console.log("");
  console.log("pass " + pass + "   fail " + fail);
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
}
try { process.exit(fail ? 1 : 0); } catch (e) { }
