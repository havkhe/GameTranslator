// VX Ace / VX extraction and patching, driven through the portable Ruby runtime.
//
// Both engines use the same Ruby Marshal layout, so one walker covers them: the extractor
// collects translatable strings from every *.rvdata2 (VX Ace) / *.rvdata (VX), and the
// patcher writes them back. This is the Ruby path v2 used; the scripts are carried over
// rather than rewritten, because they were validated on real games (2485 translations
// written back with every .rvdata2 still loadable by Ruby afterwards).
//
// The text rules applied afterwards are the same ones extract/rules.js applies to MV, so a
// game behaves the same whichever engine it uses.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const R = require("../extract/rules.js");

/** Where the portable Ruby and its scripts live, relative to the install root. */
function runtimePaths(root) {
  return {
    ruby: path.join(root, "ruby", "bin", "ruby.exe"),
    extract: path.join(root, "pipeline", "ruby", "vxace_extract.rb"),
    patch: path.join(root, "pipeline", "ruby", "vxace_patch.rb"),
  };
}

function runRuby(script, args, timeoutMs) {
  if (!fs.existsSync(script)) throw new Error("缺少 Ruby 脚本: " + script);
  const r = spawnSync(args.ruby, [script, ...args.rest], {
    encoding: "utf8",
    timeout: timeoutMs || 900000,
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.error) throw r.error;
  const stdout = r.stdout || "";
  if (r.status !== 0) {
    const detail = (r.stderr || stdout || ("exit " + r.status)).split(/\r?\n/).slice(0, 4).join(" | ");
    throw new Error("Ruby " + path.basename(script) + " 失败: " + detail);
  }
  return stdout;
}

/**
 * Is this string already Chinese (kanji-dominant, no kana) — enough to skip it?
 *
 * A kana-free run of kanji is ambiguous: 剣 / 盾 / 薬 / 回復魔法 are Japanese words that happen to be
 * written with the same characters the Chinese translation uses, and a title translated by another
 * tool (MTool keeps its result inside the archive) really does yield Chinese source, and asking the
 * model to translate Chinese into Chinese made it refuse — measured on one such game, 1,954 of 2,117
 * entries were already Chinese.
 *
 * The MV side resolves this by only skipping PROSE (see translate/index.js mayBeChineseAlready and
 * CHINESE_PROSE_MIN): a short kana-free term is sent rather than dropped. This side never got that
 * change, so on a real VX Ace game 226 of the 905 collected strings — skill, item and enemy NAMES,
 * the text the player reads in every menu — were discarded as "already Chinese" and never entered a
 * translation task (docs/P25).
 */
function isChineseLike(s, minLength) {
  const t = String(s);
  if (/[\u3040-\u309f\u30a0-\u30ff]/.test(t)) return false;
  const han = (t.match(/[\u3400-\u9fff]/g) || []).length;
  if (!(han >= 2 && han * 2 >= t.replace(/\s/g, "").length)) return false;
  // Only prose counts as "already Chinese"; a short term goes to the model.
  return minLength === undefined ? true : t.length >= minLength;
}

/** The length from which a kana-free CJK string is treated as prose rather than a term (as in MV). */
const CHINESE_PROSE_MIN = 12;

/**
 * Extract translatable strings from a folder of .rvdata2/.rvdata files.
 *
 * Text that is already Chinese is dropped before it becomes a translation task. This
 * matters here more than for MV: a title translated by another tool (MTool keeps its result
 * inside the archive) yields Chinese source, and asking the model to translate Chinese into
 * Chinese made it refuse, which cascaded into thousands of failures. Measured on one such
 * game: 1954 of 2117 entries were already Chinese.
 */
function extract(dataDir, root, workDir, extractJson) {
  const rp = runtimePaths(root);
  const out = extractJson || path.join(workDir, "_vxace_extract.json");
  runRuby(rp.extract, { ruby: rp.ruby, rest: [dataDir, out] });
  const all = JSON.parse(fs.readFileSync(out, "utf8"));

  const entries = [];
  const seen = new Set();
  let skipped = 0, filtered = 0;
  for (const e of all) {
    // One prompt line per entry, so embedded breaks become spaces (see translate/index.js).
    const t = String(e.text).replace(/\r\n|\n|\r/g, " ");
    // A message line (`@text` of a Show Text command) is dialogue by construction, so the single-word guard of
    // the English rule must not apply to it — a bare word there is a speaker name. See isTranslatableMessage.
    const isMessage = / @text$/.test(String(e.path || ""));
    const ok = R.isTranslatable(t) || (isMessage && R.isTranslatableMessage(t));
    if (!ok) { filtered++; continue; }
    if (isChineseLike(t, CHINESE_PROSE_MIN)) { skipped++; continue; }
    if (seen.has(t)) continue;
    seen.add(t);
    entries.push({ id: entries.length, file: e.file, path: e.path, text: t });
  }
  return { entries, skipped, filtered, total: all.length };
}

/** Write the translations back into the data folder. */
function patch(dataDir, root, workDir, extractJson, transJson, reportJson) {
  const rp = runtimePaths(root);
  const out = runRuby(rp.patch, {
    ruby: rp.ruby,
    rest: [dataDir, extractJson, transJson, reportJson],
  }, 1800000);
  return out.trim();
}

module.exports = { extract, patch, runtimePaths, runRuby, isChineseLike, CHINESE_PROSE_MIN };
