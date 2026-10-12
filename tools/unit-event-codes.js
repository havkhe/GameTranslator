// Assertions for the MV/MZ event-parameter tables, using code 101 — the one command whose text slot is
// not obvious.
//
// MV  command101: setFaceImage(params[0], params[1]) …          slot 0 = face file name
// MZ  the same, plus setSpeakerName(params[4])                  slot 4 = speaker name (real text)
//
// Two failures are possible and both matter: queueing slot 0 renames nothing on disk and breaks the face
// image, and missing slot 4 leaves a Japanese name box above Chinese dialogue. The test drives the real
// extractor and patcher over a synthetic game, so both directions are proven rather than only the table.
//
// Run:  node tools/unit-event-codes.js
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const R = require("../pipeline/extract/rules.js");
const mv = require("../pipeline/extract/mv.js");
const patch = require("../pipeline/patch/mv.js");

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  ok    " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "   " + detail : "")); }
};
const under = (root, ...parts) => {
  const base = path.resolve(root);
  const t = path.join(base, ...parts);
  if (t !== base && !t.startsWith(base + path.sep)) throw new Error("outside " + base);
  return t;
};

const FACE = "\u3061\u3093\u3074\u3089";                 // ちんぴら — a real kana face name from the library
const SPEAKER = "\u30c0\u30f3\u30b8\u30e7\u30f3\u6e2c\u91cf\u58eb \u30da\u30fc\u30bf\u30fc";
const LINE = "\u300c\u3053\u306e\u9053\u306f\u3084\u3081\u3068\u3051\u300d";

const MZ = {
  list: [
    { code: 101, parameters: [FACE, 0, 0, 2, SPEAKER] },   // face name, face index, bg, position, speaker
    { code: 401, parameters: [LINE] },
  ],
};
const MV = {
  list: [
    { code: 101, parameters: [FACE, 0, 0, 2] },             // MV has no speaker parameter
    { code: 401, parameters: [LINE] },
  ],
};

