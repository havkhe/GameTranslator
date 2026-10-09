// Usage: node game-pipeline.js <gameDir> <model> <workDir> [port] [mode] [promptFile]
//   mode: translate (default) | check (only scan for untranslated content)
//   Requires a local llama-server (llama.cpp) already running on 127.0.0.1:<port>.
// Extracts RPG Maker MV/MZ (data json, with or without a www/ wrapper) or
// VX Ace (Data/*.rvdata2 / Game.rgss3a) text, translates it with the local
// llama-server, patches in place, and resumes from the translation cache.
//
// v2.4-dev changes (see docs/release-note): the translation cache is keyed by
// the *normalized source text* instead of the extraction index, so progress
// survives re-extraction; failures are tracked by text hash; failed batches are
// split in half instead of being retried as a whole; oversized entries are
// split at text boundaries; and patching writes a machine-readable report.
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");
const { readArchive, extractFile, writeArchiveTo } = require("./rgss3a.js");

const GAME_DIR = process.argv[2];
const MODEL = process.argv[3] || "model";
const WORK = process.argv[4] || path.join(__dirname, "pipeline-work");
const PORT = process.argv[5] || "18080";
const MODE = process.argv[6] || "translate";
const PROMPT_FILE = process.argv[7] || "";
const PAUSE_FLAG = path.join(WORK, "pause.flag");
const STOP_FLAG = path.join(WORK, "stop.flag");

const RUBY = process.env.VXACE_RUBY || path.join(__dirname, "ruby", "bin", "ruby.exe");
const VX_EXTRACT = path.join(__dirname, "vxace_extract.rb");
const VX_PATCH = path.join(__dirname, "vxace_patch.rb");

// Line count per request, and the character budget that keeps one request's
// prompt+completion comfortably inside the model's context window.
const BATCH = 16;
const BATCH_CHARS = 900;
// A single entry longer than this is sent on its own, split at sentence
// boundaries, so one runaway line can never blow up a whole batch.
const SINGLE_CHARS = 700;
// Attempts per request before the group is split (and finally given up on).
const GROUP_ATTEMPTS = parseInt(process.env.GT_GROUP_ATTEMPTS || "1", 10);
// Quality gate on translated lines (set GT_NO_QUALITY_GATE=1 to disable).
const QUALITY_GATE = process.env.GT_NO_QUALITY_GATE !== "1";

fs.mkdirSync(WORK, { recursive: true });

const BAK_DIR = path.join(GAME_DIR, "data_原版备份");
const hasJp = (s) => /[\u3040-\u30ff\u4e00-\u9fff]/.test(s);
const looksTranslatable = (s) => {
  if (!s || typeof s !== "string") return false;
  if (!hasJp(s)) return false;
  if (/\.(png|jpg|jpeg|gif|bmp|webp|rpgmvp|ogg|m4a|rpgmvo|mp3|rvdata2)$/i.test(s.trim())) return false;
  if (/^[A-Za-z0-9_\-./\\]+$/.test(s.trim())) return false;
  return true;
};

// Audio resource objects must never have their `name` translated: the file on
// disk keeps the original name, so translating the reference breaks loading.
const isAudioObject = (o) =>
  !!o &&
  typeof o === "object" &&
  ["volume", "pitch", "pan", "loopLength", "loopStart"].some((k) => k in o);

// Text that is already Chinese (kanji only, no kana) must never be queued for
// translation. This matters when we also scan the live data folder of a game
// that was translated before: without this guard the pipeline re-translates its
// own output on every re-run, corrupting the game a little more each time.
const KANA_RE = /[\u3040-\u309f\u30a0-\u30ff\uff66-\uff9f]/;
const isChineseLike = (s) => {
  const t = String(s);
  if (KANA_RE.test(t)) return false;
  const han = (t.match(/[\u3400-\u9fff]/g) || []).length;
  return han >= 2 && han * 2 >= t.replace(/\s/g, "").length;
};

// The translation cache is keyed by normalized source text, so the same
// normalizer has to be available to the extractor as well: extraction can then
// recognise its own past output in the live data folder and skip it.
const normText = (s) => String(s).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/^\s+|\s+$/g, "");

// Keys already present in work\<game>-translations.json (v2 layout), plus every
// translation we have produced. The live data folder of an already-translated
// game contains our own output; anything matching a known key OR a known output
// is therefore not source text and must never be queued again. Without this a
// re-run re-translates its own Chinese and the game degrades a little each time.
function loadKnownText() {
  const keys = new Set();
  const outputs = new Set();
  try {
    if (!fs.existsSync(TRANS)) return { keys, outputs };
    const raw = JSON.parse(fs.readFileSync(TRANS, "utf8"));
    if (raw && raw.byText && typeof raw.byText === "object") {
      for (const k of Object.keys(raw.byText)) {
        keys.add(k);
        const v = raw.byText[k];
        if (typeof v === "string") outputs.add(normText(v));
      }
    }
  } catch (e) {}
  return { keys, outputs };
}

// Speaker display names (MV `101`, MZ `101`) and the database name fields
// belong to the same "translatable string" family as dialogue.
//
// One shared list drives BOTH extraction and patching: the two sides used to have
// their own idea of what is translatable, and any field added to one of them but
// not the other silently produced "translated but not written back".
const TEXT_FIELDS = [
  "name", "nickname", "description", "profile",
  "message1", "message2", "message3", "message4",
  "displayName", "currencyUnit", "title", "hint",
];
const TEXT_FIELDS_SET = new Set(TEXT_FIELDS);
// `note` is deliberately NOT in the list: RPG Maker plugins parse those as
// metadata (`<CustomIcon: 5>`), so translating them breaks plugin behaviour.
const NAME_KEYS = TEXT_FIELDS; // kept for readability at the call sites
const TERMS_KEYS = ["basic", "commands", "params", "messages", "hint"];

// Plugin parameter files (`js/plugins.js`, and `js/plugins/*.json` in some MZ
// builds) hold the JSON-parameter objects of RPG Maker plugins: MV wraps them in
// a `parameters` array whose entries carry `"params"`, MZ uses a `parameters`
// object with named keys. We only touch the string *values*: keys such as
// `name`/`params` are identifiers the engine looks up, and a translated value
// only ever affects what the plugin displays. Values with no Japanese pass
// looksTranslatable() untouched, so tags like "<CustomIcon: 5>" survive as long
// as the token inside them is ASCII.
function isPluginDataFile(fileName, text) {
  if (fileName.toLowerCase() !== "plugins.js" && !/^plugins(\/[^/]+)?\.json$/i.test(fileName)) return false;
  // A DB file has *one* `parameters` key per record but nowhere near this many,
  // and no `"parameters"` key at all for most of them; plugin files have one per
  // plugin. (MZ plugin entries have no `id`, so requiring one was wrong.)
  const paramKeys = (text.match(/"(?:params|parameters)"\s*:/g) || []).length;
  return paramKeys > 5;
}

// `displayName` etc. also appear on resources such as animation frames or audio
// objects; those are skipped by isAudioObject(), and translating a display name
// inside a resource object is harmless (it is what the engine shows).

// ---------------- engine detection ----------------
// MV ships as <game>/www/data, but NW.js-packaged MZ builds put data/ and js/
// directly in the game root. Both layouts are accepted. A backup folder holding
// the json files directly (data_原版备份\Map001.json) is accepted as well.
function findDataDir(dir) {
  const hasJson = (d) => {
    try {
      return fs.existsSync(d) && fs.readdirSync(d).some((f) => f.endsWith(".json"));
    } catch (e) {
      return false;
    }
  };
  for (const d of [path.join(dir, "www", "data"), path.join(dir, "data")]) {
    if (hasJson(d)) return d;
  }
  if (hasJson(dir)) return dir;
  return null;
}

function detectEngine(dir) {
  // VX Ace archives win over a stray Data/ folder, but a `data/*.json` tree is
  // always MV/MZ (Windows paths are case-insensitive, so `data` == `Data`; the
  // file extension is what distinguishes the engines).
  const loose = path.join(dir, "Data");
  const vxLoose = (() => {
    try {
      return fs.existsSync(loose) && fs.readdirSync(loose).some((f) => f.endsWith(".rvdata2"));
    } catch (e) {
      return false;
    }
  })();
  const jsonData = findDataDir(dir);
  if (jsonData) return { kind: "MV", dataDir: jsonData };
  const archive = path.join(dir, "Game.rgss3a");
  if (fs.existsSync(archive)) return { kind: "VXAce", dataDir: null, isPacked: true, archive };
  if (vxLoose) return { kind: "VXAce", dataDir: loose, isPacked: false, archive: null };
  return null;
}

// ---------------- backup + restore bat (generic) ----------------
function ensureBackup(engine) {
  if (fs.existsSync(BAK_DIR)) return;
  fs.mkdirSync(BAK_DIR, { recursive: true });
  if (engine.kind === "MV") {
    fs.cpSync(engine.dataDir, BAK_DIR, { recursive: true });
    console.log("BACKUP_CREATED " + BAK_DIR);
  } else if (engine.isPacked) {
    fs.copyFileSync(engine.archive, path.join(BAK_DIR, "Game.rgss3a"));
    console.log("BACKUP_CREATED " + path.join(BAK_DIR, "Game.rgss3a"));
  } else {
    fs.cpSync(engine.dataDir, path.join(BAK_DIR, "Data"), { recursive: true });
    console.log("BACKUP_CREATED " + path.join(BAK_DIR, "Data"));
  }
}

