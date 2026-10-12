// HTTP client for llama-server.
//
// PORTED from the verified v2 request layer, including the two fixes that came out of
// real failures:
//   * waitForServer() — the GUI launches llama-server and the pipeline together and a
//     4B model needs 30-45 s to load. Without the wait, every request in that window
//     failed and the split retry reported each entry separately (9841 request-failed
//     records for one game). Any HTTP answer counts as "listening": the real server
//     returns 200 when ready and 503 while loading, and a test double may return 404.
//   * stall handling — a degenerate generation used to hold a server slot for minutes
//     while the client only closed its own socket. A silent gap now aborts the
//     request and erases the slot.
"use strict";
const http = require("http");

const DEFAULT_PORT = 18080;
const STALL_MS = parseInt(process.env.GT_STALL_MS || "45000", 10);
const MAX_OUTPUT_TOKENS = parseInt(process.env.GT_MAX_OUTPUT_TOKENS || "1024", 10);
const SLOT_ERASE = process.env.GT_NO_SLOT_ERASE !== "1";
/** Growth of the retry wait for a hosted endpoint (milliseconds, doubled per attempt). */
const CLOUD_BACKOFF_MS = Math.max(1, parseInt(process.env.GT_API_BACKOFF_MS || "2000", 10));
/** Ask the server to skip a reasoning model's thinking block; GT_NO_THINK=0 disables that. */
const NO_THINK = process.env.GT_NO_THINK !== "0";
const SYSTEM_PROMPT =
  "你是一个轻小说翻译模型，可以流畅通顺地以日本轻小说的风格将日文翻译成简体中文，" +
  "并联系上下文正确使用人称代词，不擅自添加原文中没有的代词。";

/**
 * The translation endpoint: a local llama-server, or an OpenAI-compatible cloud API.
 *
 * Cloud mode is chosen by environment only — GT_API_BASE, GT_API_KEY, GT_API_MODEL(S) — so a credential
 * is never part of the source, an example or a test; the window reads it from the user's own config file
 * and passes it down. GT_API_MODELS may list a fallback chain (comma separated); the first is used until
 * its quota runs out, and a hosted key usually carries an independent free quota per model
 * (measured: an Alibaba Model Studio key answers 403 AllocationQuota.FreeTierOnly when one model's free
 * tier is spent, while the next model still has its own).
 */
function endpoint() {
  const base = String(process.env.GT_API_BASE || "").replace(/\/+$/, "");
  const key = String(process.env.GT_API_KEY || "");
  const chain = String(process.env.GT_API_MODELS || process.env.GT_API_MODEL || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (base && key && chain.length) return { kind: "api", base: base, key: key, models: chain };
  return { kind: "local", base: "", key: "", models: [] };
}

/**
 * Which model to ask, and whether a fallback is available.
 *
 * The choice is per PROCESS on purpose: a spent free tier is spent for the whole run, so once a model is
 * exhausted every later request must use the next one. Nothing about the game's progress depends on it —
 * the caller retries the same line and the cache keeps everything already translated.
 */
let apiModelIndex = 0;
function currentModel(ep) { return ep.models[Math.min(apiModelIndex, ep.models.length - 1)] || ""; }
function nextModel(ep) {
  if (apiModelIndex + 1 >= ep.models.length) return null;
  apiModelIndex++;
  return ep.models[apiModelIndex];
}

/**
 * Exact token usage the endpoint reported (cloud mode only).
 *
 * The offline estimate of "what will this cost" can only assume a characters-to-tokens ratio; a hosted
 * endpoint returns `usage` on every reply, so after one real run the numbers here are the truth and the
 * guesswork is over. Resets with the process, and is reported at the end of a run.
 */
const apiUsage = { requests: 0, prompt: 0, completion: 0, total: 0 };
function usage() { return Object.assign({}, apiUsage); }
function addUsage(j) {
  const u = j && j.usage;
  if (!u || typeof u !== "object") return;
  const p = Number(u.prompt_tokens) || 0, c = Number(u.completion_tokens) || 0;
  const t = Number(u.total_tokens) || (p + c);
  if (!p && !c && !t) return;
  apiUsage.requests++;
  apiUsage.prompt += p;
  apiUsage.completion += c;
  apiUsage.total += t;
}

/** Does this response body say the free allocation for the model is used up? */
function isQuotaExhausted(status, body) {
  if (status !== 403 && status !== 429 && status !== 400) return false;
  return /AllocationQuota|FreeTierOnly|free\s*tier|quota/i.test(String(body || ""));
}

/** List the models an OpenAI-compatible endpoint offers (used to fill the window's dropdown). */
function listModels({ base, key }, timeoutMs) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(base + "/models"); } catch (e) { return resolve([]); }
    const req = http.request({
      host: url.hostname, port: url.port || 443, path: url.pathname + url.search, method: "GET",
      headers: { Authorization: "Bearer " + key }, timeout: timeoutMs || 15000,
    }, (res) => {
      let d = "";
      res.on("data", (c) => { d += c; });
      res.on("end", () => {
        try {
          const j = JSON.parse(d);
          const list = Array.isArray(j.data) ? j.data : (Array.isArray(j.models) ? j.models : []);
          resolve(list.map((m) => String(m.id || m.name || "")).filter(Boolean));
        } catch (e) { resolve([]); }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve([]); });
    req.on("error", () => resolve([]));
    req.end();
  });
}

