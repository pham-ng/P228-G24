# Aurea — Phase 9: Routing Remediation + Hallucination Hardening

**Final answer: MODEL SELECTION REMAINS OPEN.** Both shared confounds identified in Phase 8 are meaningfully reduced — the routing defect is fixed with tests, and one of the two "hallucinations" turned out not to be a model hallucination at all (it was bad corpus data) and is now fully fixed for both models. But this phase's own verification work surfaced two *new*, real, shared fact-fabrication issues that were never in scope to fix here. The comparison is cleaner than Phase 8's, not clean enough to declare a winner.

---

## 1. Routing baseline (reproduced, not assumed)

`bench/routing-baseline.ts` calls `classifyLocal()` directly — no retrieval, no LLM, so this is exact and instant. Confirmed before any code change: **49/102 (48.0%)** of the Phase 8 quality-set cases were short-circuited to `complex`/`transaction` (zero retrieval, zero LLM call), matching Phase 8's reported number exactly. Also newly confirmed this phase: **2 of the original 45 ANSWER-lane cases** (`package-codes`, `payment-methods`) were *also* wrongly short-circuited — meaning Part 6/6.5's diagnosis of these two as pure retrieval/RRF failures was incomplete; a routing-layer block was compounding the problem underneath. Saved: `bench/baselines/kiosk-validation/09-routing-baseline.json`.

## 2. Routing root cause — three separate sub-mechanisms, not one

1. **`hardMoney` word list.** Any of `tiền/giá/phí/thanh toán/...` anywhere in the message forced `complex`, regardless of whether the question was a static published fact ("VAT bao nhiêu %?") or a personal calculation ("tổng hoá đơn của tôi?").
2. **Family scoring.** `COMPLEX_FAMILIES = ["room_shopping", "billing"]` forced `complex` on a mere topic match — `payment-methods` hit `"billing"` on the single word "thanh toán" (asking *which methods exist*, not asking to pay), and `package-codes` hit `"room_shopping"` on the phrase "bảng giá" (price table) with no recommendation intent at all.
3. **`quantityCue` fallback.** A bare "how much"/"bao nhiêu" without an explicit money word also forced `complex` — this is why the Vietnamese and English versions of the same breakfast-price question disagreed with each other (`giá bao nhiêu` hit rule 1, `how much` only hit rule 3, and rule 3 had no personal/sum gate at all before this fix).

## 3. Routing fix

Added two signals to `server/local-agent.ts`'s `classifyLocal()`: **`needsPersonalOrSum`** (a personal-account phrase — "của tôi", "my bill" — or a summation word — "tổng", "total") and **`CLOCK_TIME_SUPPLIED`** (a guest-typed clock time — "8am", "8 giờ sáng"). All three escalation paths above were re-gated to require one of these (or an explicit money *amount*, or a genuine write verb) before forcing `complex`/`transaction` — a bare topic word no longer does it alone.

| Condition | Old behavior | New behavior | Why safety is preserved |
|---|---|---|---|
| `hardMoney` alone | always → `complex` | → `complex` only with `needsPersonalOrSum` | A published rate has no personal reference; a folio total always does ("của tôi", "tổng") |
| `quantityCue` alone (no money word) | → `complex` unless a counting unit present | → `complex` only with `needsPersonalOrSum` too | Fixes the VI/EN inconsistency on the exact same fact |
| `COMPLEX_FAMILIES` | `["room_shopping", "billing"]`, any score | `["room_shopping"]` only, **score ≥ 4** | "billing" was redundant with (and less precise than) the money-word check; the score floor separates "gói nào rẻ nhất" (score 5, a real recommendation) from "bảng giá" (score 2, a definition lookup) |
| `WRITE_WORDS` bare-word match | "đặt" matched inside "đặt cọc" (deposit, a noun); "thanh toán" matched inside "hình thức thanh toán" (payment *methods*, informational) | Both excluded via phrase-level guards | Same false-positive class already documented for "huỷ phòng" earlier this project — a noun phrase containing a write-verb-shaped substring is not a write intent |
| Guest-supplied clock time + fee question | not previously protected by this rule at all | forces `needsPersonalOrSum` → `complex` | Re-protects "I land at 8am. How much to check in early?" — a case this project already fixed once (Part 4) after the model invented a time; this phase's first version of the fix accidentally reopened it, caught by the pre-existing regression test before shipping |

**A real safety regression was caught and fixed during this work**: "Hoàn tiền cho tôi." (refund request) fell through to `knowledge` once the blanket money-word rule was narrowed, because `WRITE_WORDS` had never actually included refund vocabulary — it only ever escalated because "tiền" (money) triggered the old blanket rule. Added `"hoàn tiền"`/`"refund"` to `WRITE_WORDS`. Caught by the new unit test (`test/routing-informational.test.ts`, case 8), not assumed safe.

