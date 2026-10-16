// Which engine does the pipeline think a game is, and where does it think the data lives?
//
// Why this test exists: the answer is silent when it is wrong. A VX Ace title whose owner had unpacked it
// by hand carried BOTH Game.rgss3a and Data/*.rvdata2; the detection looked at the loose folder first, so
// the pipeline patched Data\ (248,400 strings replaced, run reported success) and never touched the
// archive the engine actually reads — the game stayed Japanese. These cases pin the order: a real RGSSAD
// container wins, because the engine loads from it and ignores the loose files beside it.
//
//   node tools/unit-engine-detect.js
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const D = require("../pipeline/engine-detect.js");
const codec = require("../pipeline/archive/codec.js");

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (ok) { pass++; console.log("  pass  " + name); }
  else { fail++; console.log("  FAIL  " + name + "   得到 " + JSON.stringify(got) + "，应为 " + JSON.stringify(want)); }
};

const root = path.join(os.tmpdir(), "gt-detect-" + Date.now());
function mkGame(name) {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
/** A minimal but REAL v3 container (correct magic + version byte), built with the shipped codec. */
function writeArchive(file, dataDirName) {
  codec.writeArchiveTo([
    { name: dataDirName + "/Map001.rvdata2", size: 6, buf: Buffer.from("DATA01") },
  ], file);
  return file;
}

try {
  // 1) MV: www/data with JSON.
  const mv = mkGame("mv");
  fs.mkdirSync(path.join(mv, "www", "data"), { recursive: true });
  fs.writeFileSync(path.join(mv, "www", "data", "Map001.json"), "{}", "utf8");
  const e1 = D.detectEngine(mv);
  check("MV 游戏判为 MV", e1 && e1.kind, "MV");
  check("MV 的数据目录是 www/data", e1 && path.basename(path.dirname(e1.dataDir)), "www");

  // 2) VX Ace, loose only, no container anywhere.
  const loose = mkGame("loose");
  fs.mkdirSync(path.join(loose, "Data"), { recursive: true });
  fs.writeFileSync(path.join(loose, "Data", "Map001.rvdata2"), "x", "utf8");
  const e2 = D.detectEngine(loose);
  check("没有归档时判为散装 VX Ace", e2 && e2.kind + "/" + e2.packed, "VXAce/false");

  // 3) THE CASE THAT BROKE: a real container AND a loose Data folder beside it.
  const both = mkGame("both");
  fs.mkdirSync(path.join(both, "Data"), { recursive: true });
  fs.writeFileSync(path.join(both, "Data", "Map001.rvdata2"), "x", "utf8");
  writeArchive(path.join(both, "Game.rgss3a"), "Data");
  const e3 = D.detectEngine(both);
  check("归档与散装并存时按归档处理", e3 && e3.packed, true);
  check("引擎仍是 VX Ace", e3 && e3.kind, "VXAce");
  check("归档路径指向 Game.rgss3a", e3 && path.basename(e3.archive || ""), "Game.rgss3a");
  check("版本字节读到了 3（VX Ace）", e3 && e3.archiveVersion, 3);
  check("数据目录交给解包流程（不再直接改 Data\\)", e3 && e3.dataDir, null);

  // 4) Packed only, no loose folder — unchanged behaviour.
  const packedOnly = mkGame("packed");
  writeArchive(path.join(packedOnly, "Game.rgss3a"), "Data");
  const e4 = D.detectEngine(packedOnly);
  check("只有归档也判为归档", e4 && e4.packed, true);

  // 5) VX (rgss2a, version 1) is still told apart from VX Ace. The version byte sits at offset 7:
  //    six bytes of magic, then a separator, then the version.
  const vx = mkGame("vx");
  const vxFile = path.join(vx, "Game.rgss2a");
  fs.writeFileSync(vxFile, Buffer.from("RGSSAD" + "\u0000" + "\u0001" + "\u0000".repeat(8), "latin1"));
  const e5 = D.detectEngine(vx);
  check("v1 容器判为 VX", e5 && e5.kind + "/" + e5.archiveVersion, "VX/1");

  // 6) A file that merely carries the name must NOT drag a loose game down the packed path.
  const junk = mkGame("junk");
  fs.mkdirSync(path.join(junk, "Data"), { recursive: true });
  fs.writeFileSync(path.join(junk, "Data", "Map001.rvdata2"), "x", "utf8");
  fs.writeFileSync(path.join(junk, "Game.rgss3a"), "not an archive at all", "latin1");
  const e6 = D.detectEngine(junk);
  check("假的 Game.rgss3a 不会把散装游戏带进归档流程", e6 && e6.packed, false);
  check("并且回落到散装 VX Ace", e6 && e6.kind, "VXAce");

  // 7) Nothing recognisable.
  check("空目录返回 null", D.detectEngine(mkGame("empty")), null);

  console.log("");
  console.log("pass " + pass + "   fail " + fail);
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { }
}
try { process.exit(fail ? 1 : 0); } catch (e) { }
