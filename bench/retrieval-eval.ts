import "dotenv/config";

/**
 * Retrieval quality benchmark.
 *
 * Runs the golden set (bench/retrieval-golden.json) through the real rankers and
 * reports hit@k, recall@k, precision@k, nDCG@k and MRR for two legs:
 *   - BM25   the lexical leg alone (always available, no embedding server)
 *   - Hybrid BM25 + embedding vectors fused with RRF (needs the embed endpoint)
 *
 * Comparing the two is the point: it shows what the embedding leg actually buys,
 * and it measures the degraded (lexical-only) path the agent falls back to when
 * the embedding server is down — so both states are known, not assumed.
 *
 *   DB_FILE=data.db npx tsx bench/retrieval-eval.ts
 *   DB_FILE=data.db npx tsx bench/retrieval-eval.ts --out bench/retrieval-report.json
 *
 * Every label is verified against the live corpus before scoring; a label that
 * matches no document aborts the run rather than silently scoring 0, because a
 * rotten golden set teaches the wrong lesson.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { corpusDocs, retrievalRanking } from "../server/retrieval";
import {
  aggregate,
  percentile,
  relevantKeys,
  scoreQuery,
  DEFAULT_KS,
  type QueryMetrics,
  type RelevancePredicate,
} from "../server/ireval";

type Case = { id: string; lang: string; query: string; relevant: RelevancePredicate[] };

const KS = DEFAULT_KS;
const golden = JSON.parse(readFileSync(join(process.cwd(), "bench/retrieval-golden.json"), "utf8")) as {
  cases: Case[];
};

async function main() {
  const docs = corpusDocs();
  if (!docs.length) {
    console.error("The retrieval index is empty. Boot the server once (it reindexes) or run reindex.ts first.");
    process.exit(2);
  }

  // Verify every label resolves to at least one real document.
  const rotten: string[] = [];
  const relevantByCase = new Map<string, Set<string>>();
  for (const c of golden.cases) {
    const rel = relevantKeys(docs, c.relevant);
    relevantByCase.set(c.id, rel);
    if (rel.size === 0) rotten.push(c.id);
  }
  if (rotten.length) {
    console.error(`Golden labels match no document (fix the label or the corpus): ${rotten.join(", ")}`);
    process.exit(2);
  }

  const lexPerQuery: QueryMetrics[] = [];
  const vecPerQuery: QueryMetrics[] = [];
  const hybPerQuery: QueryMetrics[] = [];
  const latencies: number[] = [];
  let vectorEverAvailable = false;
  const rows: any[] = [];

  /* Cleared the first time the stored index and the configured embedding model
     disagree, so the remaining queries skip the vector leg instead of each
     paying a failed embedding call. */
  let vectorUsable = true;
  let dimensionError = "";

  for (const c of golden.cases) {
    const relevant = relevantByCase.get(c.id)!;
    const t0 = Date.now();
    /* The vector leg is forced on so it can be scored independently, even where
       production fuses it at zero. If the index was built with a different
       embedding model than the one configured now, the dimension guard fires —
       that is the guard working, not a bug — but it must not abort the run: the
       lexical leg is still measurable and is exactly what such a configuration
       serves to guests. */
    let r;
    if (vectorUsable) {
      try {
        r = await retrievalRanking(c.query, { vecWeight: 1 });
      } catch (e: any) {
        if (!String(e?.message ?? e).includes("Embedding dimension mismatch")) throw e;
        vectorUsable = false;
        dimensionError = String(e.message);
        r = await retrievalRanking(c.query, { vecWeight: 0 });
      }
    } else {
      r = await retrievalRanking(c.query, { vecWeight: 0 });
    }
    latencies.push(Date.now() - t0);
    if (r.vectorAvailable) vectorEverAvailable = true;

    const lex = scoreQuery(r.lexical.map((d) => d.docKey), relevant, KS);
    const vec = scoreQuery(r.vector.map((d) => d.docKey), relevant, KS);
    const hyb = scoreQuery(r.hybrid.map((d) => d.docKey), relevant, KS);
    lexPerQuery.push(lex);
    vecPerQuery.push(vec);
    hybPerQuery.push(hyb);

    rows.push({
      id: c.id,
      lang: c.lang,
      query: c.query,
      relevant_count: relevant.size,
      lexical_first_rank: lex.firstRelevantRank,
      vector_first_rank: vec.firstRelevantRank,
      lexical_hit5: lex.hit[5],
      vector_hit5: vec.hit[5],
    });
  }

  const lexical = aggregate(lexPerQuery, KS);
  const vector = aggregate(vecPerQuery, KS);
  const hybrid = aggregate(hybPerQuery, KS);
  const summary = {
    cases: golden.cases.length,
    vectorAvailable: vectorEverAvailable,
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: Math.max(...latencies) },
    legs: {
      bm25_production: lexical, // what production serves (RRF_VEC_WEIGHT defaults to 0)
      vector_only: vector, // the embedding leg alone — diagnostic
      hybrid_equal_weight: hybrid, // the old equal-weight fusion, for the before/after
    },
  };

  /* ---- print: three legs side by side ---- */
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const row3 = (label: string, l: Record<number, number> | number, v: Record<number, number> | number, h: Record<number, number> | number) => {
    const fmt = (x: Record<number, number> | number, k?: number) => (typeof x === "number" ? x.toFixed(3) : pct(x[k!]));
    if (typeof l === "number") {
      console.log(`${label.padEnd(12)} BM25(prod) ${fmt(l).padStart(7)}   vector ${fmt(v).padStart(7)}   hybrid=1:1 ${fmt(h).padStart(7)}`);
    } else {
      for (const k of KS) {
        console.log(
          `${`${label}@${k}`.padEnd(12)} BM25(prod) ${fmt(l, k).padStart(7)}   vector ${fmt(v as any, k).padStart(7)}   hybrid=1:1 ${fmt(h as any, k).padStart(7)}`,
        );
      }
    }
  };

  if (dimensionError) {
    console.log(
      `
! Vector leg skipped: the index and the configured embedding model disagree.
  ${dimensionError}
  The lexical numbers below are still valid and are what this configuration serves.`,
    );
  }
  console.log(`\nRetrieval benchmark — ${summary.cases} queries · vector leg ${vectorEverAvailable ? "live" : "UNAVAILABLE"}`);
  console.log(`latency p50 ${summary.latencyMs.p50}ms · p95 ${summary.latencyMs.p95}ms · max ${summary.latencyMs.max}ms`);
  console.log(`(production fuses at RRF_VEC_WEIGHT=0, so "BM25(prod)" is what guests get)\n`);
  row3("hit", lexical.hit, vector.hit, hybrid.hit);
  console.log("");
  row3("recall", lexical.recall, vector.recall, hybrid.recall);
  console.log("");
  row3("nDCG", lexical.ndcg, vector.ndcg, hybrid.ndcg);
  console.log("");
  row3("MRR", lexical.mrr, vector.mrr, hybrid.mrr);

  const missLex = rows.filter((r) => !r.lexical_hit5).map((r) => r.id);
  if (missLex.length) console.log(`\nProduction (BM25) still misses in top 5: ${missLex.join(", ")}`);
  if (vectorUsable) {
    console.log(
      `Vector-only leg is ${(vector.hit[5] * 100).toFixed(1)}% hit@5 vs BM25 ${(lexical.hit[5] * 100).toFixed(1)}%.`,
    );
  }

  const oi = process.argv.indexOf("--out");
  if (oi >= 0) {
    const out = process.argv[oi + 1];
    writeFileSync(out, JSON.stringify({ summary, rows }, null, 2));
    console.log(`\nwritten to ${out}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
