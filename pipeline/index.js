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
// Install root: the folder holding node\, ruby\, llama\ and pipeline\. Resolved rather than
// hard-coded so the app works wherever it is installed.
const ROOT = path.resolve(__dirname, "..");
const EXTRACT = path.join(WORK_DIR, GAME_NAME + "-extract.json");
const TRANS = path.join(WORK_DIR, GAME_NAME + "-translations.json");
const FAILURES = path.join(WORK_DIR, GAME_NAME + "-failures.json");
const PATCH_REPORT = path.join(WORK_DIR, GAME_NAME + "-patch-report.json");

const { isTranslatable } = require("./extract/rules.js");
const mvExtract = require("./extract/mv.js");
const vxAce = require("./extract/vxace.js");
const resources = require("./extract/resources.js");
const rgssad = require("./archive/rgssad.js");
const repackGuard = require("./archive/repack-guard.js");
const { translate } = require("./translate/index.js");
const mvPatch = require("./patch/mv.js");

const BACKUP_DIRNAME = "data_原版备份";
const ARCHIVE_DIRNAME = "_archive工作";
const ARCHIVE_NAMES = ["Game.rgss3a", "Game.rgss2a", "Game.rgssad"];

/** Which engine is this, and where does its data live? */
function detectEngine(dir) {
  const has = (d, re) => {
    try { return fs.readdirSync(d).some((f) => re.test(f)); } catch (e) { return false; }
  };
  const isDir = (d) => { try { return fs.statSync(d).isDirectory(); } catch (e) { return false; } };
  const candidates = [
    { dataDir: path.join(dir, "www", "data") },
    { dataDir: path.join(dir, "data") },
  ];
  for (const c of candidates) {
    if (!isDir(c.dataDir)) continue;
    const hasJson = has(c.dataDir, /\.json$/i);
    // A VX Ace game may also carry a "data" folder; .rvdata2 wins. Trusting the folder name
    // alone made VX Ace titles whose Data/ holds only .rvdata2 report as MV with zero
    // strings (measured on two games: 0 and 22 entries instead of 143 and 935).
    if (hasJson && !has(c.dataDir, /\.rvdata2$/i) && !has(c.dataDir, /\.rvdata$/i)) {
      return { kind: "MV", dataDir: c.dataDir, live: c.dataDir };
    }
  }
  // VX / VX Ace: a Data folder holding .rvdata2 (Ace) or .rvdata (VX), loose.
  for (const name of ["Data", "data"]) {
    const d = path.join(dir, name);
    if (!isDir(d)) continue;
    if (has(d, /\.rvdata2$/i)) return { kind: "VXAce", dataDir: d, live: d, packed: false };
    if (has(d, /\.rvdata$/i)) return { kind: "VX", dataDir: d, live: d, packed: false };
  }
  // Packed: the data lives inside an RGSSAD container. The version byte decides the engine,
  // not the filename.
  for (const n of ARCHIVE_NAMES) {
    const a = path.join(dir, n);
    if (!fs.existsSync(a)) continue;
    let version = 0;
    try { version = rgssad.archiveVersion(a); } catch (e) { }
    return { kind: version === 3 ? "VXAce" : "VX", dataDir: null, live: dir, packed: true, archive: a, archiveVersion: version };
  }
  return null;
}

/** Make sure the pristine copy of a packed archive exists, so the source is never the live file. */
function ensureArchiveBackup(engine, gameDir) {
  const bakDir = path.join(gameDir, BACKUP_DIRNAME);
  const bak = path.join(bakDir, path.basename(engine.archive));
  if (fs.existsSync(bak)) return bak;
  fs.mkdirSync(bakDir, { recursive: true });
  fs.copyFileSync(engine.archive, bak);
  console.log("BACKUP_CREATED", bak);
  return bak;
}

