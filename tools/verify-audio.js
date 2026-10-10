// Correct audio resolution check.
//
// RPG Maker MV strips a trailing underscore from resource extensions when deploying: the file on
// disk is "Battle1.ogg_" and the engine loads it for name "Battle1". Matching literal extensions
// therefore reports false alarms — the earlier check did exactly that, and its "still missing"
// verdict was wrong.
//
// Rule: a reference resolves when a file exists whose name equals "<name>.ogg" OR
// "<name>.ogg_" (any audio extension, with or without the deployment underscore).
"use strict";
const fs = require("fs");
const path = require("path");

const GAME = "J:\\game\\HGAME\\H\\(同人ゲーム)[I'm moralist] 凍堂ヒロカの隷雄譚 Ver1.1.1";
const AUDIO = path.join(GAME, "audio");
const LIVE = path.join(GAME, "data");
const say = (s) => console.log(s);

const AUDIO_EXT = /\.(ogg|m4a|wav|mp3|aac|flac)_?$/i;

/** Basenames available on disk: "Battle1" from "Battle1.ogg_". */
const onDisk = new Set();
(function index(dir) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) index(p);
    else if (AUDIO_EXT.test(e.name)) onDisk.add(e.name.replace(AUDIO_EXT, "").toLowerCase());
    else onDisk.add(e.name.replace(/\.[^.]+$/, "").toLowerCase());
  }
})(AUDIO);
say("audio basenames on disk (underscore-tolerant): " + onDisk.size);
say("");

const wanted = [];
const walk = (o, at, file) => {
  if (Array.isArray(o)) { o.forEach((v, i) => walk(v, at + "[" + i + "]", file)); return; }
  if (!o || typeof o !== "object") return;
  if (typeof o.name === "string" && (o.volume !== undefined || o.pitch !== undefined)) {
    wanted.push({ name: o.name, at: at + ".name", file });
  }
  for (const k of Object.keys(o)) { if (k !== "note") walk(o[k], at + "." + k, file); }
};
for (const f of fs.readdirSync(LIVE).filter((x) => x.endsWith(".json")).sort()) {
  let root; try { root = JSON.parse(fs.readFileSync(path.join(LIVE, f), "utf8")); } catch (e) { continue; }
  walk(root, "", f);
}

const unresolved = [];
for (const w of wanted) {
  const base = String(w.name).split("/").pop();
  if (onDisk.has(base.toLowerCase())) continue;
  unresolved.push(w);
}
say("=== audio references ===");
say("  total:      " + wanted.length);
say("  unresolved: " + unresolved.length);
say("");
const uniq = new Map();
for (const u of unresolved) uniq.set(u.name, (uniq.get(u.name) || 0) + 1);
[...uniq.entries()].forEach(([n, c]) => say("    x" + String(c).padStart(3) + "  " + JSON.stringify(n)));

// Compare with the pristine backup: anything unresolved there too is the game's own problem.
say("");
say("=== same check on the pristine backup ===");
const BAK = path.join(GAME, "data_原版备份");
const bakWanted = [];
const walk2 = (o, at, file) => {
  if (Array.isArray(o)) { o.forEach((v, i) => walk2(v, at + "[" + i + "]", file)); return; }
  if (!o || typeof o !== "object") return;
  if (typeof o.name === "string" && (o.volume !== undefined || o.pitch !== undefined)) bakWanted.push({ name: o.name, at: at + ".name", file });
  for (const k of Object.keys(o)) { if (k !== "note") walk2(o[k], at + "." + k, file); }
};
for (const f of fs.readdirSync(BAK).filter((x) => x.endsWith(".json")).sort()) {
  let root; try { root = JSON.parse(fs.readFileSync(path.join(BAK, f), "utf8")); } catch (e) { continue; }
  walk2(root, "", f);
}
const bakUnresolved = bakWanted.filter((w) => !onDisk.has(String(w.name).split("/").pop().toLowerCase()));
const bakUniq = new Map();
for (const u of bakUnresolved) bakUniq.set(u.name, (bakUniq.get(u.name) || 0) + 1);
say("  references: " + bakWanted.length + "   unresolved: " + bakUnresolved.length);
[...bakUniq.entries()].forEach(([n, c]) => say("    x" + String(c).padStart(3) + "  " + JSON.stringify(n)));
say("");
say("=== verdict ===");
const onlyLive = [...uniq.keys()].filter((n) => !bakUniq.has(n));
if (onlyLive.length === 0) say("  every unresolved reference is also unresolved in the pristine original,");
else {
  say("  references broken by translation (not broken in the original):");
  onlyLive.forEach((n) => say("    " + JSON.stringify(n)));
}
if (onlyLive.length === 0) say("  so the translation introduced no missing audio.");