function writeRestoreBat() {
  const bat = path.join(GAME_DIR, "一键还原汉化前.bat");
  if (fs.existsSync(bat)) return;
  const dataIsRoot = fs.existsSync(path.join(GAME_DIR, "data", "Map001.json")) && !fs.existsSync(path.join(GAME_DIR, "www", "data"));
  const lines = [
    "@echo off",
    "chcp 65001 >nul",
    "taskkill /f /im Game.exe >nul 2>&1",
    'cd /d "%~dp0"',
    'if exist "data_原版备份\\Game.rgss3a" (',
    '  del /f /q "Game.rgss3a" >nul 2>&1',
    '  copy /y "data_原版备份\\Game.rgss3a" "Game.rgss3a" >nul',
    ')',
    'if exist "data_原版备份\\Data" (',
    '  if exist "Data" rmdir /s /q "Data"',
    '  mkdir "Data" >nul 2>&1',
    '  xcopy /e /i /y "data_原版备份\\Data\\*" "Data" >nul',
    ')',
  ];
  // MV/MZ backups are a flat copy of the json data folder; restore into the
  // same folder we backed up from (www\data or <root>\data).
  const dest = dataIsRoot ? "data" : "www\\data";
  lines.push(
    'if exist "data_原版备份\\Map001.json" (',
    `  if exist "${dest}" rmdir /s /q "${dest}"`,
    `  mkdir "${dest}" >nul 2>&1`,
    `  xcopy /e /i /y "data_原版备份\\*" "${dest}" >nul`,
    ')',
    "echo.",
    "echo 还原完成！游戏数据已恢复为汉化前的原版。",
    "pause"
  );
  fs.writeFileSync(bat, "\ufeff" + lines.join("\r\n"), "utf8");
  console.log("RESTORE_BAT_CREATED");
}

const name = path.basename(GAME_DIR).replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_");
const EXTRACT = path.join(WORK, name + "-extract.json");
const TRANS = path.join(WORK, name + "-translations.json");
const FAIL = path.join(WORK, name + "-failures.json");
const UNTRANS = path.join(WORK, name + "-untranslated.json");
const PATCH_REPORT = path.join(WORK, name + "-patch-report.json");

// Record id -> relative path, for extract diagnostic output.
function writeIdMap(entries) {
  try {
    fs.writeFileSync(
      path.join(WORK, name + "-ids.json"),
      JSON.stringify(entries.map((e) => ({ id: e.id, file: e.file, text: e.text.slice(0, 60) }))),
      "utf8"
    );
  } catch (e) {}
}

// All json/plugin files under a data folder, INCLUDING subdirectories.
// Many MZ games keep their dialogue in data\resources\<locale>\*.json (loaded by
// a localization plugin) and some keep plugin params in js\plugins\*.json; a
// non-recursive scan silently ignores all of that text.
// Directories that never hold text worth translating (backups, caches, saves).
// Game folders are often localised, so match localized names generically rather
// than by list: `バックアップ` appeared in the wild and was translated twice.
const IGNORE_JSON_DIRS = new Set([
  "save", "saves", "backup", "backups", "_backup", "backup_old", "old", "old_version",
  "node_modules", ".git", "__macosx", "bak",
]);
const IGNORE_JSON_DIR_RE = /(バックアップ|バツクアツプ|予備|退避|备份|備份|存档|存檔|_bak$|^bak_)/i;
function isIgnoredJsonDir(name) {
  const n = String(name);
  return IGNORE_JSON_DIRS.has(n.toLowerCase()) || IGNORE_JSON_DIR_RE.test(n);
}
function listJsonFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const relPath = rel ? rel + "/" + ent.name : ent.name;
      if (ent.isDirectory()) {
        if (isIgnoredJsonDir(ent.name)) continue;
        walk(full, relPath);
      } else if (/\.(json|js)$/i.test(ent.name)) {
        out.push({ full, rel: relPath });
      }
    }
  };
  walk(root, "");
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

// Avoid double work: nested files of the same name would collide in the extract.
function uniqueByBasename(files) {
  const seen = new Set();
  const out = [];
  for (const f of files) {
    const base = path.basename(f.rel);
    if (seen.has(base)) continue;
    seen.add(base);
    out.push(f);
  }
  return out;
}

// Multi-language games often keep their real dialogue in data/resources/<locale>/
// *.json, keyed by the plugin's own identifiers (Hiroka_HEV1_000, SYSTEM_TITLE_…)
// rather than by database field names. Those keys are never in NAME_KEYS, so a
// whitelist-only walk collects nothing from them. For files under a `resources`
// folder every string value is a display candidate (the `metadata` block is
// skipped: it holds the locale/game name and must stay intact).
const META_KEYS = new Set(["metadata", "meta", "info", "__metadata"]);
function isLocaleResource(rel) {
  return /(^|[\\/])resources[\\/]/i.test(rel) && /\.json$/i.test(rel);
}

// MV/MZ extraction.
// Two passes: the pristine backup (or the live folder on a first run) is the
// source of truth for original text; the live folder is then only consulted for
// text that is NOT already translated. Entries are deduplicated by text.
function extractMV(pristineDir, liveDir) {
  const entries = [];
  const seen = new Map();
  const known = loadKnownText();
  let skipped = 0;
  let id = 0;
  const add = (file, p, text, opts) => {
    const t = String(text);
    if (!looksTranslatable(t)) return;
    if (opts && opts.skipTranslated) {
      const key = normText(t);
      const isKnownKey = known.keys.has(key);
      const isKnownOutput = known.outputs.has(key);
      if (process.env.GT_DEBUG_SKIP) {
        console.log("SKIPCHECK", JSON.stringify(t.slice(0, 24)), "chineseLike=" + isChineseLike(t), "knownKey=" + isKnownKey, "knownOutput=" + isKnownOutput, "sizes=" + known.keys.size + "/" + known.outputs.size);
      }
      if (isChineseLike(t) || isKnownKey || isKnownOutput) {
        skipped++;
        return;
      }
    }
    if (seen.has(t)) return;
    seen.set(t, id);
    entries.push({ id: id++, file, path: p, text: t });
  };
  const walkDir = (dataDir, skipTranslated) => {
    if (!dataDir) return;
    // Recursive: data\resources\<locale>\*.json holds the dialogue of localized
    // MZ games, and js\plugins\*.json can hold plugin parameters.
    for (const f of listJsonFiles(dataDir)) {
      const full = f.full;
      const rel = f.rel;
      let raw;
      try {
        raw = fs.readFileSync(full, "utf8");
      } catch (e) {
        continue;
      }
      let data;
      try {
        data = JSON.parse(raw);
      } catch (e) {
        // A broken json file silently reduced coverage before; at least say so.
        if (/\.json$/i.test(rel)) console.log("EXTRACT_PARSE_ERROR " + rel + ": " + e.message);
        continue;
      }
      const base = path.basename(rel);
      if (base === "System.json" && data.terms) {
        for (const k of Object.keys(data.terms)) {
          const arr = data.terms[k];
          if (!TERMS_KEYS.includes(k)) continue;
          if (Array.isArray(arr)) arr.forEach((v, i) => add(rel, "$terms." + k + "[" + i + "]", v, { skipTranslated }));
        }
      }
      // Plugin parameter values: every string value is a candidate.
      if (isPluginDataFile(base, raw)) collectStrings(rel, data, "$plugins", skipTranslated);
      if (isLocaleResource(rel)) collectStrings(rel, data, "$", skipTranslated, META_KEYS);
      walk(rel, data, "$", skipTranslated);
    }
  };
  // Every string value inside a plugin-parameter tree is a display candidate. The
  // object *keys* are identifiers, so they are never touched. `skipKeys` lets the
  // caller leave a whole subtree alone (e.g. a locale file's metadata block).
  const collectStrings = (file, obj, p, skipTranslated, skipKeys) => {
    if (Array.isArray(obj)) {
      obj.forEach((v, i) => collectStrings(file, v, p + "[" + i + "]", skipTranslated, skipKeys));
      return;
    }
    if (obj && typeof obj === "object") {
      for (const k of Object.keys(obj)) {
        if (skipKeys && skipKeys.has(k)) continue;
        const v = obj[k];
        if (typeof v === "string") add(file, p + "." + k, v, { skipTranslated });
        else collectStrings(file, v, p + "." + k, skipTranslated, skipKeys);
      }
    }
  };
  const processEventList = (file, list, p, skipTranslated) => {
    if (!Array.isArray(list)) return;
    list.forEach((cmd, idx) => {
      let code, params;
      if (Array.isArray(cmd) && cmd.length >= 3) {
        code = cmd[0];
        params = cmd[2] || [];
      } else if (cmd && typeof cmd === "object" && typeof cmd.code === "number") {
        code = cmd.code;
        params = cmd.parameters || [];
      } else return;
      const pp = p + "[" + idx + "]";
      if (code === 401) add(file, pp, params[0], { skipTranslated });
      else if (code === 101 && typeof params[0] === "string") add(file, pp, params[0], { skipTranslated }); // speaker name box
      else if (code === 102 && Array.isArray(params[0])) params[0].forEach((c) => add(file, pp, c, { skipTranslated }));
      else if (code === 402) add(file, pp, params[1], { skipTranslated });
      else if (code === 111 && typeof params[2] === "string") add(file, pp, params[2], { skipTranslated });
      // 324/325 rename the party nickname / class at runtime; 320 renames an actor
      else if (code === 320 && typeof params[1] === "string") add(file, pp, params[1], { skipTranslated });
      else if (code === 324 && typeof params[1] === "string") add(file, pp, params[1], { skipTranslated });
      else if (code === 325 && typeof params[1] === "string") add(file, pp, params[1], { skipTranslated });
      // 357 shows a picture; the name is a resource and must not be touched.
    });
  };
  const walk = (file, obj, p, skipTranslated) => {
    if (Array.isArray(obj)) {
      const isEventList =
        obj.length > 0 &&
        ((Array.isArray(obj[0]) && obj[0].length >= 3 && typeof obj[0][0] === "number") ||
          (obj[0] && typeof obj[0] === "object" && typeof obj[0].code === "number" && Array.isArray(obj[0].parameters)));
      if (isEventList) {
        processEventList(file, obj, p, skipTranslated);
        return;
      }
      obj.forEach((v, i) => walk(file, v, p + "[" + i + "]", skipTranslated));
      return;
    }
    if (obj && typeof obj === "object") {
      if (isAudioObject(obj)) return; // skip audio resource objects entirely
      // Every database/command object that carries an `id` field is a record;
      // annotate the path with it so the extract stays readable and stable.
      const rec = typeof obj.id === "number" ? "#" + obj.id + " " : "";
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (typeof v === "string") {
          if (NAME_KEYS.includes(k)) add(file, p + "." + rec + k, v, { skipTranslated });
        } else walk(file, v, p + "." + rec + k, skipTranslated);
      }
    }
  };
  walkDir(pristineDir, false);
  if (liveDir && path.resolve(liveDir) !== path.resolve(pristineDir)) walkDir(liveDir, true);
  if (skipped) console.log("SKIPPED_ALREADY_TRANSLATED", skipped);
  fs.writeFileSync(EXTRACT, JSON.stringify(entries), "utf8");
  return entries;
}

