// Alignment audit: for every game, is each translated string sitting where its source was?
//
// For every string position, compare the pristine backup (data_原版备份) with the live data and the
// game's own translation cache (work\<stem>-translations.json):
//
//   aligned            live[P] is exactly what the dictionary says backup[P] means
//   misaligned         live[P] is Chinese, the dictionary has backup[P], but live[P] is something else
//   elsewhere          live[P] is Chinese and the dictionary has no entry for backup[P] at all
//                      (written by an older run or by another tool - ambiguous on its own)
//   shifted            misaligned AND the dictionary's translation of backup[P] is sitting at a
//                      NEIGHBOURING position in the same file - the fingerprint of a batch whose
//                      reply lines were paired to the wrong inputs
//
// "shifted" is the one that matters: it cannot be explained by a stale dictionary, because the right
// translation is right there, one array slot away.
//
// usage:
//   node tools/audit-alignment.js [gameDir ...] [--all] [--json] [--quiet]
"use strict";
const fs = require("fs");
const path = require("path");

const WORK = path.resolve(__dirname, "..", "work");
const CACHE = path.join(WORK, "games-cache.json");
const argv = process.argv.slice(2);
const wantAll = argv.includes("--all") || argv.filter((a) => !a.startsWith("--")).length === 0;
const asJson = argv.includes("--json");
const quiet = argv.includes("--quiet");
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
const jsonCount = (p) => { try { return fs.readdirSync(p).filter((f) => /\.json$/i.test(f)).length; } catch (e) { return -1; } };

/** The name the pipeline gives a game's work files. */
const stemOf = (name) => String(name).replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_").slice(0, 60);

/** Where the live data and the pristine backup are, for MV/MZ (flat .json) and VX (nested under Data). */
function locate(gameDir) {
  const cands = [];
  const live = ["", "www"].map((w) => path.join(gameDir, w || ".", "data")).filter(isDir);
  // The backup sits BESIDE the data folder for a plain layout, but at the GAME ROOT for a bundled
  // one (www\data + <root>\data_原版备份) — which is the layout the reported game uses.
  for (const d of live) {
    const roots = [path.dirname(d), gameDir];
    for (const r of roots) {
      for (const b of [path.join(r, "data_原版备份"), path.join(r, "data_原版备份", "Data")]) {
        if (isDir(b) && jsonCount(b) > 0) cands.push({ live: d, bak: b });
      }
    }
  }
  if (!cands.length) return null;
  return cands.sort((a, b) => jsonCount(b.bak) - jsonCount(a.bak))[0];
}

function flatten(node, at, out) {
  if (typeof node === "string") { out[at] = node; return; }
  if (Array.isArray(node)) { node.forEach((v, i) => flatten(v, at + "[" + i + "]", out)); return; }
  if (node && typeof node === "object") { for (const k of Object.keys(node)) flatten(node[k], at + "." + k, out); }
}

/** The numeric index a path ends with, for the "one array slot away" test. */
function trailIndex(p) {
  const m = p.match(/\[(\d+)\]$/);
  return m ? Number(m[1]) : null;
}
function parentPath(p) {
  const m = p.match(/^(.*)\[\d+\]$/);
  return m ? m[1] : null;
}

