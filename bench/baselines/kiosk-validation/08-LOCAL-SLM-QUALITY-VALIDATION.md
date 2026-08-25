# Aurea — Phase 8: Local SLM Quality, Coverage, Multi-Turn & Speed Validation

Status: **qwen2.5:3b — YELLOW. qwen3.5:4b — YELLOW.** Neither is GREEN. Both produced a confirmed, reproducible hallucination on a specific hours/time fact during this phase.

Models tested: **qwen2.5:3b and qwen3.5:4b only**, per explicit user instruction ("làm 2 model trước đi, mai test 2 model kia sau" — do these two now, test llama3.2:3b/gemma2:2b tomorrow). Their absence here is a scheduling decision, not a gap in this report.

---

## Headline findings (read this first)

1. **A pre-existing routing defect, not model quality, explains most of this phase's raw score.** `classifyLocal()` (`server/local-agent.ts`) routes a question to `"complex"` or `"transaction"` — which short-circuits straight to escalation with **zero retrieval and zero LLM calls** (lines 497-517) — whenever its `hardMoney` heuristic fires. Traced directly (not inferred): 49 of the 102 new Phase 8 cases (48%) hit this path, including entirely safe, static, KB-answerable questions like *"Thuế VAT áp dụng bao nhiêu phần trăm?"* and *"Deluxe giá bao nhiêu?"*. This happens identically for both models because it happens **before either model is invoked**. It is the single highest-priority product finding of this phase. Per the phase's explicit freeze on routing, it was **not fixed** — only documented.
2. **Both models produced one confirmed, reproducible hallucination each**, on the same kind of fact (restaurant/bar operating hours), found by manually reading replies and then verified by rerunning the case a second time:
   - **qwen3.5:4b** on `q-beachcomber-hours`: stated *"Beach Comber Bar mở cửa từ 09:00 đến 18:00"* — the real closing time is **23:00**. Identical wrong answer both runs.
   - **qwen2.5:3b** on `q-lotus-slots`: stated Lotus Restaurant serves *"từ 07:00 đến 21:00"* as one continuous block — the real schedule is **three separate slots**, 06:00–10:30, 12:00–14:30, 18:00–22:00. Identical wrong answer both runs.
   This is symmetric and serious: neither model is hallucination-free, and per the decision rule (reject unacceptable hallucination before comparing quality), this alone caps both models at YELLOW.

---

## 1. Models tested

| Model | Status this phase |
|---|---|
| qwen2.5:3b | Fully benchmarked |
| qwen3.5:4b | Fully benchmarked |
| llama3.2:3b | Deferred to a following session, by explicit user instruction |
| gemma2:2b | Deferred to a following session, by explicit user instruction |

## 2. Frozen architecture

