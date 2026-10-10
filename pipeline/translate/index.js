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
const { ask, waitForServer } = require("./client.js");
const B = require("./batcher.js");
const { makeCache, normText } = require("./cache.js");

const DEFAULT_TEMPLATE =
  "将下列每行日文翻译成简体中文。禁止翻译成英文，只输出简体中文。\r\n" +
  "必须原样保留 \\N[1]、\\V[1]、\\N<角色名> 等控制代码；行数必须与输入完全相同。\r\n" +
  "每行输出一条译文，不要编号、不要JSON、不要解释。\r\n{lines}";

/** Is this source text already Chinese (kanji-dominant, no kana)? */
function isChineseLike(s) {
  const t = String(s);
  if (/[\u3040-\u309f\u30a0-\u30ff]/.test(t)) return false;
  const han = (t.match(/[\u3400-\u9fff]/g) || []).length;
  return han >= 2 && han * 2 >= t.replace(/\s/g, "").length;
}

/**
 * Translate a list of entries.
 *
 * @param {object} o
 * @param {Array}  o.entries    [{id, file, path, text}]
 * @param {string} o.cacheFile
 * @param {number} o.port
 * @param {string} [o.template] prompt template containing {lines}
 * @param {function} [o.onProgress]  called after every request
 * @returns {Promise<{cache, stats, fails}>}
 */
async function translate(o) {
  const entries = o.entries || [];
  const port = o.port;
  const template = o.template || DEFAULT_TEMPLATE;
  const cache = makeCache(o.cacheFile);
  if (cache.size) console.log("CACHE_LOADED", cache.size);

  const stats = { requests: 0, splits: 0, retries: 0, cached: 0, rejected: 0, skippedChinese: 0, truncated: false };
  const fails = [];
  const attemptsUsed = new Map();   // normalised text -> attempts already spent this run
  const decorationOf = new WeakMap();
  const partState = new WeakMap();   // join buffer for split parts and multi-line entries

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
    // refuse, which used to cascade into thousands of failures.
    if (group.every((g) => isChineseLike((g.parent || g).text))) {
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
        const q = B.qualityCheck(target.text, res[i]);
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
              cache.set(target.text, joined);
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
              cache.set(target.text, joined);
            }
          }
        } else {
          cache.set(target.text, decorated);
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
  console.log("TOTAL", entries.length, "DONE", entries.length - pending.length, "PENDING", pending.length, "REQUESTS", groups.length);

  for (let i = 0; i < groups.length; i++) {
    await run(groups[i], 0);
    cache.save();
    stats.cached = entries.filter((e) => cache.has(e.text)).length;
    // Progress is reported through the callback only; the caller owns the line format
    // (the UI parses it), so printing here as well produced the line twice.
    if (typeof o.onProgress === "function") o.onProgress(stats);
  }
  stats.cached = entries.filter((e) => cache.has(e.text)).length;
  return { cache, stats, fails };
}

function hashText(s) {
  let h = 0x811c9dc5;
  const str = normText(s);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}

module.exports = { translate, isChineseLike, hashText, DEFAULT_TEMPLATE };