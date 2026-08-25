/**
 * Information-retrieval metrics for the retrieval golden set.
 *
 * Pure and dependency-free on purpose: every function takes a ranked list of
 * document keys and a set of relevant keys, and returns a number. No database,
 * no model, no clock. That is what lets the unit test pin the arithmetic exactly
 * — recall@k, precision@k, MRR and nDCG@k are standard, and a bug in the metric
 * would otherwise masquerade as a bug in retrieval.
 *
 * Relevance is binary here (a document is relevant or not), which matches how the
 * golden set is labelled. The predicate matcher below turns a human-written label
 * ("the checkout policy", "the Lotus restaurant page") into the concrete set of
 * document keys in the live corpus, so the golden file never has to name DB ids.
 */

/** The document attributes a golden label is written against. CorpusDoc from
 *  retrieval.ts satisfies this; a test can supply a plain object. */
export interface EvalDoc {
  docKey: string;
  kind: string;
  topic: string | null;
  code: string | null;
  title: string;
  category: string;
}

/** One clause of a relevance label. A document is relevant to a case when it
 *  matches ANY clause. Exactly one field is set per clause. */
export type RelevancePredicate = {
  policyTopic?: string;
  room?: string;
  dining?: string;
  kbTitle?: string;
  category?: string;
};

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

export function matchesPredicate(doc: EvalDoc, p: RelevancePredicate): boolean {
  if (p.policyTopic != null) return doc.kind === "policy" && doc.topic === p.policyTopic;
  if (p.room != null) return doc.kind === "room" && norm(doc.code ?? "").includes(norm(p.room));
  if (p.dining != null) return doc.kind === "dining" && norm(doc.code ?? "").includes(norm(p.dining));
  if (p.kbTitle != null) return doc.kind === "kb" && norm(doc.title).includes(norm(p.kbTitle));
  if (p.category != null) return norm(doc.category).includes(norm(p.category));
  return false;
}

/** The set of corpus document keys that satisfy any predicate in a label. */
export function relevantKeys(docs: EvalDoc[], predicates: RelevancePredicate[]): Set<string> {
  const out = new Set<string>();
  for (const d of docs) {
    if (predicates.some((p) => matchesPredicate(d, p))) out.add(d.docKey);
  }
  return out;
}

/* ------------------------------------------------------------------ metrics */

/** 1 if any relevant document appears in the top k, else 0. */
export function hitAtK(ranked: string[], relevant: Set<string>, k: number): number {
  return ranked.slice(0, k).some((d) => relevant.has(d)) ? 1 : 0;
}

/** Fraction of the relevant set that appears in the top k. */
export function recallAtK(ranked: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 0;
  const found = ranked.slice(0, k).filter((d) => relevant.has(d)).length;
  return found / relevant.size;
}

/** Fraction of the top k that is relevant. */
export function precisionAtK(ranked: string[], relevant: Set<string>, k: number): number {
  if (k === 0) return 0;
  const found = ranked.slice(0, k).filter((d) => relevant.has(d)).length;
  return found / k;
}

/** Reciprocal of the rank (1-based) of the first relevant document; 0 if none. */
export function reciprocalRank(ranked: string[], relevant: Set<string>): number {
  for (let i = 0; i < ranked.length; i++) {
    if (relevant.has(ranked[i])) return 1 / (i + 1);
  }
  return 0;
}

/** Normalised discounted cumulative gain at k, binary relevance. */
export function ndcgAtK(ranked: string[], relevant: Set<string>, k: number): number {
  let dcg = 0;
  for (let i = 0; i < Math.min(k, ranked.length); i++) {
    if (relevant.has(ranked[i])) dcg += 1 / Math.log2(i + 2);
  }
  let idcg = 0;
  const ideal = Math.min(relevant.size, k);
  for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

export type QueryMetrics = {
  hit: Record<number, number>;
  recall: Record<number, number>;
  precision: Record<number, number>;
  ndcg: Record<number, number>;
  mrr: number;
  /** Rank (1-based) of the first relevant doc, or null when it was never found. */
  firstRelevantRank: number | null;
};

export const DEFAULT_KS = [1, 3, 5, 10] as const;

/** Every metric for one query, across the standard cutoffs. */
export function scoreQuery(ranked: string[], relevant: Set<string>, ks: readonly number[] = DEFAULT_KS): QueryMetrics {
  const hit: Record<number, number> = {};
  const recall: Record<number, number> = {};
  const precision: Record<number, number> = {};
  const ndcg: Record<number, number> = {};
  for (const k of ks) {
    hit[k] = hitAtK(ranked, relevant, k);
    recall[k] = recallAtK(ranked, relevant, k);
    precision[k] = precisionAtK(ranked, relevant, k);
    ndcg[k] = ndcgAtK(ranked, relevant, k);
  }
  let firstRelevantRank: number | null = null;
  for (let i = 0; i < ranked.length; i++) {
    if (relevant.has(ranked[i])) {
      firstRelevantRank = i + 1;
      break;
    }
  }
  return { hit, recall, precision, ndcg, mrr: reciprocalRank(ranked, relevant), firstRelevantRank };
}

/** Mean of a metric across queries, rounded to 3 dp. */
export function mean(values: number[]): number {
  if (!values.length) return 0;
  return +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(3);
}

/** Percentile (nearest-rank) of a numeric sample, for latency reporting. */
export function percentile(sample: number[], p: number): number {
  if (!sample.length) return 0;
  const s = [...sample].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

/** Aggregate a list of per-query metrics into the summary table. */
export function aggregate(perQuery: QueryMetrics[], ks: readonly number[] = DEFAULT_KS) {
  const at = (pick: (m: QueryMetrics) => Record<number, number>) =>
    Object.fromEntries(ks.map((k) => [k, mean(perQuery.map((m) => pick(m)[k]))]));
  return {
    n: perQuery.length,
    hit: at((m) => m.hit),
    recall: at((m) => m.recall),
    precision: at((m) => m.precision),
    ndcg: at((m) => m.ndcg),
    mrr: mean(perQuery.map((m) => m.mrr)),
  };
}
