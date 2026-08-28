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
import {
  classifyVector,
  SENTIMENT_PROTOTYPES,
  SENTIMENT_MARGIN,
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

console.log(failures === 0 ? "\nALL SENTIMENT NET TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
