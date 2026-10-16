// The unpack cache must notice when the archive it was taken from changes.
//
// Why this test exists: the unpacked copy is reused between runs (unpacking a 2 GB container every time would
// be wasteful), but it was reused *unconditionally*. Measured on a real game: the user restored the original
// archive from the backup, re-ran, the pipeline never re-unpacked, patched the previous run's leftover copy
// and repacked that — so the bad translation came straight back and "restore and re-run" silently did nothing.
//
//   node tools/unit-unpack-cache.js
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const R = require("../pipeline/archive/rgssad.js");
const codec = require("../pipeline/archive/codec.js");

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (ok) { pass++; console.log("  pass  " + name); }
  else { fail++; console.log("  FAIL  " + name + "   得到 " + JSON.stringify(got) + "，应为 " + JSON.stringify(want)); }
};

const root = path.join(os.tmpdir(), "gt-unpackcache-" + Date.now());
fs.mkdirSync(root, { recursive: true });

function makeArchive(file, text) {
  codec.writeArchiveTo([
    { name: "Data/Test.rvdata2", size: Buffer.byteLength(text), buf: Buffer.from(text, "utf8") },
    { name: "Graphics/x.png", size: 4, buf: Buffer.from("PIC1") },
  ], file);
  return file;
}

try {
  const live = makeArchive(path.join(root, "Game.rgss3a"), "ORIGINAL");
  const work = path.join(root, "work");
  fs.mkdirSync(work, { recursive: true });

  // 1) First unpack: nothing cached yet, so it unpacks.
  const first = R.unpack(live, work, live);
  check("首次解包不是缓存命中", first.cached === true, false);
  const dataFile = path.join(work, "unpacked", "Data", "Test.rvdata2");
  check("解包出的数据在 unpacked/Data 下", fs.existsSync(dataFile), true);
  check("内容正确", fs.readFileSync(dataFile, "utf8"), "ORIGINAL");
  check("记录了来源指纹", fs.existsSync(path.join(work, "unpack-source.json")), true);

  // 2) Second call with the archive untouched: this one IS the cache.
  const second = R.unpack(live, work, live);
  check("归档未变时复用缓存", second.cached, true);

  // 3) The archive changes underneath (a restore from backup, another tool, a manual edit). Its size and
  //    mtime move; the cached copy is stale and must not be reused.
  fs.writeFileSync(dataFile, "PATched");                      // simulate a patched leftover copy
  makeArchive(live, "RESTORED-FROM-BACKUP");                  // new size, new mtime
  const third = R.unpack(live, work, live);
  check("归档变化后不再复用缓存", third.cached === true, false);
  check("而且真的把内容换回归档里的那份", fs.readFileSync(dataFile, "utf8"), "RESTORED-FROM-BACKUP");

  // 4) And the new state becomes the cache again.
  const fourth = R.unpack(live, work, live);
  check("重新解包之后又开始复用", fourth.cached, true);

  // 5) No live file given: behave like before (cache whenever it is there), so a caller that does not know the
  //    live path keeps working.
  const fifth = R.unpack(live, work, undefined);
  check("不传 liveFile 时保持旧行为", fifth.cached, true);

  console.log("");
  console.log("pass " + pass + "   fail " + fail);
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { }
}
try { process.exit(fail ? 1 : 0); } catch (e) { }
