import "dotenv/config";

/**
 * Cross-lingual retrieval evaluation and regression gate (Phase E).
 *
 * The corpus is Vietnamese and English. Every Chinese, Japanese and Korean query
 * therefore has to cross a language boundary to reach its answer — which the
 * lexical leg cannot do at all (no shared tokens) and only a multilingual
 * embedding can. That makes this suite the sharpest available test of whether
 * the dense leg is genuinely working, and it is why it is scored per language:
 * an average would hide a language that fails completely.
 *
 * It doubles as a CI gate. `--gate` exits non-zero when any language falls below
 * its floor, so a change that quietly breaks Korean retrieval cannot ship on the
 * strength of a good Vietnamese average.
 *
 *   DB_FILE=data.db npx tsx bench/multilingual-eval.ts [--gate] [--out report.json]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { corpusDocs, retrievalRanking } from "../server/retrieval";
import { relevantKeys, scoreQuery, aggregate, percentile, DEFAULT_KS, type QueryMetrics, type RelevancePredicate } from "../server/ireval";

type Intent = { intent: string; relevant: RelevancePredicate[]; queries: Record<string, string> };

/**
 * Floors, not targets. Vietnamese and English are held near the level the
 * single-language benchmark already proves; the CJK floors are deliberately
 * lower because they depend entirely on cross-lingual embedding quality, and a
 * floor nobody can meet gets disabled rather than fixed.
 */
const FLOORS: Record<string, number> = { vi: 0.8, en: 0.8, zh: 0.6, ja: 0.6, ko: 0.6 };

async function main() {
  const docs = corpusDocs();
  if (!docs.length) {
    console.error("Retrieval index is empty — reindex first.");
    process.exit(2);
  }
  const golden = JSON.parse(
    readFileSync(join(process.cwd(), "bench/retrieval-golden-multilingual.json"), "utf8"),
  ) as { meta: { languages: string[] }; intents: Intent[] };

  /* A label that matches nothing means the corpus changed under the suite; that
     must abort rather than quietly score zero and look like a retrieval failure. */
  for (const it of golden.intents) {
    if (relevantKeys(docs, it.relevant).size === 0) {
      console.error(`Intent "${it.intent}" matches no document — fix the label or the corpus.`);
      process.exit(2);
    }
  }

  const perLang: Record<string, { metrics: QueryMetrics[]; lat: number[]; misses: string[] }> = {};
  for (const lang of golden.meta.languages) perLang[lang] = { metrics: [], lat: [], misses: [] };

  for (const it of golden.intents) {
    const rel = relevantKeys(docs, it.relevant);
    for (const lang of golden.meta.languages) {
      const q = it.queries[lang];
      if (!q) continue;
      const t0 = Date.now();
      const r = await retrievalRanking(q);
      perLang[lang].lat.push(Date.now() - t0);
      const m = scoreQuery(r.hybrid.map((d) => d.docKey), rel, DEFAULT_KS);
      perLang[lang].metrics.push(m);
      if (!m.hit[5]) perLang[lang].misses.push(it.intent);
    }
  }

  const rows = golden.meta.languages.map((lang) => {
    const a = aggregate(perLang[lang].metrics, DEFAULT_KS);
    return {
      lang,
      hit1: a.hit[1],
      hit3: a.hit[3],
      hit5: a.hit[5],
      mrr: a.mrr,
      latencyP50: percentile(perLang[lang].lat, 50),
      misses: perLang[lang].misses,
      floor: FLOORS[lang] ?? 0,
      pass: a.hit[5] >= (FLOORS[lang] ?? 0),
    };
  });

  console.log(`\nCross-lingual retrieval — ${golden.intents.length} intents × ${golden.meta.languages.length} languages\n`);
  for (const r of rows) {
    console.log(
      `  ${r.lang}  hit@1 ${(r.hit1 * 100).toFixed(0).padStart(3)}%  hit@3 ${(r.hit3 * 100).toFixed(0).padStart(3)}%  ` +
        `hit@5 ${(r.hit5 * 100).toFixed(0).padStart(3)}%  MRR ${r.mrr.toFixed(3)}  p50 ${String(r.latencyP50).padStart(4)}ms  ` +
        `floor ${(r.floor * 100).toFixed(0)}% ${r.pass ? "OK" : "FAIL"}` +
        (r.misses.length ? `  misses: ${r.misses.join(",")}` : ""),
    );
  }

  const failed = rows.filter((r) => !r.pass);
  const oi = process.argv.indexOf("--out");
  if (oi >= 0) {
    writeFileSync(process.argv[oi + 1], JSON.stringify({ ranAt: new Date().toISOString(), rows }, null, 2));
    console.log(`\nwritten to ${process.argv[oi + 1]}`);
  }

  if (process.argv.includes("--gate")) {
    if (failed.length) {
      console.error(`\nGATE FAILED: ${failed.map((f) => `${f.lang} ${(f.hit5 * 100).toFixed(0)}% < ${(f.floor * 100).toFixed(0)}%`).join(", ")}`);
      process.exit(1);
    }
    console.log("\nGATE PASSED: every language meets its floor.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
