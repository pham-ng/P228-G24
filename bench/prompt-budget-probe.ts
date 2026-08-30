/**
 * Where does a local turn's time ACTUALLY go?
 *
 *   npx tsx bench/prompt-budget-probe.ts
 *
 * "Cut the prompt" has been the standing recommendation for latency, and it is
 * worth nothing until someone checks the premise. Ollama reports its own stage
 * timings on every /api/chat call, so this asks the real question:
 *
 *   prompt_eval  time spent READING the prompt. Shrinking the prompt shrinks
 *                this, and only this.
 *   eval         time spent WRITING the answer. Unaffected by prompt length;
 *                driven by how many tokens the reply has and how fast the
 *                model decodes.
 *
 * If eval dominates, cutting the prompt buys almost nothing and the accuracy
 * risk of cutting it is not worth taking. If prompt_eval dominates, the cut is
 * worth designing — and then only the parts that carry no instruction.
 *
 * The prompt is also broken down by section so the discussion is about specific
 * text, not about a single number. Sections that are already conditional (the
 * rate rules) are reported as present or absent per question, because a figure
 * averaged over both cases describes no real turn.
 */
import "dotenv/config";
import { buildAnswerPrompt } from "../server/local-agent";
import type { Retrieved } from "../server/retrieval";
import { chat } from "../server/llm";

/* Passages standing in for retrieval, so the probe measures the prompt shape
   rather than the retriever's mood. Lengths match what retrieval really
   returns on this corpus (five passages, a few hundred characters each). */
const PASSAGE = (n: number): Retrieved => ({
  title: `Nhà hàng Lotus — thông tin ${n}`,
  category: "dining",
  source_url: null,
  content:
    "Nhà hàng Lotus phục vụ buffet sáng từ 06:00 đến 10:30 hằng ngày tại tầng trệt. " +
    "Giá buffet người lớn 650.000 VNĐ, trẻ em từ 6 đến 11 tuổi 375.000 VNĐ, trẻ dưới 6 tuổi miễn phí. " +
    "Khách lưu trú theo gói có kèm ăn sáng không phải thanh toán thêm.",
  relevance: 0.9,
  matched_by: "probe",
  coverage: 0.8,
} as Retrieved);

const QUESTIONS: Array<{ label: string; q: string; withRates: boolean }> = [
  { label: "câu ngắn thường gặp", q: "Bữa sáng phục vụ đến mấy giờ ạ?", withRates: false },
  { label: "câu hỏi giá", q: "Phòng Deluxe hướng biển giá bao nhiêu một đêm ạ?", withRates: true },
  { label: "câu nhiều vế", q: "Hồ bơi mở mấy giờ, có phòng gym không, và spa đóng cửa lúc nào ạ?", withRates: false },
];

const approxTokens = (s: string) => Math.round(s.length / 3.3);

console.log("PROMPT COMPOSITION (ký tự / ~token)\n");

for (const { label, q, withRates } of QUESTIONS) {
  const passages = Array.from({ length: 5 }, (_, i) => PASSAGE(i + 1));
  const basics = withRates ? { checkIn: "14:00", checkOut: "12:00", currency: "VND" } : undefined;

  const { system, user } = buildAnswerPrompt(q, passages, "vi", basics, "", "");
  const parts = [
    ["system (hướng dẫn)", system],
    ["user (tài liệu + câu hỏi)", user],
  ] as const;

  console.log(`— ${label}${withRates ? "  [có khối giá]" : ""}`);
  let total = 0;
  for (const [name, text] of parts) {
    console.log(`    ${name.padEnd(22)} ${String(text.length).padStart(5)} ký tự  ~${String(approxTokens(text)).padStart(4)} tok`);
    total += approxTokens(text);
  }
  console.log(`    ${"TỔNG".padEnd(22)} ${String(system.length + user.length).padStart(5)} ký tự  ~${String(approxTokens(system + user)).padStart(4)} tok\n`);
}

/* ------------------------------------------------------- the real timing */

console.log("STAGE TIMING, đo trên model đang chạy\n");
console.log("  câu hỏi                | prompt tok | đọc prompt | sinh chữ | sinh tok | tốc độ sinh");
console.log("  " + "-".repeat(88));

for (const { label, q, withRates } of QUESTIONS) {
  const passages = Array.from({ length: 5 }, (_, i) => PASSAGE(i + 1));
  const basics = withRates ? { checkIn: "14:00", checkOut: "12:00", currency: "VND" } : undefined;
  const { system, user } = buildAnswerPrompt(q, passages, "vi", basics, "", "");

  const res = await chat({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0,
  });
  const t = res.timing;
  if (!t) {
    console.log(`  ${label.padEnd(22)} | transport reported no timing`);
    continue;
  }
  const tps = t.evalMs > 0 ? (t.evalTokens / (t.evalMs / 1000)).toFixed(1) : "—";
  console.log(
    `  ${label.padEnd(22)} | ${String(t.promptEvalTokens).padStart(10)} | ${String(t.promptEvalMs + "ms").padStart(10)} | ` +
      `${String(t.evalMs + "ms").padStart(8)} | ${String(t.evalTokens).padStart(8)} | ${tps} tok/s`,
  );
}

console.log(
  "\n  Đọc bảng: cắt prompt chỉ rút ngắn cột 'đọc prompt'. Cột 'sinh chữ' không đổi.\n",
);
process.exit(0);
