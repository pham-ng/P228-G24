/**
 * Biến bench/461-run.jsonl (+ verdict giám khảo tuỳ chọn) thành
 * bench/rag-eval-report.json ĐÚNG schema mà /api/bench/rag đọc, để dashboard
 * staff hiện số 461-ca thật thay cho lần chạy 101-ca cũ.
 *
 * Field HIỆN trên dashboard = deterministic (behaviourOk, anchorsOk=đúng-số, ms,
 * expected/observed=integrity). Field judge (handling/source) chỉ để đó — route
 * vẫn khoá sau kappa (judgeCalibrated), nên chưa validated thì không hiện.
 *
 *   npx tsx bench/build461report.ts
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const run = readFileSync(join(process.cwd(), "bench", "461-run.jsonl"), "utf8")
  .trim().split("\n").map((l) => JSON.parse(l));

const vpath = join(process.cwd(), "bench", "461-verdicts.json");
const verdicts: Record<string, { correctness: number; faithfulness: number; note?: string }> =
  existsSync(vpath) ? JSON.parse(readFileSync(vpath, "utf8")) : {};

/* correctness 0-3 -> hạng handling; faithfulness 0-2 -> hạng source.
   Cùng bảng phân loại với bộ eval 101 để route tổng hợp không đổi. */
function handlingOf(r: any, v?: { correctness: number }): string | null {
  if (!v) return null;
  if (r.behaviour === "abstain" && r.expected_behavior === "abstain") return "im_lang";
  return v.correctness >= 3 ? "dung_du" : v.correctness === 2 ? "hop_ly" : v.correctness === 1 ? "thieu" : "sai";
}
function sourceOf(r: any, v?: { faithfulness: number }): string | null {
  if (!v) return null;
  if (r.behaviour === "abstain") return "khong_co_tl";
  return v.faithfulness >= 2 ? "dung_tl" : v.faithfulness === 1 ? "dung_tl" : "sai_tl";
}

const rows = run.map((r) => {
  const v = verdicts[r.test_id];
  const expected = r.expected_behavior === "ask_clarification" ? "clarify" : r.expected_behavior === "abstain" ? "abstain" : "answer";
  const observed = r.behaviour === "abstain" ? "escalate" : r.behaviour; // abstain = chuyển người trong hệ này
  const anchorsExpected = r.numeric_ok !== null ? 1 : 0;
  return {
    id: r.test_id,
    category: r.category,
    question: r.question,
    expected,
    observed,
    behaviourOk: !!r.behaviour_ok,
    reply: r.actual_answer,
    anchorsExpected,
    anchorsFound: r.numeric_ok ? 1 : 0,
    anchorsOk: r.numeric_ok === true,
    contextRecall: null, // bộ 461 không kèm gold-title khớp được — đo recall riêng
    contextRank: null,
    ms: r.ms,
    handling: handlingOf(r, v),
    source: sourceOf(r, v),
    judgeNote: v?.note,
  };
});

const report = {
  ranAt: new Date().toISOString(),
  agentModel: run[0]?.model ?? process.env.OLLAMA_MODEL ?? "qwen3.5:4b",
  judgeModel: Object.keys(verdicts).length ? "claude-opus (indicative, chưa hiệu chỉnh kappa)" : null,
  benchmark: "final_benchmark_vi.csv (461 ca, Gemini/Antigravity viết)",
  seed: 42,
  rows,
};

writeFileSync(join(process.cwd(), "bench", "rag-eval-report.json"), JSON.stringify(report, null, 2));
console.log(`Đã ghi bench/rag-eval-report.json — ${rows.length} ca, judge: ${Object.keys(verdicts).length} verdict.`);
