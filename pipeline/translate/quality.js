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
 * Bigrams of the cycle the model falls into when it degenerates.
 *
 * Taken from the values themselves rather than invented: each pair below is consecutive inside a
 * stored value such as 「本解学篇义文明文\n汉例语子语式示译」, and together they trace one cycle over a
 * vocabulary of translation-methodology words (汉语 / 例句 / 语法 / 句式 / 示译 / 句构 / 翻译 …).
 * Longer windows wrap around the cycle, which is why a single value can hold several of these.
 */
const DEGENERATE_BIGRAMS = [
  "汉例", "例语", "语子", "子语", "语式", "式示", "示译", "译句", "句构", "构方",
  "方容", "容翻", "翻汇", "汇结", "结达", "达内", "内释", "释词", "词章", "章表",
  "表本", "本解", "解学", "学篇", "篇义", "义文", "文明", "明文", "文落", "落语",
  "译说", "说言", "言段", "段法",
  // The cycle is a loop, so the pair that closes it counts as well: 段法{法汉}汉例. Leaving it out
  // let 「段法汉例」 through, which is a window that straddles the join.
  "法汉",
];
const DEGENERATE_SET = new Set(DEGENERATE_BIGRAMS);
const KANA_ANY = /[\u3040-\u309f\u30a0-\u30fa\uff66-\uff9f]/;   // ー (30fc) and ・ (30fb) excluded: they decorate a Han-only value
// Ordinary Chinese function words. Their presence means the text is a sentence, not word salad.
const CN_FUNC = /[的了是在我你他她它们这那就都也很不没和与跟对把被给到从之其于并且但所以因为如果]/;
const NON_HAN = /[，。、；：！？…‥—～·「」『』（）〈〉《》,.;:!?\s\dA-Za-z０-９]/;
// ー (prolonged sound mark) and ・ are tolerated inside a Han-only value: the observed windows
// sometimes end on one ("义文明文ー"), and neither carries lexical content on its own.
const TOLERATED = /[\u30fc\u30fb]/g;

/**
 * Does this value look like the degeneration cycle rather than a translation?
 *
 * Requires all of: Han only (plus a trailing prolonged sound mark), no punctuation or digits or
 * Latin, no ordinary function word, at least FOUR characters, and THREE distinct cycle bigrams.
 * Three rather than two because a lone ordinary word can supply one bigram (「文明」 contains both
 * 文明 and 明文), and requiring three keeps that kind of coincidence out while still catching the
 * shortest observed window (「汉例语子语式」 carries four). Four characters rather than five
 * because windows of that length occur too (「句构方容」, 「义文明文」).
 *
 * Measured on the game that exposed this: 309 stored values match, every one of them word salad,
 * and none of the 10 224 others do.
 *
 * @returns {string[]|null} the matched bigrams, or null when the value is not degenerate
 */
function degenerationMatches(value) {
  const t = String(value == null ? "" : value).replace(TOLERATED, "");
  if (t.length < 4) return null;
  if (KANA_ANY.test(t) || NON_HAN.test(t) || CN_FUNC.test(t)) return null;
  if (!/^[\u3400-\u9fff]+$/.test(t)) return null;
  const hit = new Set();
  for (let i = 0; i + 2 <= t.length; i++) {
    const g = t.slice(i, i + 2);
    if (DEGENERATE_SET.has(g)) hit.add(g);
  }
  return hit.size >= 3 ? Array.from(hit) : null;
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
  // English SOURCE: the overlap test below cannot see anything, because the source already holds those
  // letters — a paraphrase in English would look "invented 0" and be accepted. A Chinese answer must
  // carry Han characters; one without them is not Chinese.
  const srcIsEnglish = srcLetters >= 3 && !/[\u3040-\u30ff\u3400-\u9fff]/.test(src);
  if (srcIsEnglish) return cjk === 0;
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

/**
 * Does this source need translating at all (vs a label that legitimately stays)?
 *
 * The CJK test is deliberately any CJK rather than kana only. Requiring kana exempted every kana-free
 * Japanese string from the `unchanged` rule below, and a game's data is full of those: skill, element,
 * status and enemy names. Measured on one batch: 202 / 71 / 5 / 83 / 59 cached values per game were
 * identical to their source (`爪/物理 -> 爪/物理`), and those no-op "translations" still counted as
 * replaced in the patch report — one game reported "replaced 8, files 0", i.e. eight replacements that
 * changed nothing on disk. With any-CJK, an unchanged answer is rejected as `unchanged` like any other.
 */
function translatableSource(s) {
  const t = String(s).trim();
  if (!t) return false;
  if (/\.(png|jpg|jpeg|gif|bmp|webp|rpgmvp|rpgmvo|ogg|m4a|mp3|rvdata2?|rxdata)$/i.test(t)) return false;
  if (/^[A-Za-z0-9_\-./\\%]+$/.test(t)) return false;
  if (!/[\u3040-\u30ff\u3400-\u9fff]/.test(t)) {
    // An English source counts too: without this, a run on an English release had no `unchanged`
    // check at all, so an answer that echoed the English was cached and written into the game.
    const letters = (t.match(/[A-Za-z]/g) || []).length;
    if (letters < 3 || letters * 10 < t.replace(/\s/g, "").length * 6) return false;
    const words = t.split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
    return words.length >= 2 || /[.!?…:]["')\]]?$/.test(t);
  }
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

  // 9) the answer is the degeneration cycle, not a translation.
  //
  // Measured on a game translated by an earlier configuration: 351 data values and 309 cache
  // entries held windows over the cycle below. 85 of them were player-visible — skill descriptions
  // read 「本解学篇义文明文\n汉例语子语式示译」 — while the rest sat in event labels. The existing
  // repetition rule misses this shape: no single character dominates and a window of eight to forty
  // characters is far below its 120-character threshold. The current configuration no longer
  // produces it (verified by re-asking four of the original sources), so this is a guard against
  // the class, not a fix for a live cause.
  const degen = degenerationMatches(d);
  if (degen) fatal.push("degenerate:" + degen.slice(0, 3).join(","));

  return { fatal, warn };
}

module.exports = {
  qualityCheck, looksLikeEnglish, contentLength, translatableSource,
  longestRepeatedPhrase, MIN_RATIO_CHECK, KANA_ALL, KANA_EVIDENCE, HAN,
  promptFragments, promptEchoMatches, PROMPT_ECHO_MARKERS,
  degenerationMatches, DEGENERATE_BIGRAMS,
};
