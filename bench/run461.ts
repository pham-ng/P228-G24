/**
 * Chạy bộ benchmark 461 ca (final_benchmark_vi.csv, do Gemini/Antigravity viết —
 * khác họ với tác nhân Qwen và với giám khảo Claude, nên độc lập cả hai đầu)
 * qua ĐÚNG đường live tối ưu hiện tại: runLocalTurn -> hybridSearch (đã có
 * reranker bge-v2-m3, cap 1200, ctx 8192). Đa lượt được nối history y như live
 * (recentOfflineHistory: "Khách:/Trợ lý:", 4 lượt gần nhất).
 *
 * Ghi ra:
 *   bench/461-run.jsonl        — đầy đủ, có nội dung passage (để chấm faithfulness)
 *   bench/461-deterministic.json — tổng hợp phần máy tự chấm (không cần giám khảo)
 *   bench/461-judge-input.jsonl  — bản gọn cho giám khảo Claude đọc
 *
 * Phần deterministic (đúng-số, né đúng lúc, truy xuất, độ trễ) KHÔNG cần giám
 * khảo và đủ để làm tươi dashboard. Phần correctness/faithfulness để Claude chấm
 * riêng trên 461-judge-input.jsonl.
 *
 *   DB_FILE=data.db npx tsx bench/run461.ts            # cả 461 ca
 *   DB_FILE=data.db npx tsx bench/run461.ts --limit 5  # smoke test
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { runLocalTurn } from "../server/local-agent";
import { storage } from "../server/storage";
import { screenGuestMessage } from "../server/guard";
import { normalise } from "./lib/speech-metrics";

/**
 * Nhãn kỳ vọng đã hiệu chỉnh, phủ lên bộ dữ liệu gốc.
 *
 * VÌ SAO PHỦ CHỨ KHÔNG SỬA THẲNG. Bộ 461 ca giữ nguyên là bằng chứng gốc; mọi
 * chỉnh sửa nằm ở một tệp riêng, có ghi lý do từng ca, và xoá tệp đó là quay
 * lại đúng phép đo cũ. Sửa thẳng vào dữ liệu thì sáu tháng sau không ai biết
 * con số đã dịch vì model khá lên hay vì thước đo bị nới.
 *
 * ĐO ĐƯỢC trên 55 ca AMBIGUOUS: hạng mục này gộp BA việc khác nhau dưới cùng
 * một kỳ vọng `ask_clarification` — câu thật sự mơ hồ (đại từ không có tiền
 * ngữ), câu có một câu trả lời xác định ("Có internet không?"), và yêu cầu
 * hành động ("Đổi ngày giúp tôi"). Bắt hỏi lại ở hai loại sau là phạt model vì
 * phục vụ đúng. Sau hiệu chỉnh: 18% -> 82%, và 10 ca còn trượt đều cùng MỘT
 * khiếm khuyết thật — model không bao giờ hỏi lại khi gặp "cái đó / gói đó".
 */
const SUA_NHAN: Record<string, string> = (() => {
  try {
    const p = join(process.cwd(), "bench", "data", "audit-ambiguous.json");
    const ds = JSON.parse(readFileSync(p, "utf8")) as { id: string; moi: string }[];
    return Object.fromEntries(ds.map((d) => [d.id, d.moi]));
  } catch {
    return {}; /* chưa có tệp hiệu chỉnh — chạy đúng như bộ gốc */
  }
})();

const argv = process.argv.slice(2);
const LIMIT = argv.includes("--limit") ? Number(argv[argv.indexOf("--limit") + 1]) : Infinity;

