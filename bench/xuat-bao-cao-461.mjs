/**
 * Chuyển bench/461-run.jsonl (harness run461.ts) sang đúng schema
 * bench/rag-eval-report.json mà /api/bench/rag đọc.
 *
 * VÌ SAO CÓ SCRIPT NÀY. Bộ 461 câu chạy qua run461.ts, có nhiều trường hơn bộ
 * gốc 101 câu của rag-eval.ts (subcategory, difficulty, is_adversarial…) và
 * không đo context-recall/rank per-passage như rag-eval.ts. Bảng
 * /api/bench/rag đọc một schema cố định; đây là cầu nối MỘT LẦN, không sửa
 * ngược server hay harness.
 *
 * QUAN TRỌNG: dùng NHÃN ĐÃ HIỆU CHỈNH (`expected_behavior_corrected` nếu có,
 * hoặc tái tạo từ bench/data/audit-*.json + `expected_behavior` gốc) — không
 * dùng nhãn gốc. Bản chạy vừa rồi được ghi TRƯỚC khi trường
 * `expected_behavior_corrected` được thêm vào run461.ts, nên ở đây phải tái
 * tạo lại từ overlay, đúng logic mà run461.ts áp dụng lúc chạy.
 *
 *   node bench/xuat-bao-cao-461.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const RUN = join(process.cwd(), "bench", "461-run.jsonl");
const lines = readFileSync(RUN, "utf8").trim().split("\n").map((l) => JSON.parse(l));

/* Nạp mọi lớp phủ audit-*.json trong bench/data/ — hiện có audit-ambiguous.json,
   có thể thêm audit-<khác>.json sau này mà không phải sửa script. */
const audit = {};
for (const f of ["audit-ambiguous.json"]) {
  const p = join(process.cwd(), "bench", "data", f);
  if (!existsSync(p)) continue;
  const ds = JSON.parse(readFileSync(p, "utf8"));
  for (const d of ds) audit[d.id] = d.moi;
}

const RAW_TO_DASH = { answer_directly: "answer", ask_clarification: "clarify", abstain: "abstain" };
/* Nhãn hiệu chỉnh "transaction" (yêu cầu hành động) không có trong hệ ba giá
   trị {answer,clarify,abstain} mà dashboard hiểu — map về "abstain" vì hành
   vi ĐÚNG cho một yêu cầu hành động cũng là "đừng tự ứng tác, chuyển người",
   đúng ngữ nghĩa "abstain" của trang này (acceptable() coi escalate là đạt
   khi expected=abstain). Nhãn "transaction" gốc vẫn còn nguyên trong
   audit-ambiguous.json cho ai cần phân biệt tinh hơn. */
const CORRECTED_TO_DASH = { ...RAW_TO_DASH, transaction: "abstain" };

const rows = lines.map((r) => {
  const corrected = r.expected_behavior_corrected ?? audit[r.test_id] ?? r.expected_behavior;
  const expected = CORRECTED_TO_DASH[corrected] ?? RAW_TO_DASH[r.expected_behavior] ?? "answer";

  const observed = r.escalate ? "escalate" : r.behaviour === "answer_directly" ? "answer" : r.behaviour;

  const behaviourOk =
    typeof r.behaviour_ok === "boolean"
      ? r.behaviour_ok
      : // phòng khi behaviour_ok thiếu ở dòng nào đó — tính lại bằng đúng luật run461.ts hiện hành
        expected === observed ||
        (expected === "abstain" && observed === "escalate") ||
        (expected === "answer" && observed === "escalate" && (r.actual_answer || "").trim().length > 60);

  return {
    id: r.test_id,
    category: r.category || r.subcategory || "?",
    question: r.question,
    expected,
    observed,
    behaviourOk,
    reply: r.actual_answer ?? "",
    /* is_numeric>0 nghĩa là câu có kỳ vọng số cụ thể; numeric_ok là kết quả đối
       chiếu tất định run461.ts đã làm — không đo lại ở đây. */
    anchorsExpected: r.is_numeric ? 1 : 0,
    anchorsFound: r.numeric_ok ? 1 : 0,
    anchorsOk: r.numeric_ok === true,
    /* run461.ts không ghi passage đầy đủ theo hạng cho mọi dòng (mảng `passages`
       rỗng ở nhiều câu) — không đủ căn cứ suy ra contextRecall/contextRank.
       Để null: /api/bench/rag đã xử lý đúng trường hợp này (chỉ tính % truy
       xuất trên các dòng "grounded", tức contextRecall !== null). */
    contextRecall: null,
    contextRank: null,
    ms: r.ms ?? 0,
    handling: undefined, // chưa chạy giám khảo LLM cho lượt này
    source: undefined,
    _corrected_label: corrected, // vết tích để soát lại, /api/bench/rag bỏ qua trường lạ
  };
});

const out = {
  ranAt: new Date().toISOString(),
  agentModel: "qwen3.5:4b",
  judgeModel: null, // chạy tất định, không gọi giám khảo LLM lần này
  rows,
};

const dest = join(process.cwd(), "bench", "rag-eval-report.json");
writeFileSync(dest, JSON.stringify(out, null, 1) + "\n");

const n = rows.length;
const ok = rows.filter((r) => r.behaviourOk).length;
console.log(`  đã ghi ${dest}`);
console.log(`  ${n} ca · hành vi đạt ${ok}/${n} = ${Math.round((ok * 100) / n)}%`);

const byCat = {};
for (const r of rows) {
  const c = (byCat[r.category] ??= { n: 0, ok: 0 });
  c.n++;
  if (r.behaviourOk) c.ok++;
}
console.log("\n  theo hạng mục:");
for (const [c, v] of Object.entries(byCat).sort((a, b) => b[1].n - a[1].n)) {
  console.log(`    ${String(v.ok).padStart(3)}/${String(v.n).padEnd(4)} = ${String(Math.round((v.ok * 100) / v.n)).padStart(3)}%  ${c}`);
}
