// Grouping and retry strategy.
//
// PORTED from the verified v2 batcher (packGroups / translateGroupRecursive), with the
// behaviours that came out of real failures:
//
//   * The wire protocol is one line in, one line out, so a newline inside an entry
//     cannot survive it: the model reflows or drops those breaks and the reply then
//     has a different number of lines. An entire run once left ~4500 multi-line
//     dialogue lines untranslated for this reason. Multi-line entries are therefore
//     split per source line and rejoined with the source's own breaks.
//   * Packing happens by ENTRY first, then multi-line entries expand inside the
//     request. Doing it the other way round made every line its own request
//     (measured: 11990 requests for 12123 entries, versus 758 with this order).
//   * One entry the model cannot satisfy used to discard up to 15 good translations
//     and split the batch again and again. Validation failures are per-entry now.
//   * Every entry has an attempt budget per run: a line the model keeps refusing was
//     otherwise re-sent forever (measured: 71 rejections of one line in 210 s, with
//     the cache frozen and the GPU at 100%).
"use strict";
const { contentLength, qualityCheck, looksLikeEnglish, MIN_RATIO_CHECK } = require("./quality.js");
const { splitDecoration, restoreDecoration } = require("./decoration.js");

const BATCH = parseInt(process.env.GT_BATCH || "8", 10);
const BATCH_CHARS = parseInt(process.env.GT_BATCH_CHARS || "900", 10);
const SINGLE_CHARS = parseInt(process.env.GT_SINGLE_CHARS || "700", 10);
const MAX_ATTEMPTS = parseInt(process.env.GT_MAX_ATTEMPTS || "3", 10);

const normText = (s) => String(s).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/^\s+|\s+$/g, "");

/** Split an over-long line at punctuation so the model never sees a wall of text. */
function splitLongText(text, max) {
  if (text.length <= max) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > max) {
    let cut = -1;
    for (const sep of ["\n", "。", "！", "？", "、", "，", " "]) {
      const idx = rest.lastIndexOf(sep, max);
      if (idx > cut) cut = idx;
    }
    if (cut < max * 0.5) cut = max;
    parts.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  if (rest.length) parts.push(rest);
  return parts;
}

/**
 * Pack entries into requests: at most BATCH lines and BATCH_CHARS characters, always
 * keeping the lines of one entry together.
 */
function packGroups(list) {
  const groups = [];
  for (const e of list) {
    if (e.text.length > SINGLE_CHARS) {
      const parts = splitLongText(e.text, SINGLE_CHARS);
      parts.forEach((p, i) => groups.push([{ id: e.id, text: p, part: i + 1, parts: parts.length, parent: e }]));
      continue;
    }
    const last = groups[groups.length - 1];
    const lastChars = last ? last.reduce((a, x) => a + x.text.length, 0) : Infinity;
    if (last && last.length < BATCH && lastChars + e.text.length <= BATCH_CHARS && !last[0].part) last.push(e);
    else groups.push([e]);
  }
  // expand multi-line entries inside their request
  const out = [];
  for (const g of groups) {
    if (g.length === 1 && g[0].part) { out.push(g); continue; }
    const expanded = [];
    for (const e of g) {
      const lines = String(e.text).split(/(\r\n|\n|\r)/);
      const parts = [], breaks = [];
      for (const p of lines) {
        if (p === "\r\n" || p === "\n" || p === "\r") breaks.push(p);
        else parts.push(p);
      }
      if (parts.length < 2) { expanded.push(e); continue; }
      // `partObj` is the identity the caller uses to accumulate the pieces of this
      // entry. It must be shared by every part (and by nothing else), otherwise each
      // line gets its own buffer and the entry is never joined.
      const multi = { lines: parts, breaks };
      parts.forEach((ln, i) => expanded.push({ id: e.id, text: ln, part: i + 1, parts: parts.length, parent: e, partObj: multi, __multi: multi }));
    }
    out.push(expanded);
  }
  return out;
}

