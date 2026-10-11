// Assertions for the Text2Frame extractor/patcher.
//
// The plugin replays text/*.txt by line number, so the one thing that must never break is the line
// count: a pass that merges two lines or drops a blank one shifts every message after it and the game
// reads the wrong text from the wrong scene. These checks pin that, plus the details that make a second
// run safe (the pristine copy, the Chinese skip) and the two folder layouts.
//
// Run:  node tools/unit-text2frame.js
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const T = require("../pipeline/extract/text2frame.js");

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  ok    " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "   " + detail : "")); }
};

const TMP = path.resolve(path.join(os.tmpdir(), "unit-t2f-" + process.pid));
/** Every path this test touches is built here and asserted to stay under TMP. */
function under(root, ...parts) {
  const base = path.resolve(root);
  const t = path.join(base, ...parts);
  if (t !== base && !t.startsWith(base + path.sep)) throw new Error("outside " + base + ": " + parts.join("/"));
  return t;
}
const write = (rel, text) => {
  const p = under(TMP, ...rel.split("/"));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, "utf8");
  return p;
};

// A message file with the shape Text2Frame writes: a blank line between blocks, a speaker line, and a
// dialogue block split across two lines. 7 lines, 5 of them carrying text.
const MESSAGE = [
  "\u3000\u5922\u524d\u548c\u6f22\uff1a",                 // 　夢前和漢：
  "\u300c\u3042\u3042\u3063\u2661\u300d",                 // 「ああっ♡」
  "",
  "\u3000\u7d30\u5c71\uff1a",                             // 　細山：
  "\u300c\u3044\u3044\u3060\u308d\uff1f",
  "\u3000\u3082\u3063\u3068\u3057\u3088\u3046\u305c\u300d",
  "",
].join("\r\n");

try {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(under(TMP, "data"), { recursive: true });
  write("data/System.json", "{}");
  const msgPath = write("text/message.txt", MESSAGE);

  console.log("=== layout: text/ beside the data folder ===");
  const roots = T.textRoots(TMP, under(TMP, "data"));
  check("one text root found", roots.length === 1, "got " + roots.length);
  check("labelled text", roots.length === 1 && roots[0].rel === "text", roots.length ? roots[0].rel : "");

  const r = T.extract(TMP, under(TMP, "data"));
  check("2 files counted", r.files === 1, "files=" + r.files);
  check("5 message lines extracted", r.entries.length === 5, "entries=" + r.entries.length);
  check("the speaker line is included", r.entries.some((e) => e.text.includes("\u5922\u524d\u548c\u6f22")));
  check("blank lines are not queued", !r.entries.some((e) => !e.text.trim()));
  check("file label is text/message.txt", r.entries[0].file === "text/message.txt", r.entries[0].file);
  check("line 0 is addressed as $[0]", r.entries[0].path === "$[0]", r.entries[0].path);
  check("the second line keeps its own index", r.entries[1].path === "$[1]", r.entries[1].path);
  // The index is the line's position in the file, not its position among the entries: entry 2 is the
  // speaker line that follows a blank line, so it must still report $[3].
  check("the line after the blank keeps its file index", r.entries[2].path === "$[3]", r.entries[2].path);

  console.log("");
  console.log("=== pristine snapshot before anything is written ===");
  const made = T.ensureBackup(TMP, under(TMP, "data"));
  check("one backup folder created", made.length === 1, JSON.stringify(made));
  check("the backup holds the message file", fs.existsSync(under(TMP, "text_原版备份", "message.txt")));
  check("a second call makes nothing", T.ensureBackup(TMP, under(TMP, "data")).length === 0);

  console.log("");
  console.log("=== patch: line count must be identical ===");
  const before = fs.readFileSync(msgPath, "utf8");
  const map = new Map(r.entries.map((e, i) => [e.text, "\u8bd1\u6587" + (i + 1)]));   // 译文N
  const rep = T.patch(TMP, under(TMP, "data"), { lookup: (t) => map.get(t) }, null);
  const after = fs.readFileSync(msgPath, "utf8");
  check("every extracted line replaced", rep.replaced === 5, "replaced=" + rep.replaced);
  check("nothing missing", rep.missing === 0, "missing=" + rep.missing);
  check("one file written", rep.files === 1, "files=" + rep.files);
  const lc = (s) => s.split(/\r?\n/).length;
  check("line count unchanged", lc(before) === lc(after), lc(before) + " -> " + lc(after));
  check("blank lines still blank", after.split(/\r?\n/)[2] === "", JSON.stringify(after.split(/\r?\n/)[2]));
  check("CRLF preserved", !/[^\r]\n/.test(after));
  check("line 4 replaced, line 5 replaced separately", after.includes("\u8bd1\u65873") && after.includes("\u8bd1\u65874"), JSON.stringify(after.split(/\r?\n/).slice(3, 6)));

  console.log("");
  console.log("=== a second run must not re-queue the Chinese ===");
  const r2 = T.extract(TMP, under(TMP, "data"));
  check("the pristine lines are still the source", r2.entries.length === 5, "entries=" + r2.entries.length);
  check("every live line is skipped as already Chinese", r2.skipped === 5, "skipped=" + r2.skipped);
  check("the pristine file is untouched", fs.readFileSync(under(TMP, "text_原版备份", "message.txt"), "utf8") === MESSAGE);

  console.log("");
  console.log("=== the other layout: www/text ===");
  fs.rmSync(under(TMP, "text"), { recursive: true, force: true });
  fs.rmSync(under(TMP, "text_原版备份"), { recursive: true, force: true });
  fs.mkdirSync(under(TMP, "www", "data"), { recursive: true });
  write("www/data/System.json", "{}");
  write("www/text/message.txt", MESSAGE);
  const rootsW = T.textRoots(TMP, under(TMP, "www", "data"));
  check("one www text root found", rootsW.length === 1, "got " + rootsW.length);
  check("labelled www/text", rootsW.length === 1 && rootsW[0].rel === "www/text", rootsW.length ? rootsW[0].rel : "");
  const rw = T.extract(TMP, under(TMP, "www", "data"));
  check("www layout extracts the same five lines", rw.entries.length === 5, "entries=" + rw.entries.length);
  check("file label is www/text/message.txt", rw.entries[0].file === "www/text/message.txt", rw.entries[0].file);

  console.log("");
  console.log("=== a game with no text folder is left alone ===");
  fs.rmSync(under(TMP, "www", "text"), { recursive: true, force: true });
  const r0 = T.extract(TMP, under(TMP, "www", "data"));
  check("no entries", r0.entries.length === 0, "entries=" + r0.entries.length);
  check("no files", r0.files === 0, "files=" + r0.files);
  check("no backup created", T.ensureBackup(TMP, under(TMP, "www", "data")).length === 0);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log("");
console.log("  pass " + pass + "   fail " + fail);
process.exit(fail ? 1 : 0);
