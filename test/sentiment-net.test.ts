/**
 * An unhappy guest must reach a person without having to press a button.
 *
 * The thumbs-down path already escalates properly — urgent task, ten-minute
 * SLA, an apology — but it only fires when the guest chooses to use it, and an
 * unhappy guest usually says nothing and leaves. This net reads the complaint
 * out of the message itself.
 *
 * These assertions are pure: they run `classifyVector` against fixed vectors,
 * so no model, index or network is involved. The live cross-language check
 * lives in the sentiment probe; what is locked here is the DECISION RULE —
 * margin, direction, and the fact that a calm fault report is not a complaint.
 */
import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyVector,
  classifyLinear,
  SENTIMENT_PROTOTYPES,
  SENTIMENT_MARGIN,
  SENTIMENT_BACKEND,
  type GuestSentiment,
} from "../server/sentiment-net";

let failures = 0;
function ok(cond: boolean, label: string) {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
}

/* Synthetic 4-d vectors: prototypes are unit axes, so cosine is exact and the
   rule can be tested without embedding anything. */
const negIdx = SENTIMENT_PROTOTYPES.map((p, i) => (p.label === "negative" ? i : -1)).filter((i) => i >= 0);
const neuIdx = SENTIMENT_PROTOTYPES.map((p, i) => (p.label === "neutral" ? i : -1)).filter((i) => i >= 0);
const vectors = SENTIMENT_PROTOTYPES.map((p) => (p.label === "negative" ? [1, 0] : [0, 1]));

console.log("=== the decision rule ===");
ok(negIdx.length >= 5, `enough negative prototypes (${negIdx.length})`);
ok(neuIdx.length >= 5, `enough neutral prototypes (${neuIdx.length})`);

{
  const v = classifyVector([1, 0], SENTIMENT_PROTOTYPES, vectors)!;
  ok(v.label === "negative" && v.margin === 1, "a pure complaint vector reads negative with full margin");
}
{
  const v = classifyVector([0, 1], SENTIMENT_PROTOTYPES, vectors)!;
  ok(v.label === "neutral" && v.margin === 1, "a pure lookup vector reads neutral with full margin");
}
{
  /* Exactly between the two: the rule must NOT call this a complaint, because
     the cost of a false positive is an urgent task on a real front desk. */
  const v = classifyVector([1, 1], SENTIMENT_PROTOTYPES, vectors)!;
  ok(v.margin === 0, "an ambiguous vector has zero margin");
  ok(v.margin < SENTIMENT_MARGIN, "and therefore does not trip the threshold");
}

console.log("\n=== the threshold is set where it was measured ===");
/* Measured across eight complaints in six languages and twelve ordinary
   messages: complaints landed 0.19-0.36 on the negative side, ordinary
   messages 0.42+ on the neutral side. The threshold has to sit under every
   measured complaint and far from every measured lookup. */
ok(SENTIMENT_MARGIN <= 0.19, `threshold ${SENTIMENT_MARGIN} is below the lowest measured complaint (0.190)`);
ok(SENTIMENT_MARGIN > 0, "and is not zero, which would flag every message");

console.log("\n=== a calm fault report is not a complaint ===");
/* Without an explicit neutral example, "部屋のエアコンが壊れています" (the
   air-con is broken) was flagged as an unhappy guest and would have opened an
   urgent front-desk task on top of the maintenance dispatch the routing layer
   already creates for it. */
const faultProtos = SENTIMENT_PROTOTYPES.filter(
  (p) => p.label === "neutral" && /hỏng|không chạy|rò|kiểm tra|xem/.test(p.text),
);
ok(faultProtos.length >= 2, `calm fault reports are represented as neutral (${faultProtos.length} prototypes)`);

console.log("\n=== prototypes stay in one language on purpose ===");
/* The whole argument for this approach is that bge-m3 carries Vietnamese
   examples across languages — measured catching Korean, Chinese, Russian,
   Japanese and English complaints. If someone starts translating prototypes,
   that property stops being tested and the list grows per language again. */
const nonVi = SENTIMENT_PROTOTYPES.filter((p) => /[가-힣ぁ-ヿ一-鿿Ѐ-ӿ]/.test(p.text));
ok(nonVi.length === 0, "no CJK/Cyrillic prototypes — cross-language coverage comes from the embedder");

console.log("\n=== the trained linear head ===");
/* The head is the shipped classifier (F1 91.8 held out, against F1 ~15 for the
   prototypes). These assertions are about the CONTRACT, not the accuracy — the
   accuracy is measured by `bench/sentiment-probe-eval.ts` against labelled data,
   which is the only place it can honestly be measured. What must not drift is
   that the weights match the encoder's width, that the operating point is a
   real probability, and that a mismatched vector is refused rather than scored
   against garbage. */
ok(SENTIMENT_BACKEND === "linear", `the trained head is the default backend (got "${SENTIMENT_BACKEND}")`);

const headPath = join(process.cwd(), "server", "data", "sentiment-head.json");
ok(existsSync(headPath), "server/data/sentiment-head.json ships with the project");

if (existsSync(headPath)) {
  const h = JSON.parse(readFileSync(headPath, "utf8"));
  ok(h.dim === 1024, `head width matches bge-m3 (${h.dim})`);
  ok(h.weights.length === h.dim, "weight count matches the declared width");
  ok(h.threshold > 0 && h.threshold < 1, `operating point is a probability (${h.threshold})`);
  ok(h.trainedOn >= 400, `trained on a real labelled set (${h.trainedOn} messages)`);

  /* A vector of the wrong width must return null, not a score. Retrieval's
     embedder is configurable, and silently scoring a 768-d vector against
     1024-d weights would produce confident nonsense on every guest turn. */
  ok(classifyLinear([1, 2, 3], h, h.threshold) === null, "a wrong-width vector is refused, not scored");
  ok(classifyLinear([], h, h.threshold) === null, "an empty vector is refused");

  /* Direction: the weight vector itself is the most negative input possible, and
     its negation the most neutral. If these ever swap, every complaint routes as
     calm and the feature fails silently. */
  const most = classifyLinear(h.weights, h, h.threshold);
  const least = classifyLinear(h.weights.map((x: number) => -x), h, h.threshold);
  ok(most?.label === "negative", "the weight direction reads as a complaint");
  ok(least?.label === "neutral", "the opposite direction reads as calm");
  ok(!!most && !!least && most.score > least.score, "and the scores are ordered the right way round");

  /* Scale-invariance: the head normalises internally, so an unnormalised vector
     from the embedder must score identically to a normalised one. */
  const a = classifyLinear(h.weights, h, h.threshold)!;
  const b = classifyLinear(h.weights.map((x: number) => x * 7.3), h, h.threshold)!;
  ok(Math.abs(a.score - b.score) < 1e-9, "scoring is invariant to vector magnitude");
}

console.log(failures === 0 ? "\nALL SENTIMENT NET TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