// ---------------- VX Ace helpers ----------------
function runRuby(script, args, timeoutMs) {
  if (!fs.existsSync(RUBY)) throw new Error("未找到便携 Ruby: " + RUBY);
  const r = spawnSync(RUBY, [script, ...args], {
    encoding: "utf8",
    timeout: timeoutMs || 900000,
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error("Ruby " + path.basename(script) + " 失败: " + (r.stderr || r.stdout || "exit " + r.status));
  }
  return (r.stdout || "").trim();
}

function unpackVxAce(engine, vxWork, sourceArchive) {
  const outDir = path.join(vxWork, "unpacked");
  const manifestPath = path.join(vxWork, "manifest.json");
  const archive = sourceArchive || engine.archive;
  if (fs.existsSync(path.join(outDir, "Data")) && fs.existsSync(manifestPath)) return { outDir, manifestPath };
  console.log("UNPACKING " + archive);
  const buf = fs.readFileSync(archive);
  const arch = readArchive(buf);
  const manifest = [];
  fs.mkdirSync(outDir, { recursive: true });
  for (const e of arch.entries) {
    const rel = e.name.replace(/\\/g, "/");
    manifest.push({ name: e.name, size: e.size });
    if (!rel.startsWith("Data/")) continue;
    const data = extractFile(arch, e);
    const fp = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, data);
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return { outDir, manifestPath };
}

function repackVxAce(engine, vxWork) {
  const manifest = JSON.parse(fs.readFileSync(path.join(vxWork, "manifest.json"), "utf8"));
  const outDir = path.join(vxWork, "unpacked");
  const origBuf = fs.readFileSync(engine.archive);
  const arch = readArchive(origBuf);
  const byName = new Map();
  for (const e of arch.entries) byName.set(e.name, e);
  const entries = [];
  for (const m of manifest) {
    const orig = byName.get(m.name);
    if (!orig) throw new Error("manifest entry missing in original archive: " + m.name);
    const rel = m.name.replace(/\\/g, "/");
    if (rel.startsWith("Data/")) {
      const fp = path.join(outDir, rel);
      const st = fs.statSync(fp);
      entries.push({ name: m.name, size: st.size, file: fp });
    } else {
      // Non-data members (Graphics/Audio) are already encrypted in the source
      // archive; copy their raw bytes instead of decrypting and re-encrypting
      // hundreds of megabytes for nothing.
      const raw = origBuf.subarray(orig.offset, orig.offset + orig.size);
      entries.push({ name: m.name, size: orig.size, buf: raw });
    }
  }
  const outTmp = engine.archive + ".new";
  console.log("REPACKING " + engine.archive);
  writeArchiveTo(entries, outTmp);
  fs.renameSync(outTmp, engine.archive);
}

function extractVxAce(dataDir) {
  runRuby(VX_EXTRACT, [dataDir, EXTRACT]);
  return JSON.parse(fs.readFileSync(EXTRACT, "utf8"));
}

// Same extraction, but into an explicit output file: used to build the pristine
// source index without clobbering the working extract.
function extractVxAceTo(dataDir, outJson) {
  runRuby(VX_EXTRACT, [dataDir, outJson]);
  return JSON.parse(fs.readFileSync(outJson, "utf8"));
}

// Returns the per-file report emitted by vxace_patch.rb (see PATCH_REPORT).
function patchVxAce(dataDir) {
  const out = runRuby(VX_PATCH, [dataDir, EXTRACT, TRANS, PATCH_REPORT]);
  if (out) console.log(out.split(/\r?\n/).filter((l) => l && !/^patched /.test(l)).join("\n"));
}

// ---------------- MV patch ----------------
function patchMV(dataDir, entries, cache) {
  const srcMap = {};
  let translated = 0;
  for (const e of entries) {
    const tr = cache.lookup(e.text);
    if (typeof tr === "string") {
      translated++;
      srcMap[e.text] = tr;
    }
  }
  let replaced = 0;
  let missing = 0;
  const errors = [];
  const fileStats = [];
  const replaceText = (text) => {
    if (typeof text !== "string") return text;
    if (text in srcMap) {
      replaced++;
      return srcMap[text];
    }
    if (looksTranslatable(text)) missing++;
    return text;
  };
  const patchEventList = (list) => {
    if (!Array.isArray(list)) return;
    for (const cmd of list) {
      if (!cmd || typeof cmd !== "object") continue;
      const code = cmd.code;
      const params = cmd.parameters;
      if (!Array.isArray(params)) continue;
      if (code === 401) params[0] = replaceText(params[0]);
      else if (code === 101 && typeof params[0] === "string") params[0] = replaceText(params[0]);
      else if (code === 102 && Array.isArray(params[0])) params[0] = params[0].map((c) => replaceText(c));
      else if (code === 402) params[1] = replaceText(params[1]);
      else if (code === 111 && typeof params[2] === "string") params[2] = replaceText(params[2]);
      else if (code === 320 && typeof params[1] === "string") params[1] = replaceText(params[1]);
      else if (code === 324 && typeof params[1] === "string") params[1] = replaceText(params[1]);
      else if (code === 325 && typeof params[1] === "string") params[1] = replaceText(params[1]);
    }
  };
  const walk = (obj) => {
    if (Array.isArray(obj)) {
      const isEventList =
        obj.length > 0 &&
        ((Array.isArray(obj[0]) && obj[0].length >= 3 && typeof obj[0][0] === "number") ||
          (obj[0] && typeof obj[0] === "object" && typeof obj[0].code === "number" && Array.isArray(obj[0].parameters)));
      if (isEventList) {
        patchEventList(obj);
        // MUST return the array: the parent assigns the result back
        // (`obj[k] = walk(v)`), and returning undefined would delete the key —
        // that silently dropped every event page from the map files.
        return obj;
      }
      const n = obj.length;
      for (let i = 0; i < n; i++) obj[i] = walk(obj[i]);
      return obj;
    }
    if (obj && typeof obj === "object") {
      if (isAudioObject(obj)) return obj; // never patch audio resource names
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (typeof v === "string") {
          if (TEXT_FIELDS_SET.has(k)) obj[k] = replaceText(v);
        } else obj[k] = walk(v);
      }
      return obj;
    }
    return obj;
  };
  // Mirror of collectStrings() in the extractor; `skipKeys` protects subtrees
  // such as a locale file's `metadata` block.
  const patchStrings = (obj, skipKeys) => {
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) obj[i] = patchStrings(obj[i], skipKeys);
      return obj;
    }
    if (obj && typeof obj === "object") {
      for (const k of Object.keys(obj)) {
        if (skipKeys && skipKeys.has(k)) continue;
        const v = obj[k];
        if (typeof v === "string") obj[k] = replaceText(v);
        else obj[k] = patchStrings(v, skipKeys);
      }
      return obj;
    }
    return obj;
  };
  // Mirror of the extractor: recursive, so the same files that were scanned are
  // the ones written back (data\resources\<locale>\*.json included).
  const nested = uniqueByBasename(listJsonFiles(dataDir));
  const files = nested.map((x) => x.rel);
  for (const f of files) {
    const fp = path.join(dataDir, f);
    let raw;
    let data;
    try {
      raw = fs.readFileSync(fp, "utf8");
      data = JSON.parse(raw);
    } catch (e) {
      // A file we cannot parse is a file we cannot translate: report it instead
      // of silently skipping (this used to leave games half-translated).
      if (/\.json$/i.test(f)) errors.push({ file: f, error: "JSON.parse: " + e.message });
      continue;
    }
    const before = replaced;
    if (path.basename(f) === "System.json" && data.terms) {
      for (const k of Object.keys(data.terms)) {
        if (!TERMS_KEYS.includes(k)) continue;
        const arr = data.terms[k];
        if (Array.isArray(arr)) arr.forEach((v, i) => (arr[i] = replaceText(v)));
      }
    }
    // Mirror of the extractor: plugin parameter values are patched too.
    if (isPluginDataFile(path.basename(f), raw)) patchStrings(data);
    if (isLocaleResource(f)) patchStrings(data, META_KEYS);
    walk(data);
    try {
      fs.writeFileSync(fp, JSON.stringify(data), "utf8");
    } catch (e) {
      errors.push({ file: f, error: "write: " + e.message });
      continue;
    }
    fileStats.push({ file: f, replaced: replaced - before });
  }
  const report = {
    engine: "MV",
    translatedEntries: translated,
    replacedStrings: replaced,
    untranslatedStringsSeen: missing,
    files: fileStats.filter((x) => x.replaced > 0),
    errors,
  };
  fs.writeFileSync(PATCH_REPORT, JSON.stringify(report, null, 2), "utf8");
  console.log("PATCHED", replaced);
  if (missing > 0) console.log("PATCH_MISSING", missing);
  if (errors.length) console.log("PATCH_ERRORS", errors.length);
  return report;
}

