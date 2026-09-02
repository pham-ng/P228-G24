/**
 * Vì sao 2 doc phí (GUEST_LIST đổi tên, BOOKING_CLASS hoàn cọc) không tới model.
 * Chạy hybridSearch thật trên prod: first-stage (không rerank) vs có rerank, xem
 * doc đích xếp hạng đâu, điểm gì, và gate quyết định thế nào.
 *
 *   DB_FILE=data.db npx tsx bench/diag-retrieval.ts
 */
import "dotenv/config";
import { hybridSearch } from "../server/retrieval";
import { gateRetrieval, LOCAL_PASSAGES } from "../server/local-agent";

const QUERIES = [
  { q: "Đổi tên khách sau hạn chót bị phạt bao nhiêu tiền?", target: /guest_list|đổi tên|name change|transfer/i },
  { q: "Thời gian hoàn tiền đặt cọc tối đa là bao nhiêu ngày làm việc?", target: /booking_class|refund window|đặt cọc|deposit/i },
];

function row(r: any, i: number) {
  const t = (r.title || "").slice(0, 46).padEnd(46);
  const by = Array.isArray(r.matched_by) ? r.matched_by.join("+") : String(r.matched_by ?? "?");
  return `  #${String(i + 1).padStart(2)} rel=${(r.relevance ?? 0).toFixed(4)} cov=${(r.coverage ?? -1).toFixed(2)} q=${(r.quality || "?").slice(0, 5).padEnd(5)} by=${by.slice(0, 18).padEnd(18)} | ${t}`;
}

async function main() {
  for (const { q, target } of QUERIES) {
    console.log("\n" + "═".repeat(80) + "\nQ:", q);
    // first-stage (không rerank), lấy sâu
    const first = await hybridSearch(q, { k: 40, useRerank: false } as any);
    const fr = first.results;
    const fTargetIdx = fr.findIndex((r: any) => target.test(`${r.title} ${r.content}`));
    console.log(`\n-- FIRST-STAGE (BM25+vector RRF), ${fr.length} ứng viên, doc đích ở hạng: ${fTargetIdx < 0 ? "KHÔNG có trong 40" : fTargetIdx + 1} --`);
    fr.slice(0, 8).forEach((r: any, i: number) => console.log(row(r, i)));
    if (fTargetIdx >= 8) console.log("  ...", "\n" + row(fr[fTargetIdx], fTargetIdx), " <== DOC ĐÍCH");

    // có rerank, top LOCAL_PASSAGES (đường production)
    const prod = await hybridSearch(q, { k: LOCAL_PASSAGES } as any);
    const pr = prod.results;
    const pTargetIdx = pr.findIndex((r: any) => target.test(`${r.title} ${r.content}`));
    console.log(`\n-- CÓ RERANK, top ${LOCAL_PASSAGES} (production), doc đích ở hạng: ${pTargetIdx < 0 ? "KHÔNG lọt top-" + LOCAL_PASSAGES : pTargetIdx + 1} --`);
    pr.forEach((r: any, i: number) => console.log(row(r, i)));

    const gate = gateRetrieval(pr);
    console.log(`\n-- GATE: ok=${gate.ok} reason=${(gate as any).reason || "-"} topScore=${gate.topScore?.toFixed(4)} passages_qua=${gate.passages.length} --`);
  }
}
main();
