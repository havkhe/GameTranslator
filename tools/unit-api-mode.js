// Cloud-API mode: endpoint routing, the bearer header, model discovery, and the request/response shapes a
// hosted endpoint imposes — a spent free tier (403 AllocationQuota.FreeTierOnly), a rate limit, a model the
// endpoint cannot serve, a refused enable_thinking, and the systems-role restriction of the translation
// models.
//
// Everything runs against an in-process stub: no network, and no credential anywhere. The value the
// tests put in GT_API_KEY is assembled at runtime and exists only in this process — there is no secret
// literal in this file to leak.
//
//   node tools/unit-api-mode.js
"use strict";
const http = require("http");
const https = require("https");

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
      seen.push({ url: req.url, auth: req.headers.authorization, model: parsed.model, body: parsed });
      const reply = (status, obj) => {
        const s = JSON.stringify(obj);
        res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(s) });
        res.end(s);
      };
      if (req.url.endsWith("/models")) {
        // A realistic catalogue: text LLMs mixed with embeddings, a reranker, vision, speech and image.
        return reply(200, { data: [
          { id: "qwen-mt-plus" }, { id: "qwen-plus" }, { id: "qwen-vl-max" },
          { id: "text-embedding-v3" }, { id: "gte-rerank-v2" }, { id: "cosyvoice-v1" },
          { id: "paraformer-realtime-v2" }, { id: "sambert-zhide-v1" }, { id: "wanx-v1" },
          { id: "deepseek-v3" },
        ] });
      }
      const usage = { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128 };
      if (mode === "quota-first") {
        // The first model is out of free quota; the second answers.
        if (parsed.model === "model-a") {
          return reply(403, { error: { code: "AllocationQuota.FreeTierOnly", message: "The free quota has been exhausted." } });
        }
        return reply(200, { choices: [{ message: { content: "译文来自 " + parsed.model } }], usage: usage });
      }
      if (mode === "quota-all") {
        return reply(403, { error: { code: "AllocationQuota.FreeTierOnly", message: "free quota exhausted" } });
      }
      if (mode === "model-unknown") {
        // Verbatim from Model Studio for a name that account does not carry (qwen-mt-turbo): note it is
        // "not exist", not "does not exist" — the shape that used to slip past the classifier.
        if (parsed.model === "model-a") {
          return reply(404, { error: { message: "Model not exist.", type: "invalid_request_error", code: "model_not_found" } });
        }
        return reply(200, { choices: [{ message: { content: "译文来自 " + parsed.model } }], usage: usage });
      }
      if (mode === "system-role-forbidden") {
        // Model Studio's translation models answer this for any request carrying a system message.
        const hasSystem = (parsed.messages || []).some((m) => m && m.role === "system");
        if (hasSystem) {
          return reply(400, { error: { message: "Role must be in [user, assistant].", type: "invalid_request_error", code: "invalid_parameter_error" } });
        }
        const u = (parsed.messages || [])[0] || {};
        return reply(200, { choices: [{ message: { content: "译文来自 " + parsed.model + "／无 system 角色" } }], usage: usage });
      }
      if (mode === "think-flag-forbidden") {
        // 400 InvalidParameter.NotSupportEnableThinking, verbatim in shape.
        if (parsed.enable_thinking !== undefined) {
          return reply(400, { error: { message: "The model " + parsed.model + " does not support enable_thinking.", type: "invalid_request_error", code: "invalid_parameter_error" } });
        }
        return reply(200, { choices: [{ message: { content: "译文（已去掉 enable_thinking）" } }], usage: usage });
      }
      if (mode === "bad-key") {
        return reply(401, { error: { code: "InvalidApiKey", message: "Invalid API-key provided." } });
      }
      if (mode === "rate-limit-once") {
        if (seen.filter((x) => x.url.endsWith("/chat/completions")).length === 1) {
          return reply(429, { error: { message: "rate limited" } });
        }
        return reply(200, { choices: [{ message: { content: "限流后成功" } }], usage: usage });
      }
      return reply(200, { choices: [{ message: { content: "ok" } }], usage: usage });
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
  console.log("=== 传输层：https 端点必须走 TLS（曾经对 443 发明文 → 整轮 ECONNRESET）===");
  {
    check("https 用 TLS 模块", c.transportFor("https:") === https, true);
    check("http 用明文模块", c.transportFor("http:") === http, true);
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
  console.log("=== 端点不认识这个模型名 → 也换到链上的下一个 ===");
  {
    const s = await stub("model-unknown");
    useEnv({
      GT_API_BASE: "http://127.0.0.1:" + s.port,
      GT_API_KEY: PLACEHOLDER,
      GT_API_MODELS: "model-a,model-b",
      GT_API_BACKOFF_MS: "10",
      GT_API_RETRIES: "0",
    });
    const out = await c.ask({ port: 1, prompt: "1. hello", maxTokens: 64 });
    check("模型名无效时换到下一个并成功", out, "译文来自 model-b");
    const calls = s.seen.filter((x) => x.url.endsWith("/chat/completions"));
    check("先试了第一个模型", calls[0].model, "model-a");
    check("落到第二个模型", calls[calls.length - 1].model, "model-b");
    // "Model not exist." (the wording Model Studio actually uses) is a model problem, while the system-role
    // rejection is NOT — that one is fixed in the request shape, not by walking the chain.
    check("「Model not exist.」算模型不可用", c.isModelUnavailable(404, "Model not exist."), true);
    check("原生格式模型（input.target_lang）也算模型不可用",
      c.isModelUnavailable(400, "InvalidParameter: missing required field: input.target_lang"), true);
    check("角色报错不算模型不可用", c.isModelUnavailable(400, "Role must be in [user, assistant]."), false);
    check("密钥报错不算模型不可用", c.isModelUnavailable(401, "Invalid API-key provided."), false);
    s.server.close();
  }

  console.log("");
  console.log("=== 云端请求体：不要 system 角色（qwen-mt-* 会因此 400）===");
  {
    const s = await stub("system-role-forbidden");
    useEnv({
      GT_API_BASE: "http://127.0.0.1:" + s.port,
      GT_API_KEY: PLACEHOLDER,
      GT_API_MODELS: "model-a",
      GT_API_BACKOFF_MS: "10",
      GT_API_RETRIES: "0",
    });
    const out = await c.ask({ port: 1, prompt: "1. hello\n2. world", maxTokens: 64 });
    check("端点禁止 system 角色时仍然成功", out, "译文来自 model-a／无 system 角色");
    const sent = s.seen.find((x) => x.url.endsWith("/chat/completions"));
    check("只发了一条消息", sent.body.messages.length, 1);
    check("那一条是 user 角色", sent.body.messages[0].role, "user");
    check("人设句折进了 user 正文", sent.body.messages[0].content.includes("轻小说翻译模型"), true);
    check("正文里带着要翻译的文本", sent.body.messages[0].content.includes("1. hello"), true);
    s.server.close();
  }

  console.log("");
  console.log("=== 云端请求体：默认关闭思考链（enable_thinking:false）===");
  {
    const s = await stub("ok");
    useEnv({
      GT_API_BASE: "http://127.0.0.1:" + s.port,
      GT_API_KEY: PLACEHOLDER,
      GT_API_MODELS: "model-a",
      GT_API_BACKOFF_MS: "10",
    });
    await c.ask({ port: 1, prompt: "1. hello", maxTokens: 64 });
    const sent = s.seen.find((x) => x.url.endsWith("/chat/completions"));
    check("云端请求带 enable_thinking:false", sent.body.enable_thinking, false);
    check("云端请求不带 llama.cpp 的 chat_template_kwargs", sent.body.chat_template_kwargs, undefined);
    s.server.close();
  }

  console.log("");
  console.log("=== 模型不接受 enable_thinking → 去掉它重试同一条，而不是记失败 ===");
  {
    const s = await stub("think-flag-forbidden");
    useEnv({
      GT_API_BASE: "http://127.0.0.1:" + s.port,
      GT_API_KEY: PLACEHOLDER,
      GT_API_MODELS: "model-a",
      GT_API_BACKOFF_MS: "10",
      GT_API_RETRIES: "0",
    });
    check("该拒绝形状能被识别", c.isThinkFlagRejected(400, "The model qwen-mt-plus does not support enable_thinking."), true);
    const out = await c.ask({ port: 1, prompt: "1. hello", maxTokens: 64 });
    check("去掉参数后同一条请求成功", out, "译文（已去掉 enable_thinking）");
    const calls = s.seen.filter((x) => x.url.endsWith("/chat/completions"));
    check("第一次确实带了参数（所以才会被拒）", calls[0].body.enable_thinking, false);
    check("重试时参数已去掉", calls[calls.length - 1].body.enable_thinking, undefined);
    check("模型没有被换掉", calls.every((x) => x.model === "model-a"), true);
    const again = await c.ask({ port: 1, prompt: "2. world", maxTokens: 64 });
    check("后续请求也不再带该参数", again, "译文（已去掉 enable_thinking）");
    s.server.close();
  }

  console.log("");
  console.log("=== 鉴权失败（401）不换模型、不重试 ===");
  {
    const s = await stub("bad-key");
    useEnv({
      GT_API_BASE: "http://127.0.0.1:" + s.port,
      GT_API_KEY: PLACEHOLDER,
      GT_API_MODELS: "model-a,model-b",
      GT_API_BACKOFF_MS: "10",
      GT_API_RETRIES: "2",
    });
    let err = "";
    try { await c.ask({ port: 1, prompt: "x", maxTokens: 64 }); } catch (e) { err = String(e.message); }
    const calls = s.seen.filter((x) => x.url.endsWith("/chat/completions"));
    check("请求失败", err.length > 0, true);
    check("只试了一次（没有无谓重试）", calls.length, 1);
    check("key 没被误判成模型不可用", c.isModelUnavailable(401, "Invalid API-key provided."), false);
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
  console.log("=== 用量核算（把接口上报的 usage 累加，用于估算额度）===");
  {
    const s = await stub("ok");
    useEnv({
      GT_API_BASE: "http://127.0.0.1:" + s.port,
      GT_API_KEY: PLACEHOLDER,
      GT_API_MODELS: "model-a",
      GT_API_BACKOFF_MS: "10",
    });
    const before = c.usage();
    await c.ask({ port: 1, prompt: "1. a", maxTokens: 64 });
    await c.ask({ port: 1, prompt: "2. b", maxTokens: 64 });
    const after = c.usage();
    check("统计到 2 次请求", after.requests - before.requests, 2);
    check("输入 token 累加", after.prompt - before.prompt, 240);
    check("输出 token 累加", after.completion - before.completion, 16);
    check("合计 token 累加", after.total - before.total, 256);
    s.server.close();
  }

  console.log("");
  console.log("=== 模型列表：只保留大语言模型 ===");
  {
    const CHAT = ["qwen-mt-plus", "qwen-mt-turbo", "qwen-plus", "qwen-max", "qwen-turbo", "qwen-long",
      "qwen3-max", "qwen2.5-72b-instruct", "qwq-plus", "deepseek-v3", "deepseek-r1", "glm-4-plus",
      "moonshot-v1-8k", "llama3.1-70b-instruct", "qwen3-coder-plus"];
    const NOT_CHAT = ["text-embedding-v3", "text-embedding-v2", "gte-rerank-v2", "qwen-vl-max",
      "qwen2.5-vl-7b-instruct", "qwen-vl-plus", "cosyvoice-v1", "paraformer-realtime-v2",
      "sambert-zhide-v1", "sensevoice-v1", "whisper-large-v3", "wanx-v1", "wanx2.1-t2i-turbo",
      "stable-diffusion-xl", "flux-schnell", "kling-v1", "qwen-tts", "qwen-audio-turbo",
      "qwen-image-edit", "bge-m3",
      // The speech-to-speech family that a live catalogue really lists beside the text models.
      "qwen3-livetranslate-flash", "qwen3.5-livetranslate-flash-realtime", "qwen3.8-omni-flash-realtime",
      "qwen3-s2s-flash-realtime-2025-09-22", "qwen-audio-3.1-realtime-plus"];
    const wronglyKept = NOT_CHAT.filter((m) => c.isTextModel(m));
    const wronglyDropped = CHAT.filter((m) => !c.isTextModel(m));
    check("非大语言模型全部被排除（" + NOT_CHAT.length + " 个）", wronglyKept.join(","), "");
    check("大语言模型一个不误伤（" + CHAT.length + " 个）", wronglyDropped.join(","), "");

    const s = await stub("ok");
    useEnv({});
    const ids = await c.listModels({ base: "http://127.0.0.1:" + s.port, key: PLACEHOLDER }, 4000);
    check("接口列表里只回大语言模型", ids.join("|"), "qwen-mt-plus|qwen-plus|deepseek-v3");
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
    check("本地模式仍用 system 角色", s.seen[0].body.messages[0].role, "system");
    check("本地模式仍带 chat_template_kwargs 关思考",
      JSON.stringify(s.seen[0].body.chat_template_kwargs), '{"enable_thinking":false}');
    check("本地模式不发 enable_thinking（那是云端的写法）", s.seen[0].body.enable_thinking, undefined);
    s.server.close();
  }

  console.log("");
  console.log("pass " + pass + "   fail " + fail);
  // Leave the environment as it was found: an in-process runner shares one process across suites, and a
  // leftover GT_API_BASE would send the NEXT suite's requests to a stub that is already closed.
  useEnv({});
  try { process.exit(fail ? 1 : 0); } catch (e) { /* a runner that stubs exit throws instead */ }
})();
