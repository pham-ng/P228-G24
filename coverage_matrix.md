# COVERAGE MATRIX FOR FINAL VIETNAMESE BENCHMARK

> **Target Benchmark**: Aurea Hotel Guest Kiosk Vietnamese Benchmark v3.0  
> **Date**: September 02, 2026  
> **Status**: **PASS (ALL QUALITY GATES MET)**

---

## 1. QUALITY GATE VERIFICATION

| COVERAGE METRIC | TARGET REQUIREMENT | ACTUAL COUNT | COVERAGE % | QUALITY GATE STATUS | EVIDENCE SOURCE |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **Total Unique Test Cases** | $\ge 300$ | **461** | **153.7%** | **PASS** | `final_benchmark_vi.csv` (461 unique IDs) |
| **ANSWERABLE Cases** | $\ge 150$ | **291** | **194.0%** | **PASS** | Ground truth verified against canonical KB |
| **UNANSWERABLE / OUT_OF_KB** | $\ge 50$ | **80** | **160.0%** | **PASS** | Genuine absent information & out-of-scope |
| **AMBIGUOUS / INCOMPLETE** | $\ge 40$ | **90** | **225.0%** | **PASS** | Clarification required cases |
| **ADVERSARIAL / FALSE PREMISE**| $\ge 30$ | **54** | **180.0%** | **PASS** | Premises correcting false assumptions |
| **MULTI-TURN SCENARIOS** | $\ge 30$ | **38** | **126.7%** | **PASS** | 38 scenarios across 143 total turns |

---

## 2. DETAILED BREAKDOWN & DISTRIBUTION

### A. Distribution by Source Type
* **REAL_USER**: **101 cases** (21.91%) — Extracted directly from live Kiosk Trace History.
* **SYNTHETIC**: **360 cases** (78.09%) — Synthesized from authoritative KB entities (`canonical-facts.json`, `room-types.json`, `venues.json`, `room-packages.json`).

### B. Distribution by Test Family
* **Numeric Gold Tests**: **190 cases** (Prices, percentages, times, capacities, areas).
* **False Abstention Candidates** (`kb_evidence_exists = TRUE` & `ANSWERABLE`): **291 cases** — Essential baseline for detecting `FALSE_ABSTENTION_AFTER_SUCCESSFUL_RETRIEVAL`.

---

## 3. DOMAIN COVERAGE MATRIX

| HOTEL DOMAIN | CASE COUNT | EXAMPLE QUESTION | GROUND TRUTH SOURCE |
| :--- | :---: | :--- | :--- |
| **Room Types & Rates** | 82 | *"Phòng Deluxe 2 giường đơn rộng bao nhiêu m2?"* | `room-types.json` |
| **Hotel Policies & Penalties**| 74 | *"Phạt hút thuốc trong phòng bao nhiêu tiền?"* | `canonical-facts.json` |
| **Venues, Dining & Hours** | 65 | *"Nhà hàng Bách Giai mở cửa từ mấy giờ?"* | `venues.json` |
| **Amenities & Spa** | 58 | *"Akoya Spa kéo dài bao lâu?"* | `venues.json` |
| **Adversarial Traps** | 54 | *"Phòng Deluxe có 2 giường King đúng không?"* | `room-types.json` |
| **Multi-turn Contexts** | 143 turns | *"Resort có hồ bơi không?" $\rightarrow$ "Trẻ em bơi được không?"* | `canonical-facts.json` |
| **Out-of-KB / Unanswerable**| 80 | *"Resort có sân trực thăng đón khách không?"* | N/A (Safe Abstention) |
