/**
 * Unit tests for the IR metric math (server/ireval.ts).
 *
 * Pure and deterministic — no database, no model, no network. The values are
 * hand-computed so a change in the formula is caught here rather than showing up
 * as a mysterious swing in the retrieval benchmark.
 *
 *   npx tsx test/retrieval-metrics.test.ts
 */

import {
  hitAtK,
  recallAtK,
  precisionAtK,
  reciprocalRank,
  ndcgAtK,
  scoreQuery,
  aggregate,
  percentile,
  mean,
  matchesPredicate,
  relevantKeys,
  type EvalDoc,
} from "../server/ireval";

let failures = 0;
function eq(actual: number, expected: number, msg: string, tol = 1e-9) {
  const ok = Math.abs(actual - expected) <= tol;
  if (ok) console.log(`  PASS  ${msg} (= ${actual})`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}: expected ${expected}, got ${actual}`);
  }
}
function truthy(cond: boolean, msg: string) {
  if (cond) console.log(`  PASS  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}

// Ranked list a,b,c,d,e with the single relevant doc "c" at position 3 (1-based).
const ranked = ["a", "b", "c", "d", "e"];
const rel1 = new Set(["c"]);

console.log("=== IR METRICS: single relevant doc at rank 3 ===");
eq(hitAtK(ranked, rel1, 1), 0, "hit@1");
eq(hitAtK(ranked, rel1, 3), 1, "hit@3");
eq(recallAtK(ranked, rel1, 2), 0, "recall@2");
eq(recallAtK(ranked, rel1, 3), 1, "recall@3");
eq(precisionAtK(ranked, rel1, 3), 1 / 3, "precision@3");
eq(reciprocalRank(ranked, rel1), 1 / 3, "MRR");
// nDCG@3: DCG = 1/log2(3+1) = 1/2 = 0.5 ; IDCG = 1/log2(2) = 1 ; nDCG = 0.5
eq(ndcgAtK(ranked, rel1, 3), 0.5, "nDCG@3");
// nDCG@1: relevant not in top 1 -> 0
eq(ndcgAtK(ranked, rel1, 1), 0, "nDCG@1");

console.log("=== IR METRICS: two relevant docs ===");
const rel2 = new Set(["a", "d"]); // ranks 1 and 4
eq(recallAtK(ranked, rel2, 1), 0.5, "recall@1 (1 of 2)");
eq(recallAtK(ranked, rel2, 5), 1, "recall@5 (2 of 2)");
eq(precisionAtK(ranked, rel2, 4), 2 / 4, "precision@4");
eq(reciprocalRank(ranked, rel2), 1, "MRR (first at rank 1)");
// nDCG@5: DCG = 1/log2(2) + 1/log2(5) = 1 + 0.4306765... ; IDCG = 1/log2(2)+1/log2(3)
const dcg = 1 / Math.log2(2) + 1 / Math.log2(5);
const idcg = 1 / Math.log2(2) + 1 / Math.log2(3);
eq(ndcgAtK(ranked, rel2, 5), dcg / idcg, "nDCG@5 (two hits)");

console.log("=== IR METRICS: no relevant doc found ===");
const relNone = new Set(["z"]);
eq(reciprocalRank(ranked, relNone), 0, "MRR = 0 when absent");
eq(ndcgAtK(ranked, relNone, 5), 0, "nDCG = 0 when absent");
truthy(scoreQuery(ranked, relNone).firstRelevantRank === null, "firstRelevantRank null when absent");

console.log("=== IR METRICS: scoreQuery + aggregate ===");
const q1 = scoreQuery(ranked, rel1);
truthy(q1.firstRelevantRank === 3, "scoreQuery firstRelevantRank = 3");
const agg = aggregate([scoreQuery(ranked, rel1), scoreQuery(ranked, rel2)]);
eq(agg.hit[5], 1, "aggregate hit@5 (both hit)");
eq(agg.mrr, mean([1 / 3, 1]), "aggregate MRR is the mean");
eq(agg.n as unknown as number, 2, "aggregate counts 2 queries");

console.log("=== IR METRICS: percentile ===");
eq(percentile([10, 20, 30, 40, 50], 50), 30, "p50 nearest-rank");
eq(percentile([10, 20, 30, 40, 50], 95), 50, "p95 nearest-rank");
eq(percentile([], 50), 0, "percentile of empty = 0");

console.log("=== RELEVANCE PREDICATES ===");
const docs: EvalDoc[] = [
  { docKey: "policy/1", kind: "policy", topic: "checkout", code: null, title: "Checkout policy", category: "policy/checkout" },
  { docKey: "policy/2", kind: "policy", topic: "occupancy", code: null, title: "Occupancy", category: "policy/occupancy" },
  { docKey: "room/5", kind: "room", topic: null, code: "Deluxe Ocean View Queen Bed", title: "Deluxe HB", category: "room_type" },
  { docKey: "dining/3", kind: "dining", topic: null, code: "Lotus Restaurant", title: "Lotus", category: "dining_venue" },
  { docKey: "kb/1", kind: "kb", topic: null, code: null, title: "Cable car and Vinpearl Harbour ticket prices", category: "neighborhood" },
];
truthy(matchesPredicate(docs[0], { policyTopic: "checkout" }), "policyTopic matches");
truthy(!matchesPredicate(docs[1], { policyTopic: "checkout" }), "policyTopic does not match wrong topic");
truthy(matchesPredicate(docs[2], { room: "deluxe ocean view" }), "room code substring (case-insensitive)");
truthy(matchesPredicate(docs[3], { dining: "lotus" }), "dining code substring");
truthy(matchesPredicate(docs[4], { kbTitle: "cable car" }), "kbTitle substring");
truthy(!matchesPredicate(docs[2], { dining: "lotus" }), "room is not matched by a dining predicate");

const rel = relevantKeys(docs, [{ policyTopic: "checkout" }, { dining: "lotus" }]);
truthy(rel.has("policy/1") && rel.has("dining/3") && rel.size === 2, "relevantKeys unions predicates");

console.log(failures === 0 ? "\nALL RETRIEVAL METRIC TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
