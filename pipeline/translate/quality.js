// Translation quality gates.
//
// PORTED from the verified v2 implementation, which was calibrated against the
// user's own corpus: 78,603 real translation pairs, and the echo filter measured at
// 0 false positives in 8,656 real translations.
//
// Two tiers, as in v2:
//   fatal  -> the answer must not reach the game (retry / record as failure)
//   warn   -> recorded, still written
//
// Deliberate design points carried over, each with the measurement that produced it:
//   * "fatal if letters >= cjk" (the naive English test) rejected correct lines that
//     keep proper nouns and tags ("プラグインテストHELP" -> "插件测试HELP"). Only
//     latin letters the SOURCE did not contain count as evidence of English.
//   * repetition is judged by dominance (share of the text), and the source's own
//     repetition is allowed: a game really does ship "これはとても長い台詞です。"×100.
//   * a single character is a valid answer ("さくら" -> "樱"), and rejecting it sank
//     whole batches, so only an empty answer is invalid.
"use strict";

const KANA_ALL = /[\u3040-\u309f\u30a0-\u30ff\uff66-\uff9f]/;
const KANA_EVIDENCE = /[\u3041-\u3096\u30a1-\u30fa\uff66-\uff9d]/;
const HAN = /[\u3400-\u9fff]/;
// Layout padding and marks that carry no translatable meaning. Syllables stay
// counted: an earlier version removed the whole kana block and measured
// "おはよう、ミアです。" as zero content, which disabled the gate for all Japanese.
const MEANINGLESS_IN_LENGTH = /[\s\u3000\u3063\u30c3\u3099\u309a\u309b\u309c\u30fc\u30fb\u3001\u3002\u2026\u2025!?！！？？♥♡♪☆★◆◇●○◎※〜~ー―‐]/g;

const countMatches = (s, re) => (String(s).match(re) || []).length;
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Text-bearing length: no padding, no meaningless marks. */
function contentLength(s) {
  return String(s).replace(MEANINGLESS_IN_LENGTH, "").length;
}

const MIN_RATIO_CHECK = 3;

/**
 * Instruction text that must never appear in an answer.
 *
 * The model sometimes answers with the instruction itself instead of a translation. The batch
 * parser strips such lines, but it deliberately keeps at least one line (so a reply of a single
 * good line is not emptied), which left the single-entry case uncovered: a one-line group whose
 * answer IS the echo was accepted verbatim. Measured on the game that exposed this: five cache
 * entries held the prompt — "チェストウッド" -> "每行输出一条译文，不要编号、不要JSON、" — and the
 * patch step wrote them into Tilesets.json and into resources/ja-JP/SystemText.json, where the
 * load-menu label became the instruction text. Six player-visible strings were affected.
 *
 * The list below is the shipped template's wording. A caller that knows its own template should
 * pass fragments derived from it (promptFragments) so an edited prompt is covered too.
 */
const PROMPT_ECHO_MARKERS = [
  "将下列每行日文", "翻译成简体中文", "禁止翻译成英文", "只输出简体中文",
  "必须原样保留", "不要增加也不要删除", "行数必须与输入", "每行输出一条译文",
  "不要编号", "不要JSON", "不要解释",
];

