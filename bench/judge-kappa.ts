/**
 * Does the LLM judge agree with a human?
 *
 *   npx tsx bench/judge-kappa.ts [labels.json]
 *
 * The judge produces a number. This asks whether that number means anything,
 * and it is the step most teams skip — a judge nobody calibrated is an opinion
 * with a decimal point.
 *
 * HOW TO USE IT — người chấm TRƯỚC, máy chấm SAU. Thứ tự này quan trọng.
 *   1. `npx tsx bench/make-label-sheet.ts` → mở `bench/data/label-sheet.html`,
 *      bấm hết, Xuất JSON vào `bench/data/human-labels.json`. Bảng đó KHÔNG
 *      hiện điểm máy: thấy được nó thì tới ca thứ ba mươi người ta đã chấm
 *      theo máy, và κ đo được là đo sự đồng hoá chứ không phải đồng thuận.
 *   2. `npx tsx bench/rag-eval.ts --judge` — giám khảo máy chấm trên CÙNG bộ
 *      luật, vì cả hai phía đều sinh ra từ `bench/rubric.ts`.
 *        { "VI-F-01": { "handling": "dung_du", "source": "dung_tl" }, ... }
 *   3. Chạy file này.
 *
 * Bản chấm đầu (2026-08-29) cho κ = 0,36 / 0,15 và lý do KHÔNG phải giám khảo
 * dở: rubric của máy có dòng "từ chối đúng = correctness 3", nút của người thì
 * ghi "3 · đúng & đủ". Hai bộ luật khác nhau. Xem `bench/rubric.ts`.
 *
 * COHEN'S KAPPA, not raw agreement. If 80% of answers are correct, a judge that
 * says "correct" every single time agrees with a human 80% of the time while
 * knowing nothing. Kappa subtracts the agreement you would get by chance:
 *
 *     κ = (observed − expected) / (1 − expected)
 *
 * Reading it, by the convention the literature uses:
 *     < 0.20  none        — the judge is noise, do not report its numbers
 *     0.21-0.40  fair     — usable for spotting big regressions only
 *     0.41-0.60  moderate — usable for tracking, not for a customer claim
 *     0.61-0.80  substantial — the usual bar for shipping a judge
 *     > 0.80  almost perfect
 *
 * Re-check monthly. A rubric drifts as the product changes; a kappa measured
 * once is a kappa about a system that no longer exists.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

type Label = { handling?: string; source?: string };

const labelPath = process.argv[2] ?? join(process.cwd(), "bench", "data", "human-labels.json");
const reportPath = join(process.cwd(), "bench", "rag-eval-report.json");

if (!existsSync(reportPath)) {
  console.error("Chưa có bench/rag-eval-report.json — chạy `npx tsx bench/rag-eval.ts --judge` trước.");
  process.exit(2);
}
if (!existsSync(labelPath)) {
  console.error(
    `Chưa có ${labelPath}.\n\n` +
      `Tạo file JSON dạng:\n` +
      `  {\n    "VI-F-01": { "handling": "dung_du", "source": "dung_tl" },\n    "VI-U-03": { "handling": "hop_ly", "source": "khong_co_tl" }\n  }\n\n` +
      `Chấm bằng mắt TRƯỚC, không nhìn điểm của giám khảo — nhìn rồi thì kappa vô nghĩa.`,
  );
  process.exit(2);
}

const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
  judgeModel: string | null;
  rows: { id: string; handling?: string | null; source?: string | null }[];
};
const human = JSON.parse(readFileSync(labelPath, "utf8")) as Record<string, Label>;

/**
 * Cohen's kappa trên thang DANH MỤC.
 *
 * Bản trước dùng thang số 0–3 rồi coi như danh mục, nên kappa không trọng số
 * phạt "người 3 / máy 2" y hệt "người 3 / máy 0". Với một thang thứ bậc thì đó
 * là khắt khe quá mức: 25 ca lệch đúng MỘT bậc đã đủ dìm κ xuống 0,36.
 *
 * Thang mới trong `bench/rubric.ts` là danh mục thật — "thieu" không nằm giữa
 * "dung_du" và "sai", nó là một chuyện khác hẳn. Nên ở đây kappa không trọng số
 * là phép đo ĐÚNG, không còn là phép đo khắt khe: không có thứ bậc nào để mà
 * cho điểm bán phần.
 */
