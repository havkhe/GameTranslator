// Batch translator: walk every game the GUI scan found and translate them one
// after another, resuming automatically after an interruption.
//
//   node batch-translate.js <modelName> [--order=small|list] [--limit=N] [--only=substring]
//
// State per game lives in the same work directory the GUI uses, so:
//   * a game that is already finished (its patch report exists and the run
//     reported no missing text) is skipped on the next start,
//   * a game that was interrupted resumes from its own cache.
"use strict";
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const APP = "D:\\GameTranslator";
const NODE = path.join(APP, "node", "node.exe");
const PIPELINE = path.join(APP, "game-pipeline.js");
const WORK = path.join(APP, "work");
const CACHE = path.join(WORK, "games-cache.json");
const PORT = "18080";
const SUPPORTED = new Set(["MV", "MZ", "VXAce", "VX"]);

const argv = process.argv.slice(2);
const model = argv.find((a) => !a.startsWith("--")) || "Galtransl-v4-4B-2601.gguf";
const opt = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith("--" + name + "="));
  return hit ? hit.split("=").slice(1).join("=") : dflt;
};
const order = opt("order", "small");
const limit = parseInt(opt("limit", "0"), 10);
const only = opt("only", "");

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sanitize = (dir) => path.basename(dir).replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_");

// ---- the game list: prefer the GUI's own scan result -------------------------
function loadGames() {
  let games = [];
  if (fs.existsSync(CACHE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(CACHE, "utf8"));
      const arr = Array.isArray(raw) ? raw : raw.games || [];
      games = arr
        .filter((g) => g && g.Dir && SUPPORTED.has(g.Kind))
        .map((g) => ({ dir: g.Dir, kind: g.Kind, bytes: g.DataBytes || 0, already: !!g.AlreadyCn }));
    } catch (e) {
      log("games-cache.json unreadable:", e.message);
    }
  }
  if (!games.length) {
    log("no games-cache.json entries; falling back to a filesystem scan of the settings ScanPath");
    let scan = "J:\\game";
    try { scan = JSON.parse(fs.readFileSync(path.join(APP, "settings.json"), "utf8")).ScanPath || scan; } catch (e) {}
    const walk = (d, depth) => {
      if (depth > 4) return;
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      for (const e of ents) {
        if (!e.isDirectory()) continue;
        const p = path.join(d, e.name);
        const kind = detect(p);
        if (kind) games.push({ dir: p, kind, bytes: 0, already: false });
        else walk(p, depth + 1);
      }
    };
    walk(scan, 0);
  }
  return games;
}

function detect(dir) {
  const has = (p) => fs.existsSync(path.join(dir, p));
  if (has("www\\data\\System.json")) return "MZ";
  if (has("data\\System.json")) return "MV";
  if (has("Game.rgss3a")) return "VXAce";
  if (has("Game.rgss2a") || has("Game.rgssad")) return "VX";
  if (fs.existsSync(path.join(dir, "Data"))) {
    try {
      const f = fs.readdirSync(path.join(dir, "Data"));
      if (f.some((x) => x.endsWith(".rvdata2"))) return "VXAce";
      if (f.some((x) => x.endsWith(".rvdata"))) return "VX";
    } catch (e) {}
  }
  return null;
}

// A game counts as finished when its last run reported nothing left to do.
function finished(dir) {
  const base = sanitize(dir);
  const rep = path.join(WORK, base + "-patch-report.json");
  if (!fs.existsSync(rep)) return false;
  try {
    const j = JSON.parse(fs.readFileSync(rep, "utf8"));
    if (typeof j.missing === "number" && j.missing > 0) return false;
    const fails = path.join(WORK, base + "-failures.json");
    if (fs.existsSync(fails)) {
      const f = JSON.parse(fs.readFileSync(fails, "utf8"));
      if (Array.isArray(f) && f.length > 0) return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

function runGame(g) {
  return new Promise((resolve) => {
    const args = [PIPELINE, g.dir, model, WORK, PORT, "translate"];
    const t0 = Date.now();
    log("START  [" + g.kind + "] " + g.dir);
    const child = cp.spawn(NODE, args, { stdio: ["ignore", "pipe", "pipe"] });
    let tail = [];
    let lastProgress = "";
    const onData = (d) => {
      for (const line of String(d).split(/\r?\n/)) {
        if (!line.trim()) continue;
        if (/^PROGRESS/.test(line)) { lastProgress = line; continue; }
        if (/^(EXTRACTED|TOTAL|TRANSLATED|FAILURES|PATCHED|PATCH_MISSING|CACHE_LOADED|MODEL_DEGRADED|STALL)/.test(line)) {
          tail.push(line);
          if (tail.length > 12) tail.shift();
        }
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("close", (code) => {
      const mins = ((Date.now() - t0) / 60000).toFixed(1);
      log("END    code=" + code + " in " + mins + " min  last=" + (lastProgress || "n/a"));
      tail.forEach((l) => log("       " + l));
      resolve({ code, mins, tail });
    });
  });
}

(async () => {
  let games = loadGames();
  if (only) games = games.filter((g) => g.dir.toLowerCase().includes(only.toLowerCase()));
  const pending = games.filter((g) => !finished(g.dir));
  const skipped = games.length - pending.length;
  log("games in scan: " + games.length + "   already finished: " + skipped + "   to translate: " + pending.length);
  log("model: " + model);
  // Smallest first: it finishes many games early instead of being stuck inside one
  // huge title, and a small game is the best smoke test that the pipeline is well.
  if (order === "small") pending.sort((a, b) => (a.bytes || 0) - (b.bytes || 0));
  const todo = limit > 0 ? pending.slice(0, limit) : pending;
  log("this run will process: " + todo.length);

  let done = 0, failed = 0;
  for (const g of todo) {
    const ok = await runGame(g);
    if (ok.code === 0) done++; else failed++;
    fs.writeFileSync(path.join(WORK, "batch-status.json"), JSON.stringify({
      model, order, startedCount: todo.length, done, failed,
      last: g.dir, lastCode: ok.code, updated: new Date().toISOString(),
    }, null, 2), "utf8");
  }
  log("BATCH COMPLETE  ok=" + done + "  failed=" + failed + "  of " + todo.length);
})();
