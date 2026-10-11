// Does the deployed v3 translator actually use the corrected logic?
//
// The GUI launches <deployment>\pipeline\index.js, so that file tree — not the repo — is what a user's
// click runs. This asserts, by reading the deployed files, that every fix from this session is present
// there. Text checks only; nothing is executed.
"use strict";
const fs = require("fs");
const path = require("path");

const DEP = "D:\\GameTranslatorV3";
const SRC = "C:\\Users\\Administrator\\Documents\\Codex\\2026-08-05\\https-github-com-asuojun-claude-vision\\outputs\\GameTranslator";
const BS = "\\";

const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch (e) { return null; } };
const say = (s) => console.log(s);

const checks = [];
function check(name, file, test) {
  const text = read(path.join(DEP, file));
  checks.push({ name, file, ok: text === null ? null : test(text) });
}

// 1) the dialogue-resource module exists and is wired into the pipeline
check("dialogue resource module present", "pipeline\\extract\\resources.js", (t) => t.includes("function extract") && t.includes("function patch"));
check("pipeline imports the module", "pipeline\\index.js", (t) => t.includes("extract/resources.js"));
check("pipeline extracts dialogue", "pipeline\\index.js", (t) => t.includes("resources.extract("));
check("pipeline patches dialogue", "pipeline\\index.js", (t) => t.includes("resources.patch("));
check("single source locale (dedup fix)", "pipeline\\extract\\resources.js", (t) => t.includes('SOURCE_LOCALES = ["ja-JP"]'));

// 2) the prompt no longer contains literal control codes.
//
// Checked by loading the module and reading the template itself, not by searching the file text: the
// comment above the template deliberately quotes the OLD instruction, so a text search matches the
// explanation and reports a false failure.
checks.push({
  name: "built-in template free of literal codes",
  file: "pipeline\\translate\\index.js",
  ok: (() => {
    try {
      const mod = require(path.join(DEP, "pipeline", "translate", "index.js"));
      const t = mod.DEFAULT_TEMPLATE || "";
      return t.length > 0 && !t.includes(BS + "N[") && !t.includes(BS + "V[") && !t.includes(BS + "N<");
    } catch (e) { return false; }
  })(),
});

// 3) the control-code rule that rejects invented codes
check("code-invented rule present", "pipeline\\translate\\quality.js", (t) => t.includes("code-invented"));

// 4) the archive fixes
check("per-member key preserved", "pipeline\\archive\\codec.js", (t) => t.includes("e.key") && t.includes("fileKey"));
check("keystream generated on the fly", "pipeline\\archive\\codec.js", (t) => t.includes("advanceKey") && !t.includes("KEY_BYTES_TARGET"));
check("v3 repack decrypts before re-encrypting", "pipeline\\archive\\rgssad.js", (t) => t.includes("extractFile(arch, orig)"));

// 5) the VX Ace path
check("VX Ace extract and patch wired", "pipeline\\index.js", (t) => t.includes("vxAce.extract") && t.includes("vxAce.patch"));

say("=== deployed translator (" + DEP + ") ===");
say("");
let ok = 0, bad = 0, missing = 0;
for (const c of checks) {
  const mark = c.ok === null ? "MISSING" : (c.ok ? "  ok  " : " FAIL ");
  if (c.ok === null) missing++; else if (c.ok) ok++; else bad++;
  say("  [" + mark + "] " + c.name.padEnd(42) + " (" + c.file + ")");
}
say("");
say("  ok " + ok + "   failed " + bad + "   missing " + missing);
say("");

// The prompt file the pipeline actually reads, since it overrides the built-in template.
const promptPath = path.join(DEP, "work", "prompt.txt");
const prompt = read(promptPath);
say("=== prompt file the pipeline reads ===");
say("  " + promptPath);
if (prompt === null) say("  (absent — the built-in template is used instead)");
else {
  const clean = !prompt.includes(BS + "N[") && !prompt.includes(BS + "V[") && !prompt.includes(BS + "N<");
  say("  no literal control codes: " + clean);
  prompt.split(/\r?\n/).filter((l) => l.trim()).slice(0, 4).forEach((l) => say("      " + l.slice(0, 96)));
}

// Files present in the repo but not deployed, which would mean a fix is only half applied.
say("");
say("=== repo vs deployment ===");
function walk(dir, base, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else if (e.name.endsWith(".js")) out.push(path.relative(base, p));
  }
  return out;
}
const repoFiles = walk(path.join(SRC, "pipeline"), path.join(SRC, "pipeline"), []);
let differ = 0, absent = 0;
for (const f of repoFiles) {
  const a = read(path.join(SRC, "pipeline", f));
  const b = read(path.join(DEP, "pipeline", f));
  if (b === null) { say("  MISSING in deployment: " + f); absent++; }
  else if (a.replace(/\r\n/g, "\n") !== b.replace(/\r\n/g, "\n")) { say("  DIFFERS: " + f); differ++; }
}
say("  repo pipeline files: " + repoFiles.length + "   differing " + differ + "   missing " + absent);
say(differ === 0 && absent === 0
  ? "  deployment matches the repository exactly"
  : "  deployment is NOT in step with the repository");
