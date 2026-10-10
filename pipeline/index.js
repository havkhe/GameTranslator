// Pipeline entry point (v3).
//
// Usage:
//   node pipeline/index.js <gameDir> <workDir> <port> [mode] [promptFile] [modelName]
//
//   mode = translate (default) | extract | check
//
// The work directory holds the same per-game files as v2, so an existing work folder
// keeps working: <sanitised-name>-{extract,translations,failures,patch-report}.json.
//
// Stages: detect engine -> locate source (pristine backup when present) -> extract ->
// translate -> patch the live files. Each stage prints a single machine-readable line
// so the GUI can follow progress without parsing prose.
"use strict";
const fs = require("fs");
const path = require("path");

const GAME_DIR = process.argv[2];
const WORK_DIR = process.argv[3];
const PORT = parseInt(process.argv[4] || "18080", 10);
const MODE = process.argv[5] || "translate";
const PROMPT_FILE = process.argv[6] || "";

if (!GAME_DIR || !WORK_DIR) {
  console.log("USAGE: node pipeline/index.js <gameDir> <workDir> <port> [mode] [promptFile]");
  process.exit(2);
}

const sanitize = (name) => name.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_").slice(0, 60);
const GAME_NAME = sanitize(path.basename(path.resolve(GAME_DIR)));
const EXTRACT = path.join(WORK_DIR, GAME_NAME + "-extract.json");
const TRANS = path.join(WORK_DIR, GAME_NAME + "-translations.json");
const FAILURES = path.join(WORK_DIR, GAME_NAME + "-failures.json");
const PATCH_REPORT = path.join(WORK_DIR, GAME_NAME + "-patch-report.json");

const { isTranslatable } = require("./extract/rules.js");
const mvExtract = require("./extract/mv.js");
const { translate } = require("./translate/index.js");
const mvPatch = require("./patch/mv.js");

const BACKUP_DIRNAME = "data_原版备份";

/** Which engine is this, and where does its data live? */
function detectEngine(dir) {
  const has = (d, re) => {
    try { return fs.readdirSync(d).some((f) => re.test(f)); } catch (e) { return false; }
  };
  const candidates = [
    { kind: "MV", dataDir: path.join(dir, "www", "data") },
    { kind: "MV", dataDir: path.join(dir, "data") },
  ];
  for (const c of candidates) {
    if (!fs.existsSync(c.dataDir)) continue;
    const hasJson = has(c.dataDir, /\.json$/i);
    // A VX Ace game may also carry a "data" folder; .rvdata2 wins (the v2 bug that
    // reported VX Ace titles as MV with zero strings).
    if (hasJson && !has(c.dataDir, /\.rvdata2$/i) && !has(c.dataDir, /\.rvdata$/i)) {
      return { kind: "MV", dataDir: c.dataDir, live: c.dataDir };
    }
  }
  return null;
}

(async () => {
  console.log("GAME", GAME_DIR);
  fs.mkdirSync(WORK_DIR, { recursive: true });

  const engine = detectEngine(GAME_DIR);
  if (!engine) {
    console.log("NOT_SUPPORTED 无法识别的游戏引擎（v3 P1 支持 RPG Maker MV/MZ 的 JSON 数据）");
    process.exit(4);
  }
  console.log("ENGINE", engine.kind, engine.dataDir);

  // Source of truth is the pristine backup when one exists: once a game is translated
  // its live files hold Chinese, and re-reading them would ask the model to translate
  // Chinese into Chinese.
  const backup = path.join(GAME_DIR, BACKUP_DIRNAME);
  const hasBackup = fs.existsSync(backup) && fs.readdirSync(backup).some((f) => /\.json$/i.test(f));
  const sourceDir = hasBackup ? backup : engine.live;
  if (hasBackup) console.log("SOURCE_FROM_BACKUP", backup);

  const { entries, skipped } = mvExtract.extract(sourceDir, engine.live);
  fs.writeFileSync(EXTRACT, JSON.stringify(entries, null, 0), "utf8");
  console.log("EXTRACTED", entries.length, skipped ? "SKIPPED_ALREADY_TRANSLATED " + skipped : "");

  if (MODE === "extract") { console.log("EXTRACT_DONE"); process.exit(0); }

  let template;
  if (PROMPT_FILE && fs.existsSync(PROMPT_FILE)) {
    const custom = fs.readFileSync(PROMPT_FILE, "utf8").trim();
    if (custom.includes("{lines}") || custom.includes("{numbered}")) {
      template = custom;
      console.log("PROMPT_FROM_FILE", PROMPT_FILE);
    } else {
      console.log("PROMPT_FILE_IGNORED 缺少 {lines} 占位符，使用默认提示词");
    }
  }

  const { cache, stats, fails } = await translate({
    entries, cacheFile: TRANS, port: PORT, template,
    onProgress: () => {},
  });

  // A save can be refused to protect an existing cache; report rather than hide it.
  fs.writeFileSync(FAILURES, JSON.stringify(fails, null, 0), "utf8");
  console.log("TRANSLATED", stats.cached, "FAILURES", fails.length, "REQUESTS", stats.requests);

  if (MODE === "check") { console.log("CHECK_DONE"); process.exit(0); }

  const report = mvPatch.patch(engine.live, cache, PATCH_REPORT);
  console.log("PATCHED", report.replaced, "MISSING", report.missing, "FILES", report.files,
    report.errors.length ? "ERRORS " + report.errors.length : "");
  console.log("DONE");
})().catch((e) => {
  console.log("PIPELINE_ERROR", e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : String(e));
  process.exit(1);
});
