// Usage: node game-pipeline.js <gameDir> <model> <workDir> [port]
//   Requires a local llama-server (llama.cpp) already running on 127.0.0.1:<port>.
// Extracts RPG Maker MV/MZ (www/data json) or VX Ace (Data/*.rvdata2 / Game.rgss3a)
// text, translates with Ollama and/or a network API, patches in place, and resumes
// from translations.json when re-run.
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { spawnSync } = require("child_process");
const { readArchive, extractFile, writeArchiveTo } = require("./rgss3a.js");

const GAME_DIR = process.argv[2];
const MODEL = process.argv[3] || "model";
const WORK = process.argv[4] || path.join(__dirname, "pipeline-work");
const PORT = process.argv[5] || "18080";
const PAUSE_FLAG = path.join(WORK, "pause.flag");
const STOP_FLAG = path.join(WORK, "stop.flag");

const RUBY = process.env.VXACE_RUBY || path.join(__dirname, "ruby", "bin", "ruby.exe");
const VX_EXTRACT = path.join(__dirname, "vxace_extract.rb");
const VX_PATCH = path.join(__dirname, "vxace_patch.rb");
const BATCH = 16;

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

// ---------------- engine detection ----------------
function detectEngine(dir) {
  const wwwData = path.join(dir, "www", "data");
  if (fs.existsSync(wwwData)) {
    try {
      if (fs.readdirSync(wwwData).some((f) => f.endsWith(".json"))) return { kind: "MV", dataDir: wwwData };
    } catch (e) {}
  }
  const loose = path.join(dir, "Data");
  const archive = path.join(dir, "Game.rgss3a");
  if (fs.existsSync(archive)) return { kind: "VXAce", dataDir: null, isPacked: true, archive };
  if (fs.existsSync(loose)) {
    try {
      if (fs.readdirSync(loose).some((f) => f.endsWith(".rvdata2"))) return { kind: "VXAce", dataDir: loose, isPacked: false, archive: null };
    } catch (e) {}
  }
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
    'if exist "data_原版备份\\Map001.json" (',
    '  if exist "www\\data" rmdir /s /q "www\\data"',
    '  mkdir "www\\data" >nul 2>&1',
    '  xcopy /e /i /y "data_原版备份\\*" "www\\data" >nul',
    ')',
    "echo.",
    "echo 还原完成！游戏数据已恢复为汉化前的原版。",
    "pause",
  ];
  fs.writeFileSync(bat, "\ufeff" + lines.join("\r\n"), "utf8");
  console.log("RESTORE_BAT_CREATED");
}

const name = path.basename(GAME_DIR).replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_");
const EXTRACT = path.join(WORK, name + "-extract.json");
const TRANS = path.join(WORK, name + "-translations.json");
const FAIL = path.join(WORK, name + "-failures.json");

// ---------------- MV/MZ extraction ----------------
function extractMV(dataDir) {
  const entries = [];
  const seen = new Map();
  let id = 0;
  const add = (file, p, text) => {
    const t = String(text);
    if (!looksTranslatable(t)) return;
    if (seen.has(t)) return;
    seen.set(t, id);
    entries.push({ id: id++, file, path: p, text: t });
  };
  const processEventList = (file, list, p) => {
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
      if (code === 401 || code === 405) add(file, pp, params[0]);
      else if (code === 102 && Array.isArray(params[0])) params[0].forEach((c) => add(file, pp, c));
      else if (code === 402) add(file, pp, params[1]);
      else if (code === 111 && typeof params[2] === "string") add(file, pp, params[2]);
    });
  };
  const walk = (file, obj, p) => {
    if (Array.isArray(obj)) {
      const isEventList =
        obj.length > 0 &&
        ((Array.isArray(obj[0]) && obj[0].length >= 3 && typeof obj[0][0] === "number") ||
          (obj[0] && typeof obj[0] === "object" && typeof obj[0].code === "number" && Array.isArray(obj[0].parameters)));
      if (isEventList) {
        processEventList(file, obj, p);
        return;
      }
      obj.forEach((v, i) => walk(file, v, p + "[" + i + "]"));
      return;
    }
    if (obj && typeof obj === "object") {
      if (isAudioObject(obj)) return; // skip audio resource objects entirely
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (typeof v === "string") {
          if (["name", "nickname", "description", "message1", "message2", "profile"].includes(k)) add(file, p + "." + k, v);
        } else walk(file, v, p + "." + k);
      }
    }
  };
  const files = fs.readdirSync(dataDir).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(dataDir, f), "utf8"));
    } catch (e) {
      continue;
    }
    if (f === "System.json" && data.terms) {
      for (const k of Object.keys(data.terms)) {
        const arr = data.terms[k];
        if (Array.isArray(arr)) arr.forEach((v, i) => add(f, "$terms." + k + "[" + i + "]", v));
      }
    }
    walk(f, data, "$");
  }
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