/* CSV parser nhận biết dấu ngoặc kép (ô chứa dấu phẩy/xuống dòng). */
function parseCSV(t: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else {
      if (c === '"') q = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
      else if (c === "\r") { /* skip */ }
      else cell += c;
    }
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const raw = readFileSync(join(process.cwd(), "final_benchmark_vi.csv"), "utf8");
const rows = parseCSV(raw);
const H = rows[0].map((h) => h.trim());
const col = (n: string) => H.indexOf(n);
const get = (r: string[], n: string) => (r[col(n)] ?? "").trim();
const bool = (r: string[], n: string) => get(r, n).toLowerCase() === "true";

type Case = { r: string[] };
const cases: Case[] = rows.slice(1).filter((r) => r.length >= H.length - 3).map((r) => ({ r }));

/* Nhóm theo hội thoại, giữ thứ tự lượt — để dựng history cho đa lượt. */
const byConv = new Map<string, string[][]>();
for (const { r } of cases) {
  const cid = get(r, "conversation_id");
  if (!byConv.has(cid)) byConv.set(cid, []);
  byConv.get(cid)!.push(r);
}
for (const list of byConv.values()) list.sort((a, b) => (parseInt(get(a, "turn_id")) || 0) - (parseInt(get(b, "turn_id")) || 0));

const basics = (() => {
  const h = storage.getHotel();
  return h ? { checkIn: h.checkInTime, checkOut: h.checkOutTime, currency: h.currency } : undefined;
})();

/* Nối history y hệt live: 4 dòng gần nhất, mỗi body cắt 150 ký tự. */
function buildHistory(prior: { q: string; a: string }[]): string {
  const lines: string[] = [];
  for (const t of prior) {
    lines.push(`Khách: ${t.q.replace(/\s+/g, " ").slice(0, 150)}`);
    lines.push(`Trợ lý: ${t.a.replace(/\s+/g, " ").slice(0, 150)}`);
  }
  return lines.slice(-4).join("\n");
}

/* Phát hiện né/từ chối trả lời (deterministic). */
const ABSTAIN_RE = /không đủ thông tin|chưa có thông tin|không có thông tin|KHONG_DU_THONG_TIN|liên hệ (lễ tân|nhân viên|trực)|chuyển (bạn|quý khách)?.*(lễ tân|nhân viên)|xin lỗi.*(không thể|chưa thể)|vui lòng liên hệ/i;
function detectAbstain(reply: string, escalate: boolean): boolean {
  return escalate || ABSTAIN_RE.test(reply) || reply.trim().length === 0;
}

/**
 * Hỏi lại (clarify) — BA dạng, không phải một.
 *
 * Bản đầu chỉ nhận dạng "từ để hỏi + dấu ?" và bỏ sót hai dạng phổ biến không
 * kém trong tiếng Việt. Đo trên 55 ca AMBIGUOUS đã chạy:
 *
 *   · "A hay B ạ?" — cấu trúc lựa chọn. Câu "anh/chị muốn huỷ đặt phòng HAY
 *     huỷ một dịch vụ ạ?" là một câu hỏi lại hoàn hảo, bị chấm thành `answer`
 *     vì trong câu không có chữ "nào" hay "gì".
 *   · "chúng tôi cần biết mã gói phòng cụ thể" — hỏi lại viết ở thể trần
 *     thuật, không có dấu hỏi. Vẫn là hỏi lại về mặt hành vi.
 */
const CLARIFY_RES = [
  /(nào|gì|ý (anh|chị|bạn)|cụ thể|rõ hơn|loại nào|dịch vụ nào|phòng nào)\b[^?]*\?/i,
  /\bhay\b[^?]{0,80}\?/i,
  /anh\/chị (muốn|đang)[^?]{0,80}\?/i,
  /(cần biết|cho (em|chúng tôi) biết|vui lòng cho biết)/i,
  /đang (muốn )?hỏi (về|giá)/i,
];
function classifyBehaviour(reply: string, escalate: boolean): "answer" | "clarify" | "abstain" {
  /**
   * THỨ TỰ QUAN TRỌNG: xét hỏi lại TRƯỚC khi `escalate` cắt ngang.
   *
   * `detectAbstain` trả về true ngay khi `escalate` bật, nên một lượt vừa hỏi
   * lại vừa chuyển người thì không bao giờ được tính là hỏi lại — dù hỏi lại
   * mới là hành vi đang được đo. Hệ thống hoàn toàn có thể làm cả hai việc.
   */
  if (reply.trim() && CLARIFY_RES.some((re) => re.test(reply))) return "clarify";
  if (detectAbstain(reply, escalate)) return "abstain";
  return "answer";
}

/* Trích token số để chấm đúng-số. Giữ cả bản có và không dấu phân cách nghìn. */
function numbers(s: string): Set<string> {
  const out = new Set<string>();
  const m = s.match(/\d[\d.,:]*\d|\d/g) || [];
  for (const tok of m) {
    out.add(tok);
    out.add(tok.replace(/[.,]/g, "")); // 3.000.000 -> 3000000
  }
  return out;
}

async function main() {
  const t0 = Date.now();
  const outRows: any[] = [];
  const judgeRows: any[] = [];
  let done = 0;
  const answers = new Map<string, string>(); // test_id -> answer, để dựng history

  for (const [cid, list] of byConv) {
    const prior: { q: string; a: string }[] = [];
    for (const r of list) {
      if (done >= LIMIT) break;
      const test_id = get(r, "test_id");
      const question = get(r, "question");
      const ground_truth = get(r, "ground_truth");
      const must_abstain = bool(r, "must_abstain");
      const is_numeric = bool(r, "is_numeric");
      const is_multi = bool(r, "is_multi_turn");
      const answerability = get(r, "answerability");
      const expected_behavior = get(r, "expected_behavior") || get(r, "expected_model_behavior");
      const refCtx = get(r, "reference_contexts");
      const srcDoc = get(r, "source_document");

      const guard = screenGuestMessage(question);
      const isEmergency = !!guard.emergencyKind;
      const history = is_multi && prior.length ? buildHistory(prior) : undefined;

      const ts = Date.now();
      let turn: any;
      try {
        turn = await runLocalTurn({ question, isEmergency, lang: "vi", basics, history });
        if (guard.forceEscalation) turn = { ...turn, escalate: true };
      } catch (e) {
        turn = { reply: null, escalate: true, passages: [], error: String(e) };
      }
      const ms = Date.now() - ts;
      const reply = String(turn.reply ?? "");
      const passages: { title?: string; content?: string }[] = turn.passages ?? [];

      // deterministic
      const behaviour = classifyBehaviour(reply, !!turn.escalate);
      // đích hành vi: map expected_behavior -> {answer,clarify,abstain}
      const goc = expected_behavior === "ask_clarification" ? "clarify" : expected_behavior === "abstain" ? "abstain" : "answer";
      const want = SUA_NHAN[test_id] ?? goc;
      /**
       * Chấp nhận "vừa trả lời vừa chuyển người" cho câu mong `answer`.
       *
       * Đây là hợp đồng Info-First của chính sản phẩm — nêu thông tin đã công
       * bố VÀ giao lượt cho lễ tân — nên đếm nó là trượt là đo sai thiết kế.
       * `bench/rag-eval.ts` đã có đúng luật này; harness ở đây thì thiếu.
       * Bảy ca kiểu "Có internet không?" trả lời đúng và đủ mà vẫn bị tính sai.
       */
      const coNoiDung = reply.trim().length > 60;
      const behaviour_ok =
        behaviour === want ||
        (want === "transaction" && (behaviour === "abstain" || behaviour === "clarify")) ||
        (want === "answer" && behaviour === "abstain" && !!turn.escalate && coNoiDung);
      let numeric_ok: boolean | null = null;
      if (is_numeric && want === "answer") {
        const wantN = numbers(ground_truth);
        const gotN = numbers(reply);
        const key = [...wantN].filter((x) => x.length >= 2); // bỏ số 1 chữ số nhiễu
        numeric_ok = key.length === 0 ? null : key.every((k) => gotN.has(k) || gotN.has(k.replace(/[.,]/g, "")));
      }

      outRows.push({
        test_id, conversation_id: cid, turn_id: get(r, "turn_id"),
        category: get(r, "category"), subcategory: get(r, "subcategory"),
        difficulty: get(r, "difficulty"), source_type: get(r, "source_type"),
        is_numeric, is_adversarial: bool(r, "is_adversarial"), is_multi_turn: is_multi,
        answerability, must_abstain, expected_behavior,
        /* Nhãn ĐÃ hiệu chỉnh — khác `expected_behavior` khi bench/data/audit-*.json
           phủ lên. Lưu riêng để bảng tổng hợp gộp đúng nhóm; xem behBy() dưới. */
        expected_behavior_corrected: want,
        question, ground_truth, reference_contexts: refCtx, source_document: srcDoc,
        actual_answer: reply, escalate: !!turn.escalate, route: turn.route ?? null,
        topScore: turn.topScore ?? null, ms,
        passages,
        behaviour, behaviour_ok, numeric_ok,
      });
      // bản gọn cho giám khảo — nối passage thành text đọc được
      judgeRows.push({
        test_id, question, ground_truth, expected_behavior, must_abstain, is_numeric, answerability,
        actual_answer: reply,
        passages_text: passages.map((p, i) => `[${i + 1}] ${p.title ?? ""}: ${(p.content ?? "").replace(/\s+/g, " ").slice(0, 500)}`).join("\n"),
      });

      answers.set(test_id, reply);
      prior.push({ q: question, a: reply });
      done++;
      if (done % 25 === 0) console.log(`  ${done}/${Math.min(cases.length, LIMIT)}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    }
    if (done >= LIMIT) break;
  }

  // tổng hợp deterministic
  const numCases = outRows.filter((r) => r.numeric_ok !== null);
  const lat = outRows.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (n: number, d: number) => d ? +(n / d * 100).toFixed(1) : 0;
  const q = (p: number) => lat.length ? lat[Math.floor(p * (lat.length - 1))] : 0;
  /**
   * Gộp theo nhãn ĐÃ HIỆU CHỈNH, không phải `expected_behavior` gốc.
   *
   * Bug đã bắt được sau lần chạy đầu: mỗi dòng thì `behaviour_ok` tính đúng
   * theo `want` đã qua audit, nhưng bảng tổng hợp này lọc bằng
   * `expected_behavior` GỐC — nên một ca đã đổi kỳ vọng từ "phải hỏi lại"
   * sang "phải trả lời thẳng" vẫn bị xếp vào nhóm cũ, làm tỉ lệ nhóm đó sai
   * dù từng dòng bên dưới đúng. Gộp theo `expected_behavior_corrected` thì
   * khớp với cách `behaviour_ok` đã tính.
   */
  const behBy = (want: string) => {
    const cs = outRows.filter((r) => r.expected_behavior_corrected === want);
    const ok = cs.filter((r) => r.behaviour_ok).length;
    return `${pct(ok, cs.length)}% (${ok}/${cs.length})`;
  };
  const behOkAll = outRows.filter((r) => r.behaviour_ok).length;
  const det = {
    ranAt: new Date().toISOString(),
    model: process.env.OLLAMA_MODEL ?? "?",
    config: { cap: process.env.LOCAL_PASSAGE_CHAR_CAP ?? "?", ctx: process.env.LOCAL_NUM_CTX ?? "?", rerank: process.env.RERANK_ENABLED ?? "?" },
    n: outRows.length,
    behaviour_accuracy: `${pct(behOkAll, outRows.length)}% (${behOkAll}/${outRows.length})`,
    behaviour_by_type: {
      answer_directly: behBy("answer_directly"),
      ask_clarification: behBy("ask_clarification"),
      abstain: behBy("abstain"),
      transaction: behBy("transaction"),
    },
    numeric_exactness: `${pct(numCases.filter((r) => r.numeric_ok).length, numCases.length)}% (${numCases.filter((r) => r.numeric_ok).length}/${numCases.length})`,
    latency_ms: { p50: q(0.5), p90: q(0.9), p95: q(0.95) },
  };

  writeFileSync(join(process.cwd(), "bench", "461-run.jsonl"), outRows.map((r) => JSON.stringify(r)).join("\n"));
  writeFileSync(join(process.cwd(), "bench", "461-judge-input.jsonl"), judgeRows.map((r) => JSON.stringify(r)).join("\n"));
  writeFileSync(join(process.cwd(), "bench", "461-deterministic.json"), JSON.stringify(det, null, 2));
  console.log("\n=== DETERMINISTIC (không cần giám khảo) ===");
  console.log(JSON.stringify(det, null, 2));
  console.log(`\nĐã ghi bench/461-run.jsonl (${outRows.length}), bench/461-judge-input.jsonl, bench/461-deterministic.json`);
}

main();
