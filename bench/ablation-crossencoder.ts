import "dotenv/config";

/**
 * Extends the Phase D ablation with the ONE variant it could not measure
 * before: a real cross-encoder (BAAI/bge-reranker-v2-m3), scored via Hugging
 * Face's Inference API, compared against the same golden set and the same
 * scoring code as `bench/ablation.ts`.
 *
 * Kept as a separate script rather than added to ablation.ts's VARIANTS list
 * because it depends on a third-party network call (HF_API_KEY) that the
 * other variants do not — a missing key should not break the local-only
 * ablation, and a slow/rate-limited HF response should not slow it down either.
 *
 * This does NOT modify server/retrieval.ts. It reads the same hybrid ranking
 * `retrievalRanking` already produces (useRerank: false) and reranks the head
 * of that list itself, exactly mirroring the LLM-rerank code path in
 * retrieval.ts so the two are comparable apples-to-apples.
 *
 *   HF_API_KEY=... DB_FILE=data.db npx tsx bench/ablation-crossencoder.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { corpusDocs, retrievalRanking, chunkDocKey } from "../server/retrieval";
import { storage } from "../server/storage";
import { hfCrossEncoderScores, hfRerankConfigured } from "../server/rerank-hf";
import { applyRerank } from "../server/rerank";
import { relevantKeys, scoreQuery, aggregate, percentile, type RelevancePredicate } from "../server/ireval";

type Case = { id: string; lang: string; query: string; relevant: RelevancePredicate[] };

const RERANK_DEPTH = 8;

async function main() {
  if (!hfRerankConfigured()) {
    console.error("HF_API_KEY chưa có trong .env.");
    process.exit(2);
  }

  const docs = corpusDocs();
  const chunks = storage.listChunks();
  const golden = JSON.parse(readFileSync(join(process.cwd(), "bench/retrieval-golden.json"), "utf8")) as {
    cases: Case[];
  };

  const per = [];
  const lat: number[] = [];
  const misses: string[] = [];
  let fellBackToOriginalOrder = 0;

  for (const [i, c] of golden.cases.entries()) {
    process.stderr.write(`\r  ${i + 1}/${golden.cases.length}  ${c.id.padEnd(28)}`);
    const t0 = Date.now();

    // Same hybrid ranking production uses (vecWeight 0.5, no LLM rerank).
    const base = await retrievalRanking(c.query, { vecWeight: 0.5, useRerank: false });
    const head = base.hybrid.slice(0, RERANK_DEPTH);
    const chunkFor = (docKey: string) => chunks.find((ch) => chunkDocKey(ch.kind, ch.refId) === docKey);
    const candidates = head.map((d, idx) => {
      const ch = chunkFor(d.docKey);
      return { id: idx, title: ch?.title ?? d.docKey, text: ch?.body ?? "" };
    });

    const scores = await hfCrossEncoderScores(c.query, candidates);
    let ranked = base.hybrid;
    if (scores) {
      const reordered = applyRerank(
        head.map((_, idx) => ({ id: idx })),
        scores,
      ).map((x) => head[x.id]);
      ranked = [...reordered, ...base.hybrid.slice(RERANK_DEPTH)];
    } else {
      fellBackToOriginalOrder++;
    }

    lat.push(Date.now() - t0);
    const relevant = relevantKeys(docs, c.relevant);
    const rankedKeys = ranked.map((d) => d.docKey);
    const m = scoreQuery(rankedKeys, relevant);
    per.push(m);
    if (!m.hit[5]) misses.push(c.id);
  }
  process.stderr.write("\r" + " ".repeat(60) + "\r");

  const agg = aggregate(per);
  console.log(`\n${"=".repeat(74)}`);
  console.log(`Hybrid + BAAI/bge-reranker-v2-m3 (cross-encoder thật, qua HF Inference API)`);
  console.log("=".repeat(74));
  console.log(`hit@1  ${(agg.hit[1] * 100).toFixed(1)}%`);
  console.log(`hit@3  ${(agg.hit[3] * 100).toFixed(1)}%`);
  console.log(`hit@5  ${(agg.hit[5] * 100).toFixed(1)}%`);
  console.log(`MRR    ${agg.mrr.toFixed(3)}`);
  console.log(`nDCG@5 ${(agg.ndcg[5] * 100).toFixed(1)}%`);
  console.log(`latency p50 ${percentile(lat, 50)}ms · p95 ${percentile(lat, 95)}ms`);
  console.log(`\ncác câu trượt hit@5: ${misses.length ? misses.join(", ") : "(không có)"}`);
  if (fellBackToOriginalOrder) {
    console.log(`\nCẢNH BÁO: ${fellBackToOriginalOrder}/${golden.cases.length} câu bị rớt về thứ tự gốc — HF trả lỗi/quá nửa số lượt gọi thất bại cho câu đó (rate limit hoặc mạng).`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
