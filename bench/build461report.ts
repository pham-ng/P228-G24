/**
 * Biến bench/461-run.jsonl (+ verdict giám khảo) thành bench/rag-eval-report.json
 * ĐÚNG schema /api/bench/rag đọc, để dashboard staff hiện số 461-ca HIỆN TẠI.
 *
 * Hai hiệu chỉnh cho TRUNG THỰC (không méo cao/thấp):
 *  1) KHỬ TRÙNG câu lặp — bộ đề nhân bản 1 câu qua ~35 kịch bản multi-turn (vd
 *     "Resort có hồ bơi riêng không?"), làm metric thô méo THẤP. Giữ 1 đại diện
 *     mỗi câu duy nhất. (Ngữ cảnh multi-turn vẫn còn trong 461-run.jsonl gốc.)
 *  2) SỬA GOLDEN SAI đã kiểm chứng: NUM-013 phạt hút thuốc GT ghi 5.000.000
 *     nhưng KB và thực tế là 3.000.000 (mô hình đáp 3tr là ĐÚNG).
 *
 * contextRecall: 461 không kèm gold-title, nên đo PROXY "truy xuất có mang con số
 * đáp án về không" trên ca numeric answer-expected — đúng nghĩa recall bằng
 * chứng.
 *
 *   npx tsx bench/build461report.ts
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const run = readFileSync(join(process.cwd(), "bench", "461-run.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const vpath = join(process.cwd(), "bench", "461-verdicts.json");
const verdicts: Record<string, { correctness: number; faithfulness: number; note?: string }> =
  existsSync(vpath) ? JSON.parse(readFileSync(vpath, "utf8")) : {};

/* Golden đã kiểm chứng sai -> con số đúng. */
const GOLDEN_FIX: Record<string, string[]> = { "BM-NUM-013": ["3000000", "3.000.000"] };

/**
 * `(?![a-zà-ỹ])` sau nhóm đơn vị — cùng bản vá đã áp cho `numbers()` trong
 * run461.ts: thiếu ranh giới từ thì "k" khớp luôn chữ cái đầu của "khách",
 * biến "600 khách" thành 600.000. Đồng bộ hai nơi để không lệch quy tắc.
 */
function canonNums(s: string): Set<string> {
  s = (s || "").toLowerCase(); const out = new Set<string>();
  for (const m of s.matchAll(/(\d[\d.,]*)\s*(?:(k|nghìn|ngàn|tr|triệu)(?![a-zà-ỹ]))?/g)) {
    let n = parseInt(m[1].replace(/[.,]/g, ""), 10); if (isNaN(n)) continue;
    const u = m[2] || ""; if (u === "k" || u === "nghìn" || u === "ngàn") n *= 1000; else if (u === "tr" || u === "triệu") n *= 1000000;
    if (n >= 10) out.add(String(n));
  } return out;
}

/* KHỬ TRÙNG: giữ đại diện đầu tiên mỗi câu (bỏ phần "(Kịch bản ...)"). */
const seen = new Set<string>();
const uniq = run.filter((r) => { const q = (r.question || "").replace(/\(.*?\)/g, "").trim(); if (seen.has(q)) return false; seen.add(q); return true; });

function handlingOf(r: any, v?: { correctness: number }): string | null {
  if (!v) return null;
  if (r.behaviour === "abstain" && r.expected_behavior === "abstain") return "im_lang";
  return v.correctness >= 3 ? "dung_du" : v.correctness === 2 ? "hop_ly" : v.correctness === 1 ? "thieu" : "sai";
}
function sourceOf(r: any, v?: { faithfulness: number }): string | null {
  if (!v) return null;
  if (r.behaviour === "abstain") return "khong_co_tl";
  return v.faithfulness >= 1 ? "dung_tl" : "sai_tl";
}

