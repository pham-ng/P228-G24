import "dotenv/config";

/**
 * Part 6.5: controlled retrieval-architecture experiment.
 *
 * Isolates retrieval from generation entirely — no LLM call anywhere in this
 * script — so every number here is retrieval-only and immune to the local
 * model's run-to-run generation noise found in Part 6. Reuses the existing
 * golden set and IR-metric harness (bench/retrieval-eval.ts,
 * server/ireval.ts) rather than inventing new scoring.
 *
 *   DB_FILE=data.db npx tsx bench/rrf-remediation.ts --out bench/baselines/kiosk-validation/06-rrf-remediation.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { storage } from "../server/storage";
import { corpusDocs, retrievalRanking, chunkDocKey, type RankedDoc, type CorpusDoc } from "../server/retrieval";
import { aggregate, percentile, relevantKeys, scoreQuery, DEFAULT_KS, type QueryMetrics, type RelevancePredicate } from "../server/ireval";
import type { DocChunk } from "@shared/schema";

type Case = { id: string; lang: string; query: string; relevant: RelevancePredicate[] };

function loadCases(): Case[] {
  const golden = JSON.parse(readFileSync(join(process.cwd(), "bench/retrieval-golden.json"), "utf8")) as { cases: Case[] };
  const multi = JSON.parse(readFileSync(join(process.cwd(), "bench/retrieval-golden-multilingual.json"), "utf8")) as {
    intents: { intent: string; relevant: RelevancePredicate[]; queries: Record<string, string> }[];
  };
  const fromMulti: Case[] = [];
  for (const i of multi.intents) {
    for (const [lang, query] of Object.entries(i.queries)) {
      fromMulti.push({ id: `M-${i.intent}-${lang}`, lang, query, relevant: i.relevant });
    }
  }
  return [...golden.cases, ...fromMulti];
}

/* ------------------------------------------------------------ corpus variants */

const DUP_KB_REFIDS = new Set([18, 19, 22]); // kb duplicates of a policy topic (guest list, package codes, payment)
const RATE_PACKAGE_CATEGORY = "rate_package";

function corpusVariant(all: DocChunk[], variant: "A" | "B" | "C" | "D"): DocChunk[] {
  if (variant === "A") return all;
  if (variant === "B") return all.filter((c) => !(c.kind === "kb" && DUP_KB_REFIDS.has(c.refId)));
  if (variant === "C") return all.filter((c) => c.category !== RATE_PACKAGE_CATEGORY);
  return all.filter((c) => !(c.kind === "kb" && DUP_KB_REFIDS.has(c.refId)) && c.category !== RATE_PACKAGE_CATEGORY);
}

/* ------------------------------------------------------------ diversity cap */

/** Deterministic, domain-agnostic diversity constraint applied AFTER fusion
 *  scoring: at most `maxPerCategory` chunks sharing the same `category` value
 *  survive into the final ranking, in score order. Every chunk already carries
 *  a category (policy/<topic>, room_type, dining_venue, rate_package, kb
 *  sub-categories), so this needs no domain-specific knowledge of "packages"
 *  or "rooms" — it is the same rule for every category. */
function applyDiversityCap(ranked: RankedDoc[], catByKey: Map<string, string>, maxPerCategory: number): RankedDoc[] {
  const perCat = new Map<string, number>();
  const out: RankedDoc[] = [];
  for (const r of ranked) {
    const cat = catByKey.get(r.docKey) ?? "unknown";
    const n = perCat.get(cat) ?? 0;
    if (n >= maxPerCategory) continue;
    perCat.set(cat, n + 1);
    out.push(r);
  }
  return out;
}

/* ------------------------------------------------------------ scoring one config */

type ConfigResult = {
  label: string;
  n: number;
  overall: ReturnType<typeof aggregate>;
  byLang: Record<string, ReturnType<typeof aggregate>>;
  latencyMs: { p50: number; p95: number };
  misses5: string[];
};

