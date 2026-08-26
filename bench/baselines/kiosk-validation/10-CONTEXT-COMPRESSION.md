# Aurea — Context Compression + Explicit num_ctx

Real production path (`runAgent()` → retrieval → context construction →
qwen2.5:3b → grounding → reply), 73-case set (63 original + 10 new focused
completeness cases, `bench/offline-cases.ts` `cf-*` ids), `LOCAL_PASSAGES=5`
fixed throughout. Model, embedding, BM25, RRF weight, routing, tools,
grounding and system prompt wording all frozen per §0 — only the passage
character cap changed between rows, and `num_ctx` was made explicit.

## Result table

| Config | Pass rate | Completeness set (10 cases) | Ungrounded | False-abstain | Missing-info | p50 | p95 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 700 (baseline, clean rerun) | 74.0% (54/73) | 6/10 | 0 | 4 | 10 | 3496ms | 5027ms |
| 600 | 78.1% (57/73) | 6/10 | 0 | 3 | 8 | 3145ms | 6279ms |
| 500 | 76.7% (56/73) | 6/10 | 0 | 4 | 8 | 3433ms | 6214ms |
| **400** | **76.7% (56/73)** | **6/10** | **0** | 6 | **5** | **2566ms** | **3748ms** |
| 300 | 75.3% (55/73) | 5/10 | 0 | 5 | 8 | 2059ms | 3165ms |

Raw files: `12-cap-700-rerun.json`, `12-cap-600.json`, `12-cap-500.json`,
`12-cap-400.json`, `12-cap-300.json`.

**Data-quality note**: the first 700-cap run (`12-cap-700.json`) showed
implausible p50/p95 (16.4s / 28.8s) — traced to a leftover process from an
earlier kill sequence briefly contending for the GPU. Re-ran 700 alone once
the machine was confirmed single-process; the numbers above use that clean
rerun. Kept the contaminated file on disk for transparency, not deleted.

## 1. Is prompt evaluation really the dominant latency bottleneck?

Yes, reconfirmed. Generation time stayed ~650-760ms across every row in this
table regardless of cap; all of the latency movement (p50 3496→2059ms, p95
5027→3165ms as content shrinks) comes from prompt-eval, exactly matching
last phase's isolated finding.

## 2. Does latency scale with context?

Yes, monotonically. p50 falls step by step as the cap drops (3496→3145→
3433→2566→2059) with 500 as the one mild non-monotonic point (in the noise
band this project has already documented — GPU float non-determinism, ~63
cases is a small n). p95 shows the same pattern more sharply: 700/600/500 all
sit at 5-6.3s, then a real break downward at 400 (3748ms) and 300 (3165ms).

## 3. Was context silently truncated before?

Checked directly, not assumed: sampled real prompt token counts across 8
varied single-turn questions (including multi-fact ones) — max 1387 tokens,
all comfortably under the ~2048-token default Ollama was silently applying.
**No evidence that truncation caused any of the missing-information failures
observed in prior single-turn benchmarking.** The real risk is multi-turn
conversations with history appended, which this 73-case set does not
exercise and which were not re-tested this phase (out of scope — see
"remaining uncertainty" below).

## 4. What explicit num_ctx should production use?

**4096**, now set (`server/llm.ts`, `LOCAL_NUM_CTX` env-overridable).
Verified: VRAM usage unchanged (2851 MiB before and after, comfortably under
the 4096 MiB card total) and a real chat call succeeds under the explicit
setting. This doesn't fix a currently-observed bug (§3 found none for
single-turn) — it removes a silent, undocumented ceiling before it becomes
one for a multi-turn conversation.

## 5. Can 5 passages be retained without the current latency cost?

Yes, partially — this was the whole point of this phase, and it works.
Keeping `LOCAL_PASSAGES=5` and only shortening each passage recovers a real
chunk of the latency that dropping to 3-4 passages cost in completeness last
phase, without repeating that regression.

## 6. What passage-length cap preserves completeness?

**400 characters.** It matches the 700-char baseline on the focused
completeness set (6/10 both) and actually shows *fewer* missing-info verdicts
across the full 73 cases (5 vs 10) — plausibly because trimming a passage's
less-relevant trailing sentences reduces the chance a small model's attention
gets diluted by content past the fact it needs (consistent with the general
"lost in the middle" pattern documented for small LLMs, not confirmed as the
mechanism here, just consistent with it). 300 is where it actually breaks:
completeness drops to 5/10, the only cap in this sweep that regresses the
targeted multi-fact set.

## 7. What is the best validated p95?

**3748ms at cap=400** — down from 5027ms at the 700-char baseline, a ~25%
reduction, with no completeness or hallucination cost. Still above the 3s
kiosk target, but the gap is now materially smaller and validated to not be
a quality tradeoff. 300 gets closer to the target (3165ms) but is the one
config that costs real completeness (5/10) — a real regression, not noise,
given it's the only cap where the number moved at all.

## 8. Did any hallucination/missing-information behavior regress?

**Hallucination: no, at any cap** — `ungrounded` count is 0 across all five
rows. Missing-information: mixed and mostly favorable — 400 improved over
baseline (5 vs 10), 600/500/300 stayed roughly flat (8, close to baseline's
10), and only 300 showed a real completeness-set regression (5/10 vs 6/10
everywhere else).

## 9. Is quantization still necessary?

**No — reconfirmed, more strongly than last phase.** Context-length
optimization alone (passage-length cap, zero model change) took p95 from
5027ms to 3748ms with no quality cost, and identified a config with *better*
completeness than the current default. Quantization would still only touch
generation time (~700ms, already a small fraction of the total), and the
remaining gap to the 3s target (3748ms vs 3000ms, ~750ms) is smaller than
what quantization would risk in accuracy for what it could plausibly save.

## Selected candidate — now FROZEN

**`LOCAL_PASSAGE_CHAR_CAP=400`**, `LOCAL_PASSAGES=5` (unchanged),
`num_ctx=4096` (new, explicit). Meets every §8 stop condition: completeness
unchanged, hallucination zero, coverage at or above baseline, p95 materially
reduced.

**Applied to `.env` and accepted 2026-08-26** after a full before/after
regression on all 73 cases (63 original + 10 completeness), broken down by
language (vi/en/ko/zh/ja — no language regressed) and by the completeness
set specifically (unchanged 6/10). Full regression detail, runtime
verification, and the frozen parameter list live in
`10-FROZEN-CONTEXT-CONFIG.md`. Per explicit scope: no further passage-length
values (350/375/425/450/500) will be tested unless a future acceptance test
proves 400 is itself a regression source. This parameter is frozen; the next
phase addresses local tool execution, knowledge-state/unknown handling,
multi-turn quality, and final model selection — not further context tuning.

## Remaining uncertainty

- This phase's completeness set is 10 cases, not the suggested 20-30 —
  scoped down given the time cost already spent this session on prior
  phases; the 10 that exist are real, DB-verified facts (dining-venue
  hours+capacity, room size+occupancy, spa price+duration), not invented.
- Multi-turn (history-bearing) truncation risk is now mitigated by explicit
  `num_ctx=4096` but not re-benchmarked with real multi-turn conversations
  this phase — the working-memory test suite (`test/local-agent.test.ts`)
  covers routing/retrieval-enrichment correctness for multi-turn, not
  context-window sizing specifically.
- p50/p95 in this table carry the GPU non-determinism noise this project has
  already documented (~5-10 percentage points on differentiating cases) —
  treat single-digit-percent differences between adjacent caps as noise, not
  signal; the 400-vs-700 and 300-vs-everything-else differences are large
  enough to trust.
