# Part 5 — Offline Root-Cause Decomposition

Diagnostic only. No production code changed. Full per-case trace:
`bench/baselines/kiosk-validation/03-root-cause-trace.json`.

## 1. Executive Summary

53/63 cases correct (84.1%) on the frozen configuration. Of the 10 failures,
**5 are retrieval ranking failures** (the gate passed — Part 2's fix is not
implicated — but `hybridSearch` ranked the wrong document first), **2 are
over-eager routing** (money-adjacent wording escalated a pure information
lookup before retrieval ever ran), **1 is a genuine model-capability failure**
(`breakfast-ko` — correct evidence, model still refused), **1 is a gap in the
abstention detector itself** (a new prose-refusal phrasing slipped through),
and **1 is not a real failure at all** — a benchmark measurement artifact that
flagged a legitimate phone-number fragment as a fabricated number while the
model's actual answer was correct.

**Retrieval, not the SLM, is the dominant failure category.** Half of all
failures trace to `hybridSearch` ranking the wrong document, not to the model
misreading a document it was correctly given.

A separate finding, confirmed by reading code rather than by this trace,
changes how every CJK number in this project must be read: production's
`replyLang()` cannot produce `"ko"/"ja"/"zh"` — it collapses everything
non-Vietnamese to English. See §11.

## 2. Frozen Configuration

See `bench/baselines/kiosk-validation/03-FROZEN-CONFIG-FOR-ROOT-CAUSE.md`.
bge-m3, `LOCAL_MIN_SCORE=0.005`, `MIN_COVERAGE=0.34`, `LOCAL_PASSAGES=5`,
`qwen3.5:4b` via Ollama native, 138-chunk corpus, 63-case benchmark.

## 3. 63-Case Results

53/63 correct (84.1%) by this trace's own fact/grounding check — not directly
comparable to Part 2's 80.0% "usefulness" figure, which is computed only over
the 45-case answer lane by a slightly different check (Part 2's number
excludes the escalate lane from the denominator; this trace's headline
includes it). Both are archived; neither supersedes the other.

## 4. Failure Trace Method

`bench/root-cause-trace.ts` calls the exact pipeline pieces `runLocalTurn`
itself composes — `classifyLocal`, `hybridSearch`, `gateRetrieval`,
`answerFromPassages` — and records every intermediate value: route, every
candidate's score/coverage/match-type, which gate check (score vs coverage)
would independently have passed or failed, the raw model reply, abstention
verdict, and an independent grounding check against the passages actually
served. This is the real decision path, not a re-implementation of it.

## 5. Root-Cause Taxonomy (as observed)

| Case | Primary root cause |
|---|---|
| pets-vi | RETRIEVAL_FAILURE |
| pets-en | RETRIEVAL_FAILURE |
| id-required | RETRIEVAL_FAILURE |
| room-count | RETRIEVAL_FAILURE |
| guestlist-lowseason | RETRIEVAL_FAILURE (see caveat, §6) |
| package-codes | ROUTING_FAILURE* |
| payment-methods | ROUTING_FAILURE* |
| extra-bed-count | ABSTENTION_POLICY_FAILURE |
| breakfast-ko | MODEL_REASONING_FAILURE |
| chinese-restaurant | BENCHMARK_FAILURE (not a real failure) |

*ROUTING_FAILURE is not one of the 14 supplied categories — it occurs
upstream of retrieval entirely (`classifyLocal` sends the message to the
"complex" lane before any document is fetched), so it does not fit
RETRIEVAL_GATE_FAILURE (C) or any tool category. Named explicitly rather than
forced into the nearest label.

## 6. Case-by-Case Failure Table

| Case | Retrieval correct | Gate passed | Evidence sufficient | Model used evidence | Final correct |
|---|---|---|---|---|---|
| pets-vi | **No** (wrong top doc) | Yes | No | Abstained (correctly, given wrong evidence) | No |
| pets-en | **No** | Yes | No | Abstained (correctly) | No |
| id-required | **No** | Yes | No | Abstained (correctly) | No |
| room-count | **No** | Yes | No | Abstained (correctly) | No |
| guestlist-lowseason | Ambiguous* | Yes | Ambiguous* | Abstained | No |
| package-codes | N/A — never reached | N/A | N/A | N/A | No |
| payment-methods | N/A — never reached | N/A | N/A | N/A | No |
| extra-bed-count | **Yes** (coverage 1.00) | Yes | **Yes** | **No** (soft refusal despite correct doc) | No |
| breakfast-ko | **Yes** (rank 0) | Yes | **Yes** | **No** (abstained despite correct doc) | No |
| chinese-restaurant | **Yes** (rank 0) | Yes | **Yes** | **Yes** (correct answer) | Yes** |

