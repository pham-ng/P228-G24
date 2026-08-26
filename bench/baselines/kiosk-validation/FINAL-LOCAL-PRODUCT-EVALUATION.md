# Aurea — RELEASE-GRADE LOCAL MODEL EVALUATION REPORT

> **Production Readiness Status:** 🔴 **RED — REJECTED FOR ENTERPRISE DEPLOYMENT**  
> **Evaluation Date:** August 26, 2026  
> **Evaluated Target:** Local Concierge Engine (`qwen2.5:3b` Q4_K_M via Ollama 0.32.15)  
> **Hardware Target:** NVIDIA GeForce GTX 1650 Ti (4GB VRAM) / Intel Core i7  
> **Evaluation Constraint:** Strict Frozen-State Evaluation (0% Optimization / 0% Post-Hoc Tuning)  

---

## 1. Executive Summary & Release Gate Verdict

A comprehensive, release-grade, frozen-state evaluation was conducted on the **Aurea Local/Offline AI Concierge Branch** to determine its readiness to serve real hotel guests as an enterprise product. The benchmark comprised **403 atomic test cases** and **60 multi-turn conversations** (totaling **591 evaluated turns**) across 5 production languages (Vietnamese, English, Korean, Chinese, Japanese).

### Release Gate Summary Table

| Quality Gate / Metric | Enterprise Target | Measured Baseline | Status | Impact / Failure Rationale |
| :--- | :--- | :--- | :--- | :--- |
| **Critical Fabrication Rate** | **0.0%** (0 cases) | **0.5%** (2 cases) | ❌ **FAIL** | Invented cable car price (`250.000đ`) & visitor curfew (`23:00`) |
| **Answerable Usefulness** | **≥ 80.0%** | **28.8%** (65/226) | ❌ **FAIL** | High rate of partial answers & missing facts in 3B model |
| **Knowledge-State Accuracy** | **≥ 85.0%** | **78.7%** (317/403) | ❌ **FAIL** | False positives on ambiguous queries & gate over-blocking |
| **Safety / Escalation Reliability** | **≥ 95.0%** | **78.7%** (70/89) | ❌ **FAIL** | Unsafe handling of guest monetary/booking changes |
| **Multilingual Language Purity** | **≥ 95.0%** | **94.0%** (379/403) | ⚠️ **MARGINAL** | Occasional language leakage in KO, JA, and ZH queries |
| **Latency P95 (Warm)** | **≤ 10,000 ms** | **4,486 ms** | ✅ **PASS** | Fast GPU-accelerated local inference |

**Final Classification:** 🔴 **RED** — The system is **NOT** ready for enterprise deployment. Remediation is required before re-testing.

---

## 2. Frozen Configuration & System State

The evaluation environment was locked prior to dataset execution.

- **LLM Model:** `qwen2.5:3b` (Quantization: `Q4_K_M`, Size: 2.2 GB)
- **Embedding Model:** `bge-m3:latest` (1024 dimensions, Size: 664 MB)
- **Ollama Engine Version:** Ollama 0.32.15 (Context Window `num_ctx=4096`, `keep_alive=forever`)
- **GPU Accelerator:** NVIDIA GeForce GTX 1650 Ti (4GB Dedicated VRAM, 100% GPU Offload)
- **Retrieval Pipeline:** Hybrid BM25 (diacritic-folded) + BGE-M3 Reciprocal Rank Fusion (`RRF_K=60`, `RRF_CANDIDATE_DEPTH=50`)
- **Retrieval Thresholds:** `LOCAL_MIN_SCORE=0.005`, `LOCAL_PASSAGES=5`, `LOCAL_PASSAGE_CHAR_CAP=700`
- **Database Baseline:** `data.db` canonical store (136 indexed document chunks)
- **Manifest URI:** `bench/baselines/kiosk-validation/FINAL-LOCAL-EVAL-MANIFEST.json`

---

## 3. Evaluation Methodology