function unpackVxAce(engine, vxWork) {
  const outDir = path.join(vxWork, "unpacked");
  const manifestPath = path.join(vxWork, "manifest.json");
  if (fs.existsSync(path.join(outDir, "Data")) && fs.existsSync(manifestPath)) return { outDir, manifestPath };
  console.log("UNPACKING " + engine.archive);
  const buf = fs.readFileSync(engine.archive);
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
      const data = extractFile(arch, orig);
      entries.push({ name: m.name, size: data.length, buf: data });
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

function patchVxAce(dataDir) {
  runRuby(VX_PATCH, [dataDir, EXTRACT, TRANS]);
}

// ---------------- MV patch ----------------
function patchMV(dataDir, entries, translations) {
  const srcMap = {};
  for (const e of entries) if (e.id in translations) srcMap[e.text] = translations[e.id];
  let replaced = 0;
  const replaceText = (text) => {
    if (typeof text !== "string") return text;
    if (text in srcMap) {
      replaced++;
      return srcMap[text];
    }
    return text;
  };
  const patchEventList = (list) => {
    if (!Array.isArray(list)) return;
    for (const cmd of list) {
      if (!cmd || typeof cmd !== "object") continue;
      const code = cmd.code;
      const params = cmd.parameters;
      if (!Array.isArray(params)) continue;
      if (code === 401 || code === 405) params[0] = replaceText(params[0]);
      else if (code === 102 && Array.isArray(params[0])) params[0] = params[0].map((c) => replaceText(c));
      else if (code === 402) params[1] = replaceText(params[1]);
      else if (code === 111 && typeof params[2] === "string") params[2] = replaceText(params[2]);
    }
  };
  const walk = (obj) => {
    if (Array.isArray(obj)) {
      const isEventList =
        obj.length > 0 &&
        obj[0] &&
        typeof obj[0] === "object" &&
        typeof obj[0].code === "number" &&
        Array.isArray(obj[0].parameters);
      if (isEventList) {
        patchEventList(obj);
        return;
      }
      for (const v of obj) walk(v);
      return;
    }
    if (obj && typeof obj === "object") {
      if (isAudioObject(obj)) return; // never patch audio resource names
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (typeof v === "string") {
          if (["name", "nickname", "description", "message1", "message2", "profile"].includes(k)) obj[k] = replaceText(v);
        } else walk(v);
      }
    }
  };
  const files = fs.readdirSync(dataDir).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    const fp = path.join(dataDir, f);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(fp, "utf8"));
    } catch (e) {
      continue;
    }
    if (f === "System.json" && data.terms) {
      for (const k of Object.keys(data.terms)) {
        const arr = data.terms[k];
        if (Array.isArray(arr)) arr.forEach((v, i) => (arr[i] = replaceText(v)));
      }
    }
    walk(data);
    fs.writeFileSync(fp, JSON.stringify(data), "utf8");
  }
  console.log("PATCHED", replaced);
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
  if (t.length > 0 && t.length < 3) return null;
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

function askLocal(content) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "local",
      messages: [{ role: "user", content }],
      temperature: 0.3,
      max_tokens: 2048,
      stream: false,
    });
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: "/v1/chat/completions", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(d);
            if (j.error) return reject(new Error(typeof j.error === "string" ? j.error : JSON.stringify(j.error)));
            const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
            if (!text) return reject(new Error("llama 无返回内容"));
            resolve(text);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(240000, () => req.destroy(new Error("timeout")));
    req.write(body);
    req.end();
  });
}

async function ask(content) { return askLocal(content); }

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

function parseResult(text) {
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
  const obj = {};
  for (const line of t.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d{1,3})[.、:：]\s*(.+)$/);
    if (m) obj[m[1]] = m[2].trim();
  }
  if (Object.keys(obj).length) return obj;
  return null;
}

