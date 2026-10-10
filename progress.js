// Progress report for the batch translation.
//
//   node progress.js            one-shot report
//   node progress.js --watch    refresh in place
//   node progress.js --json     machine-readable (used by the HTML dashboard)
"use strict";
const fs = require("fs");
const path = require("path");

const APP = "D:\\GameTranslator";
const WORK = path.join(APP, "work");
const BATCH_LOGS = ["D:\\dsh\\gt-audit\\batch3.log", "D:\\dsh\\gt-audit\\batch2.log", "D:\\dsh\\gt-audit\\batch.log"];
const WATCHDOG = "D:\\dsh\\gt-audit\\watchdog-status.json";

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes("--json");

const sanitize = (dir) => path.basename(dir).replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_");
const SUPPORTED = new Set(["MV", "MZ", "VXAce", "VX"]);

function loadGames() {
  const p = path.join(WORK, "games-cache.json");
  if (!fs.existsSync(p)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    const arr = Array.isArray(raw) ? raw : raw.games || [];
    return arr.filter((g) => g && g.Dir && SUPPORTED.has(g.Kind));
  } catch (e) {
    return [];
  }
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return null; }
}

// PowerShell's Tee-Object writes UTF-16LE on 5.1, so the log must be decoded
// explicitly; reading it as UTF-8 silently finds nothing (every regex missed).
function readTextAny(p) {
  try {
    const b = fs.readFileSync(p);
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.toString("utf16le").replace(/^\uFEFF/, "");
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
      const swapped = Buffer.from(b);
      for (let i = 0; i + 1 < swapped.length; i += 2) { const t = swapped[i]; swapped[i] = swapped[i + 1]; swapped[i + 1] = t; }
      return swapped.toString("utf16le").replace(/^\uFEFF/, "");
    }
    return b.toString("utf8").replace(/^\uFEFF/, "");
  } catch (e) {
    return "";
  }
}

function countCache(dir) {
  const j = readJson(path.join(WORK, sanitize(dir) + "-translations.json"));
  return j && j.byText ? Object.keys(j.byText).length : 0;
}

function statusOf(g) {
  const base = sanitize(g.Dir);
  const tr = readJson(path.join(WORK, base + "-translate-report.json"));
  const fails = readJson(path.join(WORK, base + "-failures.json"));
  const have = countCache(g.Dir);
  let state = "等待";
  if (tr && tr.entries) {
    const pct = tr.translated / tr.entries;
    if (pct >= 0.9) state = "已完成";
    else if (tr.translated > 0) state = "部分完成";
    else state = "失败待重跑";
  } else if (have > 0) {
    state = "进行中";
  }
  return {
    dir: g.Dir,
    name: path.basename(g.Dir).slice(0, 46),
    kind: g.Kind,
    state,
    entries: tr ? tr.entries : 0,
    translated: tr ? tr.translated : have,
    failures: Array.isArray(fails) ? fails.length : (tr ? tr.failures : 0),
    cached: have,
  };
}

function serverInfo() {
  const out = { pid: null, memMB: null, model: null, running: false };
  try {
    const cp = require("child_process");
    const psOut = cp.execFileSync("powershell.exe", ["-NoProfile", "-Command",
      "$p = Get-CimInstance Win32_Process -Filter \"Name='llama-server.exe'\" | Where-Object { $_.CommandLine -match '18080' } | Select-Object -First 1; " +
      "if ($p) { $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue; " +
      "\"$($p.ProcessId)|$([math]::Round($proc.WorkingSet64/1MB))|$($p.CommandLine)\" }"],
      { encoding: "utf8", timeout: 20000 }).trim();
    if (psOut) {
      const parts = psOut.split("|");
      out.pid = parseInt(parts[0], 10);
      out.memMB = parseInt(parts[1], 10);
      const m = parts.slice(2).join("|").match(/-m\s+"?([^"]+?)"?(?:\s|$)/);
      out.model = m ? path.basename(m[1]) : null;
      out.running = true;
    }
  } catch (e) {}
  const wd = readJson(WATCHDOG);
  out.watchdogRestarts = wd ? wd.restarts : null;
  return out;
}

function systemInfo() {
  try {
    const cp = require("child_process");
    const s = cp.execFileSync("powershell.exe", ["-NoProfile", "-Command",
      "$os=Get-CimInstance Win32_OperatingSystem; \"$([math]::Round($os.FreePhysicalMemory/1KB))|$([math]::Round($os.TotalVisibleMemorySize/1MB,1))\""],
      { encoding: "utf8", timeout: 20000 }).trim();
    const [free, total] = s.split("|");
    return { freeMB: parseInt(free, 10), totalGB: parseFloat(total) };
  } catch (e) {
    return { freeMB: null, totalGB: null };
  }
}

