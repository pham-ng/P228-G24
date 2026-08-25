# Phase D + E — Retrieval upgrades, measured

Every change below was A/B'd on the golden set before being kept. Two of the four
experiments **lost and were left disabled**, which is the point of running them.

## Headline: the embedding model was the whole problem

| | e5-small q8 (local) | text-embedding-3-small (OpenAI) |
|---|---|---|
| vector-only hit@5 | 34.6% | **94.2%** |
| vector-only MRR | 0.249 | **0.871** |
| **hybrid hit@5** | 73.1% | **100.0%** |
| **hybrid MRR** | 0.592 | **0.941** |

Earlier phases disabled the dense leg because fusing it *lost* accuracy. That
decision was right for that model and wrong in general: re-tested with a stronger
embedding, the same leg is excellent and hybrid beats lexical outright. The
default fusion weight is therefore chosen **per model** rather than as a constant —
a flat 0.5 would silently degrade any deployment still on e5-small from 98% to 73%.

A sweep put the optimum at 0.5 (0.25 → 98.1%, **0.5 → 100%**, 0.75+ → falls back).

## Ablation (52 golden queries)

| Variant | hit@1 | hit@3 | hit@5 | MRR | p50 |
|---|---|---|---|---|---|
| Baseline (BM25) | 88.5% | 98.1% | 98.1% | 0.931 | 436ms* |
| Baseline + HyDE | 88.5% | 98.1% | 98.1% | 0.931 | 1925ms |
| **Hybrid** ← shipped | 90.4% | 98.1% | **100.0%** | 0.941 | 38ms* |
| Hybrid + HyDE | 90.4% | 98.1% | 98.1% | 0.942 | 36ms |
| Hybrid + Rerank | 90.4% | 98.1% | 98.1% | 0.942 | 998ms |
| Hybrid + HyDE + Rerank | **92.3%** | 98.1% | 98.1% | **0.955** | 992ms |

\* Latency is **not** comparable across rows: a query-vector cache is shared within
the process, so the first variant pays embedding costs later ones reuse. Only the
HyDE and rerank rows show a true added cost, because those call the model again.

### HyDE — tested, lost, left disabled
- On the lexical baseline it changed **nothing** (identical metrics) while costing
  4.4× the latency. That is expected and worth stating: HyDE moves a *vector*, so
  it cannot influence a lexical ranking at all.
- On hybrid it **dropped hit@5 from 100% to 98.1%**, reintroducing a miss the
  hybrid config had fixed. MRR rose by 0.001 — noise.
- Verdict: `HYDE_ENABLED=0`. Implemented, flagged, tested, and off.

### Reranker — tested, lost, left disabled
- Best hit@1 (92.3%) and MRR (0.955) when stacked with HyDE, but **hit@5 fell to
  98.1%** and it introduced a *new* miss (`P-package-vi`) — the reranker demoted a
  correct document out of the top 5.
- For this agent that trade is bad: it retrieves k≈4 and lets the model read the
  whole set, so **hit@5 matters more than hit@1**. Losing a correct document to
  gain rank-1 precision costs answers.
- Cost: ~1s per search.
- Verdict: `RERANK_ENABLED=0`. Worth revisiting if the agent ever consumes only
  the single top document.

### Adaptive routing — implemented
`shouldUseHyde()` skips short keyword lookups and only fires on long or
explanatory questions. Currently moot (HyDE is off) but tested and ready.

## BM25F title boost — kept
A query term matching a document's **title** is stronger evidence than the same
term in prose. Boosting *every* title match made things worse — "Nhà hàng Bách
Giai (món Trung Hoa)" collected a bonus for "nhà", "hàng", "món" on any restaurant
question — so the bonus applies only above an **IDF floor**: naming "Lotus" counts,
saying "nhà hàng" does not. Sweep: 0.6 optimal (MRR 0.931); 1.5–2.0 degrade.

## Phase E — cross-lingual gate

Six intents asked in five languages. The corpus is VI/EN only, so every ZH/JA/KO
query must cross a language boundary — which lexical search **cannot** do.

| Lang | e5-small (BM25-only) | text-embedding-3-small (hybrid) |
|---|---|---|
| vi | hit@5 100% | 100% |
| en | 100% | 100% |
| zh | 50% | **100%** |
| ja | 17% | **100%** |
| ko | **0%** | **83%** |

Korean went from **completely unanswerable to 83%** without translating one
document. This materially changes the case for Phase C: a good multilingual
embedding already lets CJK questions reach VI/EN sources, so translating the
corpus is an optimisation, not a prerequisite.

`bench/multilingual-eval.ts --gate` exits non-zero when any language falls below
its floor, so a change that breaks Korean cannot ship behind a good Vietnamese
average.

## Operational trade-off (stated, not hidden)

Hosted embeddings mean every knowledge search makes an API call: **p50 ~450ms vs
~55ms** for lexical-only, plus per-query cost. The offline path degrades honestly —
with e5-small configured the fusion weight is 0, the vector leg is skipped, and
retrieval runs BM25-only at 98.1% hit@5 with no crash and no dimension error.

## Residual

- `D-lotus-vi` still ranks Bách Giai first lexically (14.74 vs 14.61). Hybrid
  resolves it in practice; not tuned further, deliberately.
- Korean `breakfast` intent still misses at k=5.
- Latency figures inside one ablation run are cache-contaminated (see above).
