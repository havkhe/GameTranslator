// api-models.js -- pull the model catalogue from an OpenAI-compatible endpoint, keep only the models this
// tool can translate with, and (with --probe) find out which of them this key can ACTUALLY call.
//
//   set GT_API_KEY=...
//   node tools\api-models.js https://integrate.api.nvidia.com/v1
//   node tools\api-models.js https://integrate.api.nvidia.com/v1 --probe --limit 15
//   node tools\api-models.js https://integrate.api.nvidia.com/v1 --probe --only deepseek --json > out.json
//
// Why a probe is worth it: /models lists what the endpoint *offers*, not what your key may use. Measured on
// one NVIDIA key, 23 of 41 listed text models answered 404, six timed out, and four were reasoning-only
// (empty answer, long reasoning_content) -- picking from the list alone would have picked a model that
// fails every request.
//
// This uses the shipped client (pipeline/translate/client.js: listModels + ask), so the filter is the same
// one the window's 刷新列表 applies, and the probe is the same request the translator sends.
//
// The probe is deliberately SEQUENTIAL: the client reads the model chain from the environment per request,
// so probing in parallel would send one model's request under another model's name.
//
// Output goes to stdout; for a machine-readable copy redirect it (--json > models.json).
//
// URL policy: http/https only; loopback/private/link-local targets are refused unless --allow-local.
"use strict";

const dns = require("dns");
const C = require("../pipeline/translate/client.js");

function parseArgs(argv) {
  const o = {
    base: "", keyEnv: "GT_API_KEY", probe: false, only: "", limit: 15, timeoutMs: 30000,
    allowLocal: false, json: false
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--key-env") o.keyEnv = argv[++i] || "GT_API_KEY";
    else if (a === "--probe") o.probe = true;
    else if (a === "--only") o.only = String(argv[++i] || "");
    else if (a === "--limit") o.limit = parseInt(argv[++i] || "15", 10);
    else if (a === "--timeout") o.timeoutMs = parseInt(argv[++i] || "30000", 10);
    else if (a === "--allow-local") o.allowLocal = true;
    else if (a === "--json") o.json = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else rest.push(a);
  }
  o.base = (o.base || rest[0] || "").replace(/\/+$/, "");
  return o;
}

/** Loopback / private / link-local / multicast / reserved address? (Names are resolved before asking.) */
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
  console.log("用法: node tools\\api-models.js <接口地址> [--probe] [--only 关键字] [--limit N]");
  console.log("        [--timeout 毫秒] [--key-env 变量名] [--allow-local] [--json]");
  console.log("");
  console.log("  不带 --probe：只列出该端点可供翻译的文本模型");
  console.log("  --probe     ：逐个真发一条短请求，标出哪些这个密钥真能用（串行，慢但准）");
  console.log("  --only X    ：只测名字含 X 的模型（配合 --probe 用，省时间）");
  console.log("  --json      ：输出机器可读结果（--json > models.json 即可存档）");
  console.log("");
  console.log("例子: set GT_API_KEY=sk-xxx");
  console.log("      node tools\\api-models.js https://integrate.api.nvidia.com/v1 --probe --limit 15");
}