function batchState() {
  const log = BATCH_LOGS.find((p) => fs.existsSync(p));
  const st = { log: log || null, gamesDone: 0, entries: 0, failures: 0, current: null, lines: 0 };
  if (!log) return st;
  let text = "";
  try { text = readTextAny(log); } catch (e) {}
  // Keep the LAST run of each game only: a retried game appears several times in
  // the log, and summing every appearance inflated both totals (a game retried
  // after an outage counted its failures over and over).
  const byGame = new Map();
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    st.lines++;
    const start = line.match(/START\s+\[(\w+)\]\s+(.+?)\s*$/);
    if (start) {
      cur = { dir: start[2], kind: start[1], translated: 0, failures: 0 };
      byGame.set(cur.dir, cur);
      st.current = line.replace(/^\S+\s+/, "").slice(0, 90);
      continue;
    }
    if (/END\s+code=/.test(line)) {
      st.gamesDone++;
      continue;
    }
    if (!cur) continue;
    const t = line.match(/TRANSLATED (\d+)/);
    if (t) cur.translated = parseInt(t[1], 10);
    const f = line.match(/FAILURES (\d+)/);
    if (f) cur.failures = parseInt(f[1], 10);
  }
  let seen = 0;
  for (const g of byGame.values()) {
    // only count games that actually finished a run
    if (g.translated === 0 && g.failures === 0) continue;
    seen++;
    st.entries += g.translated;
    st.failures += g.failures;
  }
  st.gamesCounted = seen;
  try {
    const s = fs.statSync(log);
    st.sizeKB = Math.round(s.size / 1024);
    st.mtime = s.mtime;
  } catch (e) {}
  return st;
}

function isPipelineRunning() {
  try {
    const cp = require("child_process");
    const out = cp.execFileSync("powershell.exe", ["-NoProfile", "-Command",
      "@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'game-pipeline' }).Count"],
      { encoding: "utf8", timeout: 20000 }).trim();
    return parseInt(out, 10) > 0;
  } catch (e) { return false; }
}

function activeGame() {
  // the cache file touched most recently belongs to the game being translated
  try {
    const files = fs.readdirSync(WORK).filter((f) => f.endsWith("-translations.json"));
    let best = null;
    for (const f of files) {
      const m = fs.statSync(path.join(WORK, f)).mtimeMs;
      if (!best || m > best.m) best = { f, m };
    }
    if (!best) return null;
    const name = best.f.replace("-translations.json", "");
    const n = Object.keys(readJson(path.join(WORK, best.f)).byText || {}).length;
    const ageSec = Math.round((Date.now() - best.m) / 1000);
    return { name, count: n, ageSec };
  } catch (e) { return null; }
}

function build() {
  const games = loadGames().map(statusOf);
  const batch = batchState();
  const srv = serverInfo();
  const sys = systemInfo();
  const running = isPipelineRunning();
  const act = activeGame();
  const groups = { 已完成: [], 部分完成: [], 进行中: [], 失败待重跑: [], 等待: [] };
  for (const g of games) (groups[g.state] || groups["等待"]).push(g);

  const cachedTotal = games.reduce((a, g) => a + g.cached, 0);
  const doneCount = groups["已完成"].length;
  // Totals come from the per-game reports (authoritative) rather than from the
  // console log, which a retry rewrites.
  let translatedSum = 0, failedSum = 0, counted = 0;
  for (const g of games) {
    if (!g.entries) continue;
    counted++;
    translatedSum += g.translated;
    failedSum += g.failures;
  }
  return {
    generated: new Date().toISOString(),
    running,
    server: srv,
    system: sys,
    batch: { ...batch, mtime: batch.mtime ? batch.mtime.toISOString() : null },
    active: act,
    totals: {
      games: games.length,
      done: doneCount,
      partial: groups["部分完成"].length,
      failed: groups["失败待重跑"].length,
      waiting: groups["等待"].length,
      inProgress: groups["进行中"].length,
      entriesTranslated: translatedSum,
      entriesFailed: failedSum,
      gamesCounted: counted,
      cachedEntries: cachedTotal,
      percent: games.length ? Math.round((doneCount / games.length) * 100) : 0,
    },
    lists: {
      done: groups["已完成"].map((g) => g.name),
      failed: groups["失败待重跑"].slice(0, 12).map((g) => g.name),
      waiting: groups["等待"].slice(0, 12).map((g) => g.name),
    },
  };
}

