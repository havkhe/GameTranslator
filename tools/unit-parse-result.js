// Assertions for the reply parser.
//
// The parser decides how many translations came back, so a mistake here is reported as a failed
// request rather than as a parse error — the entry's translation is thrown away and, because the
// batch is then split and retried, the same reply is rejected again.
//
// The cases below are the ones that actually occurred, plus the numbering behaviour the parser
// must keep.
//
// Run:  node tools/unit-parse-result.js
"use strict";
const B = require("../pipeline/translate/batcher.js");

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  ok    " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "   " + detail : "")); }
};

console.log("=== a batch reply numbered 1..n is still read as numbering ===");
{
  const reply = "1. 早上好\n2. 谢谢\n3. 再见";
  const got = B.parseResult(reply);
  check("three numbered lines -> three entries", JSON.stringify(got) === JSON.stringify(["早上好", "谢谢", "再见"]), JSON.stringify(got));
  check("normalizeResult accepts count 3", JSON.stringify(B.normalizeResult(got, 3)) === JSON.stringify(["早上好", "谢谢", "再见"]));
}
console.log("");
console.log("=== a numbered reply with a gap falls back to position ===");
{
  const got = B.parseResult("1. A\n3. C");
  check("gap keeps both texts positionally", got[0] === "A" && got[2] === "C", JSON.stringify(got));
}
console.log("");
console.log("=== a single translation that starts with digits and a colon is NOT numbering ===");
{
  const reply = "12:10 [葛谷ダイスケ] 我不是叫你赶紧去买避孕套吗。 你要让我等到什么时候。";
  const got = B.parseResult(reply);
  check("returns one entry", got.length === 1, JSON.stringify(got).slice(0, 120));
  check("the text is kept whole", got[0] === reply, JSON.stringify(got[0]).slice(0, 120));
  check("normalizeResult accepts count 1", B.normalizeResult(got, 1) !== null);
}
{
  const reply = "3、三号任务完成。";
  const got = B.parseResult(reply);
  check("widely-spaced numbering marker does not trigger the numbered path", got.length === 1 && got[0] === reply, JSON.stringify(got));
}
console.log("");
console.log("=== instruction echo lines are still stripped ===");
{
  const got = B.parseResult("每行输出一条译文，不要编号、不要JSON、不要解释。\n早上好\n行数必须与输入完全相同。");
  check("echo around the answer removed", JSON.stringify(got) === JSON.stringify(["早上好"]), JSON.stringify(got));
}
console.log("");
console.log("=== an off-by-one numbering from the model is tolerated ===");
{
  const got = B.parseResult("1. 早上好\n3. 谢谢");
  check("first-run positions preserved", got[0] === "早上好" && got[2] === "谢谢", JSON.stringify(got));
}

console.log("");
console.log("  pass " + pass + "   fail " + fail);
process.exit(fail ? 1 : 0);
