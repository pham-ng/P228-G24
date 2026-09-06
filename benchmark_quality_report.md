# FINAL VIETNAMESE BENCHMARK QUALITY REPORT

> **Artifact Name**: `final_benchmark_vi.csv` / `final_benchmark_vi.xlsx`  
> **Total Unique Test Cases**: 461  
> **Date**: September 02, 2026  
> **Quality Gate Status**: **PASSED ALL CRITERIA**

---

## 1. SUMMARY OF BENCHMARK METRICS

* **TOTAL_UNIQUE_CASES**: **461** (Exceeds required minimum of 300).
* **EXACT_DUPLICATES**: **0**.
* **REAL_USER_COUNT**: **101** (21.91%).
* **SYNTHETIC_COUNT**: **360** (78.09%).
* **ANSWERABLE_CASES**: **291** (Target $\ge 150$).
* **UNANSWERABLE_CASES**: **80** (Target $\ge 50$).
* **AMBIGUOUS_CASES**: **90** (Target $\ge 40$).
* **ADVERSARIAL_CASES**: **54** (Target $\ge 30$).
* **MULTI_TURN_SCENARIOS**: **38 scenarios / 143 total turns** (Target $\ge 30$ scenarios).
* **NUMERIC_TEST_CASES**: **190 cases**.
* **FALSE_ABSTENTION_CANDIDATE_COUNT**: **291 cases** (`kb_evidence_exists = TRUE`).

---

## 2. SCHEMA COMPLIANCE

Every case in `final_benchmark_vi.csv` adheres to the strict evaluation schema:

1. `test_id` (Unique primary key)
2. `conversation_id` & `turn_id`
3. `source_type` (`REAL_USER` vs `SYNTHETIC`)
4. `category` & `subcategory`
5. `difficulty` (`easy`, `medium`, `hard`, `adversarial`)
6. `question` (Vietnamese query)
7. `answerability` (`ANSWERABLE`, `UNANSWERABLE`, `AMBIGUOUS`)
8. `ground_truth` (Authoritative KB evidence)
9. `reference_contexts`
10. `source_document` & `source_location`
11. `expected_behavior` (`answer_directly`, `ask_clarification`, `abstain`)
12. `must_abstain` (`TRUE` / `FALSE`)
13. `expected_model_behavior`
14. `kb_evidence_exists` (`TRUE` / `FALSE`)
15. `is_numeric` (`TRUE` / `FALSE`)
16. `is_adversarial` (`TRUE` / `FALSE`)
17. `is_multi_turn` (`TRUE` / `FALSE`)
18. `human_review_required` (`FALSE`)

*Runtime evaluation fields (`retrieval_evidence_found`, `model_answered`, `actual_answer`, `failure_mode`, etc.) are left completely empty as mandated prior to model execution.*
