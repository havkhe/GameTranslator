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
 * @returns {{fatal: string[], warn: string[]}}
 */
function qualityCheck(src, dst) {
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

  return { fatal, warn };
}

module.exports = {
  qualityCheck, looksLikeEnglish, contentLength, translatableSource,
  longestRepeatedPhrase, MIN_RATIO_CHECK, KANA_ALL, KANA_EVIDENCE, HAN,
};
