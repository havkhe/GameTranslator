// Assertions for scenario-folder support (pipeline/extract/scenario.js).
//
// Some games keep the whole script in scenario/*.json as event-command lists, and the data folder holds
// only a plugin parameter naming the file. The extractor and patcher must cover that folder, must take a
// pristine copy before writing, and must leave any non-command JSON in the folder alone.
//
// Run:  node tools/unit-scenario.js
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const S = require("../pipeline/extract/scenario.js");
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

const LINE = "\u3053\u308c\u306f\u7269\u8a9e\u306e\u4e00\u884c\u3067\u3059\u3002";        // これは物語の一行です。
const LINE2 = "\u3075\u3080\u3001\u898b\u4e8b\u306a\u3082\u306e\u3060\u3002";              // ふむ、見事なものだ。
const TMP = path.resolve(path.join(os.tmpdir(), "unit-scenario-" + process.pid));

try {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(under(TMP, "data"), { recursive: true });
  fs.mkdirSync(under(TMP, "scenario"), { recursive: true });
  fs.writeFileSync(under(TMP, "data", "System.json"), "{}", "utf8");
  // The story: one object keyed by scenario name, each value an event-command list.
  fs.writeFileSync(under(TMP, "scenario", "Scenario.json"), JSON.stringify({
    "\u30aa\u30fc\u30d7\u30cb\u30f3\u30b0_01": [
      { code: 101, parameters: ["", 0, 0, 2, "\u30b7\u30f3\u30b8"] },
      { code: 401, parameters: [LINE] },
      { code: 401, parameters: [LINE2] },
    ],
  }), "utf8");
  // A config file in the same folder that must NOT be touched.
  fs.writeFileSync(under(TMP, "scenario", "config.json"), JSON.stringify({ name: "設定", width: 800 }), "utf8");
  fs.writeFileSync(under(TMP, "data", "Map001.json"), JSON.stringify({ events: [{ pages: [{ list: [{ code: 401, parameters: ["\u30c7\u30fc\u30bf\u5074\u306e\u4e00\u884c"] }] }] }] }), "utf8");

  console.log("=== locating the folder ===");
  const roots = S.scenarioRoots(TMP, under(TMP, "data"));
  check("one scenario root found", roots.length === 1, "got " + roots.length);
  check("labelled scenario", roots.length === 1 && roots[0].rel === "scenario", roots.length ? roots[0].rel : "");

  console.log("");
  console.log("=== a non-command JSON in the folder is ignored ===");
  check("config.json rejected by the filter", !S.accept("config.json", under(TMP, "scenario", "config.json")));
  check("Scenario.json accepted", S.accept("Scenario.json", under(TMP, "scenario", "Scenario.json")));

  console.log("");
  console.log("=== pristine snapshot before anything is written ===");
  const made = S.ensureBackup(TMP, under(TMP, "data"));
  check("one backup folder created", made.length === 1, JSON.stringify(made));
  check("the backup holds the scenario file", fs.existsSync(under(TMP, "scenario_原版备份", "Scenario.json")));
  check("a second call makes nothing", S.ensureBackup(TMP, under(TMP, "data")).length === 0);

  console.log("");
  console.log("=== extraction ===");
  const r = S.extract(TMP, under(TMP, "data"));
  const texts = r.entries.map((e) => e.text);
  check("both story lines extracted", texts.includes(LINE) && texts.includes(LINE2), JSON.stringify(texts));
  check("the data file's line is not in this set", !texts.includes("\u30c7\u30fc\u30bf\u5074\u306e\u4e00\u884c"));
  check("the location carries the folder name", r.entries[0].file === "scenario/Scenario.json", r.entries[0].file);
  check("the config file contributed nothing", !texts.includes("\u8a2d\u5b9a"), JSON.stringify(texts));

  console.log("");
  console.log("=== patching writes the scenario file and leaves the config alone ===");
  const map = new Map([[LINE, "\u8fd9\u662f\u6545\u4e8b\u7684\u4e00\u884c\u3002"], [LINE2, "\u55ef\uff0c\u771f\u662f\u4e86\u4e0d\u8d77\u3002"]]);
  const rep = S.patch(TMP, under(TMP, "data"), { lookup: (t) => map.get(t) }, null);
  check("two values replaced", rep.replaced === 2, "replaced=" + rep.replaced);
  check("one file written", rep.files === 1, "files=" + rep.files);
  const live = JSON.parse(fs.readFileSync(under(TMP, "scenario", "Scenario.json"), "utf8"));
  const list = live["\u30aa\u30fc\u30d7\u30cb\u30f3\u30b0_01"];
  check("the story line is Chinese now", list[1].parameters[0] === map.get(LINE), JSON.stringify(list[1].parameters[0]));
  check("the second line too", list[2].parameters[0] === map.get(LINE2));
  const cfg = JSON.parse(fs.readFileSync(under(TMP, "scenario", "config.json"), "utf8"));
  check("the config file is byte-identical", cfg.name === "\u8a2d\u5b9a" && cfg.width === 800);

  console.log("");
  console.log("=== the pristine copy is the source on a second run ===");
  const r2 = S.extract(TMP, under(TMP, "data"));
  check("the original text is still the source", r2.entries.some((e) => e.text === LINE), JSON.stringify(r2.entries.map((e) => e.text)));
  check("the translated lines are skipped", r2.skipped >= 2, "skipped=" + r2.skipped);

  console.log("");
  console.log("=== a game without a scenario folder ===");
  fs.rmSync(under(TMP, "scenario"), { recursive: true, force: true });
  fs.rmSync(under(TMP, "scenario_原版备份"), { recursive: true, force: true });
  const r0 = S.extract(TMP, under(TMP, "data"));
  check("no entries", r0.entries.length === 0, "entries=" + r0.entries.length);
  check("no files", r0.files === 0, "files=" + r0.files);
  check("no backup created", S.ensureBackup(TMP, under(TMP, "data")).length === 0);

  console.log("");
  console.log("=== the data walker is unaffected when no filter is given ===");
  const dataOnly = mv.extract(under(TMP, "data"), under(TMP, "data"));
  check("data extraction still finds its line", dataOnly.entries.some((e) => e.text === "\u30c7\u30fc\u30bf\u5074\u306e\u4e00\u884c"));
  const other = patch.patch(under(TMP, "data"), { lookup: () => undefined }, null);
  check("patching the data folder with an empty cache changes nothing", other.files === 0, "files=" + other.files);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log("");
console.log("  pass " + pass + "   fail " + fail);
process.exit(fail ? 1 : 0);