/**
 * Make sure a loose MV/MZ game has a pristine copy too.
 *
 * Packed games were always protected — ensureArchiveBackup() above runs before anything else — but a
 * loose MV/MZ game with no data_原版备份 had the LIVE data extracted as its source and no backup made
 * at all. The first translation therefore overwrote the only Japanese copy, and because the next run
 * then reads the translated live data, a second translation would send Chinese back through the model.
 *
 * The copy is made once and then reused, exactly like the archive case, so every later run reads the
 * original.
 *
 * Two details matter:
 *
 *   * Language is checked first. If the live data is already Chinese, copying it would create a
 *     "pristine" backup that is itself translated — the worst outcome, because every future run would
 *     then translate from it and report success. In that case nothing is copied and the user is told.
 *   * The dialogue resources are copied too, not just the data folder. Games built with a text plugin
 *     keep their script in resources/<locale>/*.json beside the data folder, and the game archive
 *     names them directly, so a data-only backup would restore a game with data but no dialogue.
 */
function ensureDataBackup(engine, gameDir) {
  const bakDir = path.join(gameDir, BACKUP_DIRNAME);
  if (fs.existsSync(bakDir) && fs.readdirSync(bakDir).some((f) => /\.json$/i.test(f))) return bakDir;

  // Refuse to snapshot data that already looks translated.
  const profile = mvExtract.languageProfile ? mvExtract.languageProfile(engine.live) : null;
  if (profile && profile.total > 50 && profile.chineseLike) {
    console.log("BACKUP_REFUSED", "live data already looks translated (" +
      profile.kana + " kana of " + profile.total + " strings); not creating a backup from it");
    return null;
  }

  try {
    fs.mkdirSync(bakDir, { recursive: true });
    fs.cpSync(engine.live, bakDir, { recursive: true });
    // resources/ holds the dialogue of plugin-based games and sits next to the data folder.
    for (const res of ["resources", "Resources"]) {
      const src = path.join(path.dirname(engine.live), res);
      if (fs.existsSync(src)) fs.cpSync(src, path.join(bakDir, res), { recursive: true });
    }
    console.log("BACKUP_CREATED", bakDir);
    return bakDir;
  } catch (e) {
    console.log("BACKUP_FAILED", e.message);
    return null;
  }
}