function render(r) {
  const L = [];
  const pad = (s, n) => String(s).padEnd(n);
  L.push("=".repeat(78));
  L.push("  游戏翻译进度    " + new Date(r.generated).toLocaleString("zh-CN"));
  L.push("=".repeat(78));
  L.push("");
  L.push("  总进度   " + r.totals.done + " / " + r.totals.games + " 个游戏已完成  (" + r.totals.percent + "%)");
  L.push("          " + "█".repeat(Math.round(r.totals.percent / 4)).padEnd(25, "░") + " " + r.totals.percent + "%");
  L.push("");
  L.push("  分类     已完成 " + pad(r.totals.done, 4) + " 进行中 " + pad(r.totals.inProgress, 4) +
         " 部分完成 " + pad(r.totals.partial, 4) + " 失败待重跑 " + pad(r.totals.failed, 4) + " 等待 " + r.totals.waiting);
  L.push("  译文条目 已成功 " + r.totals.entriesTranslated.toLocaleString() + " 条" +
         (r.totals.entriesFailed > 0 ? "，待重跑队列 " + r.totals.entriesFailed.toLocaleString() + " 条（会自动重试）" : "") +
         "；缓存合计 " + r.totals.cachedEntries.toLocaleString() + " 条");
  L.push("");
  L.push("  " + (r.running ? "● 翻译任务正在运行" : "○ 翻译任务未运行"));
  if (r.active) {
    L.push("  当前游戏 " + r.active.name.slice(0, 50) + "  缓存 " + r.active.count + " 条" +
           (r.active.ageSec < 120 ? "  (刚更新)" : "  (上次更新 " + Math.round(r.active.ageSec / 60) + " 分钟前)"));
  }
  L.push("");
  if (r.server.running) {
    L.push("  模型     " + (r.server.model || "?") + "   PID " + r.server.pid +
           "   内存 " + r.server.memMB + " MB" + (r.server.memMB > 6000 ? "  ⚠ 偏高" : ""));
  } else {
    L.push("  模型     未运行 ⚠");
  }
  L.push("  看门狗   已自动重启服务器 " + (r.server.watchdogRestarts === null ? "?" : r.server.watchdogRestarts) + " 次");
  L.push("  系统内存 可用 " + r.system.freeMB + " MB / " + r.system.totalGB + " GB");
  L.push("");
  if (r.lists.failed.length) {
    L.push("  失败待重跑（会自动重试）:");
    for (const n of r.lists.failed) L.push("    · " + n);
    L.push("");
  }
  if (r.lists.waiting.length) {
    L.push("  队列中等待:");
    for (const n of r.lists.waiting) L.push("    · " + n);
    L.push("");
  }
  L.push("  日志: " + (r.batch.log || "无") + "   (" + (r.batch.sizeKB || 0) + " KB)");
  L.push("=".repeat(78));
  return L.join("\n");
}