Identical across every run this phase: BM25, `bge-m3`, `RRF_VEC_WEIGHT=0.5`, `LOCAL_MIN_SCORE=0.005`, `LOCAL_PASSAGES=5`, current `classifyLocal` routing (unfixed, see headline #1), current numguard, current tool schemas, current system prompt. Only `LOCAL_AGENT_MODEL` varied.

## 3. Benchmark composition

- **165 total quality cases**: the existing 63 (`bench/offline-cases.ts`) + **102 new** (`bench/quality-cases.ts`), against the spec's ~150 target — reached and slightly exceeded, not padded to a round number.
- New cases span property, rooms, dining, facilities, policy, check-in/out, occupancy, transport, packages, payment/numeric, insufficient-evidence, out-of-scope, ambiguous, multi-fact reasoning, and colloquial-paraphrase categories, every fact copied verbatim from the live KB/policy corpus before being written (no invented expected facts).
- **Multi-turn: 20 conversations**, up from the original 10, against the spec's ~30 target — an honest partial expansion, disclosed rather than silently short of the mark.
- **Safety: 18 cases, reused from Phase 7 unchanged**, per this phase's own instruction to keep safety as a minimum baseline, not the focus.
- Concurrency and context-length probes are new instrumentation, not correctness-scored.

## 4–5. Answerable coverage & precision

Raw (before separating the routing defect):

| | qwen3.5:4b | qwen2.5:3b |
|---|---:|---:|
| 102-case quality set | 48/102 (47.1%) | 44/102 (43.1%) |

**This raw number is not a clean model-quality signal.** 52 of the 102 cases were failed by *both* models; of those, the large majority are the routing-defect cases from headline finding #1 (verified: all 49 routing-defect case IDs appear inside the 52 shared-failure set). Excluding the 52 shared-failure cases, the **model-attributable comparison** on the 50 cases where the models' outcomes actually differed or both succeeded:

| | qwen3.5:4b | qwen2.5:3b |
|---|---:|---:|
| Model-attributable score | 48/50 (96%) | 44/50 (88%) |
| Real (non-scorer-artifact) unique failures | 2 (`q-room-floors`, `q-beachcomber-hours`) | 5 (`q-imperial-hilltop`, `q-room-minibar`, `q-balcony-which-room`, `q-lotus-slots`, `q-data-not-sold`) |
| Scorer-artifact unique failures | 0 | 1 (`q-cablecar-record` — reply correctly said "kỷ lục thế giới" / world record but didn't literally say "Guinness"; substantively correct, wrongly marked wrong by an over-strict expect-list) |

Every one of the 8 differentiating cases was read in full and, for the reproducibility check, rerun a second time (§14) before being classified — none of this table is taken from the raw verdict labels alone.

This **reverses the ranking from Phase 7's 63-case result**, where qwen2.5:3b led (88.9% vs 82.5%). On this larger, harder set, qwen3.5:4b is the more accurate model once the shared routing-defect noise is removed. Two things are true at once: qwen2.5:3b answers correctly more often on simple, well-trodden questions (the original 63); qwen3.5:4b extracts and synthesizes facts more reliably on harder, more varied phrasing (the new 102) — including two cases (`q-room-minibar`, `q-balcony-which-room`) where both models received the same frozen retrieval but qwen3.5:4b picked the right source document and qwen2.5:3b answered from an irrelevant villa-specific one.

## 6. Completeness

Multi-fact cases (`expect` with 2+ required groups) in the 102-case set, fraction of required fact groups present (not binary):

| | qwen3.5:4b | qwen2.5:3b |
|---|---:|---:|
| `q-breakfast-complete` (hours + child price) | 0/2 groups (false abstention — a routing-defect case) | 0/2 groups (false abstention — a routing-defect case) |
| `q-lotus-slots` (3 time slots) | 3/3 (correct on rerun) | 1/3 (hallucinated a single wrong slot) |
| `q-synth-checkin-id` (ID + child birth cert) | correct once past the routing gate | correct once past the routing gate |

Completeness could not be cleanly measured for most multi-fact cases because several were themselves routing-defect casualties before either model got a chance to demonstrate partial or full completeness. This is a direct downstream cost of headline finding #1: the routing defect doesn't just cause false abstention, it also erases the ability to measure completeness on exactly the multi-fact questions completeness testing needs most.

## 7. Groundedness

No claim in either model's correct answers was found ungrounded in the retrieved evidence (numguard's `ungrounded` flag was empty on every "correct" verdict across both 102-case runs). Groundedness failures that did occur are exactly the two hallucinations in §8.

## 8. Hallucination (including critical hallucination)

**Both models: 1 confirmed critical hallucination each**, both in the time/hours category:

| Model | Case | Stated (wrong) | Actual | Reproduced on rerun? |
|---|---|---|---|---|
| qwen3.5:4b | `q-beachcomber-hours` | 09:00–**18:00** | 09:00–**23:00** | Yes, identical both runs |
| qwen2.5:3b | `q-lotus-slots` | 07:00–**21:00** (single block) | 06:00–10:30, 12:00–14:30, 18:00–22:00 (three slots) | Yes, identical both runs |

No fabricated money, policy, availability, or membership-benefit claim was found for either model in this phase's 102-case set. Both hallucinations are time-fact fabrications, both stable across a repeat run — this is not sampling noise, it is a real generation failure mode present in both candidates.

## 9. Multilingual results

From the combined 63+102 case pool (raw, includes routing-defect cases which affect all languages roughly proportionally since the `hardMoney` heuristic isn't language-specific):

| Language | qwen3.5:4b (63-case, Phase 7) | qwen2.5:3b (63-case, Phase 7) |
|---|---:|---:|
| VI | 35/43 | 37/43 |
| EN | 7/8 | 7/8 |
| ZH | 4/4 | 4/4 |
| JA | 3/3 | 3/3 |
| KO | 3/5 | 5/5 |

Unchanged from Phase 7 — the 102-case set's multilingual cases were too few per language (5-8 CJK cases total) and too routing-defect-contaminated to produce a statistically meaningful update to these per-language numbers this phase. Treat Phase 7's language table as still current; no evidence this phase changes it.

## 10. Multi-turn results

**Tied: 25/41 scored turns correct, both models**, across the expanded 20-conversation set. 13 of 16 failed turns are byte-identical between the two models; the remaining 3 pairs of differing failures roughly cancel out. Two conversations (`mt-date-change`, `mt-tool-followup`) show the same routing defect from headline #1 firing on follow-up turns phrased as price/percentage questions ("phí thế nào?", "giá bao nhiêu?") — multi-turn is dominated by the same shared architectural issue as the main quality set, not by a model-specific multi-turn weakness.

## 11. Latency (real production path + context-length relationship)

Main-benchmark latency, unchanged from Phase 7 (this phase's 102-case set has too much routing-defect short-circuiting to produce a clean latency comparison — most "fast" responses in it are 0-LLM-call escalations, which would misleadingly deflate latency if used):

| | qwen3.5:4b | qwen2.5:3b |
|---|---:|---:|
| p50 | 11,979 ms | **4,661 ms** |
| p95 | 20,337 ms | **6,467 ms** |

**New: context-length relationship**, measured with Ollama's native timing telemetry across ~300/600/900/1300/1800-token contexts, 2 samples each (warm cache on the 2nd sample of each bucket):

| | qwen3.5:4b | qwen2.5:3b |
|---|---|---|
| Generation time (warm, similar output length) | 8,500–18,500 ms | 350–650 ms |
| Prompt-eval (prefill) time (warm) | 200–230 ms | 16–18 ms |
| Latency dominated by | **Generation** (not context length) | Generation (much smaller absolute cost) |

This directly and causally explains the latency gap: qwen3.5:4b's *generation* step — not prefill, not context length — is 15-30x slower than qwen2.5:3b's for comparable output lengths. §12 shows why: qwen3.5:4b runs partially on CPU.

## 12. Hardware fit

Unchanged from Phase 7 (measured via `ollama ps` while warm):

| | qwen3.5:4b | qwen2.5:3b |
|---|---|---|
| Loaded size | 3.7 GB | 2.2 GB |
| GPU/CPU split | **52% CPU / 48% GPU** | **100% GPU** |

## 13. Preliminary concurrency (new)

1/2/4 concurrent `runAgent()` calls, real production path:

| Concurrency | qwen3.5:4b p50 | qwen3.5:4b throughput | qwen2.5:3b p50 | qwen2.5:3b throughput | Errors |
|---:|---:|---:|---:|---:|---:|
| 1 | 15,482 ms | 0.065/s | 5,391 ms | 0.185/s | 0 (both) |
| 2 | 17,132 ms | 0.116/s | 5,024 ms | 0.39/s | 0 (both) |
| 4 | 26,228 ms | 0.091/s | 6,277 ms | 0.363/s | 0 (both) |

Neither model errored at any tested concurrency level. Neither shows anywhere close to linear throughput scaling — a single Ollama instance serializes GPU access, so 4-way concurrency mostly produces queueing, not parallel throughput, for both. qwen2.5:3b's absolute throughput is consistently ~3-4x qwen3.5:4b's at every concurrency level, tracking its per-request latency advantage.

## 14. Repeatability

Reran all 8 quality-set cases where the two models' outcomes differed, once each, for both models (16 reruns total — a reduced-scope check, not the spec's full 20-case ×2 subset, disclosed):

- **6 of 8 stable**: identical reply/verdict on rerun, including both hallucinations (§8) — confirmed real and reproducible, not one-off noise.
- **2 of 8 flipped**: qwen2.5:3b's `q-room-floors` (correct → a different, also-wrong answer) and `q-cablecar-record` (missing "Guinness" → present). Consistent with the GPU floating-point non-determinism already established in Part 6 even at `temperature=0`. **Treat the exact case counts in §5 (44 vs 48, 96% vs 88%) as approximate, not precise to the case** — the qualitative finding (qwen3.5:4b more accurate on this harder set; both hallucinate once) is robust to this noise, the exact percentages are not.

## 15. Safety sanity-check

Reused unchanged from Phase 7 (18 cases): both models 17/18 raw-flagged, both manually verified — qwen3.5:4b's flag was a false positive (a correct refusal that happened to contain "system prompt"), qwen2.5:3b's was a confirmed real jailbreak compliance (`policy-override-vi`). Not rerun this phase per the "minimum baseline, do not turn this into a security phase" instruction.

## 16. Failure taxonomy

| Cause | Example | Model-selection relevant? |
|---|---|---|
| Routing defect (`classifyLocal` hardMoney over-broad) | 49/102 cases, e.g. `q-vat-rate`, `q-deluxe-price` | **No** — identical for both models, fix belongs to a future routing phase |
| Wrong-document retrieval (same for both models, different synthesis outcome) | `q-room-minibar`, `q-balcony-which-room` | Partially — retrieval served the same noisy evidence to both; qwen3.5:4b synthesized correctly from it, qwen2.5:3b did not |
| Genuine hallucination | `q-beachcomber-hours` (4b), `q-lotus-slots` (3b) | **Yes — one each, symmetric** |
| False abstention despite adequate evidence | `q-submarine`, `q-data-not-sold` (3b only) | Yes for 3b's instance |
| Scorer over-strictness | `q-cablecar-record` (3b), `q-imperial-hilltop`'s exact wording requirement | No — benchmark artifact |

## 17. Pareto comparison

- **qwen2.5:3b**: dominant on latency (2.5-4x faster at every concurrency level) and hardware fit (100% GPU vs 52% CPU-offload); behind on the model-attributable accuracy of the harder 102-case set (88% vs 96%); ties on multi-turn and safety (both 1 real issue).
- **qwen3.5:4b**: more accurate on harder/varied phrasing; loses heavily on latency and hardware fit, which matters directly for a kiosk device; ties on hallucination and multi-turn.

Neither Pareto-dominates the other this phase — this is a genuine trade-off, unlike Phase 7's cleaner one-sided result.

## 18. Candidate ranking

**qwen2.5:3b — YELLOW.** Confirmed hallucination (`q-lotus-slots`, reproduced) plus the pre-existing safety finding from Phase 7 are each independently enough to withhold GREEN, regardless of its latency/hardware advantage. Still the stronger candidate for a latency-constrained kiosk if the hallucination and safety issues get fixed.

**qwen3.5:4b — YELLOW.** Confirmed hallucination (`q-beachcomber-hours`, reproduced) withholds GREEN despite a clean Phase 7 safety sweep and better accuracy on the harder benchmark. Its CPU-offload latency (12s p50, 20s p95) is a real practical concern for a kiosk regardless of accuracy.

Neither model earns GREEN this phase. This is the correct, non-self-praising outcome given a confirmed, reproduced hallucination in each.

## 19. Remaining uncertainties

1. **The routing defect (headline #1) needs its own investigation and fix** before either model's quality can be measured cleanly on question phrasings involving price, percentage, or quantity words — it currently discards ~48% of such questions before any model or retrieval logic runs.
2. **llama3.2:3b and gemma2:2b are still unevaluated**, deferred to the next session by the user's own choice.
3. **Repeatability (§14) shows real per-case noise** (~25% of the differentiating cases flipped on a single rerun) — the exact accuracy gap between models should be treated as approximately 5-10 percentage points on the harder set, not precisely 8.
4. **Multi-turn is currently uninformative for model selection** — it is dominated by the same routing defect as the main benchmark, not by genuine multi-turn reasoning weaknesses. A clean multi-turn comparison requires the routing fix first.
5. **Only one hallucination each was found** — not enough to estimate a reliable hallucination rate for either model; a larger targeted hours/pricing stress-test would tighten this.
6. **Completeness (§6) could not be cleanly measured** for the reason given there — most multi-fact cases were casualties of the routing defect before completeness could even be tested.

## 20. Recommended candidate

**Neither model is recommended for final acceptance yet.** Both are YELLOW: real, reproduced, still-open defects exist on each (a hallucination on both; a safety gap on qwen2.5:3b specifically). The most valuable next step is not picking between them — it's fixing the routing defect (headline #1), which is corrupting the measurement for both, and re-running this exact 165-case suite afterward for a clean comparison.

---

## Final questions, answered directly

1. **Which model is currently best for Aurea's real hotel workload?** Neither is unconditionally best. qwen2.5:3b is a better fit for kiosk latency and hardware constraints; qwen3.5:4b is more accurate on harder, more varied phrasing. Both carry an open, reproduced hallucination.

2. **Is qwen2.5:3b still superior to qwen3.5:4b after expanded testing?** **No, not cleanly.** On the original 63-case set it still leads. On the new, harder 102-case set, once the shared routing-defect noise is excluded, qwen3.5:4b is more accurate (96% vs 88% model-attributable, ±noise per §14). This is the clearest reversal in this project's model-comparison history and should not be smoothed over.

3. **Does the smaller model actually maintain answer quality while being faster?** Partially. It maintains quality on simple, well-trodden questions; it does not maintain quality on harder synthesis/paraphrase questions, where it more often picked the wrong source document or omitted required facts.

4. **Does it answer more of the questions it SHOULD answer?** Roughly the same as qwen3.5:4b once the routing-defect cases (which block both models equally) are excluded — see §5.

5. **Does it omit fewer critical facts?** No evidence either way from this phase — both had 5 vs 2 real unique failures with genuine fact omissions, favoring qwen3.5:4b, but the sample (8 differentiating cases) is small.

6. **Does it perform well in multi-turn conversations?** Tied with qwen3.5:4b (25/41 both) — multi-turn is not currently a useful differentiator; see remaining uncertainty #4.

7. **Is its latency acceptable for a kiosk?** qwen2.5:3b's (4.7s p50, 100% GPU) is much closer to kiosk-acceptable than qwen3.5:4b's (12s p50, 52% CPU-offloaded). Neither has been validated against a defined kiosk latency SLA.

8. **Is there evidence that a larger model is actually necessary?** **Some, for the first time this project.** qwen3.5:4b's edge on the harder 102-case set (2 real failures vs 5) is real evidence, though the sample is small and both models still hallucinated once. This is weaker evidence than "necessary" — it's evidence that size may help on harder phrasing, not proof it's required.

9. **What failures are still caused by the model after retrieval/tool failures are separated?** For qwen3.5:4b: 1 extraction failure (`q-room-floors`) + 1 hallucination. For qwen2.5:3b: 1 vacuous-answer failure (`q-imperial-hilltop`), 2 wrong-document-synthesis failures, 1 false abstention, 1 hallucination.

10. **What prevents us from selecting the local model for final acceptance?** Two things, independent of which model: (a) the routing defect, which must be fixed before quality can be measured cleanly at all, and (b) a confirmed, reproduced hallucination in whichever model would otherwise be selected — hallucination is explicitly the first thing the decision rule says to reject on, ahead of any accuracy or latency advantage.

Not declaring production-readiness. Per the phase's stop condition: no fine-tuning, no retrieval/routing changes (including the routing defect just found), no per-model prompt changes, and not proceeding to llama3.2:3b/gemma2:2b this session.
