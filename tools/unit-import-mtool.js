// Assertions for the MTool translation importer.
//
// The import must take only what this project would translate, and the cache's own guards must still
// apply to an imported value: a pair MTool accepted is not automatically fit to write into a game.
//
// Run:  node tools/unit-import-mtool.js
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { importFromGame } = require("./import-mtool.js");

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  ok    " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "   " + detail : "")); }
};

const TMP = path.resolve(path.join(os.tmpdir(), "unit-import-" + process.pid));
function under(root, ...parts) {
  const base = path.resolve(root);
  const t = path.join(base, ...parts);
  if (t !== base && !t.startsWith(base + path.sep)) throw new Error("outside " + base + ": " + parts.join("/"));
  return t;
}

// One entry per filter, so a regression names itself.
const SRC = {
  "\u30ad\u30e3\u30f3\u30bb\u30eb": "\u53d6\u6d88",                    // キャンセル -> 取消      keep
  "\u30ed\u30fc\u30c9\u753b\u9762": "\u8bfb\u53d6\u753b\u9762",        // ロード画面 -> 读取画面  keep
  "\u3042\u306e\u5b50\u306e\\n[1]\u300d": "\u90a3\u4e2a\u5b69\u5b50\u7684\\n[1]\u300d",   // same code -> keep
  "\u30bb\u30fc\u30d6": "\u30bb\u30fc\u30d6",                          // identity                drop
  "338": "338",                                                        // numeric id              drop
  "Heal3": "\u6cbb\u7597",                                             // source has no kana      drop
  "\u30c6\u30b9\u30c8": "\u8fd8\u662f\u30c6\u30b9\u30c8",              // value still has kana    drop
  "\u30c1\u30a7\u30b9\u30c8\u30a6\u30c3\u30c9": "\u6bcf\u884c\u8f93\u51fa\u4e00\u6761\u8bd1\u6587\uff0c\u4e0d\u8981\u7f16\u53f7\u3001",   // instruction echo -> refused
  "\u300c\\n[1]\u3055\u3093\u300d": "\u300c\\n[2]\u5148\u751f\u300d",   // control-code mismatch   -> refused
};
const EXPECTED = ["\u30ad\u30e3\u30f3\u30bb\u30eb", "\u30ed\u30fc\u30c9\u753b\u9762", "\u3042\u306e\u5b50\u306e\\n[1]\u300d"];

// The auto-scan path only looks at root JSON files that are large enough and hold at least 200 keys,
// so pad the file with identity pairs: they are dropped by the identity filter and leave the expected
// set unchanged.
for (let i = 0; i < 240; i++) {
  const k = "\u30d5\u30a3\u30e9\u30fc" + String(i).padStart(3, "0") + "\u30c6\u30ad\u30b9\u30c8\u884c";
  SRC[k] = k;
}

try {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(under(TMP, "game", "data"), { recursive: true });
  fs.mkdirSync(under(TMP, "work"), { recursive: true });
  fs.writeFileSync(under(TMP, "game", "data", "System.json"), "{}", "utf8");
  fs.writeFileSync(under(TMP, "game", "A\u7ffb\u8bd1.json"), JSON.stringify(SRC, null, 4), "utf8");

  const s = importFromGame({ game: under(TMP, "game"), work: under(TMP, "work"), apply: true, top: 5 });
  console.log("--- summary ---");
  console.log("  read " + s.readPairs + "  notText " + s.skippedNotText + "  noKana " + s.skippedNoKana +
    "  badValue " + s.skippedValue + "  already " + s.already + "  added " + s.added + "  refused " + s.refused);
  console.log("");

  check("the cache file was written", fs.existsSync(under(TMP, "work", "game-translations.json")));
  const byText = JSON.parse(fs.readFileSync(under(TMP, "work", "game-translations.json"), "utf8")).byText;
  const has = (k) => Object.prototype.hasOwnProperty.call(byText, k);

  check("a plain pair is imported", has("\u30ad\u30e3\u30f3\u30bb\u30eb") && byText["\u30ad\u30e3\u30f3\u30bb\u30eb"] === "\u53d6\u6d88");
  check("an identity pair is not imported", !has("\u30bb\u30fc\u30d6") && s.skippedValue >= 1);
  check("a numeric id is not imported", !has("338"));
  check("a source without kana is not imported", !has("Heal3"));
  check("a value that is still Japanese is not imported", !has("\u30c6\u30b9\u30c8"));
  check("an instruction echo is refused by the cache", !has("\u30c1\u30a7\u30b9\u30c8\u30a6\u30c3\u30c9") && s.refused >= 1);
  check("a control-code mismatch is refused by the cache", !has("\u300c\\n[1]\u3055\u3093\u300d"));
  check("a code-matching pair is imported", has("\u3042\u306e\u5b50\u306e\\n[1]\u300d"));
  check("the exact expected set landed", Object.keys(byText).length === EXPECTED.length && EXPECTED.every(has),
    "got " + JSON.stringify(Object.keys(byText)));
  check("exactly two pairs were refused", s.refused === 2, "refused=" + s.refused);
  check("nothing to back up on a first import", !s.backup, "backup=" + s.backup);

  console.log("");
  console.log("=== a second import is idempotent, and backs the cache up ===");
  const s2 = importFromGame({ game: under(TMP, "game"), work: under(TMP, "work"), apply: true });
  check("existing entries are recognised as already present", s2.already === EXPECTED.length, "already=" + s2.already);
  check("nothing new added", s2.added === 0, "added=" + s2.added);
  check("the cache was left untouched", s2.cacheSize === EXPECTED.length, "size=" + s2.cacheSize);

  console.log("");
  console.log("=== an import that adds to an existing cache backs it up first ===");
  // Seed the cache with one unrelated entry, so the import has something to add and something to lose.
  fs.writeFileSync(under(TMP, "work", "game-translations.json"),
    JSON.stringify({ version: 3, byText: { "\u6d4b\u8bd5\u8272": "\u30c6\u30b9\u30c8\u8272\u3067\u3059" } }), "utf8");
  const s3 = importFromGame({ game: under(TMP, "game"), work: under(TMP, "work"), apply: true });
  check("the added pairs were imported", s3.added === EXPECTED.length, "added=" + s3.added);
  check("a backup of the previous cache was kept", !!s3.backup && fs.existsSync(s3.backup), "backup=" + JSON.stringify(s3.backup));
  check("the seeded entry survived the import", Object.prototype.hasOwnProperty.call(
    JSON.parse(fs.readFileSync(under(TMP, "work", "game-translations.json"), "utf8")).byText, "\u6d4b\u8bd5\u8272"));

  console.log("");
  console.log("=== a dry run must not write ===");
  fs.rmSync(under(TMP, "work", "game-translations.json"), { force: true });
  const d = importFromGame({ game: under(TMP, "game"), work: under(TMP, "work") });
  check("nothing written on a dry run", !fs.existsSync(under(TMP, "work", "game-translations.json")));
  check("the dry run still counted what it would add", d.added === EXPECTED.length, "added=" + d.added);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log("");
console.log("  pass " + pass + "   fail " + fail);
process.exit(fail ? 1 : 0);