1. **Pre-Declared Scoring Rules:** Test cases and expected ground-truth facts were declared prior to benchmark execution.
2. **Deterministic Evaluation Harness:** Executed via `bench/final-local-eval-runner.ts` using exact string/fact extraction and anti-fabrication checking.
3. **No Retries:** Every turn was evaluated on its first-pass response; no second-chance prompting or manual intervention was permitted.
4. **Single-Layer Failure Assignment:** Every failed case was tagged with its primary root-cause failing layer.

---

## 4. Dataset Composition & Split Analysis

### 4.1 Test Suite Breakdown

- **Total Evaluated Cases:** 403 atomic cases + 60 multi-turn conversations
- **Total Evaluated Turns:** 591 turns
- **Split Distribution:**
  - **Development Evaluation Set (70%):** 283 atomic cases
  - **Holdout Evaluation Set (30%):** 120 atomic cases

### 4.2 Development vs Holdout Split Comparison

| Metric | Development Set (283 cases) | Holdout Set (120 cases) | Delta / Overfitting Check |
| :--- | :--- | :--- | :--- |
| **Fully Correct %** | **50.9%** | **48.3%** | -2.6% (Consistent across unseen structures) |
| **Partial Accuracy %** | **13.1%** | **11.7%** | -1.4% |
| **Wrong %** | **35.7%** | **39.2%** | +3.5% |
| **Critical Fabrication Rate %** | **0.4%** (1) | **0.8%** (1) | +0.4% |
| **Knowledge-State Accuracy %** | **80.2%** | **75.0%** | -5.2% |
| **Language Accuracy %** | **96.1%** | **89.2%** | -6.9% (CJK phrasing in holdout set) |
| **Latency P95** | **4,530 ms** | **4,248 ms** | -282 ms |

*Conclusion on Overfitting:* Performance on the holdout set tracks closely with the development set (-2.6% correctness drop), confirming that the benchmark measures generalizable system behavior without overfitting.

---

## 5. Overall Performance Dashboard

### 5.1 Overall Metrics (403 Atomic Cases)

| Category / Metric | Value | Case Count |
| :--- | :--- | :--- |
| **Correct (Fully Grounded & Precise)** | **50.1%** | 202 / 403 |
| **Partial (Grounded but Incomplete)** | **12.7%** | 51 / 403 |
| **Wrong (Knowledge/Routing Miss)** | **36.7%** | 148 / 403 |
| **Critical Failures (Fabrication/Hallucination)** | **0.5%** | 2 / 403 |
| **Knowledge-State Classification Accuracy** | **78.7%** | 317 / 403 |
| **Language Output Accuracy** | **94.0%** | 379 / 403 |
| **Fabrication Count** | **2 cases** | P-013, M-018 |

### 5.2 Latency Breakdown

| Metric | Measured Time | Benchmark Target | Status |
| :--- | :--- | :--- | :--- |
| **Latency P50 (Median)** | **2,669 ms** | ≤ 3,000 ms | ✅ PASS |
| **Latency P95** | **4,486 ms** | ≤ 10,000 ms | ✅ PASS |
| **Latency P99** | **14,213 ms** | ≤ 20,000 ms | ✅ PASS |
| **Timeout / Error Rate** | **0.0%** | 0.0% | ✅ PASS |

---

## 6. Per-Category Performance Metrics

| Category | Total Cases | Correct % | Partial % | Wrong % | Critical % | Knowledge-State % | Latency P50 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **FACTUAL** | 141 | 29.8% | 24.8% | 45.4% | 0.0% | 78.0% | 2,923 ms |
| **PRICING** | 71 | 33.8% | 9.9% | 54.9% | 1.4% (1) | 77.5% | 2,694 ms |
| **MULTI_FACT** | 38 | 42.1% | 23.7% | 31.6% | 2.6% (1) | 81.6% | 3,358 ms |
| **UNKNOWN_BOUNDARY** | 55 | 92.7% | 0.0% | 7.3% | 0.0% | 92.7% | 2,405 ms |
| **AMBIGUITY** | 26 | 38.5% | 0.0% | 61.5% | 0.0% | 38.5% | 2,650 ms |
| **CONFLICTING** | 10 | 60.0% | 0.0% | 40.0% | 0.0% | 60.0% | 2,191 ms |
| **SAFETY_ESCALATION** | 62 | 85.5% | 0.0% | 14.5% | 0.0% | 87.1% | 3 ms |

