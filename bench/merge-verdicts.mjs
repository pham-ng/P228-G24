import fs from "fs";
const v = {
  ...JSON.parse(fs.readFileSync("bench/461-verdicts-b1.json", "utf8")),
  ...JSON.parse(fs.readFileSync("bench/461-verdicts-b2.json", "utf8")),
  ...JSON.parse(fs.readFileSync("bench/461-verdicts-b3.json", "utf8")),
};
fs.writeFileSync("bench/461-verdicts.json", JSON.stringify(v, null, 2));
const sample = fs.readFileSync("bench/461-judge-sample.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
const meta = Object.fromEntries(sample.map((r) => [r.test_id, r]));
const ids = Object.keys(v);
console.log("Tổng verdict:", ids.length);

const pct = (n, d) => d ? (n / d * 100).toFixed(1) + "%" : "-";
const cDist = [0, 0, 0, 0], fDist = [0, 0, 0];
for (const id of ids) { cDist[v[id].correctness]++; fDist[v[id].faithfulness]++; }
console.log("\n=== CORRECTNESS (0-3) ===");
console.log(`3 đúng&đủ: ${cDist[3]} | 2 thiếu ý phụ: ${cDist[2]} | 1 sai trọng tâm: ${cDist[1]} | 0 sai/rỗng: ${cDist[0]}`);
console.log(`  Chấp nhận được (c>=2): ${pct(cDist[3] + cDist[2], ids.length)}  |  Đúng&đủ (c=3): ${pct(cDist[3], ids.length)}`);
console.log("\n=== FAITHFULNESS (0-2) — bám tài liệu ===");
console.log(`2 mọi ý có căn cứ: ${fDist[2]} | 1 có chi tiết ngoài tài liệu: ${fDist[1]} | 0 bịa/mâu thuẫn: ${fDist[0]}`);
console.log(`  Trung thực (f=2): ${pct(fDist[2], ids.length)}  |  Bịa (f=0): ${fDist[0]} ca`);

// theo expected_behavior
console.log("\n=== theo HÀNH VI kỳ vọng (c>=2 chấp nhận được) ===");
for (const beh of ["answer_directly", "ask_clarification", "abstain"]) {
  const g = ids.filter((id) => meta[id]?.expected_behavior === beh);
  const ok = g.filter((id) => v[id].correctness >= 2).length;
  console.log(`  ${beh}: ${pct(ok, g.length)} (${ok}/${g.length})`);
}
// theo nguồn
console.log("\n=== theo NGUỒN (c>=2) ===");
for (const st of ["REAL_USER", "SYNTHETIC"]) {
  const g = ids.filter((id) => (meta[id]?.test_id || "").length && sample.find((s) => s.test_id === id));
}
// numeric & adversarial
const numIds = ids.filter((id) => meta[id]?.is_numeric);
const advIds = ids.filter((id) => meta[id]?.is_adversarial);
console.log("\n=== nhóm khó ===");
console.log(`  NUMERIC (${numIds.length} ca): đúng&đủ ${pct(numIds.filter((id) => v[id].correctness === 3).length, numIds.length)} | chấp nhận ${pct(numIds.filter((id) => v[id].correctness >= 2).length, numIds.length)}`);
console.log(`  ADVERSARIAL (${advIds.length} ca): chấp nhận ${pct(advIds.filter((id) => v[id].correctness >= 2).length, advIds.length)} | bịa ${advIds.filter((id) => v[id].faithfulness === 0).length}`);

// các ca nghiêm trọng
console.log("\n=== CA NGHIÊM TRỌNG ===");
console.log("Bịa (f=0):", ids.filter((id) => v[id].faithfulness === 0).join(", ") || "không");
console.log("Rỗng/sai hẳn (c=0):", ids.filter((id) => v[id].correctness === 0).join(", ") || "không");
