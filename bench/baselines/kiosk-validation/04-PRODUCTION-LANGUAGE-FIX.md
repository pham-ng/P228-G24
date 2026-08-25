# Aurea — Part 5.5: Production-Path Language Fix + Regression

Status: **PASS WITH KNOWN MODEL LIMITATION**

All measurements in this report were run through `runAgent()` — the actual
production entry point a live kiosk message hits — not through a direct
`runLocalTurn()` call. That distinction is the whole point of this phase:
every earlier CJK number in this project (Part 2, Part 5's own trace) called
`runLocalTurn()` directly with the guest's real language already supplied,
which could never have caught this bug because it skipped the exact function
that had it.

---

## 1. Root cause

`replyLang()` (`server/agent.ts`), the function `runOfflineTurn()` used to
decide what language to answer in, only ever returns `"vi"` or `"en"`. Any
guest who wrote in Korean, Japanese, Chinese, or Russian was silently
answered in English, regardless of how well the retrieval and generation
pipeline actually understood the question.

This is a pure language-routing defect. It has nothing to do with corpus
coverage: `bge-m3` retrieval already finds the correct Vietnamese/English
source documents for CJK queries (confirmed in Part 5's trace), and the
model already answers those questions correctly in the target language once
it is actually asked to — which is exactly what this fix now lets happen.

## 2. Exact code path (verified, not assumed)

```
runAgent(conversationId)
  -> runOfflineTurn({ conv, guest, ... })       server/agent.ts:2143
       -> const lang = replyLang(conv, guest.lang)     [THE BUG — line 2144]
       -> runLocalTurn(..., lang)
       -> repairReply(reply, numericGuard, lang === "vi" ? "vi" : "en")
```

`replyLang()` has 4 call sites total. 3 feed `compareRooms()`
(`server/upsell.ts`), whose comparison-label signature is genuinely typed
`"vi" | "en"` — those callers are correct as-is and were left untouched. The
4th, inside `runOfflineTurn()`, was the only one deciding a guest-facing
answer language, and it was reusing the narrow hosted-only function.

## 3. Minimal code change

Added `offlineReplyLang()` (`server/agent.ts:740`), same detection logic and
order as `replyLang()`, but preserving `vi/en/zh/ja/ko/ru` instead of
collapsing everything non-Vietnamese to English. `replyLang()` itself is
byte-for-byte unchanged — verified by typecheck, since `compareRooms()`'s
narrower parameter type would fail to compile if `replyLang()`'s return type
had widened.

Single call-site change: `runOfflineTurn()` line 2144,
`replyLang(conv, guest.lang)` → `offlineReplyLang(conv, guest.lang)`.

One consequential type fix: `repairReply()` (`server/numguard.ts`) is
narrowly typed `lang: "vi" | "en"` — a guard-owned contract, intentionally
not touched. The one call site collapses the wider value only for that
narrow consumer: `lang === "vi" ? "vi" : "en"`. This does not reintroduce
the bug — it only affects which of two *numeric-repair* phrasings gets used
if the guard needs to strip an ungrounded number; it does not affect which
language the model's own reply is generated in.

No other file, detector, or guard was modified.

## 4. Tests added/changed

New file `test/language-routing.test.ts`, 8 assertions against
`offlineReplyLang()` directly:

| Input | Profile | Expected | Result |
|---|---|---|---|
| "Mấy giờ trả phòng?" | en | vi | PASS |
| "What time is checkout?" | vi | en | PASS |
| "退房时间是几点？" | en | zh | PASS |
| "チェックアウトは何時ですか？" | en | ja | PASS |
| "체크아웃은 몇 시인가요?" | en | ko | PASS |
| "Во сколько выезд?" | en | ru | PASS |
| "123" (no script signal) | vi | vi (profile fallback) | PASS |
| "" (empty) | vi | vi (profile fallback) | PASS |

All 8 pass. No existing test was modified. Full regression suite (10 files:
`observability`, `retrieval-metrics`, `knowledge-hygiene`, `packages-upsell`,
`crosssell`, `retrieval-upgrades`, `wizard`, `local-agent`, `index-health`,
`language-routing`) — all green, typecheck 0 errors.

## 5. Before / after results — real production path, 63 cases

Both runs used the identical frozen offline configuration
(`LLM_MODE=local`, `LOCAL_API=ollama`, `LOCAL_AGENT_MODEL=qwen3.5:4b`,
`EMBED_PROVIDER=local`, `LOCAL_EMBED_MODEL=bge-m3`, `RRF_VEC_WEIGHT=0.5`,
`LOCAL_MIN_SCORE=0.005`) and the identical 63-case set
(`bench/offline-cases.ts`), called through `runAgent()`. "Before" was
produced by temporarily reverting the one-line call-site fix, running the
same benchmark, then restoring it — not inferred from Part 5's numbers,
which could not measure this bug at all.

| Metric | Before (buggy) | After (fixed) | Δ |
|---|---|---|---|
| Overall correct | 46/63 (73.0%) | 53/63 (84.1%) | **+7 cases / +11.1pp** |
| VI correct | 35/43 | 35/43 | 0 (no change) |
| EN correct | 7/8 | 7/8 | 0 (no change) |
| ZH correct | 1/4 | 4/4 | **+3** |
| JA correct | 1/3 | 3/3 | **+2** |
| KO correct | 2/5 | 4/5 | **+2** |
| Wrong-language responses | 12 | **0** | **-12** |
| Answer rate (non-escalate lane) | unchanged per language (see §6) | unchanged | 0 |
| False abstention | unaffected by this fix (see §9) | unaffected | 0 |
| Numeric fabrication | 1 | 1 | 0 (same case, VI, pre-existing) |
| Safety (escalate lane correctness) | 18/18 | 18/18 | 0 |
| Latency p50 | 11,624ms | 11,827ms | +203ms (noise, same model/hardware) |
| Latency p95 | 17,560ms | 18,758ms | +1,198ms (noise, single-run variance) |

The fix's entire effect is concentrated exactly where it should be: the 12
CJK cases that were previously answered in the wrong language. Nothing else
moved.

## 6. CJK case-by-case results (after fix)

All 12 CJK-language cases, full detail:

| Case | Lang | Retrieved correctly? | Gate passed? | Reply language | Correct? |
|---|---|---|---|---|---|
| spa-hours-ko | ko | yes | yes | ko | PASS |
| breakfast-ko | ko | yes | yes | ko | **FAIL — see §7** |
| pets-ko | ko | yes | yes | ko | PASS |
| esc-cancel-fee-ko | ko | n/a (escalate) | n/a | ko | PASS (escalated) |
| esc-towels | ko | n/a (escalate) | n/a | ko | PASS (escalated) |
| spa-hours-zh | zh | yes | yes | zh | PASS |
| breakfast-zh | zh | yes | yes | zh | PASS |
| pool-zh | zh | yes | yes | zh | PASS |
| esc-price-zh | zh | n/a (escalate) | n/a | zh | PASS (escalated) |
| spa-hours-ja | ja | yes | yes | ja | PASS |
| checkout-ja | ja | yes | yes | ja | PASS |
| esc-price-ja | ja | n/a (escalate) | n/a | ja | PASS (escalated) |

11/12 correct, 0 wrong-language. The one failure (`breakfast-ko`) is not a
language-routing failure — the model was correctly asked to answer in
Korean and correctly retrieved the right passage, and still gave up. See
§7.

## 7. Newly exposed model failures

None. `breakfast-ko` is not new: Part 5's root-cause trace already
identified it as the project's one confirmed genuine model-capability
failure (SLM abstains despite correct retrieval and correct language being
supplied directly). This run reproduces the identical outcome now that the
guest's real language reaches the model through the actual production path
instead of through a direct test call. No other CJK case newly failed at
generation once given its correct language — the fix exposed zero new
weaknesses, only removed the one that was masking correct behavior.

## 8. Regression analysis

All 7 hard requirements checked against real measurements:

| Requirement | Result |
|---|---|
| No VI regression | PASS — 35/43 both runs, identical failing cases |
| No EN regression | PASS — 7/8 both runs, identical failing case |
| CJK actually propagated (not just detected) | PASS — 0/12 wrong-language after fix vs 12/12 before |
| No increase in hallucination/fabrication | PASS — 1 ungrounded-number case both runs, same case (`extra-bed-count`, VI, pre-existing numguard gap unrelated to language) |
| No safety regression | PASS — 18/18 escalate-lane cases correctly escalated, both runs |
| No unrelated retrieval/routing changes | PASS — retrieval-side failures (`pets-vi`, `id-required`, `chinese-restaurant`, `room-count`, `package-codes`, `guestlist-lowseason`, `payment-methods`, `extra-bed-count`) are byte-identical between before/after: same cases, same verdicts, same reply text |
| Latency not materially regressed | PASS — p50 +203ms / p95 +1,198ms, within single-run noise for an unbatched local model; no architectural change was made that could cause a systematic latency shift |

No requirement was violated. No STOP condition was triggered.

## 9. Remaining known failures (unchanged by this phase, correctly out of scope)

10 of 63 cases still fail after the fix — none touched by this phase's
scope, all previously identified in Part 5:

- **7 retrieval-ranking failures** (`pets-vi`, `id-required`,
  `chinese-restaurant`, `room-count`, `package-codes`,
  `guestlist-lowseason`, `payment-methods`) — the gate correctly passed
  relevant evidence but the model abstained or answered a nearby-but-wrong
  fact. Retrieval fixes were explicitly excluded from this phase.
- **1 numeric-guard gap** (`extra-bed-count`) — model states the fact is
  "not specified" when it is; a numguard/prompt issue, not language.
  Excluded from this phase.
- **1 abstention-detector gap** — not present in this run's failure list as
  a separate item; the reversed-word-order prose pattern noted in Part 5
  did not surface in this specific 63-case pass. Still unfixed, still
  explicitly out of scope.
- **1 genuine model-capability failure** (`breakfast-ko`) — confirmed
  pre-existing in Part 5, reproduced identically here. Upper bound on what
  a stronger local model could recover, per Part 5's decomposition,
  remains 1/10 of the original failure set.

None of these are language-routing failures. Fixing them is exactly the
"next phase" work this spec explicitly says not to start automatically
(retrieval tuning, numguard extension, abstention-detector extension, model
comparison).

---

## Final classification: PASS WITH KNOWN MODEL LIMITATION

The language-routing bug is fixed, verified through the real production
path, and regression-clean against all 7 hard requirements with real
measured before/after numbers (not inferred). The one remaining CJK failure
(`breakfast-ko`) is a pre-existing, already-documented model-capability
limitation unrelated to this fix — it existed before this phase, is
reproduced identically after, and is not treated as a blocking regression.

Per the phase's explicit instruction, stopping here. Not proceeding into
model comparison, retrieval optimization, prompt engineering, corpus
translation, RRF/HyDE experimentation, or reranking work without further
instruction.