const TMP = path.resolve(path.join(os.tmpdir(), "unit-event-codes-" + process.pid));
try {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(under(TMP, "data"), { recursive: true });
  fs.writeFileSync(under(TMP, "data", "Map001.json"), JSON.stringify({ events: [{ pages: [{ list: MZ.list }] }] }), "utf8");
  fs.writeFileSync(under(TMP, "data", "Map002.json"), JSON.stringify({ events: [{ pages: [{ list: MV.list }] }] }), "utf8");

  console.log("=== the table itself ===");
  check("code 101 targets slot 4", JSON.stringify(R.EVENT_TEXT_CODES.get(101)) === "[4]", JSON.stringify(R.EVENT_TEXT_CODES.get(101)));
  check("code 101 does not target slot 0", !R.EVENT_TEXT_CODES.get(101).includes(0));
  check("code 401 still targets slot 0", (R.EVENT_TEXT_CODES.get(401) || []).includes(0));

  console.log("");
  console.log("=== extraction ===");
  const r = mv.extract(under(TMP, "data"), under(TMP, "data"));
  const texts = r.entries.map((e) => e.text);
  check("the MZ speaker name is queued", texts.includes(SPEAKER), JSON.stringify(texts.slice(0, 4)));
  check("the face file name is NOT queued", !texts.includes(FACE));
  check("the dialogue body is queued", texts.includes(LINE));
  check("exactly two entries", r.entries.length === 2, "entries=" + r.entries.length + " " + JSON.stringify(texts));

  console.log("");
  console.log("=== patching, with a cache that claims to know the face name ===");
  const map = new Map([[FACE, "\u8be5\u9690\u8005"], [SPEAKER, "\u5730\u7262\u6d4b\u91cf\u5458 \u5f7c\u5f97"], [LINE, "\u300c\u522b\u8d70\u8fd9\u6761\u8def\u4e86\u300d"]]);
  const rep = patch.patch(under(TMP, "data"), { lookup: (t) => map.get(t) }, null);
  const mz = JSON.parse(fs.readFileSync(under(TMP, "data", "Map001.json"), "utf8"));
  const mvDoc = JSON.parse(fs.readFileSync(under(TMP, "data", "Map002.json"), "utf8"));
  const cmd = (doc) => doc.events[0].pages[0].list[0];
  const line = (doc) => doc.events[0].pages[0].list[1];

  check("the face name is left untouched", cmd(mz).parameters[0] === FACE, JSON.stringify(cmd(mz).parameters[0]));
  check("the MZ speaker name is translated", cmd(mz).parameters[4] === map.get(SPEAKER), JSON.stringify(cmd(mz).parameters[4]));
  check("the dialogue body is translated", line(mz).parameters[0] === map.get(LINE));
  check("an MV command's face name is also untouched", cmd(mvDoc).parameters[0] === FACE, JSON.stringify(cmd(mvDoc).parameters[0]));
  check("an MV command has nothing at slot 4 to touch", cmd(mvDoc).parameters.length === 4);
  check("two files were written", rep.files === 2, "files=" + rep.files);
  // Three, not four: the MZ speaker and the two dialogue bodies. The face name is deliberately not one
  // of them even though the cache holds a translation for it.
  check("three values were replaced, never the face name", rep.replaced === 3, "replaced=" + rep.replaced);

  // RPG Maker MV writes some of its own files with a leading UTF-8 BOM. JSON.parse throws on that, and
  // every read site used to swallow the error and skip the file — so System.json, which holds the whole
  // terms block (menu labels, the messages for saving and loading, the names of skill types and elements),
  // was neither extracted nor patched, and the patch report listed its strings as "missing" with no reason.
  console.log("");
  console.log("=== a data file with a UTF-8 BOM (System.json) ===");
  const bomDir = under(TMP, "bom", "data");
  fs.mkdirSync(bomDir, { recursive: true });
  const terms = { messages: ["\u30bb\u30fc\u30d6", "\u30ed\u30fc\u30c9"], basic: ["\u653b\u6483", "\u9632\u5fa1"] };
  fs.writeFileSync(under(bomDir, "System.json"), "\uFEFF" + JSON.stringify({ terms: terms, title: "Game", locale: "en_US" }), "utf8");

  const bomEntries = mv.extract(bomDir, bomDir).entries.map((e) => e.text);
  check("BOM 之后的内容照样被抽出（4 个词条）", bomEntries.length === 4, "entries=" + JSON.stringify(bomEntries));
  check("消息表被抽出", bomEntries.includes("\u30bb\u30fc\u30d6"), JSON.stringify(bomEntries));

  const termMap = new Map([["\u30bb\u30fc\u30d6", "\u5b58\u6863"], ["\u30ed\u30fc\u30c9", "\u8bfb\u6863"],
    ["\u653b\u6483", "\u653b\u51fb"], ["\u9632\u5fa1", "\u9632\u5fa1\u529b"]]);
  const bomRep = patch.patch(bomDir, { lookup: (t) => termMap.get(t) }, null);
  const bomRaw = fs.readFileSync(under(bomDir, "System.json"), "utf8");
  check("没有把该文件报成解析错误", bomRep.errors.length === 0, JSON.stringify(bomRep.errors));
  check("四个词条都被替换", bomRep.replaced === 4, "replaced=" + bomRep.replaced);
  check("回写后 BOM 仍然在", bomRaw.charCodeAt(0) === 0xFEFF);
  const bomDoc = JSON.parse(bomRaw.slice(1));
  check("消息表已变中文", bomDoc.terms.messages[0] === "\u5b58\u6863", JSON.stringify(bomDoc.terms.messages));
  check("其它字段原样保留", bomDoc.title === "Game" && bomDoc.locale === "en_US");
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log("");
console.log("  pass " + pass + "   fail " + fail);
process.exit(fail ? 1 : 0);