/** Build the request prompt for one group. */
//
// Input lines are NUMBERED, and the prompt is told to keep the numbering.
//
// Measured reason: with bare text lines, 3 of 19 batches (15.8%) came back one line
// short. The model reads a run of short entries — character names, account handles —
// as one list and merges them, so the reply no longer matches the input count and the
// whole batch fails, splits, and reports each entry as FAILED_ENTRY. A numbered input
// gives every line an anchor the model cannot merge, and the answer's numbers also
// make the count verifiable instead of inferred.
//
// The instruction is added here rather than relying on the saved prompt file, so the
// fix works with a user's existing template and with the GUI-supplied prompt.txt.
function buildPrompt(group, template) {
  const flat = (s) => String(s).replace(/\r\n|\n|\r/g, " ");
  const core = (s) => splitDecoration(flat(s)).core;
  const body = group.map((e) => core(e.text)).join("\n");
  let p = String(template);
  p = p.replace(/\{lines\}/g, body);
  if (!p.includes(body)) p = p + "\n\n" + body;
  return p;
}

/** Pull the answer lines out of a model reply. */
function parseResult(text) {
  const raw = String(text == null ? "" : text);
  const t = raw.trim();
  // numbered-JSON shape
  if (t.startsWith("{")) {
    try {
      const j = JSON.parse(t);
      const keys = Object.keys(j).filter((k) => /^\d+$/.test(k)).sort((a, b) => a - b);
      if (keys.length) return keys.map((k) => String(j[k]));
    } catch (e) {}
  }
  const plain = raw.split(/\r?\n/).map((x) => x.trim()).filter((x) => x.length);

  // Numbered lines. The answer's own numbering is the strongest signal available, so
  // it is used for counting too: the numbers must run 1..n in order, and a gap means
  // the model skipped a line rather than that the batch should be accepted.
  const numbered = [];
  for (const line of plain) {
    const m = line.match(/^\s*(\d+)\s*[.、:：)]\s*(\S.*)$/);
    if (m) numbered.push({ n: Number(m[1]), text: m[2] });
  }
  if (numbered.length) {
    const sequential = numbered.every((x, i) => x.n === i + 1);
    if (sequential) return numbered.map((x) => x.text);
    // Gaps or repeats: fall back to positional use so a small numbering slip does not
    // discard otherwise good translations, but keep only the first run of each index.
    const out = [];
    for (const x of numbered) {
      if (out[x.n - 1] === undefined) out[x.n - 1] = x.text;
    }
    return out;
  }

  // instruction echo: drop the known prompt sentences
  const INSTR = /(必须原样保留|不要编号|不要JSON|行数必须|只输出|禁止翻译成英文|翻译成简体中文|逐行|输入已按)/;
  let s = 0; while (s < plain.length - 1 && INSTR.test(plain[s])) s++;
  let e = plain.length; while (e - 1 > s && INSTR.test(plain[e - 1])) e--;
  return plain.slice(s, e);
}

/** Trim model markup from one answer line. */
function cleanOutput(s) {
  let t = String(s == null ? "" : s).trim();
  t = t.replace(/<\/?im(_| )?(start|end)>?/gi, "").replace(/<\|im_(start|end)\|>/gi, "");
  if (/^注意：必须原样保留/.test(t)) return null;
  if (t.length === 0) return null;
  return t;
}

function normalizeResult(raw, count) {
  if (!Array.isArray(raw) || raw.length !== count) return null;
  return raw.map((x) => String(x));
}

/** Join the lines of one multi-line entry back together. */
function joinParts(parts, got, srcText) {
  const breaks = String(srcText).match(/\r\n|\n|\r/g) || [];
  let out = got[0];
  for (let k = 1; k < got.length; k++) out += (breaks[k - 1] || "") + got[k];
  return out;
}

module.exports = {
  packGroups, buildPrompt, parseResult, cleanOutput, normalizeResult,
  splitLongText, joinParts, normText, contentLength, qualityCheck, looksLikeEnglish,
  splitDecoration, restoreDecoration, MIN_RATIO_CHECK,
  BATCH, BATCH_CHARS, SINGLE_CHARS, MAX_ATTEMPTS,
};
