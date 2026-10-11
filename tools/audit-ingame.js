// "The UI says translated, the game is still Japanese" - find those games.
//
// The UI's numbers come from OUR artifacts (extract, cache, report), so they measure "how much of what
// we extracted is translated". That is not the same as "how much of the game the player sees is
// Chinese": an engine whose text we only partly extract, an archive the game reads instead of the
// files we wrote, or a state note that says "not supported" all break the equivalence.
//
// This reads, for every game:
//   * what the UI claims   - work\games-state.json (State/Note) and the game's -translate-report.json
//   * what the engine loads - the data folder the engine actually reads, scanned for Japanese kana
//     versus Chinese (byte-level, so it works for .json and for Marshal .rvdata2 alike)
// and prints the games where the claim and the loaded data disagree.
//
// usage: node tools/audit-ingame.js [--all|gameDir ...] [--json]
"use strict";
const fs = require("fs");
const path = require("path");

const WORK = path.resolve(__dirname, "..", "work");
const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const dirs = argv.filter((a) => !a.startsWith("--"));

function within(root, name) {
  if (typeof name !== "string" || name === "" || name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new Error("refusing unsafe name: " + JSON.stringify(name));
  }
  const t = path.resolve(root, name);
  if (t !== root && !t.startsWith(root + path.sep)) throw new Error("outside root: " + name);
  return t;
}
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };

/** Which data folder does the engine read? (nw.js bundle reads www\data; a plain MV project reads data/) */
function engineData(gameDir) {
  const bundled = isDir(path.join(gameDir, "www")) &&
    (isFile(path.join(gameDir, "nw.dll")) || isFile(path.join(gameDir, "package.json")) || isFile(path.join(gameDir, "Game.exe")));
  const cands = [];
  if (bundled) cands.push(path.join(gameDir, "www", "data"));
  cands.push(path.join(gameDir, "data"), path.join(gameDir, "Data"), path.join(gameDir, "www", "data"));
  for (const c of cands) if (isDir(c) && fs.readdirSync(c).some((f) => /\.(json|rvdata2?|rxdata)$/i.test(f))) return c;
  return null;
}

/** Japanese kana vs Chinese characters, counted over the raw bytes (works for .json and Marshal). */
function scriptRatio(dir, exts) {
  let kana = 0, han = 0, files = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!exts.test(f)) continue;
    let buf;
    try { buf = fs.readFileSync(within(dir, f)); } catch (e) { continue; }
    files++;
    const s = buf.toString("utf8");
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      if ((cp >= 0x3040 && cp <= 0x30ff) || cp === 0x30fc) kana++;
      else if (cp >= 0x3400 && cp <= 0x9fff) han++;
    }
  }
  const total = kana + han;
  return { files: files, kana: kana, han: han, kanaPct: total ? (100 * kana / total) : 0 };
}

const states = new Map();
try {
  for (const g of JSON.parse(fs.readFileSync(path.join(WORK, "games-state.json"), "utf8"))) {
    if (g && g.Dir) states.set(String(g.Dir), { State: g.State || "", Note: g.Note || "" });
  }
} catch (e) { /* the state file is optional */ }

function reportFor(gameDir) {
  const stem = path.basename(gameDir).replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_").slice(0, 60);
  try {
    const j = JSON.parse(fs.readFileSync(path.join(WORK, stem + "-translate-report.json"), "utf8"));
    return { entries: j.entries, translated: j.translated };
  } catch (e) { return null; }
}

let games = dirs;
if (!games.length) {
  try {
    games = JSON.parse(fs.readFileSync(path.join(WORK, "games-cache.json"), "utf8")).map((g) => String(g && g.Dir || "")).filter(Boolean);
  } catch (e) { console.log("读不到 games-cache.json"); process.exit(1); }
}

const rows = [];
for (const g of games) {
  if (!isDir(g)) continue;
  const data = engineData(g);
  if (!data) continue;
  const rel = path.relative(g, data).replace(/\\/g, "/") || ".";
  const ext = /(^|\/)(www\/)?(data|Data)$/.test(rel) ? (rel.includes("www") ? /\.json$/i : /\.(json|rvdata2?|rxdata)$/i) : /\.(json|rvdata2?|rxdata)$/i;
  const live = scriptRatio(data, /\.(json|rvdata2?|rxdata)$/i);
  const bakDir = path.join(g, "data_原版备份");
  const bakData = isDir(path.join(bakDir, "Data")) ? path.join(bakDir, "Data") : bakDir;
  const bak = isDir(bakData) ? scriptRatio(bakData, /\.(json|rvdata2?|rxdata)$/i) : null;
  const archive = ["Game.rgss3a", "Game.rgssad", "Game.rgss2a", "Data.rgss3a"].filter((f) => isFile(path.join(g, f)));
  const st = states.get(g) || { State: "", Note: "" };
  const rep = reportFor(g);
  rows.push({ game: path.basename(g), dir: g, dataDir: rel, live: live, backup: bak, archive: archive,
    uiState: st.State, uiNote: st.Note, report: rep });
}

if (asJson) { console.log(JSON.stringify(rows, null, 1)); }
else {
  console.log("=== 每局：UI 的说法 vs 游戏真正加载的数据里还剩多少日文 ===");
  console.log("  游戏".padEnd(40) + "数据目录        备份假名%  现役假名%   我们的报告(已译/条目)   UI 状态");
  const suspects = [];
  for (const r of rows.sort((a, b) => (b.live.kanaPct || 0) - (a.live.kanaPct || 0))) {
    const claim = r.report ? (r.report.translated + "/" + r.report.entries) : "-";
    const pct = r.report && r.report.entries ? Math.round(100 * r.report.translated / r.report.entries) : null;
    console.log("  " + String(r.game).slice(0, 38).padEnd(38) +
      String(r.dataDir).slice(0, 14).padEnd(16) +
      (r.backup ? r.backup.kanaPct.toFixed(1).padStart(9) : "        -") +
      (r.live ? r.live.kanaPct.toFixed(1).padStart(10) : "         -") +
      (claim + (pct !== null ? " (" + pct + "%)" : "")).padStart(22) + "   " + (r.uiState || "-").slice(0, 18));
    // the symptom: our report claims a high share, but the data the engine loads is still kana-heavy
    const claimed = pct !== null && pct >= 60;
    const stillJapanese = r.live && r.backup && r.live.kanaPct >= 0.6 * r.backup.kanaPct && r.live.kanaPct > 20;
    if (claimed && stillJapanese) suspects.push(r);
    else if (r.archive.length) suspects.push(Object.assign({ archiveOnly: true }, r));
  }
  console.log("");
  console.log("=== 「报告说翻了、游戏里其实多半还是日文」的游戏: " + suspects.filter((s) => !s.archiveOnly).length + " 个 ===");
  for (const s of suspects.filter((x) => !x.archiveOnly)) {
    console.log("   " + s.game);
    console.log("      数据目录 " + s.dataDir + "（备份假名 " + s.backup.kanaPct.toFixed(1) + "% → 现役 " + s.live.kanaPct.toFixed(1) + "%）" +
      "   报告 " + s.report.translated + "/" + s.report.entries + "    UI: " + s.uiState + " / " + s.uiNote);
  }
  const arch = suspects.filter((x) => x.archiveOnly);
  if (arch.length) {
    console.log("");
    console.log("=== 另外：存在打包归档的游戏（" + arch.length + " 个，游戏可能从归档读数据）===");
    for (const s of arch) console.log("   " + String(s.game).slice(0, 50).padEnd(52) + s.archive.join(", "));
  }
}