function waitForServer(port, maxMs) {
  const deadline = Date.now() + (maxMs || 0);
  return new Promise((resolve) => {
    const probe = () => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/health", method: "GET", timeout: 3000 },
        (res) => { res.resume(); resolve(true); }
      );
      req.on("timeout", () => { req.destroy(); retry(); });
      req.on("error", () => retry());
      req.end();
    };
    const retry = () => {
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(probe, 2000);
    };
    probe();
  });
}

function eraseSlot(port, slotId) {
  if (!SLOT_ERASE) return;
  const path = slotId === undefined || slotId === null ? "/slots/0?action=erase" : "/slots/" + slotId + "?action=erase";
  try {
    const req = http.request({ host: "127.0.0.1", port, path, method: "POST" }, (res) => res.resume());
    req.setTimeout(4000, () => req.destroy(new Error("slot erase timeout")));
    req.on("error", () => {});
    req.end();
  } catch (e) {}
}

/**
 * One translation request.
 * @returns {Promise<string>} the raw model answer
 */
function ask({ port, prompt, maxTokens, onStall }) {
  const ep = endpoint();
  const isApi = ep.kind === "api";
  const CLOUD_RETRIES = Math.max(0, parseInt(process.env.GT_API_RETRIES || "4", 10));
  return new Promise((resolve, reject) => {
    // The model is resolved per attempt, because a spent quota moves the chain on mid-run.
    const payloadBase = Object.assign({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
      top_p: 0.8,
      frequency_penalty: 0.1,
      max_tokens: Math.max(64, Math.min(MAX_OUTPUT_TOKENS, maxTokens || MAX_OUTPUT_TOKENS)),
      stream: false,
    },
    // A reasoning model answers inside `reasoning_content` first and can spend the whole token budget
    // there, leaving `content` empty — measured on Qwen3.5-0.8B: 3,492 characters of "Thinking Process" and
    // no answer at max_tokens 1024, 16,732 and still none at 4096, finish_reason "length" every time. The
    // pipeline saw "no content" and recorded a request failure for every entry, so that model translated
    // nothing at all (0 / 24 long sentences, 29 request-failed).
    //
    // Switching the thinking block off makes it answer immediately and cheaply (7 characters in 5 tokens
    // for the same input). The flag is sent for every LOCAL model because a template that does not define
    // the variable simply ignores it — Hy-MT2 and Galtransl are unaffected — and GT_NO_THINK=0 drops it.
    // A hosted endpoint is not llama.cpp and does not take llama.cpp extensions.
    (!isApi && NO_THINK) ? { chat_template_kwargs: { enable_thinking: false } } : null);
    const modelOf = () => (isApi ? currentModel(ep) : "local");
    let settled = false;
    let stallTimer = null;
    let attempt = 0;
    const finish = (fn, arg) => { if (settled) return; settled = true; if (stallTimer) clearTimeout(stallTimer); fn(arg); };

    /** Where the request goes: the local server, or the configured OpenAI-compatible endpoint. */
    let target;
    if (isApi) {
      let u;
      try { u = new URL(ep.base + "/chat/completions"); } catch (e) { return finish(reject, new Error("bad GT_API_BASE: " + ep.base)); }
      target = { host: u.hostname, port: u.port || (u.protocol === "http:" ? 80 : 443), path: u.pathname + u.search };
    } else {
      target = { host: "127.0.0.1", port, path: "/v1/chat/completions" };
    }

    const send = () => {
      const body = JSON.stringify(Object.assign({ model: modelOf() }, payloadBase));
      const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) };
      if (isApi) headers.Authorization = "Bearer " + ep.key;
      const req = http.request(
        Object.assign({ method: "POST", headers }, target),
        (res) => {
          let data = "";
          const arm = () => {
            if (stallTimer) clearTimeout(stallTimer);
            stallTimer = setTimeout(() => {
              if (typeof onStall === "function") onStall();
              req.destroy(new Error("stalled"));
              if (!isApi) eraseSlot(port, res.headers && res.headers["x-llama-slot-id"]);
            }, STALL_MS);
          };
          arm();
          res.on("data", (c) => { data += c; arm(); });
          res.on("end", () => {
            if (stallTimer) clearTimeout(stallTimer);
            // Free tier spent (403 AllocationQuota.FreeTierOnly on Model Studio, and the same shape on
            // other hosts): move to the next model in the chain and ask again — the SAME line, so nothing
            // about the batch is lost and no entry is recorded as failed because a quota ran out.
            if (isApi && isQuotaExhausted(res.statusCode, data)) {
              const from = modelOf();
              const to = nextModel(ep);
              if (to) {
                console.log("API_MODEL_SWITCH " + from + " -> " + to + "   （" + from + " 免费额度已用完，继续用 " + to + " 翻译）");
                attempt = 0;
                return setTimeout(send, 500);
              }
              return finish(reject, new Error("all models out of quota（" + ep.models.join(" / ") + " 的免费额度都用完了；" +
                "已完成的译文都在缓存里，换 key 或等额度恢复后可直接续跑）"));
            }
            // A rate limit (429) or a transient 5xx is NOT a bad translation: retrying is right, while the
            // caller's reaction to a failure is to split the batch, which would hammer the limit with more,
            // smaller requests. Retry here, with the server's own Retry-After.
            if (isApi && (res.statusCode === 429 || res.statusCode >= 500) && attempt < CLOUD_RETRIES) {
              const after = parseFloat(res.headers["retry-after"]);
              const waitMs = Number.isFinite(after) && after > 0
                ? Math.min(60000, after * 1000)
                : Math.min(30000, CLOUD_BACKOFF_MS * Math.pow(2, attempt));
              attempt++;
              return setTimeout(send, waitMs);
            }
            try {
              const j = JSON.parse(data);
              if (j.error) return finish(reject, new Error(typeof j.error === "string" ? j.error : JSON.stringify(j.error)));
              if (isApi) addUsage(j);
              const msg = j.choices && j.choices[0] && j.choices[0].message;
              const text = msg && msg.content;
              if (!text) {
                // Name the cause instead of the symptom: an empty answer next to a long reasoning block means
                // a reasoning model spent the budget thinking, which is a setting, not a broken model.
                const think = msg && typeof msg.reasoning_content === "string" ? msg.reasoning_content.length : 0;
                return finish(reject, new Error(think > 0
                  ? "thinking-only reply: " + think + " chars of reasoning_content and no answer（该模型先思考后作答，思考占满了输出预算；关闭思考后即可）"
                  : (isApi ? "API returned no content (HTTP " + res.statusCode + ")" : "llama returned no content")));
              }
              finish(resolve, text);
            } catch (e) {
              // A non-JSON body from a hosted endpoint is usually a proxy or quota page; say so.
              finish(reject, isApi ? new Error("API returned non-JSON (HTTP " + res.statusCode + "): " + data.slice(0, 160)) : e);
            }
          });
        }
      );
      req.on("error", (e) => {
        // A local server that refuses the connection is down and retrying changes nothing; a hosted
        // endpoint dropping a connection is worth another try.
        if (isApi && attempt < CLOUD_RETRIES) {
          attempt++;
          return setTimeout(send, Math.min(30000, CLOUD_BACKOFF_MS * Math.pow(2, attempt)));
        }
        if (!isApi) eraseSlot(port);
        finish(reject, e);
      });
      req.write(body);
      req.end();
    };
    send();
  });
}

module.exports = {
  ask, waitForServer, eraseSlot, endpoint, listModels, isQuotaExhausted, usage,
  resetApiModel: function () { apiModelIndex = 0; },
  SYSTEM_PROMPT, DEFAULT_PORT, MAX_OUTPUT_TOKENS, STALL_MS,
};
