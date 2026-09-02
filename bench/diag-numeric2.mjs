import fs from "fs";
const rows = fs.readFileSync("bench/461-run.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));

// Chuẩn hoá số kiểu Việt: 800k->800000, 1tr/1 triệu->1000000, 5.000->5000, bỏ phân cách nghìn
function canonNums(s) {
  s = (s || "").toLowerCase();
  const out = new Set();
  // dạng "800k", "1.05 triệu", "2tr"
  for (const m of s.matchAll(/(\d[\d.,]*)\s*(k|nghìn|ngàn|tr|triệu|m2|m²)?/g)) {
    let raw = m[1].replace(/[.,](?=\d{3}\b)/g, "").replace(/[.,]/g, ""); // bỏ phân cách nghìn
    let n = parseInt(raw, 10);
    if (isNaN(n)) continue;
    const unit = m[2] || "";
    if (unit === "k" || unit === "nghìn" || unit === "ngàn") n *= 1000;
    else if (unit === "tr" || unit === "triệu") n *= 1000000;
    if (n >= 10) out.add(String(n)); // bỏ số lẻ 1 chữ số
  }
  return out;
}
const keyNums = (s) => [...canonNums(s)];
const matchAll = (want, hay) => want.length > 0 && want.every((k) => hay.has(k));

const num = rows.filter((r) => r.is_numeric && r.expected_behavior === "answer_directly" && keyNums(r.ground_truth).length > 0);
let ok = 0, fail = [];
for (const r of num) {
  const want = keyNums(r.ground_truth);
  const ans = canonNums(r.actual_answer);
  if (matchAll(want, ans)) ok++; else fail.push(r);
}
console.log(`Numeric answer-expected (có số trong GT): ${num.length} | ĐÚNG (chuẩn hoá) ${ok} = ${(ok/num.length*100).toFixed(1)}% | SAI ${fail.length}`);

// gom câu lặp
const byQ = {};
for (const r of fail) { const q = r.question.replace(/\(.*?\)/g, "").trim().slice(0, 40); (byQ[q] ??= []).push(r); }
console.log("\n=== CA SAI gom theo câu (lặp) ===");
for (const [q, v] of Object.entries(byQ).sort((a, b) => b[1].length - a[1].length)) console.log(`  ${v.length}×  ${q}`);

// phân loại gốc rễ (đã chuẩn hoá số)
const cat = { corpus_gap_repeated: [], retrieval_miss: [], route_escalate: [], had_it_wrong_gen: [], genuine_wrong: [] };
for (const r of fail) {
  const want = keyNums(r.ground_truth);
  const ans = canonNums(r.actual_answer);
  const passNums = canonNums(r.passages.map((p) => `${p.title} ${p.content}`).join(" "));
  const gtInPass = matchAll(want, passNums);
  const empty = (r.actual_answer || "").trim() === "";
  const isPoolRepeat = /hồ bơi riêng/i.test(r.question);
  if (empty && r.escalate) cat.route_escalate.push(r);
  else if (isPoolRepeat) cat.corpus_gap_repeated.push(r);
  else if (!gtInPass) cat.retrieval_miss.push(r);
  else if (gtInPass && !matchAll(want, ans)) cat.had_it_wrong_gen.push(r);
  else cat.genuine_wrong.push(r);
}
console.log("\n=== GỐC RỄ (sau chuẩn hoá) ===");
for (const [k, v] of Object.entries(cat)) console.log(`  ${k}: ${v.length}`);

// in nhóm retrieval_miss + had_it_wrong_gen (lỗi đáng chú ý, không lặp)
for (const k of ["retrieval_miss", "had_it_wrong_gen", "genuine_wrong"]) {
  if (!cat[k].length) continue;
  console.log(`\n########## ${k} ##########`);
  for (const r of cat[k]) {
    console.log(`— ${r.test_id} route=${r.route} | GT: ${keyNums(r.ground_truth).join(",")} | passages=${r.passages.length}`);
    console.log(`  Q: ${r.question.slice(0, 75)}`);
    console.log(`  A: ${(r.actual_answer || "(rỗng)").slice(0, 160)}`);
  }
}
