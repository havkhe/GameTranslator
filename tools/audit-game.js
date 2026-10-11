// End-of-run audit for one game: the standard closing step.
//
// This replaces the ad-hoc verification the watchdog used, whose "resource names changed" count
// matched every key ending in `name` — including CommonEvents[N].name and Map*[*].events[N].name,
// which are editor labels. On the moralist game that reported 9043 "changes" when the number of
// genuine resource-reference changes was zero, and the resulting "needs attention" verdict was
// wrong. Two smaller faults in the same checker are fixed here as well: it never looked at strings
// inside arrays (so a polluted System.json terms.commands was invisible) and never looked at
// resources/<locale>/, where plugin-based games keep their dialogue.
//
// Exit code 0 = no defect, 1 = defects found, 3 = no JSON data (VX Ace / packed, not covered here).
//
// Usage:  node tools/audit-game.js <gameDir> [--json]
"use strict";
const path = require("path");
const { auditGame } = require("./audit-lib.js");

const GAME = path.resolve(process.argv[2] || ".");
const AS_JSON = process.argv.includes("--json");
const { report, defects, nodata } = auditGame(GAME);

if (nodata) {
  console.log("AUDIT_NODATA 未找到 JSON 数据目录（MV/MZ）。VX Ace 的 .rvdata2/归档不在本工具范围内。");
  process.exit(3);
}

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(defects ? 1 : 0);
}

const say = (s) => console.log(s);
say("=== audit: " + report.game + " ===");
say("  data    : " + report.live);
say("  backup  : " + (report.backup || "(none — resource and echo comparisons skipped)"));
say("");
say("  files parsed : " + report.files + "   strings " + report.totalStrings +
  "   kana-bearing " + report.kanaStrings);
say("                 (kana-bearing counts every string in data/, including script and plugin");
say("                  blobs the extractor never targets — dialogue coverage is reported below)");
say("");
const line = (label, n, isDefect) => say("  [" + (n ? (isDefect ? "BAD " : "info") : " ok ") + "] " +
  label.padEnd(34) + String(n));
line("unparsable data files", report.unparsable.length, true);
line("prompt-instruction residue", report.promptEcho.length, true);
line("degenerate (word-salad) values", report.degradation.length, true);
line("resource refs changed", report.resourceChanged.length, true);
line("non-string values changed", report.nonStringChanged.length, true);
line("control-code pollution", report.codePollution.length, true);
line("audio broken by translation", report.audioBrokenByTranslation.length, true);
say("  [info] editor labels changed           " + report.editorLabels + "   (shown only in the editor)");
say("  [info] audio unresolved              live " + report.audioUnresolvedLive +
  " / original " + report.audioUnresolvedBackup + "   (the original's own gaps are not defects)" +
  (report.audioAttributionSkipped ? "   [no backup: breakage not attributed]" : ""));
const d = report.dialogue;
if (d && d.files) {
  const pct = d.kanaBackup ? (100 * (d.kanaBackup - d.kanaLive) / d.kanaBackup) : 0;
  say("  [info] dialogue: " + d.files + " file(s), " + d.total + " strings" +
    ", kana now " + d.kanaLive + " (original " + d.kanaBackup + "), translated " + pct.toFixed(1) + "%");
}

const dump = (title, list, fmt, limit) => {
  if (!list.length) return;
  say(""); say("=== " + title + " ===");
  for (const x of list.slice(0, limit)) say("  " + fmt(x));
  if (list.length > limit) say("  … " + (list.length - limit) + " more");
};
dump("unparsable", report.unparsable, (x) => x.file + " — " + x.err, 20);
dump("prompt residue", report.promptEcho, (x) => x.file + "  " + x.key + "\n      echo [" + x.echo + "]  value " + JSON.stringify(x.value), 40);
{
  const real = report.degradation.filter((x) => !x.editorLabel);
  const labels = report.degradation.filter((x) => x.editorLabel);
  if (report.degradation.length) {
    say("");
    say("=== degenerate (word-salad) values ===");
    say("  " + real.length + " in player-visible content, " + labels.length + " in editor labels");
    for (const x of real.slice(0, 40)) say("  " + x.file + "  " + x.key + "\n      " + JSON.stringify(x.value).slice(0, 140) + "\n      bigrams " + x.bigrams.slice(0, 4).join(","));
    if (real.length > 40) say("  … " + (real.length - 40) + " more");
  }
}
dump("resource references changed", report.resourceChanged, (x) => x.file + "  " + x.key + "\n      original " + JSON.stringify(x.from) + "\n      now      " + JSON.stringify(x.to), 40);
dump("non-string values changed", report.nonStringChanged, (x) => x.file + "  " + x.key + "  " + x.from + " -> " + x.to, 20);
dump("control-code pollution", report.codePollution, (x) => x.file + "  " + x.key + "\n      lost " + JSON.stringify(x.lost) + "  added " + JSON.stringify(x.added) + "\n      original " + JSON.stringify(x.from) + "\n      now      " + JSON.stringify(x.to), 40);
dump("audio broken by translation", report.audioBrokenByTranslation, (x) => JSON.stringify(x), 20);
dump("no backup twin", report.missingInBackup, (x) => x, 40);

say("");
say("AUDIT_VERDICT " + (defects ? "DEFECTS " + defects : "CLEAN") + " " + path.basename(report.game));
process.exit(defects ? 1 : 0);
