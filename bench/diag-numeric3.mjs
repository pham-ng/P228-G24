import fs from "fs";
const rows = fs.readFileSync("bench/461-run.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
function canonNums(s) {
  s = (s || "").toLowerCase(); const out = new Set();
  for (const m of s.matchAll(/(\d[\d.,]*)\s*(k|nghìn|ngàn|tr|triệu)?/g)) {
    let n = parseInt(m[1].replace(/[.,]/g, ""), 10); if (isNaN(n)) continue;
    const u = m[2] || ""; if (u === "k" || u === "nghìn" || u === "ngàn") n *= 1000; else if (u === "tr" || u === "triệu") n *= 1000000;
    if (n >= 10) out.add(String(n));
  } return out;
}
const keyNums = (s) => [...canonNums(s)];
const matchAll = (w, h) => w.length > 0 && w.every((k) => h.has(k));
const num = rows.filter((r) => r.is_numeric && r.expected_behavior === "answer_directly" && keyNums(r.ground_truth).length > 0);

// (a) raw
const rawOk = num.filter((r) => matchAll(keyNums(r.ground_truth), canonNums(r.actual_answer))).length;
// (b) khử lặp theo câu (giữ 1 đại diện mỗi câu)
const seen = new Set(), uniq = [];
for (const r of num) { const q = r.question.replace(/\(.*?\)/g, "").trim(); if (!seen.has(q)) { seen.add(q); uniq.push(r); } }
const uniqOk = uniq.filter((r) => matchAll(keyNums(r.ground_truth), canonNums(r.actual_answer))).length;
// (c) khử lặp + loại ca cần availability-tool (booking đa điều kiện) + loại GT nghi sai
const TOOL = /(tìm phòng|đặt.*phòng|từ \d+\/\d+.*đến|ngân sách|phòng cho \d+ người.*\d+\/\d+)/i;
const adj = uniq.filter((r) => !TOOL.test(r.question) && r.test_id !== "BM-NUM-013"); // 013 golden sai (5tr vs 3tr đúng)
const adjOk = adj.filter((r) => matchAll(keyNums(r.ground_truth), canonNums(r.actual_answer))).length;

console.log("=== NUMERIC ACCURACY 3 CÁCH TÍNH ===");
console.log(`(a) Thô (mọi instance):        ${rawOk}/${num.length} = ${(rawOk/num.length*100).toFixed(1)}%`);
console.log(`(b) Khử câu lặp:               ${uniqOk}/${uniq.length} = ${(uniqOk/uniq.length*100).toFixed(1)}%`);
console.log(`(c) Khử lặp + loại tool + GT sai: ${adjOk}/${adj.length} = ${(adjOk/adj.length*100).toFixed(1)}%`);

console.log("\n=== KIỂM CHỨNG CORPUS ===");
// phạt hút thuốc: 3tr hay 5tr?
const smoke = rows.find((r) => /phạt hút thuốc/i.test(r.question) && r.passages.length);
if (smoke) { const has3 = /3\.000\.000|3000000/.test(JSON.stringify(smoke.passages)); const has5 = /5\.000\.000|5000000/.test(JSON.stringify(smoke.passages)); console.log(`Phạt hút thuốc trong passages: 3.000.000=${has3}, 5.000.000=${has5} -> model đáp 3tr là ĐÚNG theo KB`); }
// 5000m2 hồ bơi
const pool = rows.find((r) => /hồ bơi riêng/i.test(r.question) && r.passages.length);
if (pool) { const has5000 = /5\.?000\s*m|5000m|diện tích.*5000/i.test(JSON.stringify(pool.passages)); console.log(`"5.000m²" hồ bơi trong passages: ${has5000} -> ${has5000 ? "CÓ" : "KHÔNG có trong KB (lỗ hổng corpus)"}`); }

// các ca SAI còn lại sau khử lặp
console.log("\n=== CA SAI CÒN LẠI (sau khử câu lặp) ===");
for (const r of uniq.filter((r) => !matchAll(keyNums(r.ground_truth), canonNums(r.actual_answer)))) {
  console.log(`— ${r.test_id} route=${r.route} | GT:${keyNums(r.ground_truth).join(",")} | ${TOOL.test(r.question) ? "[TOOL]" : ""}`);
  console.log(`  Q: ${r.question.slice(0, 72)}`);
  console.log(`  A: ${(r.actual_answer || "(rỗng)").slice(0, 130)}`);
}