async function translate(entries) {
  if (fs.existsSync(PAUSE_FLAG)) fs.rmSync(PAUSE_FLAG);
  if (fs.existsSync(STOP_FLAG)) fs.rmSync(STOP_FLAG);
  const translations = fs.existsSync(TRANS) ? JSON.parse(fs.readFileSync(TRANS, "utf8")) : {};
  let failures = fs.existsSync(FAIL) ? JSON.parse(fs.readFileSync(FAIL, "utf8")) : [];
  const pending = entries.filter((e) => !(e.id in translations));
  console.log("TOTAL", entries.length, "DONE", entries.length - pending.length, "PENDING", pending.length);
  let batchCount = 0;
  for (let i = 0; i < pending.length; i += BATCH) {
    checkFlags();
    const batch = pending.slice(i, i + BATCH);
    const lines = batch.map((e, j) => j + 1 + ". " + e.text).join("\n");
    const prompt =
      "将下列每行日文翻译成简体中文（禁止翻译成英文，只能输出简体中文）。必须原样保留 \\N[1]、\\V[1]、\\N<角色名> 等控制代码与角色名标记，不得增删行数。\n" +
      '只输出一个JSON对象，键为行号，值为简体中文译文，例如{"1":"译文一","2":"译文二"}，不要输出其他内容。\n\n' +
      lines;
    let result = null;
    for (let attempt = 0; attempt < 3 && !result; attempt++) {
      try {
        const resp = await ask(prompt);
        const obj = parseResult(resp);
        if (obj) {
          const r = {};
          let ok = true;
          for (let j = 0; j < batch.length; j++) {
            const v = obj[String(j + 1)];
            if (v === undefined || typeof v !== "string") {
              ok = false;
              break;
            }
            const c = cleanOutput(v);
            if (c === null || looksLikeEnglish(c)) {
              ok = false;
              break;
            }
            r[batch[j].id] = c;
          }
          if (ok) result = r;
        }
      } catch (e) {
        if (attempt === 2) failures.push({ batch: i, err: e.message });
      }
    }
    if (result) Object.assign(translations, result);
    else if (batch.length) failures.push({ batch: i, err: "parse-fail" });
    batchCount++;
    if (batchCount % 5 === 0) {
      fs.writeFileSync(TRANS, JSON.stringify(translations), "utf8");
      fs.writeFileSync(FAIL, JSON.stringify(failures), "utf8");
      console.log("PROGRESS", Object.keys(translations).length, "/", entries.length);
    }
  }
  const missing = entries.filter((e) => !(e.id in translations));
  if (missing.length) {
    console.log("RETRY_SINGLE", missing.length);
    for (const e of missing) {
      let done = false;
      for (const prompt of [
        "请将下面日文翻译成简体中文（禁止输出英文）：\n" + e.text,
        "将下面日文翻译成简体中文（只能输出中文）：\n" + e.text,
        "翻译成简体中文（禁止英文）：\n" + e.text,
      ]) {
        if (done) break;
        try {
          const resp = await ask(prompt);
          const c = cleanOutput(resp);
          if (c && !/^注意：/.test(c) && c.length >= 2 && !looksLikeEnglish(c)) {
            translations[e.id] = c;
            done = true;
          }
        } catch (err) {}
      }
      if (!done) failures.push({ id: e.id, err: "single-fail" });
    }
    fs.writeFileSync(TRANS, JSON.stringify(translations), "utf8");
    fs.writeFileSync(FAIL, JSON.stringify(failures), "utf8");
  }
  // prune stale failure records whose entries were later recovered
  const missingIds = new Set(entries.filter((e) => !(e.id in translations)).map((e) => e.id));
  failures = failures.filter((f) => {
    if (f.id !== undefined) return missingIds.has(f.id);
    if (f.batch !== undefined) {
      const batchEntries = entries.slice(f.batch, f.batch + BATCH);
      return batchEntries.some((e) => missingIds.has(e.id));
    }
    return true;
  });
  fs.writeFileSync(TRANS, JSON.stringify(translations), "utf8");
  fs.writeFileSync(FAIL, JSON.stringify(failures), "utf8");
  console.log("TRANSLATED", Object.keys(translations).length, "FAILURES", failures.length);
  return translations;
}

// ---------------- main ----------------
(async () => {
  console.log("GAME", GAME_DIR);
  console.log("MODEL", MODEL);
  const engine = detectEngine(GAME_DIR);
  if (!engine) {
    console.error("NOT_SUPPORTED 无法识别的游戏引擎（需要 MV/MZ 的 www/data 或 VX Ace 的 Data/Game.rgss3a）");
    process.exit(2);
  }
  console.log("ENGINE", engine.kind + (engine.isPacked ? " (packed)" : ""));

  ensureBackup(engine);
  writeRestoreBat();

  let entries;
  let dataDir = engine.dataDir;
  let vxWork = null;
  if (engine.kind === "MV") {
    entries = extractMV(dataDir);
  } else {
    vxWork = path.join(WORK, name + "-vx");
    fs.mkdirSync(vxWork, { recursive: true });
    if (engine.isPacked) {
      const r = unpackVxAce(engine, vxWork);
      dataDir = path.join(r.outDir, "Data");
    }
    entries = extractVxAce(dataDir);
  }
  console.log("EXTRACTED", entries.length);

  const translations = await translate(entries);

  if (engine.kind === "MV") {
    patchMV(dataDir, entries, translations);
  } else {
    patchVxAce(dataDir);
    if (engine.isPacked) repackVxAce(engine, vxWork);
  }
  console.log("DONE");
})().catch((e) => {
  console.error("ERROR", e && e.stack ? e.stack : e);
  process.exit(1);
});
