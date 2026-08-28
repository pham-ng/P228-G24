# Aurea — RELEASE-GRADE LOCAL MODEL EVALUATION REPORT (v2)

> **Production Readiness Status:** 🔴 **RED — NOT READY FOR ENTERPRISE DEPLOYMENT**
> **Evaluation Date:** August 28, 2026
> **Evaluated Target:** Local Concierge Engine (`qwen3.5:4b` Q4_K_M via Ollama)
> **Hardware Target:** NVIDIA GeForce GTX 1650 Ti (4 GB VRAM) / Intel Core i7
> **Harness:** `bench/final-eval-v2.ts` — frozen case set, pre-declared rules, no retries
> **Superseded:** `FINAL-LOCAL-PRODUCT-EVALUATION.md` (different model, different code, different scorer — see §8)

---

## 1. Release Gate Verdict

Full frozen set: **403 atomic cases + 60 multi-turn conversations (188 turns) = 591 evaluated turns**, five production languages.

| Quality Gate | Target | Measured | Status |
| :--- | :--- | :--- | :--- |
| **Critical fabrication rate** | 0.0% | **0.0%** (0/403) | ✅ **PASS** |
| **Answerable usefulness (strict)** | ≥ 80.0% | **35.0%** (79/226) | ❌ **FAIL** |
| **Answerable usefulness (lenient)** | — | 50.4% (114/226) | — |
| **Knowledge-state accuracy** | ≥ 85.0% | **65.0%** | ❌ **FAIL** |
| **Safety / escalation reliability** | ≥ 95.0% | **83.1%** (74/89) | ❌ **FAIL** |
| **Multilingual language purity** | ≥ 95.0% | **99.8%** | ✅ **PASS** |
| **Latency p95 (warm)** | ≤ 10,000 ms | **9,710 ms** | ✅ **PASS** |

**Classification: 🔴 RED.** Three gates fail. The system is safe — it invents nothing — but it is not yet useful enough to answer a guest without supervision.

---

## 2. Frozen Configuration

- **LLM:** `qwen3.5:4b` (Q4_K_M, 3.73 GB) — **100% GPU resident** via `LOCAL_NUM_GPU=36`
- **Embeddings:** `bge-m3` (1024-d, 664 MB) — **CPU** via `LOCAL_EMBED_NUM_GPU=0`, freeing VRAM for the LLM
- **Context:** `num_ctx=4096`, `keep_alive=forever`
- **Retrieval:** BM25 (diacritic-folded) + bge-m3, RRF; `LOCAL_MIN_SCORE=0.005`, `LOCAL_PASSAGES=5`, `LOCAL_PASSAGE_CHAR_CAP=400`
- **Intent net:** enabled (`LOCAL_INTENT_NET=1`), margin 0.15
- **Corpus:** 136 indexed chunks, 68 rate packages
- Nothing else ran on the machine during measurement (a parallel `npm test` was previously measured moving p50 from 6.6 s to 8.9 s)

---

## 3. Where the Failures Are

| Failing layer | Count | What it means |
| :--- | ---: | :--- |
| **GATE** | 60 | An answerable question was escalated to a human |
| **MODEL_REASONING** | 52 | Answered, but none of the expected facts appeared |
| **MODEL_COMPLETENESS** | 35 | Answered with SOME expected facts, nothing fabricated |
| **SAFETY** | 15 | Should have escalated, did not |
| **AMBIGUITY** | 12 | Bare fragment answered instead of clarified |
| **KNOWLEDGE_STATE** | 2 | Answered confidently about something not in the corpus |

**The largest bucket is conservatism, not error.** Those 60 GATE failures produced no wrong answer — the guest was handed to a person. On a hotel floor that is a staffing cost, not a trust incident. The 52 MODEL_REASONING failures are the ones that matter for usefulness.

Only **15 turns** were genuinely unsafe, and **zero** produced a fabricated figure.

---

## 4. By Question Type

| Expected behaviour | n | Correct |
| :--- | ---: | ---: |
| `unknown` (must admit ignorance) | 62 | **96.8%** |
| `escalate` (must reach a human) | 89 | **83.1%** |
| `ambiguous` (must ask back) | 26 | 53.8% |
| `answerable` (must answer correctly) | 226 | **35.0%** |

The pattern is consistent: **the system knows what it does not know (96.8%) far better than it answers what it does know (35.0%)**. That is the safe direction to be wrong in, and it is also why the product is not yet useful — a concierge that defers most questions is a very expensive routing layer.

---

## 5. By Language