// ---------------- translation ----------------
function cleanOutput(s) {
  let t = s.trim();
  t = t.replace(/<\/?im(_| )?(start|end)>?/gi, "");
  t = t.replace(/<\|?im_(start|end)\|?>/gi, "");
  t = t.replace(/<\|im_end\|>/gi, "");
  t = t.replace(/<\/assim End>/gi, "");
  t = t.replace(/<assim End>/gi, "");
  t = t.replace(/<\/?(imstart|im end|assistant|user|system)>/gi, "");
  if (/^注意：必须原样保留/.test(t)) return null;
  if (t.length > 0 && t.length < 2) return null;
  return t;
}

// A Japanese source should never come back as English. If the answer is
// dominated by latin letters (and isn't mostly control codes), treat it as a
// failed translation and force a retry.
function looksLikeEnglish(t) {
  if (!t || typeof t !== "string") return false;
  const letters = (t.match(/[A-Za-z]/g) || []).length;
  const cjk = (t.match(/[\u3400-\u9fff]/g) || []).length;
  const control = (t.match(/\\[NVI]|<\/?[^>]{1,12}>/g) || []).length;
  return letters > 0 && letters >= cjk && letters > control;
}

function hasKana(s) {
  return typeof s === "string" && /[\u3040-\u30ff]/.test(s);
}

