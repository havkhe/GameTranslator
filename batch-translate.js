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

// A game counts as finished when its last run actually translated it.
//
// Checking only for the patch report was wrong: a run made while the model server
// was down still writes a patch report (with nothing translated), so the game was
// treated as done and the failure was silently frozen in. A run that translated
// little of what it extracted must be retried, which is what makes this batch
// self-healing after an outage.
function finished(dir) {
  const base = sanitize(dir);
  const rep = path.join(WORK, base + "-patch-report.json");
  if (!fs.existsSync(rep)) return false;
  const tr = path.join(WORK, base + "-translate-report.json");
  if (fs.existsSync(tr)) {
    try {
      const j = JSON.parse(fs.readFileSync(tr, "utf8"));
      const entries = j.entries || 0;
      const translated = j.translated || 0;
      if (entries > 0 && translated < entries * 0.9) return false;   // retry
    } catch (e) {
      return false;
    }
  }
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

// How many strings does the pipeline still consider translatable in this game?
// Used by --recheck to decide whether an "already Chinese" verdict really means
// there is nothing left (the extractor skips Chinese-looking text, so a fully
// translated game yields very few entries; a partially translated one does not).
function quickExtractCount(dir) {
  return new Promise((resolve) => {
    const child = cp.spawn(NODE, [PIPELINE, dir, model, WORK, PORT, "extract"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => { try { child.kill(); } catch (e) {} }, 600000);
    child.on("close", () => {
      clearTimeout(timer);
      const m = out.match(/EXTRACTED (\d+)/);
      const skipped = out.match(/SKIPPED_ALREADY_TRANSLATED (\d+)/);
      const n = m ? parseInt(m[1], 10) : 0;
      // Entries the extractor produced are the ones it would translate; a game that
      // is already Chinese still yields a few (proper nouns, kanji-only labels), so
      // only a substantial count counts as "work left".
      resolve(n - (skipped ? parseInt(skipped[1], 10) : 0) > 50 ? n : 0);
    });
  });
}

function runGame(g) {  return new Promise((resolve) => {
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

  // Respect the scan's own verdict for titles that are already Chinese.
  //
  // The GUI marks a game AlreadyCn when its data files are mostly Han with almost
  // no kana (IsAlreadyTranslated: cn > 500 && kana < cn * 0.2) and its "全部汉化"
  // button skips those. This batch runner used to ignore the flag, so it extracted
  // and "translated" thousands of already-Chinese strings — Chinese into Chinese,
  // wasting hours and risking damage to finished games. Pass --include-cn to
  // override (useful for a game whose Chinese was applied by another tool and is
  // still missing pieces), or --recheck to ask the pipeline itself first.
  const includeCn = argv.includes("--include-cn");
  const recheck = argv.includes("--recheck");
  let alreadyCn = games.filter((g) => g.already);
  if (recheck) {
    // let the extractor count what is actually left before deciding
    const kept = [];
    for (const g of alreadyCn) {
      const out = await quickExtractCount(g.dir);
      if (out > 0) { log("RECHECK " + out + " strings left in " + path.basename(g.dir).slice(0, 40)); kept.push(g); }
      else log("RECHECK nothing to translate in " + path.basename(g.dir).slice(0, 40));
    }
    alreadyCn = [];
    games = games.filter((g) => !g.already).concat(kept);
  } else if (!includeCn) {
    games = games.filter((g) => !g.already);
  }

  const pending = games.filter((g) => !finished(g.dir));
  const skipped = games.length - pending.length;
  log("games in scan: " + loadGames().length +
      "   already Chinese: " + (includeCn ? 0 : alreadyCn.length) +
      "   finished: " + skipped + "   to translate: " + pending.length);
  if (!includeCn && alreadyCn.length) {
    log("skipping (already Chinese, GUI verdict): " + alreadyCn.map((g) => path.basename(g.dir).slice(0, 26)).join(" | "));
  }
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
