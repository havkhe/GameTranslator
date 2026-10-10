// Decorative runs: withhold them from the request, put them back on the answer.
//
// PORTED VERBATIM from the verified v2 implementation (game-pipeline.js
// splitDecoration/restoreDecoration). Validation that carried over:
//   * 10/10 round-trips byte-identical on real lines;
//   * against the live model, "…………そうか…………" is sent as "そうか", answered
//     "这样啊", and displayed "…………这样啊…………";
//   * 13.9% of entries in the game measured have such an edge run.
//
// Only the EDGES are split off. Runs inside a sentence are left alone ("おいクズ！！！！
// 　まだ息してるか" uses its emphasis), and a syllable is never touched, so "みっつ"
// cannot lose its small っ.
"use strict";

const DECOR_BODY = "[♥♡♪♫☆★✩✪◆◇■□●○◎※〓…‥ー―‐〜~～]";
const PUNCT_TAIL = /(?:[\s\u3000]*[。、！？!?，,．.]{2,}[\s\u3000]*)+$/;

function splitDecoration(s) {
  const text = String(s);
  let prefix = "", suffix = "", core = text;
  const lead = core.match(new RegExp("^(?:[\\s\\u3000]*" + DECOR_BODY + "+[\\s\\u3000]*)+"));
  if (lead) { prefix = lead[0]; core = core.slice(lead[0].length); }
  let tail = core.match(new RegExp("(?:[\\s\\u3000]*" + DECOR_BODY + "+[\\s\\u3000]*)+$"));
  if (!tail) tail = core.match(PUNCT_TAIL);
  if (tail) { suffix = tail[0]; core = core.slice(0, core.length - tail[0].length); }
  if (!core.trim()) return { core: text, prefix: "", suffix: "" };   // decoration only
  return { core, prefix, suffix };
}

function restoreDecoration(translation, parts) {
  let out = String(translation).trim();
  if (!parts || (!parts.prefix && !parts.suffix)) return out;
  const p = parts.prefix.trim(), suf = parts.suffix.trim();
  if (p && !out.startsWith(p)) out = p + out;
  if (suf) {
    const last = suf.slice(-1);
    const escaped = last.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!out.endsWith(suf) && !new RegExp(escaped + "{2,}$").test(out)) out = out + suf;
  }
  return out;
}

module.exports = { splitDecoration, restoreDecoration, DECOR_BODY, PUNCT_TAIL };