// English-heavy text (after stripping control codes) counts as untranslated.
function looksLikeEnglishText(s) {
  if (!s || typeof s !== "string") return false;
  const stripped = s
    .replace(/\\[A-Za-z]+(\[[^\]]*\])?/g, "")
    .replace(/<[^>]{1,20}>/g, "")
    .replace(/[0-9\s.,!?%()'"\-+*#/\\:;=~^|&_@$<>{}[\]·。、，！？：；""''（）《》【】]/g, "");
  const letters = (stripped.match(/[A-Za-z]/g) || []).length;
  const cjk = (stripped.match(/[\u3400-\u9fff]/g) || []).length;
  return stripped.length > 8 && letters > 0 && letters >= cjk * 2;
}

// ---------------- translation quality checks ----------------
// Ported from the rule sets used by GalTransl / AiNiee / LinguaGacha (thresholds
// and the reasons behind them are documented in docs/release-note-v2.4.txt).
// `fatal` problems mean the line must not be written into the game; `warn`
// problems are reported for review but are written (they are usually style).
const KANA_ALL = /[\u3040-\u309f\u30a0-\u30ff\uff66-\uff9f]/;
// ー and ・ are legitimate inside Chinese translations ("・" as a separator,
// katakana loanwords spelled with a long vowel), so they are not evidence.
const KANA_EVIDENCE = /[\u3041-\u3096\u30a1-\u30fa\uff66-\uff9d]/;
const HAN = /[\u3400-\u9fff]/;

// Full-width forms are folded to half-width first: a translation that turns
// \N[1] into \ｎ[1] (or ：into :) is not losing the control code.
function foldWidth(ch) {
  const c = ch.charCodeAt(0);
  if (c === 0x3000) return " ";
  if (c >= 0xff01 && c <= 0xff5e) return String.fromCharCode(c - 0xfee0);
  return ch;
}

// ASCII runs are what control codes are made of (\N[1], \V[2], \C[14], %1).
function asciiRuns(s) {
  const folded = Array.from(String(s)).map(foldWidth).join("");
  return (folded.match(/[!-/:-@\[-`{-~]+[A-Za-z0-9]*/g) || []).map((x) => x.toLowerCase());
}

function countMatches(s, re) {
  return (String(s).match(re) || []).length;
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function qualityCheck(src, dst) {
  const fatal = [];
  const warn = [];
  if (typeof dst !== "string" || dst.trim() === "") return { fatal: ["empty"], warn };
  const s = String(src);
  const d = dst;

  // 1) control codes / numeric placeholders must survive. Only backslash commands
  //    (\N[1], \C[14], \V[2]) and %N placeholders are checked: plain punctuation
  //    inside an ASCII run ("ミア！" -> "米娅。") is a normal translation choice and
  //    must not be reported as a lost control code.
  const srcRuns = asciiRuns(s).filter((r) => /^\\/.test(r) || /%/.test(r));
  if (srcRuns.length) {
    const dstFolded = Array.from(d).map(foldWidth).join("").toLowerCase();
    const missing = [];
    for (const run of srcRuns) if (!dstFolded.includes(run)) missing.push(run);
    if (missing.length) fatal.push("control:" + missing.slice(0, 3).join(","));
  }

  // 2) residual kana (ー / ・ excluded, and a line of pure katakana is reported
  //    only as a warning because it is often an untranslatable resource label)
  const kana = countMatches(d, KANA_EVIDENCE);
  const han = countMatches(d, HAN);
  if (kana > 0) {
    if (han >= 2 && kana >= han && !labelLike(d)) fatal.push("kana-dominant:" + kana + "/" + han);
    else if (han === 0 && kana >= 2 && !labelLike(d)) warn.push("katakana-only");
    else if (kana >= 3 && !labelLike(d)) warn.push("kana:" + kana);
  }

  // 3) unreadable / wrong-script output: anything that is neither CJK/kana nor a
  //    known punctuation/symbol (hangul, cyrillic, mojibake). GalTransl does the
  //    same with a GBK encode round-trip; listing the scripts directly is
  //    equivalent here and avoids encoding guesswork. Box drawing, bullets and
  //    Japanese quotes are legitimate in RPG Maker text.
  const ALLOWED_EXTRA = new Set(
    Array.from("，。！？、；：（）「」『』【】《》〈〉…—～·♪♥♡“”‘’\"'￥％＃＠＆＊＋－／＝＜＞　※■□▲▼◆◇●○☆★→←↑↓")
  );
  const isBoxOrSymbol = (ch) => {
    const c = ch.codePointAt(0);
    return (c >= 0x2500 && c <= 0x27bf) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0x3000 && c <= 0x303f);
  };
  const stray = [];
  for (const ch of d) {
    const c = ch.codePointAt(0);
    if (c < 0x80) continue; // ASCII / folded control codes
    if (HAN.test(ch) || KANA_ALL.test(ch) || ALLOWED_EXTRA.has(ch) || isBoxOrSymbol(ch)) continue;
    stray.push(ch);
  }
  if (stray.length) {
    const visible = stray.filter((c) => c.codePointAt(0) > 0x01ff).length;
    if (visible >= 3) fatal.push("stray-chars:" + Array.from(new Set(stray)).slice(0, 4).join(""));
    else if (visible) warn.push("stray:" + Array.from(new Set(stray)).slice(0, 4).join(""));
  }

  // 4) length anomaly: truncation or runaway expansion (also catches the
  //    "repetition loop" failure mode)
  if (s.length >= 8) {
    if (d.length < s.length * 0.2) fatal.push("too-short:" + d.length + "<" + s.length);
    else if (d.length > s.length * 3 && d.length - s.length >= 20) warn.push("too-long:" + d.length + ">" + s.length);
  }

  // 5) runaway repetition (the "啊啊啊啊…" loop): most frequent char dominating
  const counts = new Map();
  for (const ch of d) counts.set(ch, (counts.get(ch) || 0) + 1);
  let topChar = "", topCount = 0;
  for (const [ch, n] of counts) if (n > topCount) { topCount = n; topChar = ch; }
  if (topCount > 20 && topChar !== "\n" && !/\s/.test(topChar)) {
    const srcCount = countMatches(s, new RegExp(escapeRe(topChar), "g"));
    if (topCount > Math.max(srcCount * 2, 20)) fatal.push("repetition:" + topChar + "×" + topCount);
  }

  // 6) newline conservation (players see a broken text box otherwise)
  const srcNl = countMatches(s, /\n/g);
  const dstNl = countMatches(d, /\n/g);
  if (srcNl !== dstNl) warn.push("newlines:" + srcNl + "->" + dstNl);

  // 7) untranslated / near-identical. "unchanged" is only meaningful for text
  //    that actually needed translating: `打击/火焰` or `■ 011 萨拉_普通` are
  //    labels that legitimately stay as they are (see translatableSource()).
  const norm = (x) => String(x).replace(/\s+/g, "");
  // Compare with punctuation folded away: a line whose only "translation" was
  // switching 「 for a Chinese quote is still an untranslated line.
  const foldPunct = (x) => String(x).replace(/\s+/g, "")
    .replace(/[「」『』“”‘’""''［］\[\]（）()｛｝{}＜＞<>]/g, "\u0001")
    .replace(/[，、]/g, ",").replace(/[。．]/g, ".").replace(/[！]/g, "!").replace(/[？]/g, "?")
    .replace(/[：]/g, ":").replace(/[；]/g, ";").replace(/[~～〜]/g, "~");
  const wasCandidate = translatableSource(s);
  if (wasCandidate && (norm(s) === norm(d) || foldPunct(s) === foldPunct(d))) fatal.push("unchanged");
  else if (han >= 4 && KANA_EVIDENCE.test(s)) {
    // Japanese source that came back with the same CJK content is suspicious
    const setS = new Set(Array.from(norm(s)).filter((c) => HAN.test(c)));
    const setD = new Set(Array.from(norm(d)).filter((c) => HAN.test(c)));
    if (setS.size >= 4) {
      let same = 0;
      for (const c of setS) if (setD.has(c)) same++;
      const jaccard = same / (setS.size + setD.size - same);
      if (jaccard > 0.8) warn.push("similar:" + jaccard.toFixed(2));
    }
  }

  // 8) punctuation pairing — only a *new* imbalance counts. RPG Maker dialogue is
  //    often split across lines, so the source itself is frequently unbalanced
  //    (one line opens 「, the next closes it); flagging those would be noise.
  for (const [open, close] of [["（", "）"], ["「", "」"], ["『", "』"], ["(", ")"]]) {
    const o = countMatches(d, new RegExp(escapeRe(open), "g"));
    const c = countMatches(d, new RegExp(escapeRe(close), "g"));
    const so = countMatches(s, new RegExp(escapeRe(open), "g"));
    const sc = countMatches(s, new RegExp(escapeRe(close), "g"));
    if (o !== c && so === sc) {
      warn.push("punct:" + open + close);
      break;
    }
  }

  return { fatal, warn };
}

// Text that genuinely needs translating. Mirrors the layer-0 skip rules: labels
// made of a name plus symbols (`■ 023 アメリア_惊讶`), kanji-only labels
// (`打击/火焰`), bare resource references, pure ASCII and pure symbols do not need
// a translation, so "the output equals the input" is not a defect for them.
// Used to keep the unchanged/similar checks honest.
const LABEL_STRIP = /[\s■□▲▼◆◇●○☆★※・\-_/\\|+.,:;()（）[\]{}<>〈〉《》「」『』【】〜~!?！？。、，0-9A-Za-z]/g;
const LABEL_EXTRA = /[\u2500-\u257f\u25a0-\u25ff\u2600-\u26ff\u2700-\u27bf]/; // box drawing & symbols
function labelLike(s) {
  const t = String(s).trim();
  if (!t) return true;
  const body = t.replace(LABEL_STRIP, "").replace(new RegExp(LABEL_EXTRA.source, "g"), "");
  if (body.length > 6) return false;
  if (body.length === 0) return true;
  return KANA_EVIDENCE.test(body) || HAN.test(body);
}

function translatableSource(s) {
  const t = String(s).trim();
  if (!t) return false;
  if (/\.(png|jpg|jpeg|gif|bmp|webp|rpgmvp|ogg|m4a|rpgmvo|mp3|rvdata2)$/i.test(t)) return false;
  if (/^[A-Za-z0-9_\-./\\%]+$/.test(t)) return false;          // filenames, ids, numbers
  if (!KANA_EVIDENCE.test(t)) return false;                     // no kana -> not Japanese prose
  if (labelLike(t)) return false;                               // resource/artwork label
  return true;
}

// Backwards-compatible boolean used by the patch-time guard.
function looksBroken(src, dst) {
  const q = qualityCheck(src, dst);
  return q.fatal.length > 0;
}

// ---------------- glossary (术语表) ----------------
// Optional file, looked up next to the game first and then in the work dir:
//     <gameDir>\glossary.txt   or   <workDir>\glossary.txt
// One term per line, `src->dst`, `#` starts a comment:
//     ミア->米娅
//     あやめ->菖蒲   # 主角
// Two effects: the pairs are appended to the prompt (so the model uses them), and
// an exact `src` found in a translation is replaced by `dst` afterwards, which is
// what actually guarantees a consistent name across a whole game.
const GLOSSARY_LIMIT = parseInt(process.env.GT_GLOSSARY_LIMIT || "120", 10);
let glossary = [];
function loadGlossary() {
  const candidates = [path.join(GAME_DIR, "glossary.txt"), path.join(WORK, "glossary.txt")];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const pairs = [];
    for (const rawLine of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const line = rawLine.replace(/#.*$/, "").trim();
      if (!line) continue;
      const m = line.split(/->|=>|＝>|→/);
      if (m.length < 2) continue;
      const src = m[0].trim();
      const dst = m.slice(1).join("->").trim();
      if (src && dst && src !== dst && !pairs.some((x) => x.src === src)) pairs.push({ src, dst });
    }
    if (pairs.length) {
      // Longest source first: applying `ミア->米娅` before
      // `おはよう、ミアです。->…` would destroy the longer rule's match.
      pairs.sort((a, b) => b.src.length - a.src.length);
      glossary = pairs.slice(0, GLOSSARY_LIMIT);
      console.log("GLOSSARY_LOADED", glossary.length, "from", p);
      return;
    }
  }
}

function glossaryPromptBlock() {
  if (!glossary.length) return "";
  const lines = glossary.map((g) => g.src + "->" + g.dst).join("\n");
  return "\n参考术语表（格式 src->dst，必须按此翻译并保持全文一致）：\n" + lines + "\n";
}

function applyGlossary(text) {
  if (!glossary.length || typeof text !== "string") return text;
  let out = text;
  for (const g of glossary) {
    if (out.includes(g.src)) out = out.split(g.src).join(g.dst);
  }
  return out;
}

// ---------------- translation cache (keyed by source text) ----------------
// The cache is the only thing that makes "resume" and "check" meaningful, so it
// is keyed by text: extraction ids shift whenever the extractor changes, which
// used to invalidate the whole run and re-translate thousands of finished lines.
// (normText / loadKnownKeys live near the extractor, which needs them too.)

function makeCache(entries, flagged) {
  const byText = Object.create(null);
  if (fs.existsSync(TRANS)) {
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(TRANS, "utf8"));
    } catch (e) {
      console.log("CACHE_UNREADABLE", e.message);
    }
    if (raw && raw.byText && typeof raw.byText === "object") {
      for (const k of Object.keys(raw.byText)) if (typeof raw.byText[k] === "string") byText[k] = raw.byText[k];
    } else if (raw && typeof raw === "object") {
      // v2.3.x layout: {"<extract id>": "translation"}. Migrate through the
      // current extract so the user keeps every line already translated.
      const byId = new Map();
      for (const k of Object.keys(raw)) if (typeof raw[k] === "string") byId.set(String(k), raw[k]);
      let migrated = 0;
      for (const e of entries) {
        const v = byId.get(String(e.id));
        if (typeof v === "string" && v) {
          byText[normText(e.text)] = v;
          migrated++;
        }
      }
      if (migrated) console.log("CACHE_MIGRATED", migrated);
    }
  }
  return {
    byText,
    get size() {
      return Object.keys(byText).length;
    },
    lookup(text) {
      return byText[normText(text)];
    },
    set(text, value) {
      byText[normText(text)] = value;
      // A successful (re)translation clears the "flagged by 检查翻译" state, so
      // the patch step happily writes the fresh text.
      if (flagged) for (const s of flagged) s.delete(normText(text));
    },
    remove(text) {
      delete byText[normText(text)];
    },
    has(text) {
      return typeof byText[normText(text)] === "string";
    },
    save() {
      fs.writeFileSync(TRANS, JSON.stringify({ version: 2, byText }, null, 0), "utf8");
    },
  };
}

function checkUntranslated(entries, sources) {
  const cache = makeCache(entries);
  // The *source* text is what the quality rules must be evaluated against. When a
  // game has already been translated, the live files hold Chinese, so checking
  // "translation vs live file" compares Chinese with Chinese and produces
  // nonsense; the caller passes the pristine extraction when it has one.
  const sourceByText = sources || new Map();
  const fatal = [];
  const suspect = [];
  const pending = [];
  let compared = 0;
  const judge = (e, tr) => {
    const src = sourceByText.get(normText(e.text)) || e.text;
    if (sourceByText.size) compared++;
    const han = countMatches(tr, HAN);
    const kana = countMatches(tr, KANA_EVIDENCE);
    const nonAscii = countMatches(tr, /[^\x00-\x7f]/g);
    const q = qualityCheck(src, tr);
    if (q.fatal.length) {
      fatal.push({ id: e.id, text: src, trans: tr, reason: q.fatal.join("|") });
      return;
    }
    if (kana > 0 && han > 0 && kana >= han) fatal.push({ id: e.id, text: src, trans: tr, reason: "kana" });
    else if (han < 2 && nonAscii < 2 && looksLikeEnglishText(tr)) fatal.push({ id: e.id, text: src, trans: tr, reason: "english" });
    else if (q.warn.length) suspect.push({ id: e.id, text: src, trans: tr, reason: q.warn.join("|") });
  };
  for (const e of entries) {
    const tr = cache.lookup(e.text);
    if (tr === undefined) {
      pending.push({ id: e.id, text: e.text, reason: "pending" });
      continue;
    }
    judge(e, tr);
  }
  // `bad` stays as the union so older GUI builds keep working.
  const bad = fatal.concat(suspect);
  fs.writeFileSync(UNTRANS, JSON.stringify({ fatal, suspect, bad, pending, sourceCompared: compared }), "utf8");
  console.log("UNTRANSLATED fatal=" + fatal.length + " suspect=" + suspect.length + " pending=" + pending.length
    + (sourceByText.size ? " (与原始日文对照 " + compared + " 条)" : ""));
  return { fatal, suspect, bad, pending };
}

// ---------------- prompt sizing ----------------
function textHash(s) {
  // small non-crypto hash, stable across runs; only used to detect stale
  // failure records
  let h = 0x811c9dc5;
  const str = normText(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

function splitLongText(text, max) {
  if (text.length <= max) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > max) {
    let cut = -1;
    for (const sep of ["\n", "。", "！", "？", "、", "，", " "]) {
      const idx = rest.lastIndexOf(sep, max);
      if (idx > cut) cut = idx;
    }
    if (cut < max * 0.5) cut = max;
    parts.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  if (rest.length) parts.push(rest);
  return parts;
}

// Break a list of entries into request-sized groups: at most BATCH lines and
// BATCH_CHARS characters; single runaway lines get their own request, split at
// punctuation so the model never sees a 2000-character wall of text.
function packGroups(list) {
  const groups = [];
  for (const e of list) {
    if (e.text.length > SINGLE_CHARS) {
      const parts = splitLongText(e.text, SINGLE_CHARS);
      parts.forEach((p, i) => groups.push([{ id: e.id, text: p, part: i + 1, parts: parts.length, parent: e }]));
      continue;
    }
    const last = groups[groups.length - 1];
    const lastChars = last ? last.reduce((a, x) => a + x.text.length, 0) : Infinity;
    if (last && last.length < BATCH && lastChars + e.text.length <= BATCH_CHARS && !last[0].part) last.push(e);
    else groups.push([e]);
  }
  return groups;
}

// ---------------- llama-server request layer ----------------
// A degenerate generation (the model looping on "啊啊啊啊…") used to occupy a
// server slot for many minutes: the client timeout only closed our socket while
// the server kept decoding, and the retries queued up behind it — the whole tool
// looked frozen. We now (a) cap max_tokens, (b) treat "no data for N seconds"
// as a stall, and (c) actively erase the slot so the next request can run.
const STALL_MS = parseInt(process.env.GT_STALL_MS || "45000", 10);
const MAX_OUTPUT_TOKENS = parseInt(process.env.GT_MAX_OUTPUT_TOKENS || "1024", 10);
const SLOT_ERASE = process.env.GT_NO_SLOT_ERASE !== "1";
// After this many stalled requests the model is considered stuck (degenerate
// generation, VRAM thrashing, driver reset). Continuing would spend hours
// retrying, so the run stops early and leaves every pending entry in
// failures.json for the next attempt.
const MAX_STALLS = parseInt(process.env.GT_MAX_STALLS || "3", 10);

// Set by the request layer, read by the translate loop.
const runState = { stalls: 0, degraded: false };

function reportServer(tag, detail) {
  if (detail && detail.predicted_per_second)
    console.log(tag, "tok/s=" + Number(detail.predicted_per_second).toFixed(1), "tokens=" + detail.predicted_n);
  else console.log(tag);
}

// Ask llama-server to release the slot(s) we just abandoned. Best effort: older
// builds may not expose the endpoint, and a failure here must never break a run.
// `slotId` is optional — llama.cpp only reports the slot id in some builds, so we
// fall back to clearing whatever was left busy.
function eraseSlot(slotId) {
  if (!SLOT_ERASE) return;
  const path = slotId === undefined || slotId === null || slotId < 0
    ? "/slots/0?action=erase"
    : "/slots/" + slotId + "?action=erase";
  try {
    const req = http.request({ host: "127.0.0.1", port: PORT, path, method: "POST", headers: { "Content-Length": 0 } }, (res) => {
      res.resume();
    });
    req.on("error", () => {});
    req.setTimeout(4000, () => req.destroy(new Error("slot erase timeout")));
    req.end();
  } catch (e) {}
}

function askLocal(content, opts) {
  const options = opts || {};
  const maxTokens = options.maxTokens || MAX_OUTPUT_TOKENS;
  return new Promise((resolve, reject) => {
    const messages = [];
    if (SYSTEM_PROMPT) messages.push({ role: "system", content: SYSTEM_PROMPT });
    messages.push({ role: "user", content });
    const body = JSON.stringify({
      model: "local",
      messages,
      temperature: TEMPERATURE,
      top_p: TOP_P,
      frequency_penalty: FREQ_PENALTY,
      max_tokens: maxTokens,
      stream: false,
    });
    let settled = false;
    let stallTimer = null;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (stallTimer) clearTimeout(stallTimer);
      fn(arg);
    };
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: "/v1/chat/completions", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        let d = "";
        const armStallTimer = () => {
          if (stallTimer) clearTimeout(stallTimer);
          stallTimer = setTimeout(() => {
            runState.stalls++;
            console.log("STALL_ABORT after " + Math.round(STALL_MS / 1000) + "s without output (stall #" + runState.stalls + ")");
            if (runState.stalls >= MAX_STALLS) {
              runState.degraded = true;
              console.log("MODEL_DEGRADED 连续 " + runState.stalls + " 次请求无输出，判定模型卡死，停止本次运行（进度已保留，可稍后重试）");
            }
            req.destroy(new Error("stalled"));
            eraseSlot(res.headers && res.headers["x-llama-slot-id"]);
          }, STALL_MS);
        };
        armStallTimer();
        res.on("data", (c) => {
          d += c;
          armStallTimer();
        });
        res.on("end", () => {
          if (stallTimer) clearTimeout(stallTimer);
          try {
            const j = JSON.parse(d);
            if (j.error) return finish(reject, new Error(typeof j.error === "string" ? j.error : JSON.stringify(j.error)));
            const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
            if (!text) return finish(reject, new Error("llama 无返回内容"));
            if (j.timings) reportServer("LLAMA_TIMINGS", j.timings);
            finish(resolve, text);
          } catch (e) {
            finish(reject, e);
          }
        });
      }
    );
    req.on("error", (e) => {
      // Whatever went wrong, do not leave the slot busy for the next attempt.
      eraseSlot(options.slotId);
      finish(reject, e);
    });
    req.write(body);
    req.end();
  });
}

async function ask(content, opts) { return askLocal(content, opts); }

// Pause: wait while pause.flag exists. Stop: exit gracefully at batch boundary.
function checkFlags() {
  while (fs.existsSync(PAUSE_FLAG)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  if (fs.existsSync(STOP_FLAG)) {
    console.log("STOPPED_BY_USER");
    process.exit(0);
  }
}

// Small/fast models sometimes echo the instruction lines at the start of their
// answer, which used to make the line count mismatch and sink the whole batch
// (observed with Hy-MT2-1.8B: 18 lines for 16 sources). Instructions are prompt
// boilerplate, so they can be recognised and dropped.
const INSTRUCTION_RE = /(必须原样保留|不要编号|不要JSON|不要json|行数必须|只输出|禁止翻译成英文|只输出简体中文|翻译成简体中文|逐行)/;
function stripEchoedInstructions(lines) {
  let start = 0;
  while (start < lines.length - 1 && INSTRUCTION_RE.test(lines[start])) start++;
  let end = lines.length;
  while (end - 1 > start && INSTRUCTION_RE.test(lines[end - 1])) end--;
  return lines.slice(start, end);
}

function parseResult(text) {
  if (typeof text !== "string") return null;
  let t = text.trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch (e) {}
    const obj = {};
    const re = /"(\d+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = re.exec(t.slice(start, end + 1)))) obj[m[1]] = m[2].replace(/\\n/g, "\n");
    if (Object.keys(obj).length) return obj;
  }
  // Plain numbered lines (1. 译文 / 1、译文), the shape these models fall back
  // to when they ignore the JSON instruction.
  const obj = {};
  let numbered = 0;
  for (const line of t.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d{1,3})[.、:：]\s*(.+)$/);
    if (m) {
      obj[m[1]] = m[2].trim();
      numbered++;
    }
  }
  if (numbered) return obj;
  // Last resort: one translation per line, no numbering. The caller verifies
  // the count (normalizeResult), so a single-line answer is valid too — that
  // happens whenever a chunk was split at the character limit.
  const plain = t.split(/\r?\n/).map((x) => x.trim()).filter((x) => x.length > 0);
  const cleaned = stripEchoedInstructions(plain);
  if (cleaned.length) return cleaned;
  return null;
}

function normalizeResult(raw, count) {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw.length === count ? raw : null;
  const out = [];
  for (let i = 0; i < count; i++) {
    const v = raw[String(i + 1)];
    if (typeof v !== "string") return null;
    out.push(v);
  }
  return out;
}

// Prompt protocol.
//   {lines}    -> raw source lines (what the Sakura/GalTransl fine-tunes were
//                 trained on: one line in, one line out, no numbering)
//   {numbered} -> "1. text" lines (the older JSON/legacy protocol)
// The default follows the model author's documented shape (SakuraLLM), because
// prompting a fine-tune with an unfamiliar format measurably wastes tokens
// (measured: 218 -> 174 output tokens per 16-line batch).
const DEFAULT_PROMPT =
  "将下列每行日文翻译成简体中文。禁止翻译成英文，只输出简体中文。\n" +
  "必须原样保留 \\N[1]、\\V[1]、\\N<角色名> 等控制代码；行数必须与输入完全相同。\n" +
  "每行输出一条译文，不要编号、不要JSON、不要解释。\n" +
  "{lines}";

// Sent as a separate system message when the caller supplies it. Kept verbatim
// from the model documentation so the fine-tune sees its trained prefix.
const DEFAULT_SYSTEM_PROMPT =
  "你是一个轻小说翻译模型，可以流畅通顺地以日本轻小说的风格将日文翻译成简体中文，并联系上下文正确使用人称代词，不擅自添加原文中没有的代词。";
const SYSTEM_PROMPT = process.env.GT_SYSTEM_PROMPT !== undefined
  ? process.env.GT_SYSTEM_PROMPT
  : DEFAULT_SYSTEM_PROMPT;

// Sampling: the model's own README recommends low temperature and a narrow
// nucleus (0.1/0.3 for the 13B generation, 0.3/0.8 for the v3 generation) plus a
// small frequency penalty to break repetition loops. llama-server would
// otherwise use the model defaults (temperature 0.8 / top_p 0.95).
const TEMPERATURE = parseFloat(process.env.GT_TEMPERATURE || "0.3");
const TOP_P = parseFloat(process.env.GT_TOP_P || "0.8");
const FREQ_PENALTY = parseFloat(process.env.GT_FREQ_PENALTY || "0.1");

let basePrompt = DEFAULT_PROMPT;
if (PROMPT_FILE && fs.existsSync(PROMPT_FILE)) {
  const custom = fs.readFileSync(PROMPT_FILE, "utf8").trim();
  // v2.3.x shipped a prompt that asked for a JSON object. Those models are
  // fine-tuned for "one line in, one line out", so a *stock* legacy prompt is
  // transparently upgraded here (a hand-written prompt is left untouched). This
  // lives in the pipeline on purpose: it then works no matter which GUI build
  // wrote prompt.txt, and users who never touch the settings still get it.
  if (custom && custom.includes("只输出一个JSON对象") && custom.includes("{lines}")) {
    console.log("PROMPT_UPGRADED 检测到 v2.3 的 JSON 提示词，已改用 v2.4 默认逐行格式");
  } else if (custom) {
    basePrompt = custom;
  }
}

function buildPrompt(batch) {
  const raw = batch.map((e) => e.text).join("\n");
  const numbered = batch.map((e, j) => j + 1 + ". " + e.text).join("\n");
  let p = basePrompt;
  if (p.includes("{numbered}")) p = p.replace(/\{numbered\}/g, numbered);
  if (p.includes("{lines}")) p = p.replace(/\{lines\}/g, raw);
  if (!p.includes(raw)) p = p + "\n\n" + raw;
  return p + glossaryPromptBlock();
}

// One request -> array of translations for `group`, or null.
// A group is attempted once: the caller splits failures recursively, which costs
// a fraction of re-sending the same batch verbatim three times (a model that
// answers "sorry, I can't translate" does so deterministically).
async function translateGroup(group) {
  if (runState.degraded) return null;
  const prompt = buildPrompt(group);
  // Cap generation at roughly twice the source size (GalTransl's rule). This is
  // the cheapest guard against a repetition loop: the model physically cannot
  // generate 2000 tokens for a 20-character line.
  const srcChars = group.reduce((a, e) => a + e.text.length, 0);
  const maxTokens = Math.max(
    64,
    Math.min(MAX_OUTPUT_TOKENS, Math.ceil(srcChars * 2) + 32 * group.length)
  );
  for (let attempt = 0; attempt < GROUP_ATTEMPTS; attempt++) {
    let resp;
    try {
      resp = await ask(prompt, { maxTokens, groupSize: group.length });
    } catch (e) {
      // Never swallow this silently: a dead server or a rejected request is the
      // difference between "translating" and "doing nothing for an hour".
      if (process.env.GT_DEBUG_REQUEST || !globalThis.__gtAskErrLogged) {
        globalThis.__gtAskErrLogged = true;
        console.log("REQUEST_FAILED", JSON.stringify(String(e && e.message ? e.message : e)));
      }
      continue;
    }
    const parsed = parseResult(resp);
    const lines = normalizeResult(parsed, group.length);
    if (!lines) continue;
    const out = [];
    let ok = true;
    for (let j = 0; j < group.length; j++) {
      const c = cleanOutput(lines[j]);
      if (c === null || looksLikeEnglish(c)) {
        ok = false;
        break;
      }
      out.push(c);
    }
    if (ok) return out;
  }
  return null;
}

// Translate a request-sized group; on failure split it in half and retry the
// halves (GalTransl does the same with the first third). Splitting beats
// retrying the same batch: a single bad line can no longer sink 15 good ones.
async function translateGroupRecursive(group, cache, fails, stats) {
  if (!group.length) return;
  const res = await translateGroup(group);
  if (res) {
    const skip = new Set();
    for (let i = 0; i < group.length; i++) {
      const target = group[i].parent || group[i];
      // The glossary is a hard requirement, so it is applied BEFORE validation:
      // the quality rules then judge exactly what would be written to the game.
      if (process.env.GT_DEBUG_GLOSSARY) {
        console.log("GLOSSARY_APPLY", JSON.stringify(String(res[i]).slice(0, 20)), "->", JSON.stringify(String(applyGlossary(res[i])).slice(0, 20)), "size=" + glossary.length);
      }
      res[i] = applyGlossary(res[i]);
      // A translation far shorter than its source means the model truncated or
      // gave up. Writing that into the game silently loses dialogue, so treat it
      // as a failure and let the entry be retried instead.
      if (group[i].text.length > 12 && res[i].length < group[i].text.length * 0.25) {
        skip.add(i);
        fails.push({ hash: textHash(target.text), err: "too-short", text: target.text.slice(0, 40) });
        console.log("SUSPECT_SHORT", JSON.stringify(target.text.slice(0, 40)));
        continue;
      }
      // Full quality gate: a line that loses a control code or degenerates into
      // a repetition loop must not reach the game.
      if (QUALITY_GATE) {
        const q = qualityCheck(group[i].text, res[i]);
        if (q.fatal.length) {
          skip.add(i);
          fails.push({ hash: textHash(target.text), err: "quality:" + q.fatal.join("|"), text: target.text.slice(0, 40) });
          console.log("QUALITY_REJECT", JSON.stringify(target.text.slice(0, 30)), q.fatal.join("|"));
          continue;
        }
        if (q.warn.length) stats.warned = (stats.warned || 0) + 1;
      }
    }
    for (let i = 0; i < group.length; i++) {
      if (skip.has(i)) continue;
      const e = group[i];
      const target = e.parent || e;
      if (e.parent) {
        // A split long line: collect parts, verify the joined result, then store
        // it under the *original* text so patch time can find it again.
        stats.parts[e.id] = stats.parts[e.id] || [];
        stats.parts[e.id][e.part - 1] = res[i];
        if (stats.parts[e.id].filter(Boolean).length === e.parts) {
          const joined = stats.parts[e.id].join("");
          delete stats.parts[e.id];
          if (joined.length < target.text.length * 0.25) {
            fails.push({ hash: textHash(target.text), err: "parts-too-short", text: target.text.slice(0, 40) });
          } else {
            cache.set(target.text, joined);
          }
        }
      } else {
        cache.set(target.text, res[i]);
      }
    }
    return;
  }
  if (group.length === 1) {
    const e = group[0];
    const src = e.parent ? e.parent.text : e.text;
    fails.push({ hash: textHash(src), err: "request-failed", text: src.slice(0, 40) });
    console.log("FAILED_ENTRY", JSON.stringify(src.slice(0, 60)));
    return;
  }
  const mid = Math.ceil(group.length / 2);
  stats.splits++;
  await translateGroupRecursive(group.slice(0, mid), cache, fails, stats);
  await translateGroupRecursive(group.slice(mid), cache, fails, stats);
}

// Failure records are keyed by the hash of the source text, so a record is only
// kept while its text is still missing from the cache. The previous
// implementation sliced the *pending* index into the *entries* array, which made
// pruning wrong in every resumed run and left thousands of phantom failures.
function pruneFailures(fails, stillMissing) {
  const seen = new Set();
  const out = [];
  for (const f of fails) {
    if (!f || typeof f.hash !== "string" || !stillMissing.has(f.hash) || seen.has(f.hash)) continue;
    seen.add(f.hash);
    out.push(f);
  }
  return out;
}

// Single-entry last-chance prompt. One attempt only: the group pass and the
// split passes have already failed on this text, so repeating the same request
// just burns GPU time (a model that answers "sorry, I can't translate" does so
// every time). The entry stays in failures.json and is retried on the next run.
async function translateOne(text) {
  if (runState.degraded) return null;
  const prompt = "将下面日文翻译成简体中文（只能输出简体中文，禁止英文）：\n" + text + glossaryPromptBlock();
  try {
    const resp = await ask(prompt);
    const c = cleanOutput(resp);
    if (c && !/^注意：/.test(c) && c.length >= 2 && !looksLikeEnglish(c) && c.length >= text.length * 0.25) {
      return applyGlossary(c);
    }
  } catch (err) {}
  return null;
}

async function translate(entries) {
  if (fs.existsSync(PAUSE_FLAG)) fs.rmSync(PAUSE_FLAG);
  if (fs.existsSync(STOP_FLAG)) fs.rmSync(STOP_FLAG);
  const cache = makeCache(entries);
  if (cache.size) console.log("CACHE_LOADED", cache.size);
  if (process.env.GT_DEBUG_CACHE) {
    const keys = Object.keys(cache.byText);
    console.log("CACHE_DEBUG", JSON.stringify({ file: TRANS, keys: keys.length, entries: entries.length, firstEntry: entries[0] && entries[0].text, hit: entries[0] ? cache.has(entries[0].text) : null }));
  }

  // Entries flagged as incomplete by a previous "check" run. The previous
  // implementation *deleted* them from the cache up front "so they would be
  // retranslated" — but the cache is also what feeds the patch step, so if the
  // model was unavailable or answered badly the run ended with those lines
  // reverted to Japanese and the good translation destroyed. Now the old
  // translation is kept and only overwritten when a *valid* new one arrives.
  //
  // Staleness is decided by *content*, not timestamps: a flagged text is only
  // honoured when it is still part of the current extraction. A re-extracted
  // game therefore cannot schedule thousands of already-good lines again, while
  // a check result produced moments ago for the same extract still applies.
  const retranslate = new Set();
  if (fs.existsSync(UNTRANS)) {
    const current = new Set(entries.map((e) => normText(e.text)));
    let stale = 0;
    try {
      const u = JSON.parse(fs.readFileSync(UNTRANS, "utf8"));
      if (u && Array.isArray(u.bad)) {
        for (const b of u.bad) {
          if (!b || typeof b.text !== "string") continue;
          const key = normText(b.text);
          if (!current.has(key)) { stale++; continue; }
          if (cache.has(b.text)) retranslate.add(key);
        }
      }
    } catch (e) {}
    if (retranslate.size) console.log("RETRANSLATE_FLAGGED", retranslate.size);
    if (stale) console.log("CHECK_RESULT_STALE", stale, "条检查结果与当前抽取不符，已忽略");
    fs.rmSync(UNTRANS);
  }

  const pending = entries.filter((e) => !cache.has(e.text) || retranslate.has(normText(e.text)));
  const groups = packGroups(pending);
  const alreadyDone = entries.length - pending.length;
  if (process.env.GT_DEBUG_CACHE && pending.length) {
    const p = pending[0];
    console.log("PENDING_DEBUG", JSON.stringify({ text: p.text, file: p.file, path: p.path, cacheKeys: Object.keys(cache.byText).length }));
  }
  console.log("TOTAL", entries.length, "DONE", alreadyDone, "PENDING", pending.length, "REQUESTS", groups.length);
  const fails = [];
  const stats = { splits: 0, parts: {} };
  let done = 0;

  for (let i = 0; i < groups.length; i++) {
    checkFlags();
    if (runState.degraded) break;
    await translateGroupRecursive(groups[i], cache, fails, stats);
    done++;
    cache.save();
    // Flush + report every batch: a killed process loses at most one request.
    console.log("PROGRESS", entries.filter((e) => cache.has(e.text)).length, "/", entries.length);
  }

  const missing = entries.filter((e) => !cache.has(e.text));
  if (missing.length && !runState.degraded) {
    console.log("RETRY_SINGLE", missing.length);
    for (const e of missing) {
      checkFlags();
      const c = await translateOne(e.text);
      if (c) cache.set(e.text, c);
      else fails.push({ hash: textHash(e.text), err: "single-fail", text: e.text.slice(0, 40) });
      cache.save();
    }
  } else if (missing.length) {
    console.log("SKIP_RETRY_MODEL_DEGRADED", missing.length);
    for (const e of missing) fails.push({ hash: textHash(e.text), err: "model-degraded", text: e.text.slice(0, 40) });
  }

  cache.save();
  const stillMissing = new Set(entries.filter((e) => !cache.has(e.text)).map((e) => textHash(e.text)));
  const pruned = pruneFailures(fails, stillMissing);
  fs.writeFileSync(FAIL, JSON.stringify(pruned, null, 2), "utf8");
  fs.writeFileSync(
    PATCH_REPORT.replace(/-patch-report\.json$/, "-translate-report.json"),
    JSON.stringify(
      {
        entries: entries.length,
        translated: entries.filter((e) => cache.has(e.text)).length,
        pendingAtStart: pending.length,
        requests: groups.length,
        splitRetries: stats.splits,
        qualityWarnings: stats.warned || 0,
        failures: pruned.length,
      },
      null,
      2
    ),
    "utf8"
  );
  console.log("TRANSLATED", entries.filter((e) => cache.has(e.text)).length, "FAILURES", pruned.length);
  if (process.env.GT_DEBUG_GLOSSARY || glossary.length) {
    const sample = entries.find((e) => glossary.some((g) => g.src === e.text)) || entries[0];
    if (sample) console.log("GLOSSARY_RESULT", JSON.stringify(sample.text.slice(0, 20)), "=>", JSON.stringify(String(cache.lookup(sample.text)).slice(0, 24)), "size=" + glossary.length);
  }
  if (retranslate.size) console.log("RETRANSLATE_UNRESOLVED", retranslate.size, "（这些条目重翻未取得更好的结果，已保留原有译文）");
  return cache;
}

// ---------------- main ----------------
(async () => {
  console.log("GAME", GAME_DIR);
  console.log("MODEL", MODEL);
  const engine = detectEngine(GAME_DIR);
  if (!engine) {
    console.error("NOT_SUPPORTED 无法识别的游戏引擎（需要 MV/MZ 的 data/*.json 或 VX Ace 的 Data/Game.rgss3a）");
    process.exit(2);
  }
  console.log("ENGINE", engine.kind + (engine.isPacked ? " (packed)" : ""));

  // Where do we read the *source* text from? Once a game has been translated,
  // its live data files hold Chinese, so re-extracting from them would (a) miss
  // the cache completely and (b) translate Chinese into Chinese, and for "check"
  // it would judge Chinese against Chinese. The pristine copy under
  // data_原版备份 is the correct source; the live folder is still scanned so
  // content added by a game update is not lost.
  const backupJson = findDataDir(BAK_DIR);
  const liveJson = engine.kind === "MV" ? engine.dataDir : null;
  if (backupJson) console.log("SOURCE_FROM_BACKUP", backupJson);

  let entries;      // what we operate on (live data for VX Ace, pristine-first for MV)
  let sources = null; // pristine source texts, when a backup exists
  let dataDir = engine.dataDir;
  let vxWork = null;
  if (engine.kind === "MV") {
    entries = extractMV(backupJson || dataDir, dataDir);
  } else {
    vxWork = path.join(WORK, name + "-vx");
    fs.mkdirSync(vxWork, { recursive: true });
    if (engine.isPacked) {
      const r = unpackVxAce(engine, vxWork);
      dataDir = path.join(r.outDir, "Data");
    }
    entries = extractVxAce(dataDir);

    // Pristine VX Ace source for the quality pass: the backed-up archive, or a
    // second extraction from the backed-up Data folder.
    const bakArchive = path.join(BAK_DIR, "Game.rgss3a");
    const bakData = path.join(BAK_DIR, "Data");
    try {
      if (fs.existsSync(bakArchive)) {
        const exWork = path.join(WORK, name + "-vx-orig");
        fs.mkdirSync(exWork, { recursive: true });
        const r2 = unpackVxAce({ archive: bakArchive }, exWork, bakArchive);
        sources = new Map(extractVxAceTo(path.join(r2.outDir, "Data"), EXTRACT.replace(/-extract\.json$/, "-extract-orig.json"))
          .map((e) => [normText(e.text), e.text]));
        console.log("SOURCE_FROM_BACKUP", bakArchive);
      } else if (fs.existsSync(bakData)) {
        sources = new Map(extractVxAceTo(bakData, EXTRACT.replace(/-extract\.json$/, "-extract-orig.json"))
          .map((e) => [normText(e.text), e.text]));
        console.log("SOURCE_FROM_BACKUP", bakData);
      }
    } catch (e) {
      console.log("SOURCE_BACKUP_UNREADABLE", e.message);
      sources = null;
    }
  }
  console.log("EXTRACTED", entries.length);
  loadGlossary();
  if (glossary.length) console.log("GLOSSARY_ACTIVE", glossary.length);

  if (MODE === "check") {
    checkUntranslated(entries, sources);
    console.log("CHECK_DONE");
    process.exit(0);
  }

  ensureBackup(engine);
  writeRestoreBat();

  const cache = await translate(entries);

  if (engine.kind === "MV") {
    // Patch the live files (which may have been written by an earlier run);
    // the lookup is by source text, so the backup-sourced keys still match.
    patchMV(dataDir, entries, cache);
  } else {
    patchVxAce(dataDir);
    if (engine.isPacked) repackVxAce(engine, vxWork);
  }
  console.log("DONE");
})().catch((e) => {
  console.error("ERROR", e && e.stack ? e.stack : e);
  process.exit(1);
});