13 new unit tests (`test/routing-informational.test.ts`) cover all 10 of the spec's required cases plus 3 case-shape regressions; all pass. The pre-existing `test/local-agent.test.ts` routing regression block was updated — every changed expectation carries a comment explaining old behavior, new behavior, and why (not silently edited); full existing test suite is green.

## 4. Before/after routing metrics

| | Before | After |
|---|---:|---:|
| Quality-set (102) short-circuited | 49 (48.0%) | **25 (24.5%)** |
| Original ANSWER-lane (45) wrongly blocked | 2 | **0** |
| Original ESCALATE-lane (18) still escalating | 18 | 14 (4 correctly reclassified as informational — verified case by case, see §10) |
| Genuinely transactional/personal/recommendation cases (folio, budget, cheapest, cancel, change-date, book-table, extend, towels, pay) | escalate | **still escalate, unchanged** |

## 5. Beach Comber Bar investigation

Traced the exact evidence passed to the model (not assumed): the dedicated `Beach Comber Bar — ẩm thực` chunk itself stated `Giờ mở cửa: 09:00–18:00`, while a separately curated `Restaurants and bars — hours` KB article stated `Beach Comber Bar is open 09:00–23:00`. **Two source documents disagreeing about the same fact.** The model's answer ("09:00 đến 18:00") was a verbatim, faithful quote of its top-ranked passage. Traced to `server/data/venues.json` / the live `dining_venues` DB row: `hours: [{open:"09:00", close:"18:00"}]` — a genuine data-entry error (source file `Beachcomber-7.txt`), not a generation failure. Root cause: **DATA_CONFLICT**, matching the exact taxonomy category the spec listed and the same failure class this project already fixed once before (Part 1's spa-hours conflict).

## 6. Lotus Restaurant investigation

Traced the exact evidence: the dedicated `Lotus Restaurant — ẩm thực` chunk read `Giờ mở cửa: 07:00–21:00 (Sáng 06:00–10:30, Trưa 12:00–14:00, Tối 18:00–22:00)` — **the correct 3-slot structure was already present**, but a separate, wrong, misleadingly-derived summary field (`07:00–21:00`, which does not even span the real hours correctly) was displayed first and prominently, with the true structure demoted to a parenthetical. Root cause traced to `hoursText()` in `server/dining.ts`: it always led with `v.hours` (a coarse span field, independent of and not derived from the meal windows) before appending `v.mealWindows`. The model reads the first thing it sees, exactly like a person would. Root cause: **structural evidence presentation**, not generation — the spec's own example of the correct diagnosis to reach before touching code.

## 7. Hallucination root causes — a materially different diagnosis than Phase 8 assumed

**Neither confirmed "hallucination" was actually the model inventing an unsupported fact.** Both were the model faithfully reporting what its top-ranked evidence said — evidence that was wrong (Beach Comber) or badly presented (Lotus). This matters: Phase 8's framing ("both models each produced exactly one hallucination") implied a generation-layer defect requiring a generation-layer fix. The real fix was two lines of data and one function, at the retrieval-evidence layer, and it fully resolved Beach Comber for both models without touching either model.

## 8. Hallucination remediation

1. **Beach Comber**: corrected the live `dining_venues.hours` row from `18:00` to `23:00` (checkpoint saved before the change: `bench/baselines/kiosk-validation/data.db.pre-phase9`), matching `server/data/venues.json`'s source-of-truth copy, which was corrected identically.
2. **Lotus / all future multi-window venues**: `hoursText()` now shows *only* the meal-window breakdown when meal windows exist, and only falls back to the coarse `v.hours` span when there are none — a generalizable presentation fix, not a per-venue patch. Verified small blast radius before shipping: **Lotus Restaurant is the only venue in the current 7-venue corpus with meal windows**, so this touches exactly the case it needed to and nothing else.
3. Reindexed (`reindex.ts`) and reverified with real model calls (not assumed from the code change alone):

| | Before | After |
|---|---|---|
| Beach Comber — qwen3.5:4b | "09:00 đến 18:00" (wrong) | **"09:00 đến 23:00" (correct)** |
| Beach Comber — qwen2.5:3b | (not previously tested standalone) | **"09:00 đến 23:00" (correct)** |
| Lotus — qwen3.5:4b | "09:00 đến 18:00" collapsed single interval (wrong) | **"06:00–10:30, 12:00–14:00, 18:00–22:00" — full 3-slot structure preserved (correct)** |
| Lotus — qwen2.5:3b | "07:00 đến 21:00" (wrong) | **"06:00 đến 22:00" — still a single collapsed interval, a *different* wrong answer** |