async function scoreConfig(
  label: string,
  cases: Case[],
  docs: CorpusDoc[],
  rank: (query: string) => Promise<RankedDoc[]>,
): Promise<ConfigResult> {
  const relByCase = new Map<string, Set<string>>();
  for (const c of cases) relByCase.set(c.id, relevantKeys(docs, c.relevant));

  const perQuery: (QueryMetrics & { lang: string; id: string })[] = [];
  const latencies: number[] = [];
  const misses5: string[] = [];

  for (const c of cases) {
    const relevant = relByCase.get(c.id)!;
    if (relevant.size === 0) continue; // label doesn't resolve under this corpus variant (expected for dedup variants)
    const t0 = Date.now();
    const ranked = await rank(c.query);
    latencies.push(Date.now() - t0);
    const m = scoreQuery(ranked.map((d) => d.docKey), relevant, DEFAULT_KS);
    perQuery.push({ ...m, lang: c.lang, id: c.id });
    if (!m.hit[5]) misses5.push(c.id);
  }

  const byLang: Record<string, ReturnType<typeof aggregate>> = {};
  for (const lang of new Set(perQuery.map((m) => m.lang))) {
    byLang[lang] = aggregate(perQuery.filter((m) => m.lang === lang), DEFAULT_KS);
  }

  return {
    label,
    n: perQuery.length,
    overall: aggregate(perQuery, DEFAULT_KS),
    byLang,
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    misses5,
  };
}

function printResult(r: ConfigResult) {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  console.log(
    `${r.label.padEnd(34)} n=${r.n}  hit@1=${pct(r.overall.hit[1])}  hit@5=${pct(r.overall.hit[5])}  MRR=${r.overall.mrr.toFixed(3)}  nDCG@5=${r.overall.ndcg[5].toFixed(3)}  p50=${r.latencyMs.p50}ms`,
  );
  const langs = ["vi", "en", "zh", "ja", "ko"];
  const langStr = langs
    .filter((l) => r.byLang[l])
    .map((l) => `${l}=${pct(r.byLang[l].hit[5])}`)
    .join(" ");
  console.log(`    by-lang hit@5: ${langStr}`);
}