// Split instruction text into checkable chunks. Punctuation and whitespace both separate chunks,
// and the backslash is included: the older template names 控制代码 examples, which must not
// survive into a translation even accidentally.
const FRAGMENT_SPLIT = /[，。、；：！？…‥\r\n\t ,.;:!?\u3000（）()［］\[\]「」『』<>《》“”‘’"'`~〜～+\-=*&^%$#@|/\\]+/;

/**
 * Chunks of a prompt template that a translation must not contain.
 *
 * Chunks are cut at punctuation; a chunk counts when it is at least four characters long and holds
 * at least two Han characters, which keeps generic fragments ("颜色", "图标") out while retaining
 * the phrases that identify the instruction.
 */
function promptFragments(template) {
  const t = String(template == null ? "" : template)
    .replace(/\{lines\}/g, "\n").replace(/\{numbered\}/g, "\n");
  const out = new Set();
  for (const chunk of t.split(FRAGMENT_SPLIT)) {
    const c = chunk.trim();
    if (c.length < 4) continue;
    if ((c.match(/[\u3400-\u9fff]/g) || []).length < 2) continue;
    out.add(c);
  }
  return Array.from(out);
}

/**
 * Which instruction fragment does `dst` echo, or "" when it echoes none.
 *
 * A fragment the SOURCE itself contains is not an echo: a game may legitimately ship a string that
 * happens to match, and rejecting it would lose a good translation.
 */
function promptEchoMatches(dst, src, fragments) {
  const d = String(dst == null ? "" : dst);
  if (!d) return "";
  const s = String(src == null ? "" : src);
  const list = fragments && fragments.length ? fragments : PROMPT_ECHO_MARKERS;
  for (const f of list) {
    if (!f || s.includes(f)) continue;
    if (d.includes(f)) return f;
  }
  return "";
}

/** A Japanese source should never come back as English. */
function looksLikeEnglish(t, source) {
  if (!t || typeof t !== "string") return false;
  const src = typeof source === "string" ? source : "";
  const letters = countMatches(t, /[A-Za-z]/g);
  if (!letters) return false;
  const srcLetters = countMatches(src, /[A-Za-z]/g);
  const cjk = countMatches(t, /[\u3400-\u9fff]/g);
  const control = countMatches(t, /\\[NVI]|<\/?[^>]{1,12}>/g);
  const invented = letters - Math.min(letters, srcLetters);
  return invented >= cjk && invented > control;
}

/** Longest substring (up to maxLen) repeating at least minCount times. */
function longestRepeatedPhrase(text, minLen, maxLen) {
  const n = text.length;
  if (n < minLen * 2) return "";
  for (let len = Math.min(maxLen, n >> 1); len >= minLen; len--) {
    const counts = new Map();
    for (let i = 0; i + len <= n; i++) {
      const sub = text.slice(i, i + len);
      const c = (counts.get(sub) || 0) + 1;
      counts.set(sub, c);
      if (c >= 5) return sub;
    }
  }
  return "";
}

/** Does this source need translating at all (vs a label that legitimately stays)? */
function translatableSource(s) {
  const t = String(s).trim();
  if (!t) return false;
  if (/\.(png|jpg|jpeg|gif|bmp|webp|rpgmvp|rpgmvo|ogg|m4a|mp3|rvdata2?|rxdata)$/i.test(t)) return false;
  if (/^[A-Za-z0-9_\-./\\%]+$/.test(t)) return false;
  if (!KANA_EVIDENCE.test(t)) return false;
  return true;
}

/**
 * Judge one translation.
 * @param {object} [opts] `promptFragments` — instruction chunks from the caller's own template.
 * @returns {{fatal: string[], warn: string[]}}
 */
function qualityCheck(src, dst, opts) {
  const s = String(src), d = String(dst);
  const fatal = [], warn = [];

  // 1) control codes must survive
  for (const m of s.match(/\\[NVI]\[\d+\]|\\[NVI]<[^>]+>/g) || []) {
    if (!d.includes(m)) fatal.push("control:" + m);
  }

  // 2) a Japanese answer must not be dominated by kana or stray marks
  const kana = countMatches(d, KANA_EVIDENCE);
  const han = countMatches(d, HAN);
  if (han === 0 && kana >= 2) fatal.push("kana-only");

  // 3) stray characters that suggest mojibake or leaked markup
  const stray = d.match(/[―︎�]|ＥＮＤＩ|ＨＡＰＰＹ/g);
  if (stray) {
    if (stray.length >= 3) fatal.push("stray-chars:" + Array.from(new Set(stray)).slice(0, 4).join(""));
    else warn.push("stray:" + Array.from(new Set(stray)).slice(0, 4).join(""));
  }

  // 4) length anomaly
  const cs = contentLength(s), cd = contentLength(d);
  if (cs >= MIN_RATIO_CHECK && cd < cs * 0.25) fatal.push("too-short:" + cd + "<" + cs);
  else if (cd > cs * 3 && cd - cs >= 20) warn.push("too-long:" + cd + ">" + cs);

  // 5) runaway repetition, measured as dominance and excused when the source repeats
  const counts = new Map();
  for (const ch of d) counts.set(ch, (counts.get(ch) || 0) + 1);
  let topChar = "", topCount = 0;
  for (const [ch, n] of counts) if (n > topCount) { topCount = n; topChar = ch; }
  const share = d.length ? topCount / d.length : 0;
  if (topCount > 20 && share > 0.5 && topChar !== "\n" && !/\s/.test(topChar)) {
    const srcCount = countMatches(s, new RegExp(escapeRe(topChar), "g"));
    if (topCount > srcCount * 2) fatal.push("repetition:" + topChar + "×" + topCount);
  }
  if (d.length >= 120) {
    const phrase = longestRepeatedPhrase(d, 4, 12);
    if (phrase) {
      const n = countMatches(d, new RegExp(escapeRe(phrase), "g"));
      if (n >= 8 && (n * phrase.length) / d.length >= 0.5) {
        const srcCount = countMatches(s, new RegExp(escapeRe(phrase), "g"));
        if (srcCount < n / 2) fatal.push("repetition-phrase:" + phrase.slice(0, 8) + "×" + n);
      }
    }
  }

  // 6) newline conservation
  const srcNl = countMatches(s, /\n/g), dstNl = countMatches(d, /\n/g);
  if (srcNl !== dstNl) warn.push("newlines:" + srcNl + "->" + dstNl);

  // 6b) control codes must not be INVENTED.
  //
  // The prompt used to name example codes ("\N[1]", "\V[1]"), and the model copied them into
  // short entries: "スマホ" -> "\N[1]智能手机", "司祭3" -> "\N[1]祭司3", and malformed forms such
  // as "\[1\]恶魔之王首领卡提斯" in event names. The engine then renders an actor name where
  // none belongs, or shows the escape literally. Rule 1 already catches codes that were lost;
  // this catches codes that were added, by comparing the counts of each backslash sequence.
  const codeCount = (x) => {
    const m = String(x).match(/\\[A-Za-z]?[\[<][^\]>]{0,16}[\]>]|\\./g);
    const out = Object.create(null);
    for (const c of m || []) out[c] = (out[c] || 0) + 1;
    return out;
  };
  const srcCodes = codeCount(s), dstCodes = codeCount(d);
  for (const c of Object.keys(dstCodes)) {
    if ((srcCodes[c] || 0) < dstCodes[c]) { fatal.push("code-invented:" + c); break; }
  }

  // 7) untranslated / near-identical
  const norm = (x) => String(x).replace(/\s+/g, "");
  const foldPunct = (x) => String(x).replace(/\s+/g, "")
    .replace(/[「」『』“”‘’""''［］\[\]（）()｛｝{}＜＞<>]/g, "\u0001")
    .replace(/[，、]/g, ",").replace(/[。．]/g, ".").replace(/[！]/g, "!")
    .replace(/[？]/g, "?").replace(/[：]/g, ":").replace(/[；]/g, ";").replace(/[~～〜]/g, "~");
  if (translatableSource(s) && (norm(s) === norm(d) || foldPunct(s) === foldPunct(d))) fatal.push("unchanged");
  else if (han >= 4 && KANA_EVIDENCE.test(s)) {
    const same = countMatches(d, /[\u3400-\u9fff]/g);
    if (same && norm(s) === norm(d)) fatal.push("unchanged");
  }

  // 8) the answer is the instruction, not a translation.
  //
  // Last because it is the cheapest to explain and the most damaging to miss: a stored echo is
  // re-applied on every later run and shows up in the game as menu labels and item names.
  const echo = promptEchoMatches(d, s, opts && opts.promptFragments);
  if (echo) fatal.push("prompt-echo:" + echo.slice(0, 10));

  return { fatal, warn };
}

module.exports = {
  qualityCheck, looksLikeEnglish, contentLength, translatableSource,
  longestRepeatedPhrase, MIN_RATIO_CHECK, KANA_ALL, KANA_EVIDENCE, HAN,
  promptFragments, promptEchoMatches, PROMPT_ECHO_MARKERS,
};