Lotus is fixed for qwen3.5:4b, not for qwen2.5:3b. This is now clean evidence of a genuine, model-specific defect (qwen2.5:3b independently compresses multi-interval schedules even given correct, well-presented evidence) rather than a shared architectural confound — and per the freeze's explicit "do not create a model-specific patch" rule, it was correctly left unfixed this phase rather than papered over with per-model prompt tuning.

## 9. 24-case hours/schedule validation set

New (`bench/hours-validation-cases.ts`), every fact copied verbatim from the corpus before writing, covering single-interval, multi-interval, meal-specific, facility-hours (policy `FACILITY_HOURS`), insufficient-evidence, entity-disambiguation, and multilingual/paraphrase cases:

| | qwen3.5:4b | qwen2.5:3b |
|---|---:|---:|
| Correct | 22/25 (88.0%) | 19/25 (76.0%) |

The multi-slot fix **generalizes beyond Lotus**: `h-halal-slots-vi` (Halal VietFlavors, a different 2-slot venue) passes for both models. `h-lotus-slots-vi/en` fail for qwen2.5:3b only, consistent with §8.

**Two new shared findings, discovered by this validation set, confirmed real by reading both models' actual replies, and explicitly NOT fixed this phase (out of the two-hallucination scope this phase was chartered for):**

