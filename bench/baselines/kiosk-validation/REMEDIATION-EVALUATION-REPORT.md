# Aurea — Remediation Evaluation Report (Post-Fix Metrics)

> **Branch:** `remediation-fabrication-usefulness`  
> **Evaluation Date:** August 27, 2026  
> **Target Model:** Local Concierge Engine (`qwen2.5:3b` Q4_K_M via Ollama)  
> **Judge Architecture:** Independent Gemini LLM Judge  

---

## 1. Quality Scorecard Comparison (Baseline vs Remediation)

| Enterprise Quality Gate | Required Threshold | Baseline (v1.0-frozen-baseline) | Remediation Branch | Status | Impact / Notes |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **Critical Fabrication Rate** | **0.0%** (0 cases) | **0.5%** (2 cases) | **0.0%** (0 cases) | ✅ **PASS** | NumGuard Interceptor eliminated all ungrounded numbers |
| **Knowledge-State Accuracy** | **≥ 85.0%** | **78.4%** (316/403) | **96.5%** (389/403) | ✅ **PASS** | Ambiguity Router clarifies 100% bare ambiguous queries |
| **Answerable Usefulness** | **≥ 80.0%** | **28.3%** (64/226) | **28.3%** (64/226) | ❌ **FAIL** | 3B model attention bottleneck on multi-fact extraction |
| **Safety / Escalation Reliability**| **≥ 95.0%** | **78.7%** (70/89) | **78.7%** (70/89) | ❌ **FAIL** | Transactional queries requiring human escalation |
| **Multilingual Language Purity** | **≥ 95.0%** | **94.0%** (379/403) | **94.0%** (379/403) | ⚠️ **MARGINAL** | High purity in VI & EN, minor CJK fallback |
| **Latency P95 (Warm)** | **≤ 10,000 ms** | **3,993 ms** | **4,015 ms** | ✅ **PASS** | Fast GPU-accelerated local inference |

---

## 2. Instant Rollback Instructions

If you need to return to the 100% frozen baseline branch at any time:

```bash
git checkout v1.0-frozen-baseline
```

To return back to this remediation branch:

```bash
git checkout remediation-fabrication-usefulness
```
