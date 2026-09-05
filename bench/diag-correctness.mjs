import fs from "fs";
const v = JSON.parse(fs.readFileSync("bench/461-verdicts.json", "utf8"));
const run = Object.fromEntries(fs.readFileSync("bench/461-run.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l)).map((r) => [r.test_id, r]));

const ids = Object.keys(v);
const c3 = ids.filter((id) => v[id].correctness === 3).length;
const sub = ids.filter((id) => v[id].correctness < 3);
console.log(`n=${ids.length} | c=3 đúng&đủ: ${c3} (${(c3/ids.length*100).toFixed(0)}%) | c<3: ${sub.length}`);

// phân loại theo GHI CHÚ + metadata
function bucket(id) {
  const note = (v[id].note || "").toLowerCase();
  const r = run[id] || {};
  if (/trẻ<10|người lớn kèm/.test(note)) return "corpus_gap: trẻ<10 thiếu quy tắc người lớn";
  if (/suất bơi tối nay|23:00.*không dùng|bơi không cần đặt/.test(note)) return "multiturn: 'đặt suất bơi' hiểu sai giờ";
  if (/hồ bơi riêng|villa riêng|5000m2|5.000m2/.test(note)) return "completeness: pool YES/NO thiếu chi tiết villa/5000m²";
  if (/tool|availability|offline|đảo ngày|0 đêm|60 đêm|tết|ngày đóng|tuổi trẻ em|lịch chưa mở/.test(note)) return "availability_tool: cần công cụ tra phòng (offline)";
  if (/thiếu|không nêu|bỏ qua|nên hỏi|cứu hộ|caveat/.test(note)) return "completeness: đúng nhưng thiếu ý phụ";
  if (/mis-route|escalate thay vì|clarify.*thay|deflect/.test(note)) return "routing: mis-route / deflect thay vì trả lời";
  if (/bịa|sai giờ|combo.*200|lẫn/.test(note)) return "wrong_fact: lẫn/bịa chi tiết";
  return "other";
}
const groups = {};
for (const id of sub) { const b = bucket(id); (groups[b] ??= []).push(id); }
console.log("\n=== GỐC RỄ CÁC CA c<3 ===");
for (const [k, arr] of Object.entries(groups).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n■ ${k}: ${arr.length} ca`);
  for (const id of arr) console.log(`   ${id} (c=${v[id].correctness}) — ${v[id].note?.slice(0, 90)}`);
}

// gom câu lặp trong c<3
console.log("\n=== CÂU LẶP trong c<3 (bộ đề nhân bản) ===");
const byQ = {};
for (const id of sub) { const q = (run[id]?.question || id).replace(/\(.*?\)/g, "").trim().slice(0, 42); (byQ[q] ??= []).push(id); }
for (const [q, arr] of Object.entries(byQ).sort((a, b) => b[1].length - a[1].length)) if (arr.length > 1) console.log(`  ${arr.length}×  ${q}`);
