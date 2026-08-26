# Aurea — Frozen Local Inference Configuration

Applied 2026-08-26. This is the accepted, production `.env` state for the
offline/local (qwen2.5:3b) kiosk path after the context-compression
experiment (`10-CONTEXT-COMPRESSION.md`). Do not re-tune any of these values
without a full regression proving a specific one is a live problem.

## Frozen parameters

| Parameter | Value | Source |
|---|---|---|
| `LOCAL_AGENT_MODEL` | `qwen2.5:3b` | fixed earlier this session (was misconfigured to qwen3.5:4b) |
| `LOCAL_API` | `ollama` | native endpoint, required to disable thinking mode |
| `LOCAL_KEEP_ALIVE` (code default) | `-1` (forever) | fixes repeated 9-19s reload spikes |
| `LOCAL_PASSAGES` | `5` (unchanged) | preserves retrieval coverage |
| `LOCAL_PASSAGE_CHAR_CAP` | **`400`** (new, this step) | validated context-compression candidate |
| `LOCAL_NUM_CTX` (code default) | `4096` | explicit, was previously an undocumented ~2048 default |
| Embedding model | `bge-m3` | unchanged |
| Lexical search | `BM25` | unchanged |
| `RRF_VEC_WEIGHT` | `0.5` | unchanged |
| `LOCAL_MIN_SCORE` | `0.005` | unchanged |
| Truncation method | `truncateAtBoundary()` (sentence-boundary aware) | replaces the old naive `.slice()` cut, this step |

## Runtime verification (performed before accepting)

- `process.env.LOCAL_PASSAGE_CHAR_CAP` reads `400` with no other code path
  overriding `PASSAGE_CHAR_CAP` (`server/local-agent.ts:171` is the only
  definition site).
- Live `hybridSearch()` + `truncateAtBoundary()` call confirmed real passages
  are cut to ≤400 chars at a sentence boundary; passages already under 400
  chars pass through unchanged.
- VRAM unaffected (2851 MiB used, same as before this change) — this
  parameter has no memory-footprint implication, only prompt token count.

## Before (700-char baseline) → After (400-char, frozen)

Real production path (`runAgent()`), same 73-case set (63 original + 10
`cf-*` completeness cases), all other parameters identical.

| Metric | 700 (before) | 400 (after, frozen) |
|---|---:|---:|
| Overall pass rate | 74.0% (54/73) | **76.7% (56/73)** |
| Completeness set (10 cases) | 6/10 | 6/10 |
| Hallucination (ungrounded) | 0 | 0 |
| False abstention | 4 | 6 |
| Wrong-language | 1 | 2 (see note below — not a regression of a previously-passing case) |
| Missing-information | 10 | **5** |
| p50 | 3496ms | **2566ms** |
| p95 | 5027ms | **3748ms** |

By language (pass/total):

| Lang | 700 | 400 |
|---|---:|---:|
| vi | 39/53 | 40/53 |
| en | 6/8 | 6/8 |
| ko | 3/5 | 4/5 |
| zh | 4/4 | 4/4 |
| ja | 2/3 | 2/3 |

No language regressed. The one new wrong-language verdict (`child-doc`, vi)
was **already failing at 700-cap** with the wrong fact (said "ID card or
passport" instead of "birth certificate"); at 400-cap it states the correct
fact but in English — a different failure mode on a case that was never
passing, not a regression of a previously-correct answer.

## Acceptance verdict

All four acceptance conditions met:
- No critical factual regression (missing-info improved 10→5).
- No hallucination regression (0 in both).
- No meaningful completeness regression (6/10 both).
- No meaningful multilingual regression (no language's pass rate dropped).

**`LOCAL_PASSAGE_CHAR_CAP=400` is frozen.** Do not test 350/375/425/450/500
or otherwise re-tune this value unless a future acceptance test proves 400
is itself a regression source.

## Next phase (not this one)

Per the user's explicit scope: the next work is system-level, not
context-tuning — local tool execution, knowledge-state/unknown handling,
multi-turn quality, and final model selection. No further context-length or
quantization experiments are in scope until one of those surfaces a concrete
problem traceable back to context configuration.
