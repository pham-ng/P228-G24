// In một lát mẫu ở dạng đọc được để chấm tay. node bench/show-sample.mjs <start> <count>
import fs from "fs";
const rows = fs.readFileSync("bench/461-judge-sample.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
const start = Number(process.argv[2] || 0), count = Number(process.argv[3] || 34);
for (const r of rows.slice(start, start + count)) {
  console.log("\n═══ " + r.test_id + " | expect=" + r.expected_behavior + (r.is_numeric ? " | NUM" : "") + (r.is_adversarial ? " | ADV" : "") + (r.is_multi_turn ? " | MT" : ""));
  console.log("Q : " + r.question);
  console.log("GT: " + (r.ground_truth || "").slice(0, 220));
  console.log("A : " + (r.actual_answer || "(rỗng)").slice(0, 400));
  console.log("P : " + (r.passages_text || "(không có)").slice(0, 700).replace(/\n/g, " ⁋ "));
}
