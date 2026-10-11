// Assertions for the pair callback the 翻译对照 panel depends on.
//
// The window learns about a finished pair from a `PAIR {"src":…,"dst":…}` line, which pipeline/index.js
// prints from translate()'s onPair callback. Two properties matter and are pinned here:
//
//   * a pair is reported for every entry this run produced — including the value of a plugin argument,
//     which is where the panel's most interesting content comes from;
//   * a pair is reported ONLY for what this run produced. A run served entirely from the cache produced
//     nothing, and the panel showing nothing is the honest signal for that; replaying cached pairs would
//     display work the run never did.
//
// The model is a local http server inside this process, so no external service and no child process.
//
// Run:  node tools/unit-translate-pairs.js
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

// Answers like a model that translates into Chinese: kana becomes 文, everything else is kept. That keeps
// the reply the same length as the source and free of kana, so it passes the quality gate for real.
const server = http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
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
  const TMP = path.resolve(path.join(os.tmpdir(), "unit-pairs-" + process.pid));
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });
    const cacheFile = path.join(TMP, "cache.json");

    const entries = [
      { id: 0, file: "CommonEvents.json", path: "$[0]", text: "\u300c\u304a\u306f\u3088\u3046\u300d" },          // 「おはよう」
      { id: 1, file: "CommonEvents.json", path: "$[1]", text: "\u3053\u3093\u3070\u3093\u306f" },                // こんばんは
      { id: 2, file: "CommonEvents.json", path: "$[2].parameters[0]", text: "\u30d2\u30ed\u30ab" },              // ヒロカ (a plugin arg value)
    ];

    console.log("=== 第一次运行：每个新译文都要报告 ===");
    const pairs = [];
    const r1 = await T.translate({ entries, cacheFile, port, onPair: (s, d) => pairs.push([s, d]) });
    check("三个条目都译了", r1.stats.cached === 3, "cached=" + r1.stats.cached + " fails=" + r1.fails.length);
    check("报告了 3 对", pairs.length === 3, "pairs=" + JSON.stringify(pairs));
    check("原文与译文都对得上",
      pairs.some((p) => p[0] === "\u300c\u304a\u306f\u3088\u3046\u300d" && p[1] === "\u300c\u6587\u6587\u6587\u6587\u300d"),
      JSON.stringify(pairs));
    check("插件参数的值也在其中", pairs.some((p) => p[0] === "\u30d2\u30ed\u30ab"), JSON.stringify(pairs));
    check("每对的原文都不是空、译文都不同于原文",
      pairs.every((p) => p[0].length > 0 && p[1] !== p[0]));

    console.log("");
    console.log("=== 第二次运行：全部命中缓存，不应再报告 ===");
    const pairs2 = [];
    const r2 = await T.translate({ entries, cacheFile, port, onPair: (s, d) => pairs2.push([s, d]) });
    check("本次没有待译", r2.stats.pending === 0, "pending=" + r2.stats.pending);
    check("没有报告任何对照（面板显示为空才是如实）", pairs2.length === 0, JSON.stringify(pairs2));
    check("没有发起请求", r2.stats.requests === 0, "requests=" + r2.stats.requests);

    console.log("");
    console.log("=== 显示层的异常绝不能影响翻译 ===");
    const r3 = await T.translate({
      entries: [{ id: 0, file: "x.json", path: "$[0]", text: "\u3042\u3044\u3046" }],
      cacheFile: path.join(TMP, "cache2.json"), port,
      onPair: () => { throw new Error("panel exploded"); },
    });
    check("回调抛异常时这一条仍被翻译并缓存", r3.stats.cached === 1, "cached=" + r3.stats.cached);
    check("没有因此产生失败记录", r3.fails.length === 0, JSON.stringify(r3.fails));

    console.log("");
    console.log("=== 线格式：一对永远是一行（JSON 转义）===");
    const line = "PAIR " + JSON.stringify({ src: "\u300c\u3042\"\u3044\u300d\n\u3046", dst: "\u300c\u6587\"\u6587\u300d\n\u6587" });
    check("含引号与换行的对照仍无换行符", line.indexOf("\n") < 0, JSON.stringify(line));
    const back = JSON.parse(line.slice(5));
    check("能被 JSON 解回原文", back.src === "\u300c\u3042\"\u3044\u300d\n\u3046", JSON.stringify(back.src));
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
    server.close();
  }

  console.log("");
  console.log("  pass " + pass + "   fail " + fail);
  process.exit(fail ? 1 : 0);
})();
