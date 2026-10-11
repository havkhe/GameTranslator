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
/** Ask the server to skip a reasoning model's thinking block; GT_NO_THINK=0 disables that. */
const NO_THINK = process.env.GT_NO_THINK !== "0";

const SYSTEM_PROMPT =
  "你是一个轻小说翻译模型，可以流畅通顺地以日本轻小说的风格将日文翻译成简体中文，" +
  "并联系上下文正确使用人称代词，不擅自添加原文中没有的代词。";

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
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(Object.assign({
      model: "local",
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
    // for the same input). The flag is sent for every model because a template that does not define the
    // variable simply ignores it — Hy-MT2 and Galtransl are unaffected — and GT_NO_THINK=0 drops it.
    NO_THINK ? { chat_template_kwargs: { enable_thinking: false } } : null));
    let settled = false;
    let stallTimer = null;
    const finish = (fn, arg) => { if (settled) return; settled = true; if (stallTimer) clearTimeout(stallTimer); fn(arg); };

    const req = http.request(
      { host: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        let data = "";
        const arm = () => {
          if (stallTimer) clearTimeout(stallTimer);
          stallTimer = setTimeout(() => {
            if (typeof onStall === "function") onStall();
            req.destroy(new Error("stalled"));
            eraseSlot(port, res.headers && res.headers["x-llama-slot-id"]);
          }, STALL_MS);
        };
        arm();
        res.on("data", (c) => { data += c; arm(); });
        res.on("end", () => {
          if (stallTimer) clearTimeout(stallTimer);
          try {
            const j = JSON.parse(data);
            if (j.error) return finish(reject, new Error(typeof j.error === "string" ? j.error : JSON.stringify(j.error)));
            const msg = j.choices && j.choices[0] && j.choices[0].message;
            const text = msg && msg.content;
            if (!text) {
              // Name the cause instead of the symptom: an empty answer next to a long reasoning block means
              // a reasoning model spent the budget thinking, which is a setting, not a broken model.
              const think = msg && typeof msg.reasoning_content === "string" ? msg.reasoning_content.length : 0;
              return finish(reject, new Error(think > 0
                ? "thinking-only reply: " + think + " chars of reasoning_content and no answer（该模型先思考后作答，思考占满了输出预算；关闭思考后即可）"
                : "llama returned no content"));
            }
            finish(resolve, text);
          } catch (e) { finish(reject, e); }
        });
      }
    );
    req.on("error", (e) => { eraseSlot(port); finish(reject, e); });
    req.write(body);
    req.end();
  });
}

module.exports = { ask, waitForServer, eraseSlot, SYSTEM_PROMPT, DEFAULT_PORT, MAX_OUTPUT_TOKENS, STALL_MS };