// A self-contained dashboard: progress.html is rewritten next to the script, so
// double-clicking it (or leaving it open) always shows current numbers without a
// server. It reloads itself every 10 s, and --live keeps the file refreshed.
function writeHtml(r) {
  const pct = r.totals.percent;
  const bar = (n, total, w) => {
    const filled = total ? Math.round((n / total) * w) : 0;
    return "█".repeat(filled) + "░".repeat(Math.max(0, w - filled));
  };
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const rows = (arr) => arr.map((n) => "<li>" + esc(n) + "</li>").join("");
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="10">
<title>游戏翻译进度</title>
<style>
 body{font-family:"Microsoft YaHei",sans-serif;background:#12161c;color:#e6e9ef;margin:0;padding:24px}
 h1{font-size:20px;margin:0 0 4px}
 .meta{color:#8b95a5;font-size:13px;margin-bottom:18px}
 .card{background:#1a2027;border:1px solid #262d36;border-radius:10px;padding:16px 18px;margin-bottom:14px}
 .big{font-size:34px;font-weight:700}
 .bar{font-family:Consolas,monospace;letter-spacing:1px;color:#4fc3f7;font-size:15px}
 .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
 .k{color:#8b95a5;font-size:12px}
 .v{font-size:19px;font-weight:600;margin-top:2px}
 .ok{color:#66bb6a}.warn{color:#ffa726}.bad{color:#ef5350}.run{color:#4fc3f7}
 ul{margin:6px 0 0;padding-left:18px;columns:2;color:#c3cad6;font-size:13px}
 li{margin:2px 0}
</style></head><body>
<h1>游戏翻译进度</h1>
<div class="meta">更新于 ${esc(new Date(r.generated).toLocaleString("zh-CN"))} ｜ 每 10 秒自动刷新</div>

<div class="card">
  <div class="k">总进度</div>
  <div class="big">${r.totals.done} / ${r.totals.games} <span style="font-size:16px;color:#8b95a5">个游戏已完成（${pct}%）</span></div>
  <div class="bar">${bar(r.totals.done, r.totals.games, 40)} ${pct}%</div>
</div>

<div class="card">
  <div class="grid">
    <div><div class="k">任务状态</div><div class="v ${r.running ? "run" : "bad"}">${r.running ? "正在运行" : "未运行"}</div></div>
    <div><div class="k">成功译文</div><div class="v ok">${r.totals.entriesTranslated.toLocaleString()}</div></div>
    <div><div class="k">缓存合计</div><div class="v">${r.totals.cachedEntries.toLocaleString()}</div></div>
    <div><div class="k">待重跑队列</div><div class="v warn">${r.totals.entriesFailed.toLocaleString()}</div></div>
    <div><div class="k">已完成游戏</div><div class="v ok">${r.totals.done}</div></div>
    <div><div class="k">部分完成</div><div class="v warn">${r.totals.partial}</div></div>
    <div><div class="k">失败待重跑</div><div class="v bad">${r.totals.failed}</div></div>
    <div><div class="k">队列中等待</div><div class="v">${r.totals.waiting}</div></div>
  </div>
</div>

<div class="card">
  <div class="grid">
    <div><div class="k">模型</div><div class="v" style="font-size:14px">${esc(r.server.model || "未运行")}</div></div>
    <div><div class="k">服务器内存</div><div class="v ${r.server.memMB > 6000 ? "warn" : "ok"}">${r.server.memMB === null ? "-" : r.server.memMB + " MB"}</div></div>
    <div><div class="k">看门狗自动重启</div><div class="v">${r.server.watchdogRestarts === null ? "-" : r.server.watchdogRestarts} 次</div></div>
    <div><div class="k">系统可用内存</div><div class="v">${r.system.freeMB === null ? "-" : r.system.freeMB + " MB"}</div></div>
  </div>
</div>

${r.active ? `<div class="card"><div class="k">当前游戏</div>
  <div class="v" style="font-size:15px">${esc(r.active.name)}</div>
  <div class="meta" style="margin:6px 0 0">已缓存 ${r.active.count.toLocaleString()} 条 ｜ ${r.active.ageSec < 120 ? "刚刚更新" : Math.round(r.active.ageSec / 60) + " 分钟前更新"}</div></div>` : ""}

${r.lists.failed.length ? `<div class="card"><div class="k bad">失败待重跑（会自动重试）</div><ul>${rows(r.lists.failed)}</ul></div>` : ""}
${r.lists.waiting.length ? `<div class="card"><div class="k">队列中等待</div><ul>${rows(r.lists.waiting)}</ul></div>` : ""}

</body></html>`;
  const out = path.join(path.dirname(__filename), "progress.html");
  fs.writeFileSync(out, html, "utf8");
  return out;
}

if (JSON_OUT) {
  console.log(JSON.stringify(build(), null, 2));
} else if (argv.includes("--html") || argv.includes("--live")) {
  const live = argv.includes("--live");
  const write = () => {
    const r = build();
    const p = writeHtml(r);
    console.log(new Date().toLocaleTimeString("zh-CN") + "  已生成 " + p);
    console.log("  总进度 " + r.totals.done + "/" + r.totals.games + " 个游戏（" + r.totals.percent + "%）  已成功 " +
      r.totals.entriesTranslated.toLocaleString() + " 条  缓存 " + r.totals.cachedEntries.toLocaleString() + " 条");
    if (r.active) console.log("  当前 " + r.active.name.slice(0, 44) + "  " + r.active.count + " 条");
    console.log("  服务器 " + (r.server.running ? r.server.memMB + " MB" : "未运行") + "   可用内存 " + r.system.freeMB + " MB");
  };
  write();
  if (live) {
    console.log("\n每 15 秒刷新 progress.html；浏览器打开它会每 10 秒自动重新加载。Ctrl+C 退出。");
    setInterval(write, 15000);
  } else {
    console.log("\n用浏览器打开上面的 progress.html 即可查看（会自动刷新）。");
  }
} else if (argv.includes("--watch")) {
  setInterval(() => {
    const out = render(build());
    process.stdout.write("\x1b[2J\x1b[H" + out + "\n  (每 15 秒刷新，Ctrl+C 退出)\n");
  }, 15000);
  process.stdout.write(render(build()) + "\n");
} else {
  console.log(render(build()));
}