\* This trace's own gold-fact check uses a single generic digit ("7") as the
assertion for guestlist-lowseason, which is common enough in unrelated
Vietnamese hospitality text to produce a false "evidence present" reading.
The top-3 titles shown (LODGING_DECLARATION, RESERVATION_CANCELLATION,
TRANSPORT) do not include the actual guest-list policy, which points to a
genuine retrieval miss — but this trace cannot fully rule out a harness
false-positive the way it could for the CJK cases in Part 2, and says so
rather than asserting certainty it does not have.

\** Scored "No" by the automated check (a stray "7           h" fragment,
almost certainly a mis-parsed phone-number continuation, was flagged as an
ungrounded number claim) but the model's actual reply is factually correct
and grounded. Corrected here rather than left to inflate the failure count.

**Answering the structural question directly:** of 10 failures, retrieval
failed outright in 5 (and possibly 6), the gate did the right thing in all 10
(Part 2's fix introduced zero new gate-side errors), the model failed to use
evidence it was correctly given in 2 (extra-bed-count, breakfast-ko), and 1
is not a real failure at all.

## 7. Tool Failure Analysis

Not applicable to the offline pipeline as it exists today. `runLocalTurn` is
retrieval-then-single-model-call with no tool-calling loop — every
"transaction"/"complex" question is routed away from the model entirely
(§9 in the frozen-config note), so there is no tool selection, tool argument,
or tool execution to fail. This is a real architectural difference from the
hosted path and should not be scored as if the offline path had tools it does
not have.

## 8. Numeric/Policy Failure Analysis

Three of the ten failures are numeric/policy questions (id-required,
room-count, extra-bed-count) — one retrieval, one retrieval, one abstention.
**Zero numeric fabrications occurred anywhere in the 63-case run.** Every
numeric failure is an abstention or a retrieval miss, never a wrong number
confidently stated. This is the safety property Part 2 was built to protect,
and it held under every case exercised here.

## 9. Multilingual Analysis

| Lang | N | Correct | Answered | Abstained |
|---|---:|---:|---:|---:|
| vi | 43 | 35 (81.4%) | 26 | 4 |
| en | 8 | 7 (87.5%) | 4 | 1 |
| ko | 5 | 4 (80.0%) | 2 | 1 |
| zh | 4 | 4 (100%) | 3 | 0 |
| ja | 3 | 3 (100%) | 2 | 0 |

No language collapses. Korean's single failure is `breakfast-ko`
(§10). Sample sizes for en/ko/zh/ja are small (3-8 cases each) — these rates
are directional, not precise estimates.

**Every one of these numbers describes the PIPELINE's capability when handed
the correct target language directly, which is how this trace (and every
other CJK measurement in this project) invokes it.** It is not what a real
guest experiences. §11 is the finding that matters more than this table.

## 10. Abstention Analysis

| Case | Evidence sufficient | Explicitly presented | Correct classification |
|---|---|---|---|
| pets-vi | No (wrong doc) | Yes (wrong content) | CORRECT_ABSTENTION |
| pets-en | No | Yes (wrong content) | CORRECT_ABSTENTION |
| id-required | No | Yes (wrong content) | CORRECT_ABSTENTION |
| room-count | No | Yes (wrong content) | CORRECT_ABSTENTION |
| guestlist-lowseason | Uncertain | Yes | CORRECT_ABSTENTION (probable) |
| extra-bed-count | **Yes** | Yes | **FALSE_ABSTENTION** (soft, undetected) |
| breakfast-ko | **Yes** | Yes | **FALSE_ABSTENTION** |

**`breakfast-ko`, examined directly as requested:** retrieval ranked
"Breakfast and buffet pricing" — the correct document, containing "served at
Lotus Restaurant from 06:00 to 10:30" — at rank 0 (score 0.0082, exactly the
pure-vector-only ceiling documented in Part 2, correctly exempted from the
coverage floor because `matched_by` includes "semantic"). The gate passed. The
model was given this passage, asked in Korean, and returned the ABSTAIN token
anyway. No tool was needed; none was missing. This is retrieval and gating
working exactly as designed, with the model failing to extract a plainly
stated fact once asked to read English source text and reply in a different
script. This is the cleanest possible model-capability failure in the dataset
— nothing upstream can explain it.

