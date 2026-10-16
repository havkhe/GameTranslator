// Translation orchestration: groups -> requests -> validation -> cache.
//
// This is the v3 rewrite of the v2 control flow. The retry model is the one proven on
// real runs, restated here so the behaviour is explicit:
//
//   1. pack entries into requests (batcher.packGroups)
//   2. send one request per group
//   3. validate each line; accepted lines are cached IMMEDIATELY (a killed process
//      then loses at most one request) and decoration withheld from the request is
//      put back
//   4. only the rejected lines are retried, once; if they fail again they are
//      recorded, never re-sent (the attempt budget)
//   5. if the model's answer has the wrong number of lines the group is halved and
//      retried, which isolates the entry that caused it
//   6. a group whose entries are already Chinese is not sent at all
"use strict";
const fs = require("fs");
const path = require("path");
const { ask, waitForServer, usage } = require("./client.js");
const B = require("./batcher.js");
const { makeCache, normText } = require("./cache.js");

const DEFAULT_TEMPLATE =
  "将下列每行文本翻译成简体中文（原文可能是日文，也可能是英文）。禁止翻译成英文，只输出简体中文。\r\n" +
  // The instruction must NOT contain literal control codes.
  //
  // It used to read 「必须原样保留 \N[1]、\V[1]、\N<角色名> 等控制代码」, and the model treated
  // those examples as text to translate: short entries came back with the codes injected, e.g.
  // "スマホ" -> "\N[1]智能手机" and "司祭3" -> "\N[1]祭司3", plus malformed ones like
  // "\[1\]恶魔之王首领卡提斯" in event and common-event names. Measured: 19 of 9747 translated
  // strings were polluted this way in one game. Naming the codes in words avoids giving the
  // model anything to copy.
  "如果原文含有反斜杠开头的控制代码（如变量、角色名、颜色、图标等），必须原样保留，不要增加也不要删除；" +
  "原文没有控制代码时，译文中也不要出现。行数必须与输入完全相同。\r\n" +
  "保持每行开头的行号，逐行输出「行号. 译文」，不要JSON、不要解释。\r\n{lines}";

/**
 * How many top-level batches may be in flight at once.
 *
 * GT_CONCURRENCY, default 1 — the shipped behaviour, one request at a time, and it stays the default
 * because that is the only setting that is right for a local llama-server (see below).
 *
 * A hosted endpoint decodes many requests together, so a strictly sequential client leaves most of its
 * capacity unused: measured against the free Index-Translate endpoint, one request at a time gives 3.4
 * requests/s, eight at a time 14.4, sixty-four 73.4, and the service was still scaling at 128 (106.6
 * requests/s). With eight-line batches that is the difference between roughly 6 lines/s and roughly 100.
 *
 * A LOCAL llama-server is a different story: the product starts it with --parallel 1, so it serves one
 * request at a time and a second batch just waits in the server's queue — no speed-up, and the silent
 * socket watchdog would be counting a request that has not started. Raise this for a hosted endpoint, or
 * for a local server that was started with a larger --parallel.
 */
const CONCURRENCY = Math.max(1, Math.min(64, parseInt(process.env.GT_CONCURRENCY || "1", 10) || 1));

/**
 * Refuse a multi-line reply that dropped the line numbers.
 *
 * The request numbers its input lines (batcher.buildPrompt), so the numbers are the anchor that makes
 * the pairing verifiable. An unnumbered reply for a multi-line group can be count-correct and still
 * shifted, which is how one game ended up with 911 of its 4,634 translated strings in the wrong
 * place - and, because the patch is keyed by the source text, that damage cannot be repaired later
 * (the Japanese is already gone from the live data). GT_ALIGN_LOOSE=1 keeps the old positional
 * acceptance for a model that will not comply.
 */
const STRICT_ALIGNMENT = process.env.GT_ALIGN_LOOSE !== "1";