(async () => {
  console.log("GAME", GAME_DIR);
  fs.mkdirSync(WORK_DIR, { recursive: true });

  const engine = detectEngine(GAME_DIR);
  if (!engine) {
    console.log("NOT_SUPPORTED 无法识别的游戏引擎（支持 MV/MZ 的 JSON 数据，以及 VX Ace/VX 的 .rvdata2/.rvdata 与 RGSSAD 归档）");
    process.exit(4);
  }
  console.log("ENGINE", engine.kind, engine.dataDir || engine.archive || "");

  // --- packed VX/VX Ace: work on an unpacked copy, never the live archive -------------
  // Unpacking into the work folder keeps the original archive intact until the patched copy
  // is written back, so a failure at any stage leaves the game untouched.
  let dataDir = engine.dataDir;
  let archiveWork = null;
  if (engine.packed) {
    const pristineArchive = ensureArchiveBackup(engine, GAME_DIR);
    const vxWork = path.join(WORK_DIR, GAME_NAME + ARCHIVE_DIRNAME);
    fs.mkdirSync(vxWork, { recursive: true });
    // Always unpack from the pristine backup: the live archive may already hold a previous
    // translation, and re-reading it would send Chinese through the model again.
    const unpackedFrom = path.join(vxWork, "source");
    fs.rmSync(unpackedFrom, { recursive: true, force: true });
    fs.mkdirSync(unpackedFrom, { recursive: true });
    const copy = path.join(unpackedFrom, path.basename(pristineArchive));
    fs.copyFileSync(pristineArchive, copy);
    console.log("SOURCE_FROM_BACKUP", pristineArchive);
    rgssad.unpack(copy, vxWork);
    dataDir = path.join(vxWork, "unpacked", "Data");
    if (!fs.existsSync(dataDir)) dataDir = path.join(vxWork, "unpacked", "data");
    archiveWork = { vxWork, archiveFile: engine.archive };
    console.log("UNPACKED_DATA", dataDir);
  }

  // --- extract ------------------------------------------------------------------------
  let entries, skipped, filtered = 0;
  if (engine.kind === "MV") {
    // Snapshot the original before reading anything, so the source is never the live data and the
    // Japanese text survives the first translation. Packed games already get this from
    // ensureArchiveBackup() above; loose MV/MZ games previously had no protection at all.
    ensureDataBackup(engine, GAME_DIR);

    const backup = path.join(GAME_DIR, BACKUP_DIRNAME);
    const hasBackup = fs.existsSync(backup) && fs.readdirSync(backup).some((f) => /\.json$/i.test(f));
    const sourceDir = hasBackup ? backup : engine.live;
    if (hasBackup) console.log("SOURCE_FROM_BACKUP", backup);
    const r = mvExtract.extract(sourceDir, engine.live);
    entries = r.entries; skipped = r.skipped;
  } else {
    const r = vxAce.extract(dataDir, ROOT, WORK_DIR, EXTRACT + ".vxsrc.json");
    entries = r.entries; skipped = r.skipped; filtered = r.filtered;
    console.log("VX_RAW", r.total, "FILTERED", filtered);
  }

  // Localization resource files hold the dialogue of games built with a text plugin; the event
  // data only carries a resource label. Merged here so the same translation pass covers both.
  if (engine.kind === "MV") {
    const bakData = path.join(GAME_DIR, BACKUP_DIRNAME);
    const pristineData = fs.existsSync(bakData) ? bakData : engine.live;
    const r = resources.extract(pristineData, engine.live);
    if (r.files) {
      console.log("RESOURCES", r.entries.length, "entries from", r.files, "file(s)",
        r.skipped ? "SKIPPED_ALREADY_TRANSLATED " + r.skipped : "");
      const have = new Set(entries.map((e) => e.text));
      for (const e of r.entries) {
        if (have.has(e.text)) continue;
        have.add(e.text);
        entries.push(e);
      }
    }
  }
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

  let failCount = 0;
  const { cache, stats, fails } = await translate({
    entries, cacheFile: TRANS, port: PORT, template,
    // The UI reads PROGRESS to drive its progress bar and status line, exactly as it
    // did with the v2 pipeline, so the line format is kept identical.
    onProgress: (s) => {
      console.log("PROGRESS", s.cached, "/", entries.length,
        "REQUESTS", s.requests, "FAILURES", failCount);
    },
  });

  // A save can be refused to protect an existing cache; report rather than hide it.
  fs.writeFileSync(FAILURES, JSON.stringify(fails, null, 0), "utf8");
  console.log("TRANSLATED", stats.cached, "FAILURES", fails.length, "REQUESTS", stats.requests);

  if (MODE === "check") { console.log("CHECK_DONE"); process.exit(0); }

  if (engine.kind === "MV") {
    const report = mvPatch.patch(engine.live, cache, PATCH_REPORT);
    console.log("PATCHED", report.replaced, "MISSING", report.missing, "FILES", report.files,
      report.errors.length ? "ERRORS " + report.errors.length : "");
    // The dialogue of a plugin-based game lives in resources/<locale>/*.json, not in the data
    // files, so it is written separately. Both steps are reported, because "patched 800 entries"
    // on a game with 5800 dialogue lines is exactly the confusion this fixes.
    const rr = resources.patch(engine.live, cache, PATCH_REPORT.replace(/\.json$/, "-resources.json"));
    if (rr.files) {
      console.log("PATCHED_RESOURCES", rr.replaced, "MISSING", rr.missing, "FILES", rr.files);
    }
  } else {
    // VX Ace / VX: Ruby writes the translations back into the .rvdata2 files of the
    // unpacked folder, then the archive is rebuilt from that folder.
    const out = vxAce.patch(dataDir, ROOT, WORK_DIR, EXTRACT + ".vxsrc.json", TRANS, PATCH_REPORT);
    if (out) console.log("RUBY_PATCH", out.split(/\r?\n/).slice(0, 3).join(" | "));
    if (archiveWork) {
      // The guard re-checks that an untouched round-trip is byte-identical before writing,
      // so a container regression cannot silently corrupt the game's images and audio.
      const guard = repackGuard.repackSafely(archiveWork.archiveFile, archiveWork.vxWork);
      if (!guard.ok) {
        console.log("REPACK_REFUSED", guard.reason);
        console.log("DONE  (数据目录已翻译，但未写回归档；游戏保持不变)");
        process.exit(0);
      }
      console.log("REPACKED", archiveWork.archiveFile);
    }
  }
  console.log("DONE");
})().catch((e) => {
  console.log("PIPELINE_ERROR", e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : String(e));
  process.exit(1);
});
