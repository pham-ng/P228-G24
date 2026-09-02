import fs from "fs";
const rows = fs.readFileSync("bench/461-run.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));

const norm = (s) => (s || "").toLowerCase().replace(/[.,]/g, "");
function numbers(s) {
  const out = new Set();
  for (const tok of (s || "").match(/\d[\d.,:]*\d|\d/g) || []) { out.add(tok); out.add(tok.replace(/[.,]/g, "")); }
  return out;
}
// số "chính" trong ground_truth (>=2 ký tự, bỏ nhiễu 1 chữ số)
function keyNums(s) { return [...numbers(s)].filter((x) => x.length >= 2); }

// numeric answer-expected cases
const num = rows.filter((r) => r.is_numeric && (r.expected_behavior === "answer_directly"));
const fails = num.filter((r) => r.numeric_ok === false);
const oks = num.filter((r) => r.numeric_ok === true);
console.log(`Numeric answer-expected: ${num.length} | ĐÚNG ${oks.length} | SAI ${fails.length} (${(fails.length/num.length*100).toFixed(0)}%)`);

// phân loại từng ca SAI
const cat = { retrieval_miss: [], route_escalate: [], had_it_wrong_gen: [], scorer_artifact: [], fabricated: [], no_passage_empty: [] };
for (const r of fails) {
  const want = keyNums(r.ground_truth);
  const ans = numbers(r.actual_answer);
  const passHay = norm(r.passages.map((p) => `${p.title} ${p.content}`).join(" "));
  const passNums = numbers(passHay);
  const gtInPass = want.length && want.every((k) => passNums.has(k) || passNums.has(k.replace(/[.,]/g, "")));
  const gtInAns = want.length && want.every((k) => ans.has(k) || ans.has(k.replace(/[.,]/g, "")));
  const empty = (r.actual_answer || "").trim() === "";

  if (empty && (r.route === "complex" || r.route === "emergency" || r.escalate)) cat.route_escalate.push(r);
  else if (gtInAns) cat.scorer_artifact.push(r);        // số ĐÚNG có trong đáp nhưng metric trượt (định dạng)
  else if (!gtInPass && r.passages.length === 0) cat.no_passage_empty.push(r);
  else if (!gtInPass) cat.retrieval_miss.push(r);       // truy xuất không mang được số đúng
  else if (gtInPass && !gtInAns) cat.had_it_wrong_gen.push(r); // có trong passage, đáp sai/thiếu
  else cat.fabricated.push(r);
}
console.log("\n=== PHÂN LOẠI GỐC RỄ (ca SAI) ===");
for (const [k, v] of Object.entries(cat)) console.log(`  ${k}: ${v.length}`);

// in chi tiết từng nhóm để đọc
for (const [k, v] of Object.entries(cat)) {
  if (!v.length) continue;
  console.log(`\n########## ${k} (${v.length}) ##########`);
  for (const r of v) {
    console.log(`— ${r.test_id} | route=${r.route} esc=${r.escalate} | GT nums: ${keyNums(r.ground_truth).join(",")}`);
    console.log(`  Q: ${r.question.slice(0, 70)}`);
    console.log(`  GT: ${(r.ground_truth || "").slice(0, 70)}`);
    console.log(`  A: ${(r.actual_answer || "(rỗng)").slice(0, 150)}`);
  }
}