- **`h-beach-facility-vi`**: both models state the private beach closes at 20:00. The real beach hours (policy `FACILITY_HOURS`) are 06:00–**18:30**; 20:00 is the *pool's* closing time from the same policy chunk. A genuine entity-confusion error, shared by both models against identical evidence.
- **`h-bachgiai-unknown`**: both models confidently state specific hours for Bách Giai restaurant, whose hours are *explicitly* marked "xem danh sách dịch vụ hoặc hỏi lễ tân" (ask front desk) in the corpus — genuinely unconfirmed. qwen3.5:4b fabricated hours matching a *different* venue (Halal VietFlavors' real hours); qwen2.5:3b fabricated a different wrong range. This is arguably more serious than the two original hallucinations, since it confidently invents specifics for a fact the corpus itself says is unknown.

One scorer artifact, not a real failure: `h-gym-ja` — both models correctly answered "5:30am–10pm" in natural Japanese notation (`午前5時30分`/`午後10時`); the test's `expect` list only anticipated `"22:00"`/`"22時"` and didn't recognize `午後10時` as the same fact.

## 10. Full 165-case regression, before/after

Both the original 63-case set and the 102-case Phase 8 quality set, through the real production path, both models:

| | qwen3.5:4b before | qwen3.5:4b after | qwen2.5:3b before | qwen2.5:3b after |
|---|---:|---:|---:|---:|
| 63-case set (raw) | 52/63 (82.5%) | 49/63 (77.8%) raw / **53/63 (84.1%) adjusted** | 56/63 (88.9%) | 53/63 (84.1%) raw / **57/63 (90.5%) adjusted** |
| 102-case quality set | 48/102 (47.1%) | **63/102 (61.8%)** | 44/102 (43.1%) | **53/102 (52.0%)** |

*"Adjusted"* accounts for 4 specific cases (`esc-breakfast-price`, `esc-breakfast-price-en`, `esc-deposit`, `esc-price-ja`) whose static `lane: "escalate"` label in `bench/offline-cases.ts` — preserved unchanged, per the phase's explicit rule not to edit the case set — is now stale: this phase's routing fix intentionally makes them informational, and both models answered every one of them **correctly and grounded** (verified: real published breakfast price 650,000 VND, real deposit amounts 1,000,000/3,000,000 VND). The scorer still marks a non-escalation on an `escalate`-lane case as a failure, so the raw number understates true correctness for these 4 cases specifically; this is documented here rather than silently patched into the scorer.

The 102-case quality-set improvement (+14.7pp for qwen3.5:4b, +8.9pp for qwen2.5:3b) is the direct, expected effect of the routing fix: roughly 24 fewer cases are discarded before retrieval, so retrieval and the model get a real chance at them for the first time.

`q-beachcomber-hours`: **correct for both models** in this full run (matches §8's manual reverification). `q-lotus-slots`: **correct for qwen3.5:4b, still wrong for qwen2.5:3b** in this full run (matches §8 exactly — the model-specific finding is stable, not a fluke of the smaller manual check).

## 11. qwen2.5:3b vs qwen3.5:4b, post-fix

| | qwen3.5:4b | qwen2.5:3b |
|---|---:|---:|
| 63-case (adjusted) | 84.1% | **90.5%** |
| 102-case quality | **61.8%** | 52.0% |
| Lotus multi-slot (this phase's target case) | fixed | still fails |
| p50 / p95 latency | 12.7–13.6s / 26–28s | **4.4–4.7s / 6.2–6.5s** |
| Hardware fit (Phase 7, unchanged) | 52% CPU offload | **100% GPU** |

Same pattern as Phase 8, now on cleaner data: qwen2.5:3b wins the original, simpler 63-case set and every latency/hardware metric by a wide margin; qwen3.5:4b is more accurate on the harder, more varied 102-case set, and is the only one of the two that fully resolved this phase's target Lotus case.

## 12. Remaining failures

- **Genuinely model-specific**: qwen2.5:3b's Lotus multi-slot compression (§8) — the clearest example this project has produced of a failure that survives identical, correct, well-presented evidence and differs between the two models.
- **New, shared, unfixed this phase**: the beach/pool entity-confusion and the Bách Giai unconfirmed-hours fabrication (§9) — real, confirmed, and explicitly deferred, not silently dropped.
- **Documented residual routing conservatism**: `esc-late-fee`, `esc-cancel-fee` (en/ko), `esc-price-zh` still escalate via the `stay_changes` family match rather than becoming informational, even though a general policy-band description of these fees is arguably safe. Left alone this phase — family-scoring rework for `TRANSACTION_FAMILIES` was judged a larger, less-evidenced change than the freeze's "smallest necessary" mandate allows.
- **`ANSWERABLE_FROM_TOOL` cases (0/4 for both models)**: every tool-shaped quality case (airport pickup price, city transfer price, lead time, package comparison) failed for both models — the local RAG-first path has no tool-execution loop when routed to `knowledge`, so these can only ever be answered if the fact happens to also be readable as KB prose. Not investigated further this phase; flagged as a real gap for the next one.

## 13. Is model comparison now trustworthy?

**Meaningfully cleaner than Phase 8, not claimed perfect.** The routing confound (which explained the majority of Phase 8's confusing raw-score drop) is fixed and tested. The Beach Comber hallucination is fully resolved and no longer contaminates either model's score. The Lotus case is now a genuine, verified, model-specific data point rather than noise. But this phase's own verification work found two *new* shared fact-fabrication issues that neither Phase 7 nor Phase 8 could have caught (they didn't exist as measured findings until this phase's 24-case set exercised them) — so "clean" would overstate the current state. The comparison is honest and improved, not finished.

## 14. Recommendation for next phase

Two candidates, roughly equal priority: (a) fix the beach/pool entity-confusion and the Bách Giai unconfirmed-hours fabrication found in §9 — both are real, both are shared (not model-selection noise), and the Bách Giai case in particular is a more serious pattern (confident fabrication over an admitted unknown) than either of this phase's original two targets; (b) resolve the `ANSWERABLE_FROM_TOOL` gap (§12) before the next model comparison, since 4/102 cases are currently unwinnable by either model regardless of quality.

---

## Final decision — answered exactly as asked

**A. Is the routing architecture now measuring answerable questions correctly?**
Yes, substantially — 48% → 24.5% short-circuited, zero false blocks on the original answer-lane, and every genuinely transactional/personal case still protected (verified case by case, with a caught-and-fixed safety regression along the way). Not perfectly: a documented set of policy-band fee questions (late checkout, cancellation) still escalate via family scoring rather than answering, a conservative but real residual gap.

**B. Are the two confirmed hours hallucinations actually fixed?**
**Beach Comber Bar: yes, for both models, verified with real reruns.** **Lotus Restaurant: yes for qwen3.5:4b, no for qwen2.5:3b** — same underlying data/presentation defect fixed, but qwen2.5:3b independently re-introduces a different wrong single-interval answer from correct evidence. Additionally, this phase's own validation work found two *new*, unfixed, shared hallucination-adjacent issues (§9) that must not be conflated with "the two hallucinations are fixed" — they are a separate, still-open problem.

**C. Which remaining failures are genuinely model-specific?**
qwen2.5:3b's Lotus multi-slot compression is the clearest, most rigorously verified example (same evidence, same routing, same everything except the model — one gets it right, one doesn't, reproducibly).

**D. Which model now has the better quality/coverage profile?**
Mixed, unchanged in shape from Phase 8: qwen2.5:3b leads the original 63-case set (90.5% adjusted vs 84.1%); qwen3.5:4b leads the harder 102-case set (61.8% vs 52.0%) and is the only one that fully resolved this phase's hallucination target.

**E. Which model now has the better kiosk performance profile?**
qwen2.5:3b, unchanged and not close — 2.7–3x faster at both p50 and p95, and the only one of the two that fits entirely in the 4GB GPU target.

**F. Is either model ready for final acceptance testing?**
**No. MODEL SELECTION REMAINS OPEN.** Neither model is unconditionally better, both still have at least one confirmed model-specific or shared defect that a final-acceptance phase should not inherit silently, and this phase's own work uncovered new open issues rather than closing the book on old ones.

Not declaring production readiness. Per the phase's stop condition: no fine-tuning, no per-model prompts, no further retrieval changes, no proceeding to llama3.2:3b/gemma2:2b this session.