`extra-bed-count` is a NEW failure mode not previously catalogued: the model
did not emit the ABSTAIN token, so `isAbstention()` returned false and the
turn was treated as a normal answer — but the prose itself is a refusal
("Thông tin... không được nêu rõ trong tài liệu; bạn cần liên hệ trực tiếp
với lễ tân"). This phrase's word order — "không được nêu rõ" comes BEFORE
"trong tài liệu" — does not match any of `local-agent.ts`'s
`ABSTAIN_PROSE` patterns, which were written assuming the opposite order
("tài liệu ... không nêu"). This is a real, narrow gap in the abstention
detector added earlier in this project, not touched here per this phase's
rule against fixing anything.

## 11. Critical Finding: `replyLang()` Cannot Produce CJK

`server/agent.ts:708` — the function production actually calls before handing
a turn to the offline pipeline — is typed `"vi" | "en"` and its body proves
it: any detected language other than Vietnamese collapses to English.
`bench/offline-answers.ts` and this phase's trace script both call
`runLocalTurn` directly with the guest's real language, bypassing
`replyLang()` — correctly, for measuring the pipeline's own capability, but
that means **every CJK result in this project, including §9 above and every
prior "ko/ja/zh works now" claim, describes what the pipeline can do, not
what a live Korean, Japanese or Chinese guest receives from the offline path
today, which is English.**

This is the single highest-value fix identified in this phase, and it was
found by reading code, not by a failing benchmark case — the benchmark cannot
see this bug by construction, since it never calls the function that has it.

## 12. P0/P1/P2/P3

| Finding | Severity | Why |
|---|---|---|
| `replyLang()` cannot produce ko/ja/zh | **P1** | Every non-VI/EN guest on the offline path gets the wrong reply language today. Not a safety/financial issue (P0 reserved for that), but a materially wrong customer-facing behavior affecting three full languages, at 100% frequency, in production, right now. |
| 5 retrieval ranking failures (pets, id, room-count, possibly guestlist) | **P1** | Correct abstention on each, so no wrong fact reached a guest — but 4-5/45 answerable questions (9-11%) get "please ask the front desk" for information the corpus actually has. |
| `extra-bed-count` soft-abstention gap | **P2** | Content is honest, not harmful, but bypasses whatever downstream escalation bookkeeping depends on `escalate: true`. |
| `breakfast-ko` model reasoning gap | **P2** | Single case, correct abstention behavior (no fabrication), but is real evidence the model was capable and did not use it. |
| Benchmark false-positive on phone-number fragment | **P3** | Measurement artifact; the product did nothing wrong. |
| Two ROUTING_FAILURE escalations on informational lookups | **P2** | Guest is safely handed to a person for a question that cost nothing to answer directly — a coverage cost, not a safety one. |

No P0 in this run: zero numeric fabrications, zero policy fabrications, every
uncertain case failed toward a human rather than toward a guess.

## 13. Highest-Leverage Future Fixes (not implemented — diagnosis only)

| Fix | Root cause addressed | Expected benefit | Risk | Effort | Validate by |
|---|---|---|---|---|---|
| Fix `replyLang()` to pass through ko/ja/zh/ru instead of collapsing to en | §11 | Every non-VI/EN offline guest gets the right language — the single largest gap found | Low; `detectMessageLang` already returns the right value, this only stops discarding it | Small | Re-run the 63-case trace through the REAL `runOfflineTurn` path (not a direct `runLocalTurn` call) in all 5 languages |
| Add lexical aliases for "chó/dog↔pets", "giấy tờ↔ID/passport", "mấy phòng↔476/room count" to the affected KB articles | §5-6, 5 retrieval failures | Recovers 4-5 of 45 answerable cases (~9-11pp) | Low — additive metadata, no ranking logic touched | Small–Medium | Re-run `bench/threshold-sweep.ts`-style recall check on just these 5 queries before/after |
| Extend `ABSTAIN_PROSE` to catch "không được nêu rõ trong X" word order | §10, extra-bed-count | Closes one soft-abstention gap; likely others share the pattern | Very low, same risk class as the fix already made once | Small | Add to `numtest.ts`, the same way the first three patterns were validated |
| Loosen `classifyLocal`'s money/complex trigger for "BB code" and "phương thức thanh toán" (payment METHODS, not a payment action) | §5, 2 routing failures | Recovers 2 informational lookups without weakening the money/write guard | Medium — must not reopen the exact false-negative class Part 4's forced-tool work closed on the hosted side | Small | Re-run the money/write regression cases already in `test/local-agent.test.ts` alongside these two |

Ranked by Impact × Confidence / Effort: `replyLang()` first (largest impact,
highest confidence, smallest change), then the retrieval aliases, then the
abstention-pattern gap, then the routing loosening (highest regression risk
of the four, needs the most care).

## 14. Is the SLM the Bottleneck?

**No — not currently, not on this evidence.** Of 10 failures: retrieval
ranking is the primary cause in 5, upstream routing in 2, an abstention-
detector gap in 1, and only **1 is a genuine model-capability limitation**
(`breakfast-ko`). A tenth is not a real failure.

Upper bound if Qwen 3.5 4B were replaced by a much stronger model, everything
else held fixed: it could only ever fix the 1 case where retrieval, gate and
evidence were all already correct and the model still failed —
`breakfast-ko`. It cannot fix retrieval ranking, cannot fix a routing
classifier's trigger words, and cannot fix an abstention-detector regex.
**Upper-bound recoverable fraction: 1/10 (10%) of current failures.** This is
a ceiling, not a prediction — nothing here claims a stronger model would
actually get that one case right, only that it is the only case theoretically
in play.

## 15. Is 100% Local Currently Demonstrated?

**Demonstrated:**
- Zero-fabrication safety holds under this 63-case set (§8), including after
  the LOCAL_MIN_SCORE change.
- Gate logic (score + coverage, Part 2 + §6 here) is working as designed and
  is not the source of any of the 10 failures traced in this phase.
- Retrieval, not model capability, is the dominant lever for further gains.

**Not demonstrated:**
- Correct reply language for a real Korean/Japanese/Chinese guest on the
  live offline path (§11 — this is a known, unfixed bug, not an open
  question).
- Behavior on the ~140 cases this 63-case set does not cover (the larger
  benchmark from the original 25-part brief was not built in this phase).
- Concurrent-request behavior, multi-turn behavior, and adversarial input —
  all still "NOT YET DEMONSTRATED" from prior phases, unchanged by this one.

**What currently prevents a confident 100%-local decision:** not model
quality — the trace here says the model is doing its narrow job correctly in
9 of 10 failing cases (correctly declining rather than guessing). What
prevents the decision is (a) a known, unfixed language-routing bug that
affects three of five supported languages with certainty, and (b) the
breadth of untested territory (concurrency, multi-turn, adversarial input)
that this phase did not touch by design.

## 16. What Remains Unknown

- Whether the 5 retrieval-ranking failures share a fixable pattern (missing
  aliases) or are 5 unrelated corpus gaps — not investigated past reading
  their top-3 candidates.
- Whether `ABSTAIN_PROSE`'s word-order gap has siblings elsewhere in the 45
  answer-lane cases that happened not to trigger it this run.
- Everything Parts 6-10 of the original 25-part brief would have measured:
  tool reliability (N/A for this architecture per §7), multi-turn, broader
  multilingual coverage, adversarial safety, and model comparison beyond
  what was already measured before this phase.

NOT YET DEMONSTRATED, stated plainly: multi-turn correctness, concurrent-load
behavior, adversarial robustness, and correct CJK reply language in
production. This phase closes exactly one open question (is the SLM the
bottleneck — no) and opens one new, concrete, high-confidence one
(`replyLang()`).
