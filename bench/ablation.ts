import "dotenv/config";

/**
 * Phase D ablation: every retrieval upgrade measured against the same golden set.
 *
 * Each configuration is a separate full pass, so the numbers are comparable and
 * nothing is inferred. Latency is wall-clock per query and includes the extra
 * model calls a variant makes — HyDE and reranking are not free, and a variant
 * that wins on accuracy while doubling response time is a different decision
 * from one that wins outright.
 *
 *   DB_FILE=data.db npx tsx bench/ablation.ts [--out bench/ablation-report.json]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { corpusDocs, retrievalRanking } from "../server/retrieval";
import { relevantKeys, scoreQuery, aggregate, percentile, DEFAULT_KS, type QueryMetrics, type RelevancePredicate } from "../server/ireval";

type Case = { id: string; lang: string; query: string; relevant: RelevancePredicate[] };
type Variant = {
  name: string;
  vecWeight: number;
  useHyde: boolean;
  useRerank: boolean;
  /** Which ranking to score: lexical-only variants read `lexical`. */
  leg: "lexical" | "hybrid";
};

const VARIANTS: Variant[] = [
  { name: "Baseline (BM25)", vecWeight: 0, useHyde: false, useRerank: false, leg: "lexical" },
  { name: "Baseline + HyDE", vecWeight: 0, useHyde: true, useRerank: false, leg: "lexical" },
  { name: "Hybrid", vecWeight: 0.5, useHyde: false, useRerank: false, leg: "hybrid" },
  { name: "Hybrid + HyDE", vecWeight: 0.5, useHyde: true, useRerank: false, leg: "hybrid" },
  { name: "Hybrid + Rerank", vecWeight: 0.5, useHyde: false, useRerank: true, leg: "hybrid" },
  { name: "Hybrid + HyDE + Rerank", vecWeight: 0.5, useHyde: true, useRerank: true, leg: "hybrid" },
];

async function main() {
  const docs = corpusDocs();
  if (!docs.length) {
    console.error("Retrieval index is empty — reindex first.");
    process.exit(2);
  }
  const golden = JSON.parse(readFileSync(join(process.cwd(), "bench/retrieval-golden.json"), "utf8")) as {
    cases: Case[];
  };
  const relevant = new Map(golden.cases.map((c) => [c.id, relevantKeys(docs, c.relevant)]));

  const rows: any[] = [];
  for (const v of VARIANTS) {
    const per: QueryMetrics[] = [];
    const lat: number[] = [];
    const misses: string[] = [];
    for (const c of golden.cases) {
      const t0 = Date.now();
      const r = await retrievalRanking(c.query, {
        vecWeight: v.vecWeight,
        useHyde: v.useHyde,
        useRerank: v.useRerank,
      });
      lat.push(Date.now() - t0);
      const ranked = (v.leg === "lexical" ? r.lexical : r.hybrid).map((d) => d.docKey);
      const m = scoreQuery(ranked, relevant.get(c.id)!, DEFAULT_KS);
      per.push(m);
      if (!m.hit[5]) misses.push(c.id);
    }
    const agg = aggregate(per, DEFAULT_KS);
    rows.push({
      variant: v.name,
      hit1: agg.hit[1],
      hit3: agg.hit[3],
      hit5: agg.hit[5],
      mrr: agg.mrr,
      ndcg5: agg.ndcg[5],
      latencyP50: percentile(lat, 50),
      latencyP95: percentile(lat, 95),
      misses,
    });
    console.log(
      `${v.name.padEnd(24)} hit@1 ${(agg.hit[1] * 100).toFixed(1)}%  hit@3 ${(agg.hit[3] * 100).toFixed(1)}%  ` +
        `hit@5 ${(agg.hit[5] * 100).toFixed(1)}%  MRR ${agg.mrr.toFixed(3)}  ` +
        `p50 ${percentile(lat, 50)}ms  p95 ${percentile(lat, 95)}ms` +
        (misses.length ? `  misses: ${misses.join(",")}` : ""),
    );
  }

  /* The recommendation is stated by the harness, not left to whoever reads it:
     accuracy first, and among ties the cheaper variant, because latency is paid
     by every guest on every question. */
  const best = [...rows].sort(
    (a, b) => b.hit5 - a.hit5 || b.mrr - a.mrr || b.hit1 - a.hit1 || a.latencyP50 - b.latencyP50,
  )[0];
  const baseline = rows[0];
  console.log(
    `\nWinner: ${best.variant} — hit@5 ${(best.hit5 * 100).toFixed(1)}% / MRR ${best.mrr.toFixed(3)} ` +
      `vs baseline ${(baseline.hit5 * 100).toFixed(1)}% / ${baseline.mrr.toFixed(3)}, ` +
      `at ${best.latencyP50}ms p50 (baseline ${baseline.latencyP50}ms).`,
  );

  const oi = process.argv.indexOf("--out");
  if (oi >= 0) {
    writeFileSync(process.argv[oi + 1], JSON.stringify({ ranAt: new Date().toISOString(), rows, winner: best.variant }, null, 2));
    console.log(`written to ${process.argv[oi + 1]}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
