// Memory watchdog for llama-server.
//
// The server can slowly accumulate host memory over many hours (measured: a
// 7.5-hour session reached 11.7 GB for a 2.5 GB model, leaving 1.7 GB free on a
// 16 GB machine; a fresh start uses 3.6 GB and stayed flat for 43 minutes of
// continuous inference). Rather than leave the machine swapping, this restarts
// the server when its working set crosses a threshold. Translation progress is
// per-game cache files, so a restart costs one request, not the run.
"use strict";
const fs = require("fs");
const cp = require("child_process");

const APP = "D:\\GameTranslator";
const EXE = APP + "\\llama\\llama-server.exe";
const MODEL = "H:\\model\\Galtransl-v4-4B-2601.gguf";
const PORT = "18080";
const THRESHOLD_MB = parseInt(process.env.GT_MEM_LIMIT_MB || "6000", 10);
const CHECK_MS = 60000;

const ARGS = ["-m", MODEL, "--host", "127.0.0.1", "--port", PORT, "-c", "4096", "-ngl", "99",
  "-b", "2048", "-ub", "512", "-t", "4", "--poll", "0", "-fa", "on",
  "-ctk", "f16", "-ctv", "f16", "--parallel", "1", "--temp", "0.3", "--top-p", "0.8",
  "--metrics", "--no-webui"];

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function ps(script) {
  try {
    return cp.execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8" }).trim();
  } catch (e) { return ""; }
}

function findServer() {
  const out = ps("Get-CimInstance Win32_Process -Filter \"Name='llama-server.exe'\" | Where-Object { $_.CommandLine -match '18080' } | Select-Object -ExpandProperty ProcessId");
  const id = parseInt(out.split(/\s+/)[0], 10);
  return Number.isFinite(id) ? id : null;
}

function workingSetMB(pid) {
  const out = ps("(Get-Process -Id " + pid + " -ErrorAction SilentlyContinue).WorkingSet64");
  const v = parseInt(out, 10);
  return Number.isFinite(v) ? Math.round(v / 1048576) : null;
}

function stop(pid) {
  ps("Stop-Process -Id " + pid + " -Force -ErrorAction SilentlyContinue");
}

function start() {
  const child = cp.spawn(EXE, ARGS, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  return child.pid;
}

function healthy() {
  const out = ps("try { (Invoke-WebRequest 'http://127.0.0.1:" + PORT + "/health' -TimeoutSec 3 -UseBasicParsing).StatusCode } catch { 'ERR' }");
  return out === "200";
}

(async () => {
  log("watchdog up: restart when working set > " + THRESHOLD_MB + " MB");
  let restarts = 0;
  for (;;) {
    const pid = findServer();
    if (!pid) {
      log("no server found; starting one");
      start();
      restarts++;
    } else {
      const mb = workingSetMB(pid);
      if (mb === null) {
        log("server " + pid + " disappeared");
      } else if (mb > THRESHOLD_MB) {
        log("working set " + mb + " MB > " + THRESHOLD_MB + " MB: restarting server " + pid);
        stop(pid);
        await new Promise((r) => setTimeout(r, 5000));
        start();
        restarts++;
      } else if (!healthy()) {
        log("server " + pid + " is " + mb + " MB but not answering /health; restarting");
        stop(pid);
        await new Promise((r) => setTimeout(r, 5000));
        start();
        restarts++;
      }
    }
    fs.writeFileSync("D:\\dsh\\gt-audit\\watchdog-status.json",
      JSON.stringify({ restarts, thresholdMB: THRESHOLD_MB, updated: new Date().toISOString() }, null, 2), "utf8");
    await new Promise((r) => setTimeout(r, CHECK_MS));
  }
})();