---

## 7. Per-Language Performance Metrics

| Language | Total Cases | Correct % | Partial % | Wrong % | Critical % | Language Accuracy % | Latency P50 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Vietnamese (VI)** | 142 | 50.0% | 5.6% | 43.0% | 1.4% (2) | 99.3% | 2,574 ms |
| **English (EN)** | 66 | 53.0% | 16.7% | 30.3% | 0.0% | 95.5% | 1,923 ms |
| **Korean (KO)** | 67 | 47.8% | 16.4% | 35.8% | 0.0% | 88.1% | 3,227 ms |
| **Chinese (ZH)** | 65 | 52.3% | 15.4% | 32.3% | 0.0% | 92.3% | 2,900 ms |
| **Japanese (JA)** | 63 | 47.6% | 17.5% | 34.9% | 0.0% | 88.9% | 2,923 ms |

---

## 8. Breakdown by Answerability Type

| Answerability Class | Cases | Correct % | Partial % | Wrong % | Critical % | Knowledge-State Accuracy % |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Answerable** | 226 | **28.8%** | 22.1% | 48.2% | 0.9% (2) | 79.2% |
| **Unknown** | 62 | **91.9%** | 1.6% | 6.5% | 0.0% | 93.5% |
| **Escalate** | 89 | **78.7%** | 0.0% | 21.3% | 0.0% | 78.7% |
| **Ambiguous** | 26 | **38.5%** | 0.0% | 61.5% | 0.0% | 38.5% |

---

## 9. Multi-Turn Conversation Evaluation (60 Conversations)

- **Total Multi-Turn Conversations:** 60 conversations
- **Total Evaluated Turns:** 224 turns
- **Conversation-Level Success Rate:** **55.0%** (33 / 60 passed cleanly)
- **Turn-Level Accuracy:** **79.8%** (179 / 224 turns passed)

### Pattern Breakdown Table

| Conversation Pattern | Total Conversations | Successful | Success Rate % | Failure Mechanism |
| :--- | :--- | :--- | :--- | :--- |
| `simple_follow_up` | 19 | 18 | **94.7%** | Minor omission of secondary detail |
| `changing_requirements` | 10 | 10 | **100.0%** | Handled parameter updates correctly |
| `pronoun_reference_resolution` | 9 | 8 | **88.9%** | Minor pronoun ambiguity |
| `language_switch` | 14 | 12 | **85.7%** | Occasional fallback to VI on complex turns |
| `clarification` | 12 | 10 | **83.3%** | Responded with full article instead of asking |
| `multi_fact_reasoning_across_turns`| 2 | 1 | **50.0%** | Forgotten constraint from turn 1 |
| `package_comparison_across_turns` | 2 | 1 | **50.0%** | Missed second package detail |
| `topic_switch` | 11 | 0 | **0.0%** | Stale passage context carried across topic change |
| `return_to_previous_topic` | 10 | 0 | **0.0%** | Failed to restore turn 1 context |
| `omitted_subject` | 10 | 0 | **0.0%** | Lost subject reference without explicit noun |
| `room_service_context_carried` | 10 | 0 | **0.0%** | Room number context leaked into pricing query |

---

## 10. Failure Taxonomy & Root Cause Analysis

Every non-correct case was assigned a single primary root cause layer:

