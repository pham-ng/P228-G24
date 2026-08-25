# Frozen configuration — Part 5 root-cause decomposition

No production code changed in this phase. Snapshot taken immediately before
the trace run.

| Component | Value |
|---|---|
| Embedding | `bge-m3`, 1024d, local via Ollama |
| Retrieval fusion | BM25 + RRF, `RRF_VEC_WEIGHT=0.5`, `RRF_K=60` |
| `LOCAL_MIN_SCORE` | 0.005 (Part 2 remediation) |
| `MIN_COVERAGE` | 0.34 (word-overlap floor, unchanged — see finding below) |
| `LOCAL_PASSAGES` | 5 |
| Local model | `qwen3.5:4b` via Ollama native `/api/chat`, `think:false` |
| Corpus | 138 chunks, `index_meta` confirmed consistent |
| Benchmark | `bench/offline-cases.ts` — 45 answer-lane + 18 escalate-lane = 63 cases |

## A second gate criterion was already in the code, not previously traced

`gateRetrieval()` applies TWO checks, not one:

1. `topScore >= LOCAL_MIN_SCORE` (the one calibrated in Part 2).
2. A word-overlap coverage floor (`MIN_COVERAGE = 0.34`) — but ONLY when no
   result in the candidate set matched via the semantic (vector) leg. Both
   failure reasons are reported as the same string, `"low_score"`, so Part 2's
   sweep could not tell them apart from the outside. The trace script built for
   this phase computes both signals independently to resolve which one actually
   fired on each case.

## Critical finding, confirmed by reading code (not requiring the trace run)

`server/agent.ts:708`, `replyLang()` — the function PRODUCTION actually calls
before invoking the offline pipeline — collapses every detected language to
only `"vi"` or `"en"`:

```ts
function replyLang(conv: Conversation, profileLang: string): "vi" | "en" {
  const detected = detectMessageLang(lastGuest?.body ?? "");
  if (detected === "vi") return "vi";
  if (detected) return "en";          // ko/ja/zh/ru ALL become "en" here
  return profileLang === "vi" ? "vi" : "en";
}
```

`bench/offline-answers.ts` (and this phase's trace script) call
`runLocalTurn` directly with `lang: c.lang` — the guest's REAL language —
bypassing `replyLang()` entirely, with a comment already noting why. This
means every CJK number this project has reported for the OFFLINE path,
including Part 2's confirmation, measures the pipeline's capability in
isolation, not what a real Korean/Chinese/Japanese guest receives from the
live offline path today, which is English.

This is not a benchmark artifact to fix by changing the benchmark — the
benchmark is correctly measuring "can the pipeline do this if given the right
language." The gap is in `replyLang()`, production code, not touched in this
diagnostic-only phase.