function kappa(pairs: [string, string][]): { k: number; observed: number; expected: number; n: number } {
  const n = pairs.length;
  if (!n) return { k: NaN, observed: 0, expected: 0, n: 0 };
  const agree = pairs.filter(([a, b]) => a === b).length / n;
  const cats = [...new Set(pairs.flatMap(([a, b]) => [a, b]))];
  let expected = 0;
  for (const c of cats) {
    const pa = pairs.filter(([a]) => a === c).length / n;
    const pb = pairs.filter(([, b]) => b === c).length / n;
    expected += pa * pb;
  }
  return { k: expected === 1 ? 1 : (agree - expected) / (1 - expected), observed: agree, expected, n };
}

const verdict = (k: number) =>
  k < 0.2 ? "KHÔNG dùng được — giám khảo chỉ là nhiễu"
  : k < 0.41 ? "yếu — chỉ đủ để phát hiện sụt lớn"
  : k < 0.61 ? "trung bình — theo dõi được, chưa đủ để công bố với khách"
  : k < 0.81 ? "khá — đủ chuẩn để dùng làm thước đo"
  : "rất cao";

console.log(`giám khảo: ${report.judgeModel ?? "(chưa chấm)"}`);

/**
 * Kết quả được GHI RA FILE, không chỉ in ra màn hình.
 *
 * `/api/bench/rag` từng bật điểm giám khảo bằng `existsSync(human-labels.json)`
 * — tức là "đã có ai đó chấm tay", chứ không phải "và họ đồng ý với máy". Chú
 * thích ngay cạnh đó ghi là đã kiểm ngưỡng 0,61; code thì không. Chấm xong mà
 * κ = 0,45 thì bảng vẫn công bố số. Giờ nó đọc chính file này.
 */
const results: Record<string, { k: number; n: number }> = {};

for (const field of ["handling", "source"] as const) {
  const pairs: [string, string][] = [];
  const disagreements: string[] = [];
  for (const row of report.rows) {
    const h = human[row.id]?.[field];
    const m = row[field];
    if (typeof h !== "string" || typeof m !== "string") continue;
    pairs.push([h, m]);
    if (h !== m) disagreements.push(`${row.id}: người ${h} / máy ${m}`);
  }
  const r = kappa(pairs);
  console.log(`\n=== ${field} ===`);
  if (!r.n) {
    console.log("  chưa có cặp nhãn nào trùng id — kiểm tra lại file nhãn");
    continue;
  }
  console.log(`  n = ${r.n} cặp`);
  console.log(`  trùng nhau thô     ${(r.observed * 100).toFixed(0)}%`);
  console.log(`  trùng do ngẫu nhiên ${(r.expected * 100).toFixed(0)}%`);
  console.log(`  κ = ${r.k.toFixed(2)}  → ${verdict(r.k)}`);
  results[field] = { k: r.k, n: r.n };
  if (r.n < 30) console.log(`  CẢNH BÁO: ${r.n} cặp là quá ít, κ sẽ rất nhiễu. Nhắm tới 50+.`);
  if (disagreements.length) {
    console.log(`  ${disagreements.length} chỗ lệch:`);
    for (const d of disagreements.slice(0, 10)) console.log(`    ${d}`);
  }
}
const BAR = 0.61;
const worst = Math.min(...Object.values(results).map((r) => r.k));
const minN = Math.min(...Object.values(results).map((r) => r.n));
/* Lấy κ THẤP NHẤT trong hai thang, không lấy trung bình: giám khảo chỉ đáng
   tin bằng cái nó chấm tệ nhất. Và `n` dưới 30 thì κ quá nhiễu để tin. */
const passed = Number.isFinite(worst) && worst >= BAR && minN >= 30;
writeFileSync(
  join(process.cwd(), "bench", "data", "kappa-result.json"),
  JSON.stringify({ ranAt: new Date().toISOString(), bar: BAR, passed, fields: results }, null, 2) + "\n",
);
console.log(
  `\nĐã ghi bench/data/kappa-result.json — ${passed ? "ĐẠT" : "CHƯA ĐẠT"} ngưỡng ${BAR}.` +
    (passed ? " Điểm giám khảo giờ hiện trên trang Benchmark." : " Trang Benchmark vẫn giấu điểm giám khảo."),
);
process.exit(0);
