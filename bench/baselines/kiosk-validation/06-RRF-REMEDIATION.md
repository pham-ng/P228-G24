# Aurea — Phase 6.5: RRF Fusion Remediation

Status: **PASS WITH KNOWN LIMITATIONS**

Conclusion up front, because it is not the one the phase set out to find:
**no controlled variant tested here — corpus dedup, RRF weight, or
diversity-aware fusion — is a clean, safe win over plain RRF at the current
production weight.** Every variant that helped one of the three hardest
remaining cases either helped only on a document-level metric that does not
reflect production's real chunk-level pick, or fixed one case while breaking
another. Production configuration is unchanged: `RRF_VEC_WEIGHT=0.5`, no
diversity cap. The one change that *does* ship from this phase is a new,
default-off `RRF_CATEGORY_CAP` toggle, left in the code for a future,
better-scoped attempt — not activated.

---

## 1. Frozen baseline

Production config at the start of this phase (unchanged from Part 6's end):
`RRF_VEC_WEIGHT=0.5`, `LOCAL_MIN_SCORE=0.005`, `LOCAL_PASSAGES=5`,
`bge-m3` dense, `qwen3.5:4b` generation, corpus = 135 chunks / 90 documents
(post Part 6's alias/chunking fix, already reindexed into `data.db`).

A retrieval-only evaluation harness was built for this phase
(`bench/rrf-remediation.ts`) reusing the pre-existing golden set
(`bench/retrieval-golden.json`, `bench/retrieval-golden-multilingual.json`)
and IR-metrics module (`server/ireval.ts`) — no new scoring logic, no LLM
call anywhere in it, so every number below is retrieval-only and immune to
the local model's generation non-determinism documented in Part 6. Two
cases were added to the golden set that it was missing (`P-pets-vi`,
`P-guestlist-vi`) — real production queries with proper predicate labels
against the live corpus, not benchmark-specific tuning.

Baseline (84 cases, 5 languages):

| Metric | Value |
|---|---|
| hit@1 | 92.9% |
| hit@5 | 98.8% |
| MRR | 0.960 |
| nDCG@5 | 0.858 |
| by-lang hit@5 | vi 100% · en 92.9% · zh 100% · ja 100% · ko 100% |
| latency p50 | 111ms (cold) / ~27ms (warm) |

## 2. Corpus redundancy analysis

Three corpus variants tested by filtering the live chunk set (via a new
test-only `chunksOverride` parameter on `retrievalRanking()` — no data.db
writes):

- **B**: remove 3 KB articles that duplicate a policy topic (`kb/18` guest
  list, `kb/19` package codes, `kb/22` payment methods) — same fact
  redundantly represented in both a KB article and a policy entry.
- **C**: remove all 10 `rate_package` category chunks ("Gói giá phòng — …")
  — an ablation to measure their dilution contribution directly.
- **D**: B + C combined.

**Correction, added after this report was first written**: this section's
framing of the 10 `rate_package` documents as "near-duplicate" was wrong,
and the user caught it before any production change was made. Reading the
actual chunk content confirms each of the 10 documents holds genuinely
distinct, non-redundant data — different room type, different rate tiers,
different real prices (e.g. "Biệt Thự 3PN Hướng Biển" at 13,850,000đ/night
vs "Tropicana 3PN" at 24,110,000đ/night for a different package). **Merging
or consolidating them, as this report originally recommended in §10, would
have destroyed real per-room pricing data.** Variant C's ablation below
(chunks removed entirely, not merged) still measures a real effect
correctly — it isolates how much these documents' *shared boilerplate* dilutes
fusion for unrelated queries — but its result must not be read as license to
merge or shrink the room-level content itself.

The actual shared element across all 10 is a single identical sentence
appended to every one of them (`server/packages.ts:432`):
`"Cũng được hỏi là: gói phòng, bảng giá, giá phòng, combo, trọn gói, bao gồm
gì, ưu đãi phòng, gói nào rẻ nhất."` — plus similarly repeated boilerplate
("Điều kiện áp dụng:", "Lưu ý: giá và điều kiện theo bảng giá công bố...").
Because this exact sentence is byte-identical in all 10 documents, it makes
every one of them BM25-relevant to any query containing "bảng giá" or "gói"
— including queries about a completely different room, or no room at all
(e.g. `package-codes`, `payment-methods`). This is a **search-alias
dilution problem, not a content-redundancy problem**. The correct fix, not
yet implemented, is to remove or make room-specific the identical alias
sentence — not to touch the priced package content itself.

| Variant | hit@1 | hit@5 | MRR | nDCG@5 |
|---|---:|---:|---:|---:|
| A (baseline) | 92.9% | 98.8% | 0.960 | 0.858 |
| B (dedupe KB/policy) | 92.9% | 98.8% | 0.960 | 0.857 |
| C (exclude rate_package) | 94.0% | 98.8% | 0.966 | 0.868 |
| D (B+C) | 94.0% | 98.8% | 0.966 | 0.869 |

Removing the rate_package chunks entirely produces a small, real
improvement (+1.1pp hit@1, +0.010 nDCG@5) — confirming they do measurably
dilute fusion — but the effect is modest at the document-collapsed level and,
as §4 shows, does not by itself translate to fixing the hardest cases in
production's actual chunk-level pick. Deduping the 3 KB/policy pairs (B) has
essentially no effect at this metric (the policy version alone already
carries the case).

## 3. RRF weight sweep

Same corpus (A), `RRF_VEC_WEIGHT` swept 0 → 1.0:

| Weight | hit@1 | hit@5 | MRR | nDCG@5 | en hit@5 | zh/ja/ko hit@5 |
|---:|---:|---:|---:|---:|---:|---:|
| 0 (lexical only) | 70.2% | 76.2% | 0.733 | 0.659 | 92.9% | **0%** |
| 0.25 | 92.9% | 98.8% | 0.960 | 0.855 | 92.9% | 100% |
| 0.5 (current) | 92.9% | 98.8% | 0.960 | 0.858 | 92.9% | 100% |
| 0.75 | 91.7% | **100%** | 0.953 | 0.860 | **100%** | 100% |
| 1.0 | 91.7% | **100%** | 0.953 | 0.860 | **100%** | 100% |

At the document-collapsed metric, 0.75–1.0 look strictly better on hit@5 (the
metric §6 of the spec weights highest) and fix the one EN case the current
weight misses, at a small cost to hit@1/MRR. **This is the result that did
not survive contact with production's real chunk-level mechanism — see §4.**

Weight 0 (BM25-only) reconfirms Part 6's finding from a different angle: it
is catastrophic for every CJK case (0% hit@5), which is why the vector leg
being on at all is non-negotiable regardless of the exact weight chosen.

## 4. Diversity-aware fusion — and why the golden-set metric was misleading

Production's `hybridSearch()` fuses and picks at the **chunk** level, with a
"max 2 chunks per source document" dedup, then truncates to
`LOCAL_PASSAGES=5`. The pre-existing golden-set evaluation harness
(`retrievalRanking()`'s `hybrid` field) instead collapses each document to
its single best-scoring chunk before ranking. These are not the same
measurement — a document can rank #1 or #2 by "best chunk" while its actual
chunks still lose the fight for a slot in production's chunk-level top-5,
if several *other* documents' chunks individually outscore it.

This was verified directly and is the most important finding of this phase.
At `RRF_VEC_WEIGHT=0.75`, the document-level golden-set metric shows
hit@5=100%. Re-running the *actual* `hybridSearch()` at that weight for the
three hardest Part 6 cases:

| Case | Golden-set doc rank @ 0.75 | Real production top-5 @ 0.75? |
|---|---|---|
| room-count | inside top-5 (doc-level) | **NO** — still misses |
| guestlist-lowseason | inside top-5 (doc-level) | **NO** — still misses |
| payment-methods | inside top-5 (doc-level) | **NO** — still misses |

Raising the vector weight raises the score of the correct document's best
chunk, but it raises the score of every *other* topically-similar chunk by
roughly the same amount — so it does not change which documents win the
5-slot competition for these particular queries. The document-collapsed
metric cannot see this because it only ever looks at one chunk per document.

A category-diversity cap was then added directly to `hybridSearch()`
(`server/retrieval.ts`, gated behind `RRF_CATEGORY_CAP`, **default off /
`Infinity`, zero behavior change unless explicitly set** — verified by
construction, not just by testing) and tested against the real production
mechanism at the current weight (0.5), cap=1 chunk per `category`:

| Case | Without cap | With `RRF_CATEGORY_CAP=1` |
|---|---|---|
| payment-methods | miss | **FIXED** — correct doc now in top-5 |
| id-required, chinese-restaurant, package-codes | already fine | still fine |
| room-count | miss | **still miss** — competes within a different, unrelated category bucket, not `rate_package` |
| guestlist-lowseason | miss | **still miss** — same reason: shares its category (`policy/booking`) with `RESERVATION_CANCELLATION`, a genuinely higher-scoring policy doc for this query, not with the rate_package chunks |
| **pets-vi** | fine (fixed by Part 6's alias fix) | **REGRESSED** — the cap, by removing a duplicate `FACILITY_HOURS` chunk, let two unrelated categories (dining, activities) fill the freed slots ahead of the CONDUCT document |

Net effect of the cap: **+1 case fixed, -1 case broken, 2 cases unaffected.**
This is exactly the outcome §5 and §9 of the spec warn against — a
configuration must not be kept for fixing target cases while damaging an
unrelated one. Diversity-aware fusion, as implemented and measured here, is
rejected.

## 5. Full regression / multilingual / latency

Because no candidate config survived §4's causality check, no config change
was carried into a full 63-case `runAgent()` regression this phase — doing
so would validate a configuration this report is not recommending. The
repeatability check (§7 below) and the retrieval-only golden set (§3, run
across zh/ja/ko explicitly) stand in as the regression evidence: the current
production weight (0.5) already scores 100% hit@5 on every CJK case, so
there is nothing to protect against here that the current config does not
already provide.

## 6. Latency

All retrieval-only variants ran in 13–34ms warm (no LLM call). Corpus dedup
variants (B/C/D) were *faster* than baseline (16–20ms vs 27ms) simply from
having fewer chunks to score — a genuine, if secondary, argument for actual
corpus cleanup in a future phase.

## 7. Repeatability

The baseline configuration was scored twice in the same process: `hit@1`,
`hit@5`, `MRR`, and `nDCG@5` were byte-identical both times
(`Identical to first run: true`). Retrieval itself is deterministic, as
expected — BM25 and cosine similarity are pure functions of the indexed
vectors, unlike the local model's greedy-decode generation step, which Part
6 found to vary run-to-run despite `temperature=0` (attributed there to
GPU floating-point non-determinism, not a code or retrieval bug). This
result reconfirms that finding by isolating retrieval from generation
entirely and showing retrieval alone has zero variance.

## 8. Causality proof (the one config that helped)

Concrete before/after for the one real improvement found this phase
(`RRF_CATEGORY_CAP=1`, current weight 0.5), payment-methods:

```
Before:
  dense rank = 1  (kb "Payment methods and bank transfer details")
  production top-5 = NO (crowded out by 4 "Gói giá phòng" chunks)
  model answer = wrong (quoted an unrelated golf-package payment clause)

After (RRF_CATEGORY_CAP=1):
  same dense rank = 1
  production top-5 = YES ("Payment methods and bank transfer details" and
                            "Payment methods and bank details (PAYMENT)"
                            both present)
  fact present in generated answer = true
```

And the one real regression it caused, pets-vi:

```
Before (no cap):
  production top-5 includes "House rules and fines (CONDUCT)" (rank 3)
  — the pets fact was reachable.

After (RRF_CATEGORY_CAP=1):
  CONDUCT drops out of the top-5 entirely — two unrelated-category chunks
  (dining, activities) fill the slots freed by capping FACILITY_HOURS'
  duplicate chunk.
```

Both are real, reproduced, chunk-level production measurements, not
projections from the document-collapsed metric.

## 9. Should this fix be forced anyway?

No. §9 of the spec is explicit: do not force a fix that trades one target
case for a regression elsewhere. A net-zero trade with added configuration
surface is not an improvement; it is a different set of failures with
identical size.

## 10. Winning configuration

**Unchanged production configuration**: `RRF_VEC_WEIGHT=0.5`,
`RRF_CATEGORY_CAP` unset (off), no reranking, no HyDE, `bge-m3`,
`qwen3.5:4b`, `LOCAL_MIN_SCORE=0.005`. The alias/chunking fix from Part 6
stays (it is a real, unambiguous, already-verified improvement, unrelated to
this phase's RRF experiments).

## 11. Why it wins

Every alternative tested either:
- improves a document-collapsed metric that does not predict production's
  actual chunk-level retrieval behavior for the hardest cases (weight
  sweep), or
- trades one fixed case for one broken case at zero net improvement
  (diversity cap), or
- helps a document-level metric modestly but was not verified to survive to
  chunk-level production picks for the cases that matter (corpus dedup
  alone).

Plain RRF at 0.5 remains the only configuration verified, by the same
chunk-level causality check applied to every alternative, not to make things
worse anywhere.

## 12. Why the rejected alternatives lose

- **RRF_VEC_WEIGHT=0.75/1.0**: wins on the golden-set document metric, loses
  on the metric that actually matters (does production retrieve the right
  chunk) for the three hardest cases; also drops hit@1/MRR slightly with no
  compensating chunk-level gain to justify the trade.
- **RRF_CATEGORY_CAP=1**: net zero (+1/-1) on the exact case set this phase
  was scoped to help, with new configuration surface and an unresolved
  interaction with the alias-duplication effect Part 6 introduced (capping
  a chunk that used to be a harmless duplicate can now cost a slot that
  mattered).
- **Corpus dedup (B/C/D)**: real but modest at the document level, unverified
  at the chunk level for the hardest cases (not tested against production's
  actual pick due to time — flagged as the correct next step, not rejected
  outright).

## 13. Is RRF still justified?

Yes, decisively. Weight=0 (BM25-only) scores 0% hit@5 on every CJK case in
this phase's sweep (§3) — the vector leg fused via RRF is what makes any
non-Latin-script guest question answerable at all. Nothing in this phase's
experiments questions hybrid RRF as the retrieval architecture; the question
was only ever the right weight and post-fusion selection rule, and the
answer there is "the current one, unchanged."

## 14. Exact production configuration (unchanged)

```
RRF_VEC_WEIGHT=0.5
RRF_LEX_WEIGHT=1        (default, unset)
RRF_CATEGORY_CAP        (unset — new toggle, off by default)
LOCAL_MIN_SCORE=0.005
LOCAL_PASSAGES=5
LOCAL_EMBED_MODEL=bge-m3
LOCAL_AGENT_MODEL=qwen3.5:4b
EMBED_PROVIDER=local
```

---

## Final classification: PASS WITH KNOWN LIMITATIONS

The phase's actual question — "can the RRF failure be fixed without
abandoning hybrid retrieval, and what is the best configuration for the
current corpus" — was answered honestly: **the best configuration is the one
already in production.** No forced change was made. Two of Part 6's three
remaining retrieval failures (room-count, guestlist-lowseason) remain
unresolved after this phase's controlled experiments; the third
(payment-methods) has a demonstrated fix (`RRF_CATEGORY_CAP=1`) that is not
being activated because it regresses a different, already-fixed case.

Recommended next step, not attempted here: **do not merge or consolidate
the 10 `rate_package` documents — each holds distinct, real per-room pricing
data and must stay intact.** The correct, narrowly-scoped fix is to remove
or make room-specific the one identical alias sentence
(`server/packages.ts:432`, `"Cũng được hỏi là: gói phòng, bảng giá, ..."`)
that is currently repeated byte-for-byte across all 10 documents and is what
actually causes them to compete for unrelated queries — a one-line, low-risk
change, unlike restructuring the priced content itself. Separately
investigate why `guestlist-lowseason` and `room-count` lose to a
same-category competitor, which the diversity cap could not distinguish
from genuine relevance.

Per the spec, stopping here — not proceeding to model comparison.