(async function () {
  const o = parseArgs(process.argv.slice(2));
  if (o.help || !o.base) { usage(); process.exit(o.base ? 0 : 2); }

  const say = (s) => { if (!o.json) console.log(s); };
  const key = String(process.env[o.keyEnv] || "");
  if (!key) { console.log("✗ 环境变量 " + o.keyEnv + " 是空的（云端模式需要密钥）"); process.exit(2); }

  let url;
  try { url = new URL(o.base); } catch (e) { console.log("✗ 不是合法的 URL"); process.exit(2); }
  if (url.protocol !== "https:" && url.protocol !== "http:") { console.log("✗ 只支持 http/https"); process.exit(2); }

  const host = url.hostname;
  if (!o.allowLocal && isPrivateAddress(host)) {
    console.log("✗ 拒绝本机/内网地址 " + host + "（本机 llama-server 请加 --allow-local）");
    process.exit(2);
  }
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && host.indexOf(":") < 0) {
    let addrs = [];
    try { addrs = await new Promise((res) => dns.lookup(host, { all: true }, (e, a) => res(e ? [] : a.map((x) => x.address)))); } catch (e) { }
    if (addrs.length === 0) { console.log("✗ DNS 解析不出 " + host); process.exit(1); }
    if (!o.allowLocal && addrs.some(isPrivateAddress)) { console.log("✗ " + host + " 解析到内网地址 " + addrs.join(", ")); process.exit(2); }
  }

  o.base = url.href.replace(/\/+$/, "");
  process.env.GT_API_BASE = o.base;
  process.env.GT_API_KEY = key;

  const all = await C.listModels({ base: o.base, key: key }, Math.max(15000, o.timeoutMs));
  if (all.length === 0) {
    say("✗ 没读到模型列表：密钥无效(401/403)、地址少了 /v1、端点不提供 /models，或网络不通。");
    process.exit(1);
  }
  say("接口   " + o.base);
  say("可用作文本翻译的模型 " + all.length + " 个（已按程序内置规则排除向量/重排/视觉/语音/图像类）");

  if (!o.probe) {
    all.forEach(function (id, i) { say("  " + String(i + 1).padStart(3) + ". " + id); });
    say("");
    say("要确认哪些这个密钥真能调用，加 --probe（可用 --only/--limit 缩小范围）。");
    if (o.json) console.log(JSON.stringify({ base: o.base, models: all }, null, 2));
    process.exit(0);
  }

  const targets = all.filter((id) => !o.only || id.toLowerCase().indexOf(o.only.toLowerCase()) >= 0);
  const todo = targets.slice(0, Math.max(1, o.limit));
  say("开始探测 " + todo.length + " 个模型（串行；每个最多 " + Math.round(o.timeoutMs / 1000) + " 秒）");
  say("");

  const results = [];
  const prompt = "1. お姉ちゃん、どこに行くの？";
  for (let i = 0; i < todo.length; i++) {
    const id = todo[i];
    process.env.GT_API_MODELS = id;
    C.resetApiModel();
    const t0 = Date.now();
    const rec = { model: id, ms: 0, verdict: "", note: "" };
    try {
      const out = await C.ask({ prompt: prompt, maxTokens: 96 });
      const s = String(out);
      const zh = (s.match(/[\u4e00-\u9fff]/g) || []).length;
      rec.ms = Date.now() - t0;
      if (zh > 0) { rec.verdict = "OK"; rec.note = s.replace(/\s+/g, " ").slice(0, 36); }
      else { rec.verdict = "ECHO"; rec.note = "有回包但没中文：" + s.replace(/\s+/g, " ").slice(0, 36); }
    } catch (e) {
      rec.ms = Date.now() - t0;
      const m = String(e.message || e);
      if (/thinking-only/i.test(m)) { rec.verdict = "THINKING"; rec.note = "先思考后作答，预算被思考占满"; }
      else if (/HTTP 404/.test(m)) { rec.verdict = "NOMODEL"; rec.note = "列表里有，这个密钥调不动"; }
      else if (/HTTP 40[13]|quota/i.test(m)) { rec.verdict = "AUTH"; rec.note = "密钥/额度：" + m.slice(0, 56); }
      else if (/HTTP 429/.test(m)) { rec.verdict = "RATE"; rec.note = "限流"; }
      else if (/timed out|timeout|ETIMEDOUT|abort/i.test(m)) { rec.verdict = "TIMEOUT"; rec.note = "超时"; }
      else { rec.verdict = "ERROR"; rec.note = m.slice(0, 66); }
    }
    results.push(rec);
    const label = { OK: "✓ 可用", ECHO: "✗ 不翻", THINKING: "✗ 只思考", NOMODEL: "✗ 无权限", AUTH: "✗ 密钥", RATE: "! 限流", TIMEOUT: "✗ 超时", ERROR: "✗ 出错" }[rec.verdict];
    say("  [" + String(i + 1).padStart(2) + "/" + todo.length + "] " + label.padEnd(9) + String(rec.ms).padStart(6) + " ms  " + id + (rec.note ? "   " + rec.note : ""));
  }

  const ok = results.filter((r) => r.verdict === "OK").sort((a, b) => a.ms - b.ms);
  const count = {};
  for (const r of results) count[r.verdict] = (count[r.verdict] || 0) + 1;
  say("");
  say("小结：" + Object.keys(count).map((k) => k + "=" + count[k]).join("  "));
  if (ok.length === 0) {
    say("没有探测到可用模型。若多数是 NOMODEL，说明这个密钥对这些模型都没有权限——换密钥或换服务商。");
  } else {
    say("可用模型（按实测延迟从快到慢）：");
    ok.forEach((r) => say("  " + String(r.ms).padStart(6) + " ms  " + r.model));
    say("");
    say("可直接粘进【设置…】→「云端 API」→ 模型链 的一行：");
    say("  " + ok.map((r) => r.model).join(","));
    // Machine-readable line for the window's 检测可用模型 button: it fills 模型链 with this.
    say("CHAIN=" + ok.map((r) => r.model).join(","));
  }

  if (o.json) console.log(JSON.stringify({ base: o.base, probed: results, chain: ok.map((r) => r.model) }, null, 2));
})();
