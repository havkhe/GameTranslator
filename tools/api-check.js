// api-check.js -- does this key + endpoint actually work, and when it does not, which of the four known
// failures is it?
//
//   set GT_API_KEY=...                    (the key is read from the environment, never from argv)
//   node tools\api-check.js https://integrate.api.nvidia.com/v1
//   node tools\api-check.js https://integrate.api.nvidia.com/v1 --model deepseek-ai/deepseek-v4.1-flash
//   node tools\api-check.js http://127.0.0.1:18080/v1 --allow-local        (the local llama-server)
//
// It does NOT reimplement the request. It wires the values into the environment and then calls the SAME
// client the pipeline uses (pipeline/translate/client.js: listModels + ask), so what you see here is what
// the translator will do -- including dropping enable_thinking when a model refuses it, and reporting a
// "thinking-only" reply instead of an empty translation.
//
// The four failures, in the order they show up:
//   401/403  the key or the base URL is wrong (or the free quota is spent -- 403 with "quota")
//   404      the model name is not one this key can invoke (the /models list is an offer, not a promise)
//   400 + "enable_thinking"   the model refuses that parameter; the client drops it and retries the line
//   empty content with a long reasoning_content  a reasoning model spent the whole output budget thinking
//            -- this is the one that ends as REQUEST_FAILED, and no model switch happens for it, so the
//            fix is either a bigger budget (GT_MAX_OUTPUT_TOKENS) or taking the model out of the chain
//
// URL policy: http/https only, and loopback/private/link-local targets are refused unless --allow-local
// is given. Host names are resolved and every resolved address is checked, so a name that points at
// 127.0.0.1/10.x is refused too; redirects are not followed because the requests go through the client,
// which does not follow them either.
"use strict";

const dns = require("dns");

function parseArgs(argv) {
  const o = { base: "", model: "", keyEnv: "GT_API_KEY", maxTokens: 0, timeoutMs: 60000, allowLocal: false, json: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model") o.model = argv[++i] || "";
    else if (a === "--key-env") o.keyEnv = argv[++i] || "GT_API_KEY";
    else if (a === "--max-tokens") o.maxTokens = parseInt(argv[++i] || "0", 10);
    else if (a === "--timeout") o.timeoutMs = parseInt(argv[++i] || "60000", 10);
    else if (a === "--allow-local") o.allowLocal = true;
    else if (a === "--json") o.json = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else rest.push(a);
  }
  o.base = (o.base || rest[0] || "").replace(/\/+$/, "");
  return o;
}