/** Is this source text already Chinese (kanji-dominant, no kana)? */
function isChineseLike(s) {
  const t = String(s);
  if (/[\u3040-\u309f\u30a0-\u30ff]/.test(t)) return false;
  const han = (t.match(/[\u3400-\u9fff]/g) || []).length;
  return han >= 2 && han * 2 >= t.replace(/\s/g, "").length;
}

/** Length from which a kana-free CJK string is treated as prose rather than a term. */
const CHINESE_PROSE_MIN = 12;

/**
 * May this entry be skipped as "already Chinese"?
 *
 * Only when the text is long enough to be prose. The bare `isChineseLike` test is wrong for exactly the
 * strings Japanese games are full of: short kana-free terms — skill and element names, status names,
 * enemy names — look Chinese by that rule (`斬撃/必殺技3`, `回復/単体1`, `蘇生1`, `怪人王`, `神父`) but are
 * Japanese and belong in Chinese as 斩击/必杀技3, 回复/单体1, 复活1, 怪人王, 神父.
 *
 * Measured on one batch of five games: every single skipped entry was of that kind — 79/79, 79/79, 62/62
 * and 97/97 of the `already-chinese` records were ≤ 7 characters with no kana. Skipping them left those
 * menu terms Japanese while everything around them was translated, and because the verdict was never
 * cached they were skipped again on every later run.
 *
 * A long Chinese sentence is still skipped, which is what this guard was added for: sending Chinese back
 * through the model makes it refuse and used to cascade into thousands of failures.
 */
function mayBeChineseAlready(s) {
  const t = String(s);
  return t.length >= CHINESE_PROSE_MIN && isChineseLike(t);
}

/**
 * Cooperative pause: wait while the window's flag file exists.
 *
 * Pausing between GAMES was the only granularity before, so on a large game the button looked dead for as
 * long as that game took — measured elsewhere in this project, one game ran 58 minutes, and the user
 * reported the pause as broken while it was simply waiting for the game to end. Waiting per request makes
 * the delay the length of one request (seconds), which is what the button promises, and the run resumes
 * exactly where it stopped because nothing is torn down.
 *
 * The flag lives in the work directory, whose path the caller already passes for every other work file.
 */
async function waitWhilePaused(flag) {
  if (!flag) return;
  if (!fs.existsSync(flag)) return;
  console.log("PAUSED 已暂停：当前请求结束后不再发出新请求（点「继续」恢复）");
  while (fs.existsSync(flag)) await new Promise((r) => setTimeout(r, 500));
  console.log("RESUMED 已继续");
}

/**
 * Translate a list of entries.
 *
 * @param {object} o
 * @param {Array}  o.entries    [{id, file, path, text}]
 * @param {string} o.cacheFile
 * @param {number} o.port
 * @param {string} [o.template] prompt template containing {lines}
 * @param {string} [o.pauseFile] while this file exists, no new request is sent
 * @param {function} [o.onProgress]  called after every request
 * @returns {Promise<{cache, stats, fails}>}
 */
