// Cloud-API mode: endpoint routing, the bearer header, model discovery, and the two hosted-endpoint
// failure shapes — a spent free tier (403 AllocationQuota.FreeTierOnly) and a rate limit.
//
// Everything runs against an in-process stub: no network, and no credential anywhere. The value the
// tests put in GT_API_KEY is assembled at runtime and exists only in this process — there is no secret
// literal in this file to leak.
//
//   node tools/unit-api-mode.js
"use strict";
const http = require("http");

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (ok) { pass++; console.log("  pass  " + name); }
  else { fail++; console.log("  FAIL  " + name + "   得到 " + JSON.stringify(got) + "，应为 " + JSON.stringify(want)); }
};

// Loaded once: endpoint() reads the environment on every call, so the cases below can just set it.
const c = require("../pipeline/translate/client.js");
const PLACEHOLDER = ["unit", "test", String(Date.now()).slice(-4)].join("-");   // not a credential

function useEnv(env) {
  for (const k of ["GT_API_BASE", "GT_API_KEY", "GT_API_MODEL", "GT_API_MODELS", "GT_API_RETRIES", "GT_API_BACKOFF_MS"]) {
    delete process.env[k];
  }
  Object.assign(process.env, env || {});
  if (c.resetApiModel) c.resetApiModel();
}

/** A stub OpenAI-compatible endpoint. `mode` decides how it answers. */
function stub(mode) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (e) { parsed = {}; }
      seen.push({ url: req.url, auth: req.headers.authorization, model: parsed.model });
      const reply = (status, obj) => {
        const s = JSON.stringify(obj);
        res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(s) });
        res.end(s);
      };
      if (req.url.endsWith("/models")) {
        return reply(200, { data: [{ id: "model-a" }, { id: "model-b" }, { id: "model-c" }] });
      }
      if (mode === "quota-first") {
        // The first model is out of free quota; the second answers.
        if (parsed.model === "model-a") {
          return reply(403, { error: { code: "AllocationQuota.FreeTierOnly", message: "The free quota has been exhausted." } });
        }
        return reply(200, { choices: [{ message: { content: "译文来自 " + parsed.model } }] });
      }
      if (mode === "quota-all") {
        return reply(403, { error: { code: "AllocationQuota.FreeTierOnly", message: "free quota exhausted" } });
      }
      if (mode === "rate-limit-once") {
        if (seen.filter((x) => x.url.endsWith("/chat/completions")).length === 1) {
          return reply(429, { error: { message: "rate limited" } });
        }
        return reply(200, { choices: [{ message: { content: "限流后成功" } }] });
      }
      return reply(200, { choices: [{ message: { content: "ok" } }] });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, seen }));
  });
}