async function main() {
  const cases = loadCases();
  const allChunks = storage.listChunks();
  const allDocs = corpusDocs();
  const catByKey = new Map(allDocs.map((d) => [d.docKey, d.category]));

  console.log(`Loaded ${cases.length} golden cases (${new Set(cases.map((c) => c.lang)).size} languages), corpus ${allChunks.length} chunks / ${allDocs.length} docs.\n`);

  const results: ConfigResult[] = [];

  /* ---- Section 1: frozen baseline (current production: vecWeight=0.5) ---- */
  console.log("=".repeat(78));
  console.log("SECTION 1 — FROZEN BASELINE (current production config)");
  console.log("=".repeat(78));
  const baseline = await scoreConfig("A: current corpus, RRF 0.5 (prod)", cases, allDocs, async (q) => {
    const r = await retrievalRanking(q, { vecWeight: 0.5 });
    return r.hybrid;
  });
  printResult(baseline);
  results.push(baseline);

  /* ---- Section 2: corpus redundancy experiment ---- */
  console.log("\n" + "=".repeat(78));
  console.log("SECTION 2 — CORPUS REDUNDANCY (RRF weight fixed at production 0.5)");
  console.log("=".repeat(78));
  for (const variant of ["B", "C", "D"] as const) {
    const chunks = corpusVariant(allChunks, variant);
    const label =
      variant === "B" ? "B: dedupe KB/policy pairs (-3 kb docs)" :
      variant === "C" ? "C: exclude rate_package chunks (-10 docs)" :
      "D: B + C combined";
    const res = await scoreConfig(label, cases, allDocs, async (q) => {
      const r = await retrievalRanking(q, { vecWeight: 0.5, chunksOverride: chunks });
      return r.hybrid;
    });
    printResult(res);
    results.push(res);
  }

  /* ---- Section 3: RRF weight sweep (current corpus, variant A) ---- */
  console.log("\n" + "=".repeat(78));
  console.log("SECTION 3 — RRF WEIGHT SWEEP (current corpus)");
  console.log("=".repeat(78));
  for (const w of [0, 0.25, 0.5, 0.75, 1.0]) {
    const res = await scoreConfig(`RRF_VEC_WEIGHT=${w}`, cases, allDocs, async (q) => {
      const r = await retrievalRanking(q, { vecWeight: w });
      return r.hybrid;
    });
    printResult(res);
    results.push(res);
  }

  /* ---- Section 4: diversity-aware fusion (current corpus, vecWeight=0.5) ---- */
  console.log("\n" + "=".repeat(78));
  console.log("SECTION 4 — DIVERSITY-AWARE FUSION (current corpus, RRF 0.5, cap by category)");
  console.log("=".repeat(78));
  for (const cap of [Infinity, 2, 1]) {
    const label = cap === Infinity ? "no cap (= baseline A)" : `max ${cap} chunk(s)/category`;
    const res = await scoreConfig(`diversity: ${label}`, cases, allDocs, async (q) => {
      const r = await retrievalRanking(q, { vecWeight: 0.5 });
      return applyDiversityCap(r.hybrid, catByKey, cap);
    });
    printResult(res);
    results.push(res);
  }

  /* ---- Section 4b: diversity + corpus D combined (best of both, if either wins alone) ---- */
  {
    const chunksD = corpusVariant(allChunks, "D");
    const res = await scoreConfig("D + diversity cap=1/category", cases, allDocs, async (q) => {
      const r = await retrievalRanking(q, { vecWeight: 0.5, chunksOverride: chunksD });
      return applyDiversityCap(r.hybrid, catByKey, 1);
    });
    printResult(res);
    results.push(res);
  }

  /* ---- Section 7: repeatability spot-check (rerun baseline once more) ---- */
  console.log("\n" + "=".repeat(78));
  console.log("SECTION 7 — REPEATABILITY (baseline rerun, same process)");
  console.log("=".repeat(78));
  const baselineRerun = await scoreConfig("A rerun (same process)", cases, allDocs, async (q) => {
    const r = await retrievalRanking(q, { vecWeight: 0.5 });
    return r.hybrid;
  });
  printResult(baselineRerun);
  const identical = JSON.stringify(baseline.overall) === JSON.stringify(baselineRerun.overall);
  console.log(`Identical to first run: ${identical}`);
  results.push(baselineRerun);

  /* ---- specific case call-outs: the 7 Part 6 failure cases, before/after ---- */
  console.log("\n" + "=".repeat(78));
  console.log("PER-CASE: the cases this phase targets");
  console.log("=".repeat(78));
  const targetIds = ["P-pets-vi", "P-guestlist-vi"];
  for (const id of targetIds) {
    const c = cases.find((x) => x.id === id);
    if (!c) continue;
    const relevant = relevantKeys(allDocs, c.relevant);
    const baseRank = await retrievalRanking(c.query, { vecWeight: 0.5 });
    const baseR = scoreQuery(baseRank.hybrid.map((d) => d.docKey), relevant, DEFAULT_KS);
    const divRank = applyDiversityCap(baseRank.hybrid, catByKey, 1);
    const divR = scoreQuery(divRank.map((d) => d.docKey), relevant, DEFAULT_KS);
    console.log(`${id}: baseline rank=${baseR.firstRelevantRank ?? "not found"}  diversity-cap=1 rank=${divR.firstRelevantRank ?? "not found"}`);
  }

  const oi = process.argv.indexOf("--out");
  if (oi >= 0) {
    writeFileSync(process.argv[oi + 1], JSON.stringify({ ranAt: new Date().toISOString(), cases: cases.length, results }, null, 2));
    console.log(`\nwritten to ${process.argv[oi + 1]}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