function audit(gameDir) {
  const loc = locate(gameDir);
  if (!loc) return null;
  const stem = stemOf(path.basename(gameDir));
  const cacheFile = path.join(WORK, stem + "-translations.json");
  if (!fs.existsSync(cacheFile)) return { game: gameDir, skipped: "没有本局的译文缓存" };
  let dict;
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    dict = j && j.byText ? j.byText : {};
  } catch (e) { return { game: gameDir, skipped: "缓存读不动" }; }

  // live strings -> their paths, so "the right translation is one slot away" can be tested
  const liveByText = new Map();
  const perFile = [];
  let compared = 0, changed = 0, aligned = 0, misaligned = 0, elsewhere = 0, shifted = 0;
  const examples = [];

  for (const f of fs.readdirSync(loc.bak).filter((x) => /\.json$/i.test(x))) {
    const lp = within(loc.live, f);
    if (!fs.existsSync(lp)) continue;
    let b, l;
    try {
      b = JSON.parse(fs.readFileSync(within(loc.bak, f), "utf8"));
      l = JSON.parse(fs.readFileSync(lp, "utf8"));
    } catch (e) { continue; }
    const bo = {}, lo = {};
    flatten(b, "$", bo);
    flatten(l, "$", lo);
    const lIndex = new Map();
    for (const p of Object.keys(lo)) if (typeof lo[p] === "string") lIndex.set(p, lo[p]);

    let fMis = 0, fShift = 0;
    for (const p of Object.keys(bo)) {
      const bt = bo[p], lt = lo[p];
      if (typeof bt !== "string" || typeof lt !== "string") continue;
      compared++;
      if (lt === bt) continue;
      changed++;
      const want = dict[bt];
      if (want === undefined) { elsewhere++; continue; }
      if (want === lt) { aligned++; continue; }
      misaligned++;
      fMis++;
      // is the right translation one array slot away in the same parent?
      const base = parentPath(p);
      const i = trailIndex(p);
      let nearby = false;
      if (base !== null && i !== null) {
        for (let d = 1; d <= 8 && !nearby; d++) {
          for (const q of [base + "[" + (i + d) + "]", base + "[" + (i - d) + "]"]) {
            if (i - d < 0) continue;
            if (lIndex.get(q) === want) { nearby = true; break; }
          }
        }
      }
      if (nearby) {
        shifted++;
        fShift++;
        if (examples.length < 5) examples.push({ file: f, path: p, source: bt, want: want, got: lt });
      }
    }
    if (fMis) perFile.push({ file: f, misaligned: fMis, shifted: fShift });
    for (const p of Object.keys(lo)) if (typeof lo[p] === "string" && lo[p]) liveByText.set(lo[p], p);
  }

  return {
    game: path.basename(gameDir), dir: gameDir, cacheEntries: Object.keys(dict).length,
    compared: compared, changed: changed, aligned: aligned, misaligned: misaligned,
    elsewhere: elsewhere, shifted: shifted,
    worstFiles: perFile.sort((a, b) => b.misaligned - a.misaligned).slice(0, 4),
    examples: examples,
  };
}

// ---------------------------------------------------------------- which games
let games = [];
if (!wantAll) {
  games = dirs;
} else {
  try {
    const list = JSON.parse(fs.readFileSync(CACHE, "utf8"));
    games = (Array.isArray(list) ? list : []).map((g) => String(g && g.Dir || "")).filter(Boolean);
  } catch (e) { console.log("读不到 games-cache.json：" + e.message); }
}

const rows = [];
for (const g of games) {
  if (!isDir(g)) continue;
  const r = audit(g);
  if (r) rows.push(r);
}

if (asJson) {
  console.log(JSON.stringify(rows, null, 1));
} else {
  const withCache = rows.filter((r) => !r.skipped);
  const affected = withCache.filter((r) => r.shifted > 0);
  if (!quiet) {
    console.log("=== 逐位置核对（原版备份 vs 现役数据 vs 本局译文缓存）===");
    console.log("  游戏".padEnd(42) + "比对     改动   对位对    对位错   挪到隔壁   词典里没这条");
    for (const r of withCache.sort((a, b) => b.shifted - a.shifted)) {
      if (!r.changed) continue;
      console.log("  " + String(r.game).slice(0, 40).padEnd(40) +
        String(r.compared).padStart(7) + String(r.changed).padStart(8) +
        String(r.aligned).padStart(8) + String(r.misaligned).padStart(8) +
        String(r.shifted).padStart(10) + String(r.elsewhere).padStart(12));
    }
    console.log("");
  }
  console.log("有缓存可核对的游戏: " + withCache.length + " 个（另有 " + rows.filter((r) => r.skipped).length + " 个没缓存，跳过）");
  console.log("**出现错位（挪到隔壁）的游戏: " + affected.length + " 个**");
  for (const r of affected.sort((a, b) => b.shifted - a.shifted)) {
    console.log("   " + String(r.game).slice(0, 46).padEnd(46) + "错位 " + String(r.misaligned).padStart(5) +
      "  其中挪到隔壁 " + String(r.shifted).padStart(5) + "   " + (r.worstFiles[0] ? r.worstFiles[0].file : ""));
  }
  fs.writeFileSync(path.join(WORK, "..", "alignment-audit.json"), JSON.stringify(rows, null, 1), "utf8");
  console.log("");
  console.log("明细已写入 " + path.resolve(WORK, "..", "alignment-audit.json"));
}