/** Literal loopback / private / link-local / multicast / reserved address? */
function isPrivateAddress(addr) {
  const a = String(addr || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (a === "::1" || a === "::" || a.startsWith("fe80:") || a.startsWith("fc") || a.startsWith("fd")) return true;
  if (a.startsWith("::ffff:")) return isPrivateAddress(a.slice(7));
  const m = a.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const x = +m[1], y = +m[2];
  if (x === 0 || x === 127 || x === 10) return true;
  if (x === 172 && y >= 16 && y <= 31) return true;
  if (x === 192 && y === 168) return true;
  if (x === 169 && y === 254) return true;
  if (x >= 224) return true;
  return false;
}

function usage() {
  console.log("用法: node tools\\api-check.js <接口地址> [--model 模型名] [--key-env 变量名]");
  console.log("        [--max-tokens N] [--timeout 毫秒] [--allow-local] [--json]");
  console.log("");
  console.log("例子: set GT_API_KEY=sk-xxx");
  console.log("      node tools\\api-check.js https://integrate.api.nvidia.com/v1");
  console.log("      node tools\\api-check.js http://127.0.0.1:18080/v1 --allow-local");
  console.log("");
  console.log("密钥只从环境变量读（默认 GT_API_KEY，可用 --key-env 改名），不接受写在命令行上。");
  console.log("① 地址 ② 模型表 ③ 真发一条翻译请求；三种失败各自给出原因与处理办法。");
}

(async function () {
  const o = parseArgs(process.argv.slice(2));
  if (o.help || !o.base) { usage(); process.exit(o.base ? 0 : 2); }

  const say = (s) => { if (!o.json) console.log(s); };
  const key = String(process.env[o.keyEnv] || "");
  const report = { base: o.base, keyEnv: o.keyEnv, keyPresent: key.length > 0 };

  say("接口   " + o.base);
  if (!key) {
    say("密钥   ✗ 环境变量 " + o.keyEnv + " 是空的（云端模式必须有密钥，本地模式不需要）");
    process.exit(2);
  }
  say("密钥   已从环境变量 " + o.keyEnv + " 读到（长度 " + key.length + "）");

  // ---- 1) address: scheme, literal host, and every resolved address
  let url;
  try { url = new URL(o.base); } catch (e) { say("① 地址   ✗ 不是合法的 URL"); process.exit(2); }
  if (url.protocol !== "https:" && url.protocol !== "http:") { say("① 地址   ✗ 只支持 http/https"); process.exit(2); }

  const host = url.hostname;
  if (!o.allowLocal && isPrivateAddress(host)) {
    say("① 地址   ✗ 拒绝本机/内网地址 " + host + "（要检测本地 llama-server 或内网端点请加 --allow-local）");
    process.exit(2);
  }
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && host.indexOf(":") < 0) {
    let addrs = [];
    try {
      addrs = await new Promise((res) => dns.lookup(host, { all: true }, (e, a) => res(e ? [] : a.map((x) => x.address))));
    } catch (e) { /* fall through: an empty list is reported below */ }
    if (addrs.length === 0) { say("① 地址   ✗ DNS 解析不出 " + host + "：域名写错了或没有网络"); process.exit(1); }
    if (!o.allowLocal && addrs.some(isPrivateAddress)) {
      say("① 地址   ✗ " + host + " 解析到内网/回环地址 " + addrs.join(", ") + "，已拒绝（除非加 --allow-local）");
      process.exit(2);
    }
    say("① 地址   OK  " + url.protocol + "//" + url.host + "  → " + addrs.join(", "));
  } else {
    say("① 地址   OK  " + url.protocol + "//" + url.host);
  }

  // ---- 2 + 3) hand the work to the shipped client, so this is the pipeline's own code path
  o.base = url.href.replace(/\/+$/, "");
  process.env.GT_API_BASE = o.base;
  process.env.GT_API_KEY = key;
  if (o.maxTokens > 0) process.env.GT_MAX_OUTPUT_TOKENS = String(o.maxTokens);
  const C = require("../pipeline/translate/client.js");

  const models = await C.listModels({ base: o.base, key: key }, o.timeoutMs);
  report.models = models.length;
  if (models.length === 0) {
    say("② 模型表 ✗ 没读到模型列表。可能是：密钥无效(401/403)、地址少了 /v1、端点不提供 /models、或网络不通。");
    say("          → 先用 --model 指定一个模型名直接做第③步，能翻就说明只是列表接口取不到。");
  } else {
    say("② 模型表 OK  能翻译的文本模型 " + models.length + " 个，例如：" + models.slice(0, 6).join(", "));
  }

  const model = o.model || models[0] || "";
  if (!model) { say("③ 对话   跳过：没有模型名可测（用 --model 指定）"); if (o.json) console.log(JSON.stringify(report, null, 2)); process.exit(1); }
  process.env.GT_API_MODELS = model;          // the client reads the chain from here; one model is enough here
  C.resetApiModel();

  const prompt = "1. お姉ちゃん、どこに行くの？\n2. Let's go, Sophie.";
  say("③ 对话   模型 " + model + (o.maxTokens > 0 ? "（max_tokens=" + o.maxTokens + "）" : "") + " ……");
  const t0 = Date.now();
  try {
    const out = await C.ask({ prompt: prompt, maxTokens: o.maxTokens > 0 ? o.maxTokens : undefined });
    const ms = Date.now() - t0;
    const zh = (String(out).match(/[\u4e00-\u9fff]/g) || []).length;
    report.chat = { model: model, ms: ms, contentChars: String(out).length, cjkChars: zh, ok: zh > 0 };
    say("   " + ms + " ms  正文 " + String(out).length + " 字（中文 " + zh + " 字）");
    if (zh > 0) {
      say("   ✓ 通过：这条链能翻出中文。");
      say("     " + String(out).replace(/\s+/g, " ").slice(0, 160));
      if (o.json) { console.log(JSON.stringify(report, null, 2)); }
      else { console.log("CHECK=ok"); }   // machine-readable line for the window's 连接测试 button
      process.exit(0);
    }
    say("   ✗ 返回了内容但没有中文（多半把原文吐回来了）。→ 换模型。");
    say("     " + String(out).replace(/\s+/g, " ").slice(0, 160));
    console.log("CHECK=fail");
    process.exit(1);
  } catch (e) {
    const msg = String(e.message || e);
    report.chat = { model: model, ms: Date.now() - t0, error: msg };
    say("   ✗ 失败：" + msg);
    if (/thinking-only reply/i.test(msg)) {
      say("   → 就是这个模型先思考后作答、把输出预算全用在 reasoning 上了（你日志里那条 REQUEST_FAILED）。");
      say("     它多半也不接受 enable_thinking（上面会打印 API_THINK_FLAG_OFF），所以没法关思考。两条路：");
      say("       a) 加大输出预算：设环境变量 GT_MAX_OUTPUT_TOKENS=4096 再跑一次（越大越费 token）");
      say("       b) 把它从模型链里去掉：用 tools\\api-models.js --probe 找出能出译文的模型");
    } else if (/\((HTTP )?40[13]\)|quota/i.test(msg)) {
      say("   → 密钥/权限/额度问题。核对密钥与 base URL 是否属于同一服务商；免费额度用尽时 403 会带 quota。");
    } else if (/HTTP 404/.test(msg)) {
      say("   → 模型名这个密钥调不动（列表里有不代表能用）。换一个，或先跑 api-models.js。");
    } else if (/HTTP 429/.test(msg)) {
      say("   → 被限流，稍后再试；程序自己会退避重试。");
    } else if (/ENOTFOUND|ECONNREFUSED|CERT|socket|timeout|ETIMEDOUT/i.test(msg)) {
      say("   → 网络层：DNS/端口/证书/超时。若走了代理，确认程序能用到代理（云端两条路默认读系统代理）。");
    }
    if (o.json) { console.log(JSON.stringify(report, null, 2)); }
    else { console.log("CHECK=fail"); }
    process.exit(1);
  }
})();
