// Assertions for the cooperative pause.
//
// The window's 暂停 writes work\paused.flag; the translate loop waits on it between REQUESTS. Pausing only
// between games is what made the button look dead: a large game runs for hours, so nothing visible happened
// for as long as that game took.
//
// The model is a local http server inside this process (no external service, no child process); it counts
// the requests it serves, which is how "the loop really stopped" is measured rather than inferred.
//
// Run:  node tools/unit-pause.js
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const T = require("../pipeline/translate/index.js");

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  ok    " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "   " + detail : "")); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let served = 0;
const server = http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    served++;
    let prompt = "";
    try { const j = JSON.parse(body); prompt = j.messages[j.messages.length - 1].content; } catch (e) { }
    const out = prompt.split(/\r?\n/).filter((l) => l.trim())
      .map((l) => l.replace(/[\u3041-\u3093\u30a1-\u30f6]/g, "\u6587"));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: out.join("\n") } }] }));
  });
});

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const TMP = path.resolve(path.join(os.tmpdir(), "unit-pause-" + process.pid));
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });
    const flag = path.join(TMP, "paused.flag");
    // 24 entries: with the default batch of 8 that is 3 requests, so the pause has to be checked more than
    // once and the "no request while paused" assertion means something.
    const entries = [];
    for (let i = 0; i < 24; i++) entries.push({ id: i, file: "x.json", path: "$[" + i + "]", text: "\u3042\u3044\u3046" + i });

    console.log("=== 标记存在时：一条请求都不应发出 ===");
    fs.writeFileSync(flag, "paused by the test", "utf8");
    served = 0;
    let done = false;
    const p = T.translate({ entries, cacheFile: path.join(TMP, "c1.json"), port, pauseFile: flag })
      .then((r) => { done = true; return r; });
    await sleep(1500);
    check("仍在暂停中（尚未完成）", !done);
    check("暂停期间没有发出任何请求", served === 0, "served=" + served);
    console.log("");
    console.log("=== 删除标记后继续跑完 ===");
    fs.rmSync(flag);
    const r1 = await p;
    check("删掉标记后完成", done);
    check("请求数 > 0", served > 0, "served=" + served);
    check("24 条都译了", r1.stats.cached === 24, "cached=" + r1.stats.cached);

    console.log("");
    console.log("=== 没有标记时不受影响 ===");
    check("标记已不在", !fs.existsSync(flag));
    served = 0;
    const r2 = await T.translate({
      entries: [{ id: 0, file: "y.json", path: "$[0]", text: "\u304b\u304d\u304f" }],
      cacheFile: path.join(TMP, "c2.json"), port, pauseFile: flag,
    });
    check("无标记时正常翻译", r2.stats.cached === 1 && served === 1, "cached=" + r2.stats.cached + " served=" + served);

    console.log("");
    console.log("=== 未传 pauseFile 时也不受影响（向后兼容）===");
    const r3 = await T.translate({
      entries: [{ id: 0, file: "z.json", path: "$[0]", text: "\u3055\u3057\u3059\u305b\u305d" }],
      cacheFile: path.join(TMP, "c3.json"), port,
    });
    check("没有 pauseFile 也能跑", r3.stats.cached === 1, "cached=" + r3.stats.cached);
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
    server.close();
  }

  console.log("");
  console.log("  pass " + pass + "   fail " + fail);
  process.exit(fail ? 1 : 0);
})();