async function translate(o) {
  const entries = o.entries || [];
  const port = o.port;
  const template = o.template || DEFAULT_TEMPLATE;
  // Instruction chunks of THIS template, so an echo is caught even when the user supplied
  // prompt.txt rather than the built-in wording.
  const echoFragments = B.promptFragments(template);
  const cache = makeCache(o.cacheFile);
  if (cache.size) console.log("CACHE_LOADED", cache.size);

  const stats = { requests: 0, splits: 0, retries: 0, cached: 0, rejected: 0, skippedChinese: 0, truncated: false };
  const fails = [];
  const attemptsUsed = new Map();   // normalised text -> attempts already spent this run
  const decorationOf = new WeakMap();
  const partState = new WeakMap();   // join buffer for split parts and multi-line entries

  /**
   * The cache refused a value (echo / degenerate / identity / control-code mismatch). Record it, so an
   * entry that the gate accepted but the cache would not keep is visible instead of disappearing: without
   * this it was neither cached nor reported, and it came back as pending on every later run.
   */
  const recordRefused = (source) => {
    stats.refused = (stats.refused || 0) + 1;
    fails.push({ hash: hashText(source), err: "quality:refused", text: String(source).slice(0, 40) });
  };

  /**
   * Store one finished pair and report it for display.
   *
   * Only values produced by THIS run are reported. A run served entirely from the cache produces nothing
   * new, and the display saying so is the honest signal — the alternative (replaying cached pairs) would
   * show thousands of pairs the run never translated.
   */
  const store = (source, value) => {
    if (!cache.set(source, value)) { recordRefused(source); return false; }
    if (typeof o.onPair === "function") {
      try { o.onPair(String(source), String(value)); } catch (e) { /* display only: never fail a run */ }
    }
    return true;
  };

  // Count attempts UP from zero.
  //
  // The first version counted DOWN and asked "is it exhausted?" as
  // `(map.get(key) || 0) <= 0`. For an entry that had never been attempted the map
  // returned undefined, `|| 0` made it zero, and zero looked exhausted — so every
  // untouched entry was treated as spent, decide() returned null before sending
  // anything, all nine groups split to singletons and the run made 0 requests. An
  // upward counter has no such ambiguity.
  const touch = (text) => {
    const k = normText(text);
    attemptsUsed.set(k, (attemptsUsed.get(k) || 0) + 1);
    return attemptsUsed.get(k);
  };
  const spent = (text) => (attemptsUsed.get(normText(text)) || 0) >= B.MAX_ATTEMPTS;

  const decoration = (entry) => {
    const src = (entry.parent || entry).text;
    let d = decorationOf.get(entry);
    if (!d) { d = B.splitDecoration(src); decorationOf.set(entry, d); }
    return d;
  };

  /** One request; returns an array aligned with `group`, entries or null. */
  const decide = async (group) => {
    if (group.every((g) => spent((g.parent || g).text))) return null;
    // Already Chinese: asking the model to translate Chinese into Chinese makes it
    // refuse, which used to cascade into thousands of failures. Only prose is skipped —
    // see mayBeChineseAlready for why short kana-free terms must still be sent.
    if (group.every((g) => mayBeChineseAlready((g.parent || g).text))) {
      stats.skippedChinese += group.length;
      return group.map(() => null);
    }
    const prompt = B.buildPrompt(group, template);
    const srcChars = group.reduce((a, e) => a + e.text.length, 0);
    const maxTokens = Math.ceil(srcChars * 2) + 32 * group.length;
    let resp;
    try {
      resp = await ask({ port, prompt, maxTokens, onStall: () => { stats.stalls = (stats.stalls || 0) + 1; } });
    } catch (e) {
      if (!globalThis.__gtAskErrLogged) {
        globalThis.__gtAskErrLogged = true;
        console.log("REQUEST_FAILED", JSON.stringify(String(e && e.message ? e.message : e)));
      }
      return null;
    }
    stats.requests++;
    // The request numbers its input lines; a reply that drops the numbering for a multi-line group
    // gives the pairing nothing to stand on, and a shifted-but-count-correct reply is exactly how a
    // game ended up with a third of its translations in the wrong place (docs/P24). Refusing it here
    // makes the group split and retry, down to single-line requests where nothing can shift.
    // GT_ALIGN_LOOSE=1 accepts unnumbered replies positionally, for a model that will not comply.
    if (STRICT_ALIGNMENT && group.length >= 2 && !B.hasNumbering(resp)) {
      stats.alignmentRejects = (stats.alignmentRejects || 0) + 1;
      return null;
    }
    const parsed = B.parseResult(resp);
    const lines = B.normalizeResult(parsed, group.length);
    if (!lines) return null;
    for (const g of group) touch((g.parent || g).text);
    const out = [];
    for (let i = 0; i < group.length; i++) {
      const c = B.cleanOutput(lines[i]);
      out.push(c === null || B.looksLikeEnglish(c, group[i].text) ? null : c);
    }
    return out.some((x) => x !== null) ? out : null;
  };

  const run = async (group, depth) => {
    if (!group.length || stats.truncated) return;
    const res = await decide(group);
    if (res) {
      if (res.every((x) => x === null)) {
        for (const g of group) {
          const t = (g.parent || g).text;
          fails.push({ hash: hashText(t), err: "already-chinese", text: t.slice(0, 40) });
        }
        return;
      }
      const skip = new Set();
      for (let i = 0; i < group.length; i++) {
        const e = group[i];
        const target = e.parent || e;
        if (res[i] === null) { skip.add(i); continue; }
        // NOTE: the attempt budget is deliberately NOT consulted here. It decides only
        // whether to send another request (the guard at the top of decide()). Checking
        // it at this point rejected the entry once its count for this group had been
        // incremented a few lines above, so the third attempt of every entry was always
        // discarded: three requests spent, a good translation produced on the last one,
        // and nothing cached.
        const decorated = B.restoreDecoration(res[i], decoration(e));
        const q = B.qualityCheck(target.text, res[i], { promptFragments: echoFragments });
        if (q.fatal.length) {
          skip.add(i);
          stats.rejected++;
          fails.push({ hash: hashText(target.text), err: "quality:" + q.fatal.join("|"), text: target.text.slice(0, 40) });
          continue;
        }
        // The join buffer is keyed by `partObj`, shared by every part of one entry.
        //
        // It must be the PART object, not the line object: packGroups turns a
        // multi-line entry into one item per source line and each item is a distinct
        // object, so keying by the item gave every line its own buffer holding one
        // line. The count never reached `parts` and the entry was never joined or
        // cached — silently, with no failure record (measured: 8 of 9 cached, the
        // multi-line one simply absent).
        //
        // The multi-line case is tested FIRST because such parts also carry `parent`
        // (the original entry); testing `parent` first sent them down the long-line
        // path, which rejoins with "" and therefore loses every line break.
        const keyObj = e.partObj || e;
        const st = partState.get(keyObj) || { got: [] };
        partState.set(keyObj, st);
        if (e.__multi) {
          st.got[e.part - 1] = decorated;
          if (st.got.filter(Boolean).length === e.parts) {
            partState.delete(keyObj);
            // Rejoin with the source's own breaks: the wire protocol is one line in,
            // one line out, so the request carried the lines separated and the reply
            // comes back separated too.
            const joined = st.got.join(e.__multi.breaks[0] !== undefined ? e.__multi.breaks[0] : "\n");
            if (B.contentLength(joined) < B.contentLength(target.text) * 0.25) {
              fails.push({ hash: hashText(target.text), err: "multiline-too-short", text: target.text.slice(0, 40) });
            } else {
              store(target.text, joined);
            }
          }
        } else if (e.parent) {
          st.got[e.part - 1] = decorated;
          if (st.got.filter(Boolean).length === e.parts) {
            partState.delete(keyObj);
            const joined = st.got.join("");
            if (B.contentLength(joined) < B.contentLength(target.text) * 0.25) {
              fails.push({ hash: hashText(target.text), err: "parts-too-short", text: target.text.slice(0, 40) });
            } else {
              store(target.text, joined);
            }
          }
        } else {
          store(target.text, decorated);
        }
      }
      // retry only the rejected lines, once
      if (skip.size && depth < 2) {
        stats.retries++;
        const list = [];
        const seenMulti = new Set();
        for (const i of skip) {
          const e = group[i];
          const multi = e.__multi || (e.parent && e.parent.__multi);
          if (multi) {
            if (seenMulti.has(multi)) continue;
            seenMulti.add(multi);
            list.push(multi.lines.map((ln, n) => ({ id: e.id, text: ln, part: n + 1, parts: multi.lines.length, parent: e.parent, __multi: multi })));
          } else {
            list.push([e]);
          }
        }
        for (const sub of list) await run(sub, depth + 1);
      }
      return;
    }
    if (group.length === 1) {
      const e = group[0];
      const src = e.parent ? e.parent.text : e.text;
      fails.push({ hash: hashText(src), err: "request-failed", text: src.slice(0, 40) });
      return;
    }
    const mid = Math.ceil(group.length / 2);
    stats.splits++;
    await run(group.slice(0, mid), depth);
    await run(group.slice(mid), depth);
  };


  const pending = entries.filter((e) => !cache.has(e.text));
  const groups = B.packGroups(pending);
  // How many entries this run actually had to translate. The caller uses it to tell "nothing was
  // pending (a re-run over a full cache)" apart from "everything pending failed", which are the same
  // output numbers but opposite outcomes.
  stats.pending = pending.length;
  console.log("TOTAL", entries.length, "DONE", entries.length - pending.length, "PENDING", pending.length, "REQUESTS", groups.length);

  // Saving and counting after EVERY group is quadratic in a big game, and big games are exactly where it
  // shows: 15,255 entries over ~2,600 groups means the growing cache file (megabytes) was rewritten ~2,600
  // times, and `entries.filter(...)` walked all 15,255 entries per group for the progress line — about 40
  // million normalise-and-lookup calls in one run. Across one day's log four large games died with exit 1
  // while making progress (`PROGRESS 12755 / 15261`, `PROGRESS 0 / 18926`), and while that crash is not yet
  // explained the cost is real on its own.
  //
  // The cadence below keeps the property the per-group save existed for — "a killed process loses at most
  // the request in flight" — by bounding it in time rather than in groups: save at least every
  // SAVE_INTERVAL_MS, and immediately when the game is small. `cache.size` is the count of translated
  // entries for this game because the cache file is per game, so the per-group progress line no longer
  // walks the entry list.
  const SAVE_INTERVAL_MS = 20000;
  let lastSaveAt = Date.now();

  // Only the TOP level is concurrent: each worker takes one group and `run()` keeps its own halving and
  // retrying sequential, so the rules above (cache immediately, retry the rejected lines once, halve on a
  // count mismatch) are unchanged inside a group. Sharing is safe because cache.set() only mutates an
  // in-memory map and cache.save() is a synchronous write — two workers can never interleave a write — and
  // every counter in `stats` is incremented in one synchronous statement.
  let nextGroup = 0;
  const worker = async () => {
    for (;;) {
      if (stats.truncated) return;
      const i = nextGroup++;
      if (i >= groups.length) return;
      await waitWhilePaused(o.pauseFile);      // the window's 暂停, honoured between requests
      await run(groups[i], 0);
      const now = Date.now();
      if (now - lastSaveAt >= SAVE_INTERVAL_MS) {
        cache.save();
        lastSaveAt = now;
      }
      stats.cached = cache.size;
      // Progress is reported through the callback only; the caller owns the line format
      // (the UI parses it), so printing here as well produced the line twice.
      if (typeof o.onProgress === "function") o.onProgress(stats);
    }
  };
  const workers = Math.min(CONCURRENCY, Math.max(1, groups.length));
  if (workers > 1) console.log("CONCURRENCY", workers, "batches in flight of", groups.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  cache.save();
  stats.cached = entries.filter((e) => cache.has(e.text)).length;
  // Cloud mode: the exact token usage the endpoint reported for this game (local llama-server leaves
  // this at zero). This is what turns "will the free quota cover it" from an estimate into a number.
  stats.apiUsage = usage();
  return { cache, stats, fails };
}

function hashText(s) {
  let h = 0x811c9dc5;
  const str = normText(s);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}

module.exports = { translate, isChineseLike, mayBeChineseAlready, CHINESE_PROSE_MIN, hashText, DEFAULT_TEMPLATE };