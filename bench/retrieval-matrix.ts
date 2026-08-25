import "dotenv/config";

/**
 * Retrieval baseline matrix — one configuration per process, same queries, same
 * scoring code.
 *
 * The existing `bench/retrieval-eval.ts` reports three FIXED columns: BM25 as
 * production runs it, the vector leg alone, and a 1:1 fusion. That is useful for
 * seeing whether the legs work, and useless for choosing a weight, because the
 * hybrid column ignores `RRF_VEC_WEIGHT` entirely — sweeping the variable
 * changed nothing and the flat result looked like evidence of insensitivity when
 * it was evidence of a hard-coded column.
 *
 * This runner measures what production actually executes: `hybridSearch`, with
 * whatever weights the environment sets. Retrieval config is read once at module
 * load in `server/retrieval.ts`, so a weight sweep has to be a sweep of
 * PROCESSES, not a loop inside one. The caller supplies the config through env
 * and gets one JSON row back; `bench/run-matrix.sh` drives the grid.
 *
 * Scoring is the shared `server/ireval.ts` used by every other retrieval
 * benchmark — a matrix that scored differently from the regression gate would be
 * measuring a different system.
 *
 *   DB_FILE=… EMBED_PROVIDER=… LOCAL_EMBED_MODEL=… RRF_VEC_WEIGHT=… \
 *     npx tsx bench/retrieval-matrix.ts --label "C: bge-m3 w=2" [--out row.json]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { hybridSearch, corpusDocs, chunkDocKey } from "../server/retrieval";
import { MODEL_EMBED, EMBED_PROVIDER } from "../server/llm";
import { storage } from "../server/storage";
import {
  relevantKeys, scoreQuery, aggregate, mean, percentile,
  type RelevancePredicate, type EvalDoc,
} from "../server/ireval";

type MonoCase = { id: string; lang: string; query: string; relevant: RelevancePredicate[] };
type Intent = { intent: string; relevant: RelevancePredicate[]; queries: Record<string, string> };

const K = 10;

/**
 * Map a retrieved passage back to the document key the golden labels use.
 *
 * `hybridSearch` returns presentation rows (title, body, provenance) rather than
 * chunk identities, so the title is the only join key available. Titles repeat
 * across chunks of the same document, which is exactly what we want here: the
 * labels are per-document.
 */
function rankedKeys(titles: string[], docs: EvalDoc[]): string[] {
  const byTitle = new Map<string, string>();
  for (const d of docs) if (!byTitle.has(d.title)) byTitle.set(d.title, d.docKey);
  const out: string[] = [];
  for (const t of titles) {
    const key = byTitle.get(t);
    /* Deduplicate: two chunks of one document are one retrieved document, and
       counting them twice would inflate precision and nDCG. */
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

async function runSet(
  cases: { id: string; lang: string; query: string; relevant: RelevancePredicate[] }[],
  docs: EvalDoc[],
) {
  const perQuery = [];
  const latencies: number[] = [];
  const perLang: Record<string, { n: number; hit1: number; hit5: number }> = {};
  const misses: string[] = [];
  let vectorLegRan = 0;

  for (const c of cases) {
    const t0 = Date.now();
    const res = await hybridSearch(c.query, { k: K });
    latencies.push(Date.now() - t0);
    if (res.results.some((r) => r.matched_by.includes("semantic"))) vectorLegRan++;

    const relevant = relevantKeys(docs, c.relevant);
    const ranked = rankedKeys(res.results.map((r) => r.title), docs);
    const m = scoreQuery(ranked, relevant);
    perQuery.push(m);

    const L = (perLang[c.lang] ??= { n: 0, hit1: 0, hit5: 0 });
    L.n++;
    if (m.hit[1]) L.hit1++;
    if (m.hit[5]) L.hit5++;
    if (!m.hit[5]) misses.push(`${c.id} (${c.lang})`);
  }

  const agg = aggregate(perQuery);
  return {
    n: cases.length,
    hit1: agg.hit[1], hit3: agg.hit[3], hit5: agg.hit[5], hit10: agg.hit[10],
    mrr: agg.mrr,
    ndcg5: agg.ndcg[5], ndcg10: agg.ndcg[10],
    latencyMean: Math.round(mean(latencies)),
    latencyP50: percentile(latencies, 50),
    latencyP95: percentile(latencies, 95),
    vectorLegRan,
    perLang, misses,
  };
}

async function main() {
  const li = process.argv.indexOf("--label");
  const label = li >= 0 ? process.argv[li + 1] : `${MODEL_EMBED} w=${process.env.RRF_VEC_WEIGHT ?? "default"}`;

  const docs = corpusDocs();
  if (!docs.length) {
    console.error("Index is empty — reindex first.");
    process.exit(2);
  }

  /* --- the monolingual golden set (52 VI/EN queries) --- */
  const mono = JSON.parse(readFileSync("bench/retrieval-golden.json", "utf8")).cases as MonoCase[];

  /* --- the multilingual set, stored by intent with one query per language --- */
  const intents = JSON.parse(readFileSync("bench/retrieval-golden-multilingual.json", "utf8")).intents as Intent[];
  const multi = intents.flatMap((i) =>
    Object.entries(i.queries).map(([lang, query]) => ({ id: `${i.intent}-${lang}`, lang, query, relevant: i.relevant })),
  );

  const monoRes = await runSet(mono, docs);
  const multiRes = await runSet(multi, docs);

  const row = {
    label,
    ranAt: new Date().toISOString(),
    config: {
      db: process.env.DB_FILE ?? "data.db",
      embedProvider: EMBED_PROVIDER,
      embedModel: MODEL_EMBED,
      vecWeight: process.env.RRF_VEC_WEIGHT ?? "(model default)",
      lexWeight: process.env.RRF_LEX_WEIGHT ?? "1",
      titleBoost: process.env.BM25_TITLE_BOOST ?? "0.6",
      chunks: storage.listChunks().length,
    },
    monolingual: monoRes,
    multilingual: multiRes,
  };

  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  console.log(`\n${label}`);
  console.log(`  db=${row.config.db}  embed=${row.config.embedModel}  vecW=${row.config.vecWeight}`);
  console.log(
    `  VI/EN (n=${monoRes.n})   hit@1 ${pct(monoRes.hit1)}  hit@3 ${pct(monoRes.hit3)}  ` +
      `hit@5 ${pct(monoRes.hit5)}  MRR ${monoRes.mrr.toFixed(3)}  nDCG@5 ${pct(monoRes.ndcg5)}  ` +
      `${monoRes.latencyMean}ms  vec-leg ${monoRes.vectorLegRan}/${monoRes.n}`,
  );
  console.log(
    `  5-lang (n=${multiRes.n})  hit@1 ${pct(multiRes.hit1)}  hit@3 ${pct(multiRes.hit3)}  ` +
      `hit@5 ${pct(multiRes.hit5)}  MRR ${multiRes.mrr.toFixed(3)}  ${multiRes.latencyMean}ms`,
  );
  const langs = Object.entries(multiRes.perLang)
    .map(([l, v]) => `${l} ${v.hit5}/${v.n}`)
    .join("  ");
  console.log(`  hit@5 theo ngôn ngữ: ${langs}`);

  const oi = process.argv.indexOf("--out");
  if (oi >= 0) {
    writeFileSync(process.argv[oi + 1], JSON.stringify(row, null, 2));
    console.log(`  -> ${process.argv[oi + 1]}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