// The whole suite is asynchronous (a stub endpoint on a socket), and a runner that loads several test
// files into one process must know when this one is finished: it also clears the API environment, which
// would otherwise redirect the next suite's requests to the closed stub.
globalThis.__gtTestDone = (async () => {
  console.log("=== 模式判定（只看环境变量）===");
  {
    useEnv({});
    check("没有配置 → 本地模式", c.endpoint().kind, "local");
    useEnv({ GT_API_BASE: "https://example.invalid/v1", GT_API_KEY: PLACEHOLDER, GT_API_MODEL: "model-a" });
    const ep = c.endpoint();
    check("备齐 base+key+model → 云端模式", ep.kind, "api");
    check("单模型时链只有一项", ep.models.join("|"), "model-a");
    useEnv({ GT_API_BASE: "https://example.invalid/v1", GT_API_KEY: PLACEHOLDER, GT_API_MODELS: "a, b ,c" });
    check("GT_API_MODELS 优先且去空格", c.endpoint().models.join("|"), "a|b|c");
    useEnv({ GT_API_BASE: "https://example.invalid/v1", GT_API_MODEL: "a" });
    check("缺少 key → 仍是本地模式", c.endpoint().kind, "local");
  }

  console.log("");
  console.log("=== 免费额度用完 → 自动换模型，同一条请求重试 ===");
  {
    const s = await stub("quota-first");
    useEnv({
      GT_API_BASE: "http://127.0.0.1:" + s.port,
      GT_API_KEY: PLACEHOLDER,
      GT_API_MODELS: "model-a,model-b",
      GT_API_BACKOFF_MS: "10",
      GT_API_RETRIES: "2",
    });
    const out = await c.ask({ port: 1, prompt: "1. hello", maxTokens: 64 });
    check("最终拿到了下一个模型的译文", out, "译文来自 model-b");
    const calls = s.seen.filter((x) => x.url.endsWith("/chat/completions"));
    check("先试了第一个模型", calls[0].model, "model-a");
    check("额度用完后落到第二个模型", calls[calls.length - 1].model, "model-b");
    check("带上了 Bearer 头", calls[0].auth, "Bearer " + PLACEHOLDER);
    check("请求路径是 /chat/completions", calls[0].url, "/chat/completions");
    const again = await c.ask({ port: 1, prompt: "2. world", maxTokens: 64 });
    check("后续请求沿用新模型", again, "译文来自 model-b");
    s.server.close();
  }

  console.log("");
  console.log("=== 全部模型的免费额度都用完 → 明确报错（进度不丢）===");
  {
    const s = await stub("quota-all");
    useEnv({
      GT_API_BASE: "http://127.0.0.1:" + s.port,
      GT_API_KEY: PLACEHOLDER,
      GT_API_MODELS: "model-a,model-b",
      GT_API_BACKOFF_MS: "10",
      GT_API_RETRIES: "0",
    });
    let err = "";
    try { await c.ask({ port: 1, prompt: "x", maxTokens: 64 }); } catch (e) { err = String(e.message); }
    check("报错里说明了额度用完", /out of quota/.test(err), true);
    check("报错里列出了模型链", /model-a \/ model-b/.test(err), true);
    check("报错里提示进度已保留", /缓存/.test(err), true);
    s.server.close();
  }

  console.log("");
  console.log("=== 限流（429）重试，而不是把这一批拆掉 ===");
  {
    const s = await stub("rate-limit-once");
    useEnv({
      GT_API_BASE: "http://127.0.0.1:" + s.port,
      GT_API_KEY: PLACEHOLDER,
      GT_API_MODELS: "model-a",
      GT_API_BACKOFF_MS: "10",
      GT_API_RETRIES: "3",
    });
    const out = await c.ask({ port: 1, prompt: "x", maxTokens: 64 });
    check("重试后成功", out, "限流后成功");
    check("模型没被换掉", s.seen.filter((x) => x.url.endsWith("/chat/completions")).every((x) => x.model === "model-a"), true);
    s.server.close();
  }

  console.log("");
  console.log("=== 模型列表（自动识别模型）===");
  {
    const s = await stub("ok");
    useEnv({});
    const ids = await c.listModels({ base: "http://127.0.0.1:" + s.port, key: PLACEHOLDER }, 4000);
    check("解析出 3 个模型", ids.join("|"), "model-a|model-b|model-c");
    check("请求带 key", s.seen.find((x) => x.url.endsWith("/models")).auth, "Bearer " + PLACEHOLDER);
    s.server.close();
  }

  console.log("");
  console.log("=== 本地模式不受影响（仍然打到 127.0.0.1:port）===");
  {
    const s = await stub("ok");
    useEnv({});
    const out = await c.ask({ port: s.port, prompt: "x", maxTokens: 64 });
    check("本地模式的回复正常", out, "ok");
    check("本地模式用 model=local", s.seen[0].model, "local");
    check("本地模式不带 Authorization", s.seen[0].auth, undefined);
    s.server.close();
  }

  console.log("");
  console.log("pass " + pass + "   fail " + fail);
  // Leave the environment as it was found: an in-process runner shares one process across suites, and a
  // leftover GT_API_BASE would send the NEXT suite's requests to a stub that is already closed.
  useEnv({});
  try { process.exit(fail ? 1 : 0); } catch (e) { /* a runner that stubs exit throws instead */ }
})();
