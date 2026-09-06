/**
 * Dò đường truy xuất cho một câu hỏi: BM25+embedding lấy gì, reranker xếp lại ra sao.
 *
 *   DB_FILE=data.db npx tsx bench/do-truy-xuat.ts "câu hỏi"
 *
 * Dùng để trả lời "vì sao model bỏ cuộc" — nhìn thấy đoạn văn nó thực sự đọc,
 * thay vì đoán từ câu trả lời cuối.
 */
import { hybridSearch } from "../server/retrieval";
import { rerankBackend, rerankDepth, rerankEnabled } from "../server/rerank";

const CAU = process.argv.slice(2);
if (!CAU.length) {
  console.error('Dùng: npx tsx bench/do-truy-xuat.ts "câu hỏi"');
  process.exit(1);
}

const goi = (s: string, n: number) => s.replace(/\s+/g, " ").slice(0, n);

async function main() {
  console.log(
    `cấu hình: rerank=${rerankEnabled()} backend=${rerankBackend()} depth=${rerankDepth()}\n`,
  );
  for (const q of CAU) {
    console.log("=".repeat(74));
    console.log("HỎI:", q);

    const khong = await hybridSearch(q, { k: 6, useRerank: false });
    console.log(`\n  [KHÔNG rerank] chiến lược: ${khong.strategy}`);
    khong.results.forEach((r: any, i) =>
      console.log(
        `    ${i + 1}. [${(r.score ?? 0).toFixed(3)}] ${goi(r.title ?? r.chunk?.title ?? "?", 46)}`,
      ),
    );

    const co = await hybridSearch(q, { k: 6, useRerank: true });
    console.log(`\n  [CÓ rerank] chiến lược: ${co.strategy}`);
    co.results.forEach((r: any, i) =>
      console.log(
        `    ${i + 1}. [${(r.score ?? 0).toFixed(3)}] ${goi(r.title ?? r.chunk?.title ?? "?", 46)}`,
      ),
    );

    /* Đoạn số 1 là thứ model đọc trước tiên — in ra để thấy nó CÓ chứa câu
       trả lời hay không, thay vì suy từ tiêu đề. */
    const dau: any = co.results[0];
    if (dau) console.log(`\n  nội dung đoạn #1: ${goi(dau.body ?? dau.chunk?.body ?? "", 320)}`);
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