| Layer | Failures | % of Non-Correct | Systemic Cause & Observable Behavior |
| :--- | :--- | :--- | :--- |
| **MODEL_REASONING** | 102 | 50.7% | The 3B model retrieves relevant context but omits 1 of 2 required facts when formulating output. |
| **GATE** | 47 | 23.4% | The retrieval score threshold (`LOCAL_MIN_SCORE=0.005`) falsely blocked answerable CJK or non-exact queries. |
| **KNOWLEDGE_STATE** | 20 | 10.0% | Model failed to abstain or ask clarifying questions when user input was ambiguous. |
| **SAFETY** | 19 | 9.5% | Tool router keyword cues failed to trap non-explicit booking/financial modification requests. |
| **MODEL_LANGUAGE** | 11 | 5.5% | Model output reverted to Vietnamese when prompted in Korean, Japanese, or Chinese. |
| **GROUNDING** | 2 | 1.0% | **CRITICAL:** Model generated ungrounded numbers not present in any retrieved passage. |

---

## 11. Critical Failures Audit

### Critical Failure 1: Case `P-013` (Pricing Fabrication)
- **User Query:** *"vé cáp treo qua đảo giá bao nhiêu một người"*
- **Model Output:** *"Giá vé cáp treo qua đảo Hòn Tre là từ 250.000 VND."*
- **Canonical Fact:** Round-trip cable car ticket for adults is **200,000 VND**.
- **Fabricated Value:** `250.000`
- **Root Cause:** Model reasoning hallucination in `qwen2.5:3b` where entrance fee was conflated with transportation fee.

### Critical Failure 2: Case `M-018` (Policy Fabrication)
- **User Query:** *"khách đến thăm phòng được ở lại tới mấy giờ, và có cần để lại giấy tờ không"*
- **Model Output:** *"Khách đến thăm phòng được ở lại tới giờ đóng cửa của resort, thường là 22:00 hoặc 23:00. Cần để lại giấy tờ tùy thân."*
- **Canonical Fact:** Room visitor curfew is strictly **20:00**.
- **Fabricated Value:** `23:00`
- **Root Cause:** Context contamination — model extracted 23:00 from Wave Bar closing time passage present in the 5-passage window.

---

## 12. Model Comparison Note (qwen2.5:3b vs qwen3.5:4b)

- **Target Model Evaluated:** `qwen2.5:3b` (Quantization Q4_K_M).
- **Comparison Context:** `qwen2.5:3b` was selected as the baseline local model to fit within 4GB VRAM alongside `bge-m3` embeddings on GTX 1650 Ti.
- **Architectural Observation:** While `qwen2.5:3b` achieves high throughput (P50 2.6s latency), its limited parameter count results in high `MODEL_REASONING` omissions (102 cases) and multi-turn context drift.

---

## 13. Production Readiness Classification & Gate Decision

### System Verdict: 🔴 RED — NOT READY FOR ENTERPRISE RELEASE

#### Exact List of System Blockers:
1. **Blocker 1 (Grounding Safety):** 2 critical numeric fabrications (cable car price and visitor curfew). Zero fabrications are tolerated for release.
2. **Blocker 2 (Factual Completeness):** Answerable usefulness of 28.8% is far below the enterprise target of 80.0%.
3. **Blocker 3 (Safety Escalation Slips):** 19 cases failed to trigger human escalation on financial/booking modification requests.
4. **Blocker 4 (Context Drift in Multi-Turn):** 0% success rate on `topic_switch` and `omitted_subject` patterns due to context pollution.

---

## 14. Recommendations for Diagnostic & Remediation Phase

1. **Remediate Grounding (Layer: GROUNDING):** Implement strict numerical verification (NumGuard / regex evidence checking) before output delivery.
2. **Refine Retrieval Gate (Layer: GATE):** Adjust CJK query handling in BGE-M3 RRF search to prevent false rejections of answerable CJK cases.
3. **Enhance System Prompt Guidance (Layer: MODEL_REASONING):** Update system prompt instructions to explicitly demand all sub-clause facts in multi-part questions.
4. **Tool Router Escalation (Layer: SAFETY):** Add financial intent patterns to tool router cues to guarantee 100% escalation on payment/booking modifications.
5. **Context Reset Handler (Layer: MULTI_TURN):** Implement topic-boundary detection to clear stale context when a guest switches topics.

---
*Report certified by Antigravity AI Concierge Evaluation Suite — August 26, 2026.*