| Lang | n | Correct | Reply in the right language |
| :--- | ---: | ---: | ---: |
| zh | 65 | **64.6%** | 98.5% |
| vi | 142 | 59.9% | 100.0% |
| en | 66 | 59.1% | 100.0% |
| ko | 67 | 49.3% | 100.0% |
| **ja** | 63 | **44.4%** | 100.0% |

Language purity is effectively solved (99.8% overall). **Answer quality is not evenly distributed**: Japanese trails Chinese by 20 points on the same corpus and the same retrieval. This is a content/generation gap, not a routing one, and it is the clearest single lead for the next remediation phase.

---

## 6. By Category (worst first)

| Category | n | Correct |
| :--- | ---: | ---: |
| FACTUAL | 141 | **35.5%** |
| MULTI_FACT | 38 | 36.8% |
| PRICING | 71 | 46.5% |
| AMBIGUITY | 26 | 53.8% |
| CONFLICTING | 10 | 60.0% |
| SAFETY_ESCALATION | 62 | 88.7% |
| UNKNOWN_BOUNDARY | 55 | **100.0%** |

`FACTUAL` is both the largest category and the weakest — 141 ordinary "what time / where / does the resort have" questions answered correctly a third of the time. `UNKNOWN_BOUNDARY` at 100% confirms the abstention machinery works perfectly.

---

## 7. Overfitting Check & Latency

| Split | n | Correct | Partial |
| :--- | ---: | ---: | ---: |
| Development (70%) | 283 | 56.2% | 9.2% |
| Holdout (30%) | 120 | **56.7%** | 7.5% |

Holdout tracks development within 0.5 points — no sign the visible set has been fitted.

**Latency:** p50 **6.00 s** · p90 8.39 s · p95 **9.71 s** · p99 19.33 s · max 29.30 s.
39 turns escalated in under 0.5 s with zero model calls (deterministic routing).
Multi-turn p95 is 25.43 s — conversation history inflates the prompt and is the worst-felt latency in the product.

**Multi-turn:** 152/188 turns correct (80.9%); 34/60 conversations correct end-to-end (56.7%).

---

## 8. Why This Report Does Not Compare Directly to the Previous One

The earlier `FINAL-LOCAL-PRODUCT-EVALUATION.md` reported 28.8% answerable usefulness and 0.5% fabrication. Three things differ, and pretending otherwise would be misleading:

1. **Different model** — `qwen2.5:3b` there, `qwen3.5:4b` here.
2. **Different code** — routing, context compression, room pricing, abstention detection and multilingual handling all changed.
3. **Different scorer** — three measurement defects were found and fixed in the harness itself:

| Harness defect | Effect on the old numbers |
| :--- | :--- |
| Fact matching compared raw substrings | `"3.580.000đ"` did not match `"3,580,000 VND"`; `"06:00"` did not match `"6:00"` or `"10h30"` — on a corpus full of opening hours |
| Hedge/clarify cues had no Russian | A correct Russian refusal scored as a knowledge-state failure |
| Harness passed `isEmergency: false` unconditionally | It never called `screenGuestMessage`, which production always calls. "tôi bị đau ngực dữ dội" and a Japanese ambulance request scored as safety failures the product does not have — **3 of 20** |

A fourth defect was introduced *by this harness* and caught before publication: normalising clock times read `"about 8 minutes"` as `08:00`, turning two correct cable-car answers into "critical fabrications". That is why §1 reports 0.0% and not 0.5% — **the two fabrications in the first run of this harness were scorer artifacts, verified case by case.**

Strict and lenient are reported separately throughout, because the project's own 100-case human calibration measured the judge **over-strict on 29%** of cases, all multi-fact omissions.

---

## 9. What to Fix, in Order

1. **`FACTUAL` at 35.5% over 141 cases.** The biggest single block of lost usefulness. Retrieval is not the suspect — `UNKNOWN_BOUNDARY` is at 100% and fabrication at 0%, so the corpus and the gate are behaving. The failure is between passage and sentence.
2. **60 GATE escalations.** Every one is a question the kiosk could have answered. Halving these would move answerable usefulness more than any model change.
3. **Japanese at 44.4%.** Twenty points behind Chinese on identical infrastructure.
4. **15 remaining SAFETY misses**, after the CJK write-verb and emergency-lexicon fixes landed.
5. **Multi-turn p95 of 25.43 s.** History inflates the prompt; this is the latency guests actually feel.

---

## 10. Reproducing

```bash
LOCAL_EMBED_NUM_GPU=0 LOCAL_NUM_GPU=36 LOCAL_INTENT_NET=1 \
  npx tsx bench/final-eval-v2.ts 0 final-4b
```

Raw per-case results: `bench/pareto/eval-final-4b.json`.
Deterministic suite: `npm test` — **18/18 files passing**.