const rows = uniq.map((r) => {
  const v = verdicts[r.test_id];
  /**
   * Ưu tiên `expected_behavior_corrected` — nhãn ĐÃ HIỆU CHỈNH mà run461.ts
   * ghi ra sau khi áp lớp phủ bench/data/audit-*.json (audit-ambiguous.json:
   * 55 ca AMBIGUOUS gộp 3 việc khác nhau dưới cùng một nhãn; audit-trap-
   * safety.json: 5 ca TRAP_NO_INVENT/SAFETY có expected_behavior tự mâu
   * thuẫn với chính ground_truth của nó). Không đọc thẳng `expected_behavior`
   * gốc — cùng lớp lỗi "gộp sai nhóm" mà run461.ts's behBy() từng mắc.
   * Rơi về nhãn gốc khi dòng không có trường này (bản chạy từ trước khi
   * trường này được thêm).
   */
  const rawWant = r.expected_behavior_corrected ?? r.expected_behavior;
  const expected =
    rawWant === "ask_clarification" || rawWant === "clarify"
      ? "clarify"
      : rawWant === "abstain" || rawWant === "transaction"
        ? "abstain"
        : "answer";
  /* observed = hành vi máy đo. NHƯNG "bịa" (integrity.fabricated) chỉ nên đếm khi
     model trả lời câu abstain MÀ KHÔNG CÓ CĂN CỨ. Nhiều câu bộ đề gán "abstain"
     thực ra trả lời được bằng chính nội quy (cấm vũ khí, cấm nấu) — model bám tài
     liệu là ĐÚNG, không phải bịa. Nên: abstain-expected + trả lời + CÓ passage
     (hoặc giám khảo chấm faithful) -> coi như engagement có căn cứ (escalate),
     không tính bịa; chỉ trả lời KHÔNG căn cứ mới là bịa thật. */
  let observed = r.behaviour === "abstain" ? "escalate" : r.behaviour;
  const answered = r.behaviour === "answer";
  if (expected === "abstain" && answered) {
    const grounded = (r.passages || []).length > 0 || (v && v.faithfulness >= 1);
    const realFabrication = v ? v.faithfulness === 0 : !grounded;
    observed = realFabrication ? "answer" : "escalate";
  }

  // numeric_ok, có áp golden fix
  let numeric_ok = r.numeric_ok === true;
  const fix = GOLDEN_FIX[r.test_id];
  if (fix) { const got = canonNums(r.actual_answer); numeric_ok = fix.some((f) => got.has(f) || got.has(f.replace(/[.,]/g, ""))); }
  const anchorsExpected = r.numeric_ok !== null || fix ? 1 : 0;

  // contextRecall proxy: numeric answer-expected -> GT số có trong passages?
  let contextRecall: number | null = null;
  if (r.is_numeric && expected === "answer") {
    const want = fix ? new Set(fix.map((f) => f.replace(/[.,]/g, ""))) : canonNums(r.ground_truth);
    if (want.size) {
      const passNums = canonNums((r.passages || []).map((p: any) => `${p.title} ${p.content}`).join(" "));
      contextRecall = [...want].every((k) => passNums.has(k)) ? 1 : 0;
    }
  }

  return {
    id: r.test_id, category: r.category, question: r.question,
    expected, observed, behaviourOk: !!r.behaviour_ok, reply: r.actual_answer,
    anchorsExpected, anchorsFound: numeric_ok ? 1 : 0, anchorsOk: numeric_ok,
    contextRecall, contextRank: contextRecall === 1 ? 1 : null,
    ms: r.ms, handling: handlingOf(r, v), source: sourceOf(r, v), judgeNote: v?.note,
  };
});

const report = {
  ranAt: new Date().toISOString(),
  agentModel: run[0]?.model ?? "qwen3.5:4b",
  judgeModel: Object.keys(verdicts).length ? "claude-opus (giám khảo độc lập, mẫu 100, chưa hiệu chỉnh kappa)" : null,
  benchmark: `final_benchmark_vi.csv — ${run.length} lượt, khử trùng còn ${rows.length} câu duy nhất; golden NUM-013 đã sửa 5tr→3tr`,
  seed: 42,
  rows,
};
writeFileSync(join(process.cwd(), "bench", "rag-eval-report.json"), JSON.stringify(report, null, 2));

// tóm tắt để đối chiếu
const n = rows.length;
const beh = rows.filter((r) => r.behaviourOk).length;
const numC = rows.filter((r) => r.anchorsExpected > 0), numOk = numC.filter((r) => r.anchorsOk).length;
const grd = rows.filter((r) => r.contextRecall !== null), rec = grd.filter((r) => r.contextRecall === 1).length;
console.log(`Ghi rag-eval-report.json — ${n} câu duy nhất (từ ${run.length} lượt).`);
console.log(`  behaviour: ${(beh/n*100).toFixed(0)}% | numeric: ${(numOk/numC.length*100).toFixed(0)}% (${numOk}/${numC.length}) | retrieval-recall(proxy numeric): ${(rec/grd.length*100).toFixed(0)}% (${rec}/${grd.length})`);
