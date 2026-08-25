/**
 * Unit tests for the Phase D retrieval upgrades: HyDE vector fusion, adaptive
 * routing, and reranker application. Pure — no model, no network, no database.
 *
 *   npx tsx test/retrieval-upgrades.test.ts
 */

import { shouldUseHyde, fuseVectors, hydeEnabled, hydeWeight } from "../server/hyde";
import { applyRerank, rerankDepth, rerankEnabled } from "../server/rerank";

let failures = 0;
function ok(cond: boolean, msg: string) {
  if (cond) console.log(`  PASS  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}
const close = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;

console.log("=== FLAGS DEFAULT OFF (experiments must be opted into) ===");
delete process.env.HYDE_ENABLED;
delete process.env.RERANK_ENABLED;
ok(!hydeEnabled(), "HyDE is disabled unless explicitly enabled");
ok(!rerankEnabled(), "reranking is disabled unless explicitly enabled");
process.env.HYDE_ENABLED = "1";
ok(hydeEnabled(), "HYDE_ENABLED=1 turns it on");
process.env.HYDE_ENABLED = "true";
ok(hydeEnabled(), "HYDE_ENABLED=true also accepted");
delete process.env.HYDE_ENABLED;

console.log("=== ADAPTIVE ROUTING ===");
/* A short keyword lookup already matches lexically; paying for a generated
   hypothesis on every search buys nothing. */
ok(!shouldUseHyde("giá vé cáp treo"), "short keyword query skips HyDE");
ok(!shouldUseHyde("spa"), "single word skips HyDE");
ok(
  shouldUseHyde("Tôi đến sớm vào buổi sáng thì có được nhận phòng trước không ạ"),
  "long conversational question uses HyDE",
);
ok(shouldUseHyde("tại sao tôi bị tính phí trả phòng muộn"), "explanatory 'tại sao' uses HyDE");
ok(shouldUseHyde("how do I get to the island"), "English 'how do' uses HyDE");
ok(!shouldUseHyde(""), "empty query skips HyDE");

console.log("=== HyDE VECTOR FUSION ===");
const q = [1, 0, 0];
const h = [0, 1, 0];
const half = fuseVectors(q, h, 0.5);
ok(close(Math.hypot(...half), 1), "fused vector is unit length");
ok(close(half[0], half[1]), "weight 0.5 gives both sides equal pull");
const mostlyQuery = fuseVectors(q, h, 0);
ok(close(mostlyQuery[0], 1) && close(mostlyQuery[1], 0), "weight 0 keeps the query vector alone");
const mostlyHyde = fuseVectors(q, h, 1);
ok(close(mostlyHyde[0], 0) && close(mostlyHyde[1], 1), "weight 1 uses the hypothesis alone");
/* The point of normalising first: a long hypothesis produces a larger raw
   vector, and without normalisation it would dominate purely by magnitude. */
const bigHyde = fuseVectors([1, 0, 0], [0, 100, 0], 0.5);
ok(close(bigHyde[0], bigHyde[1]), "a large-magnitude hypothesis cannot outvote the query");
ok(fuseVectors([1, 0], [0, 1, 0], 0.5).length === 2, "mismatched lengths truncate to the shorter");
ok(hydeWeight() >= 0 && hydeWeight() <= 1, "weight is clamped to [0,1]");
process.env.HYDE_WEIGHT = "5";
ok(hydeWeight() === 1, "an out-of-range weight clamps rather than corrupting the vector");
delete process.env.HYDE_WEIGHT;

console.log("=== RERANK APPLICATION ===");
const ranked = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
const reordered = applyRerank(ranked, new Map([[3, 9], [1, 5], [2, 1]]));
ok(reordered.map((r) => r.id).join(",") === "3,1,2,4", "scored candidates reorder by score");
/* An unscored candidate is unjudged, not judged irrelevant — dropping it would
   let one flaky model call lose a correct answer. */
ok(reordered.some((r) => r.id === 4), "an unscored candidate is kept, not discarded");
ok(reordered[reordered.length - 1].id === 4, "unscored candidates sit below scored ones");
ok(applyRerank(ranked, new Map()).map((r) => r.id).join(",") === "1,2,3,4", "no scores leaves order untouched");
ok(applyRerank(ranked, new Map([[99, 10]])).map((r) => r.id).join(",") === "1,2,3,4", "an unknown id cannot reorder anything");
ok(rerankDepth() >= 2 && rerankDepth() <= 20, "rerank depth stays in a sane range");
process.env.RERANK_DEPTH = "999";
ok(rerankDepth() === 20, "an absurd depth is capped");
delete process.env.RERANK_DEPTH;

console.log(failures === 0 ? "\nALL RETRIEVAL-UPGRADE TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
