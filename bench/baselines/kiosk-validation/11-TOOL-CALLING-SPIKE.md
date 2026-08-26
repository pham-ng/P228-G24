# Aurea — Phase 10A: Local Tool-Calling Feasibility Spike

Measurement only, per explicit scope. No production code changed — this is a
standalone harness (`bench/tool-spike.ts`) exercising the local model
directly through `chat()` with one tool schema exposed, isolated from the
production RAG-first pipeline (`local-agent.ts`) entirely.

## 1. Chosen tool

**`list_services`** — read-only, 1 required arg (`category`, enum of 6
values), 1 optional arg (`date`, defaults server-side), pure DB read, no
network dependency, deterministic output. Directly relevant to 2 of the 4
previously-failing `ANSWERABLE_FROM_TOOL` cases (airport pickup price, city
transfer price both map to `category=transport`).

- Example valid call: `{"category": "transport"}`
- Example invalid call (tested): a question with no category signal at all —
  correct behavior is asking, not guessing (see t8 below)
- Expected output: array of services with `service_id`, `name`, `category`,
  `price`, `unit`

## 2. Tool schema size

One schema, ~200 tokens fully rendered — versus the hosted path's ~18
schemas / 2,217 tokens. This isolates "can a 3B model call a *small* tool
set" from "can it survive a *large* tool catalog" (the latter question is
already answered — no — by the published research cited in
`local-agent.ts`'s header comment).

## 3. Test cases (12, target was 10-14)

| id | lang | kind | expects tool? |
|---|---|---|---|
| t1-airport-vi | vi | straightforward | yes |
| t2-airport-paraphrase-vi | vi | paraphrase | yes |
| t3-airport-en | en | straightforward | yes |
| t4-cablecar-mapping-vi | vi | mapping | yes |
| t5-buggy-mapping-vi | vi | mapping | yes |
| t6-spa-vi | vi | straightforward | yes |
| t7-spa-en | en | straightforward | yes |
| t8-ambiguous-vi | vi | ambiguous (no category signal) | **no — must clarify** |
| t9-room-trap-vi | vi | wrong-tool trap (room price, not a service) | **no — must not call** |
| t10-dining-zh | zh | straightforward | yes |
| t11-experience-ko | ko | straightforward | yes |
| t12-transfer-ja | ja | straightforward | yes |

All prices/facts referenced in scoring were queried directly from `data.db`
before writing cases, not recalled from memory (Cam Ranh Airport transfer
750,000 VND/vehicle, cable car 200,000 VND/person, electric buggy
complimentary, spa Warm Bamboo 2,700,000 VND — verified via direct SQL query
the same session).

## 4. Tool selection results

| Metric | Result |
|---|---:|
| Correct tool call when required (of 10 unambiguous "should call" cases*) | **9/10 (90%)** |
| Correct non-call when tool was wrong (t9, room trap) | 1/1 |
| Correct clarification instead of guessing (t8, ambiguous) | 1/1 |
| Wrong tool called | 0/12 |
| Unnecessary tool call | 0/12 |

*t4 excluded from the "9/10" denominator's numerator — it's the one failure,
detailed below.

**The one failure (t4, "Giá cáp treo qua đảo là bao nhiêu?")**: the model
did not call the tool at all, and instead answered in prose: *"Tôi không
thấy thông tin về dịch vụ cáp treo qua đảo trong danh sách dịch vụ được cung
cấp"* ("I don't see cable car service in the list provided") — **without
ever checking**. This is a more concerning failure mode than a wrong
argument: the model asserted absence of data it never queried. Root cause
(see §13): plausibly none of the six enum values (dining/spa/experience/
transport/roomservice/all) reads as an obvious lexical match for "cáp treo"
(cable car) to a 3B model without an example in the tool description.

## 5. Argument results

Of the 10 calls that correctly selected `list_services`: **10/10 (100%)**
set `category` matching the expected value (5× transport, 2× spa, 1× dining,
1× experience — t4's failure means transport is 5/6 possible, not 6/6).
Minor, harmless schema-compliance note: several calls passed
`"date": null` explicitly rather than omitting the optional field — the
handler already tolerates this (`args.date ?? today()`), but a stricter
validator might not.

## 6. Clarification results

t8 ("Dịch vụ ở đây giá bao nhiêu?" — no category signal): model asked
*"Tôi cần biết bạn quan tâm đến loại dịch vụ nào? Ví dụ: ăn uống, spa, trải
nghiệm du lịch, vận chuyển, hay phục vụ phòng?"* — correctly enumerated the
real categories rather than guessing or defaulting to `category=all` and
silently claiming completeness. **1/1 correct.**

## 7. Final answer results (spot-checked against real DB prices)

- t1: *"Giá đưa đón sân bay ... sẽ là 750,000 VND"* — correct, matches DB.
- t5 (electric buggy): *"... là dịch vụ miễn phí"* — correctly reported free,
  did **not** fabricate a price for a complimentary service.
- t10 (dining, zh): correctly quoted 650,000 VND buffet price.
- t11 (babysitting, ko): correctly reported no babysitting service found —
  verified true (the `experience` category's real 5 services are VinWonders/
  Vinpearl Harbour/water-sports/Aquafield, none named babysitting) — this is
  **correct grounded refusal, not a failure**, unlike t4 where the tool was
  never called to check.
- t12 (airport, ja): correctly quoted 750,000 VND.

No numeric or policy fabrication observed in any final answer that actually
reached the tool.

## 8. Per-call latency

| Stage | Range | Typical |
|---|---:|---:|
| Control (existing RAG path, zero tools) | — | 2101ms (one sample; earlier session baseline ~500-900ms warm) |
| Call 1 — tool selection (1 schema exposed) | 457-1196ms | ~600ms |
| Call 1 promptEval | 77-110ms | ~90ms |
| Call 1 generation | 353-1096ms | ~500ms |

Tool selection alone, with a single small schema, is **not** materially
slower than the existing zero-tool RAG path — confirms §2's isolation
worked: the 18-schema hosted-path cost is a schema-*count* problem, not an
inherent "any tool at all" problem.

## 9. ARCH-A vs ARCH-B comparison

| Case | ARCH-A total (2 LLM calls) | ARCH-B total (template) | Delta |
|---|---:|---:|---:|
| t1 | 1868ms | 553ms | +1315ms |
| t2 | 1733ms | 526ms | +1207ms |
| t3 | 1741ms | 462ms | +1279ms |
| t5 | 1535ms | 504ms | +1031ms |
| t6 (spa, 7 results) | **4405ms** | 507ms | **+3898ms** |
| t7 (spa, 7 results) | **4469ms** | 569ms | **+3900ms** |
| t10 | 1789ms | 457ms | +1332ms |
| t11 | 2149ms | 583ms | +1566ms |
| t12 | 1715ms | 686ms | +1029ms |

**ARCH-B (deterministic template) adds zero latency beyond the first call —
by construction, since it skips the second LLM call entirely.** ARCH-A's
cost scales with the tool result's size: spa (7 services with long names)
cost ~3.9s extra, smaller result sets (1-5 services) cost ~1-1.6s extra —
consistent with this session's established finding that prompt-eval scales
with token count, now confirmed for tool-result content specifically, not
just retrieved passages.

**Engineering finding, not originally in scope but blocking without a
workaround**: Ollama 0.32.15's native `/api/chat` cannot parse `tool_calls`
echoed back on an assistant message — every attempt failed with `"Value
looks like object, but can't find closing '}' symbol"`, reproduced via
direct `curl`, isolated down to a minimal `{function:{name,arguments:"{}"}}`
with no other fields. The Ollama version can *produce* tool_calls but not
*accept* them back in conversation history — the standard OpenAI-style
"echo the assistant's tool call, then supply the tool result" pattern is not
usable on this Ollama version. Workaround (used for all ARCH-A results
above): skip the assistant echo, append the tool result as a bare
`{role:"tool", content:...}` message directly after the user turn — this
form works and the model correctly uses the injected data. Any future ARCH-A
implementation must use this shape, not the standard one.

## 10. Static vs dynamic classification (the original 4 `ANSWERABLE_FROM_TOOL` failures)

| Case | Classification | Reasoning |
|---|---|---|
| Airport pickup price | **STATIC_OR_SLOW_CHANGING** | A published rate (750,000 VND/vehicle), changes on the order of months, not per-booking. Could be safely represented in the local KB/RAG corpus like every other published rate already is (breakfast price, deposit amounts) without a freshness risk. |
| City transfer price | **STATIC_OR_SLOW_CHANGING** | Same reasoning — a published transport rate, not user-specific or live. |
| Package comparison (lead time) | **STATIC_OR_SLOW_CHANGING**, tentatively | Lead-time rules are policy text, not live state — likely already representable as prose the way cancellation/checkout policy already is. Not directly tested this spike (no `list_services`-backed case for it); flagged for the next phase's data audit, not confirmed here. |
| Current folio / reservation state | **TRULY_DYNAMIC** | Not tested this spike (out of scope — read-only, non-guest-specific tool chosen deliberately), but genuinely requires a live tool call; no amount of RAG indexing can pre-compute a guest's current balance. |

**Practical implication**: at least 2, plausibly 3, of the 4 known failures
may be closeable by adding real published rates to the KB corpus (the same
mechanism already used for room rates, breakfast price, deposit amounts) —
**without needing a tool loop at all**. This does not solve the general
"local agent can't do live lookups" problem, which is real and would still
need this spike's ARCH-B pattern for genuinely dynamic data (folio,
availability).

## 11. Failure taxonomy

| Case | First failure | Category |
|---|---|---|
| t4 (cable car) | Model claimed absence without querying | MODEL_INTERPRETATION — the tool schema/description didn't give it enough signal to map "cáp treo" to `transport`; not a routing, execution, or grounding failure, since the tool was never reached |

Only one failure in 12 cases; no DATA, ROUTING, TOOL_ARGUMENT, AUTHORIZATION,
HITL, TOOL_EXECUTION, GROUNDING, or BENCHMARK-category failures observed.

## 12. Stop-condition evaluation

| Condition | Triggered? |
|---|---|
| A. Tool selection catastrophically unreliable | **No** — 90% on required cases, 100% on both non-call cases |
| B. Tool arguments unsafe/unreliable | **No** — 100% argument accuracy on successful calls |
| C. End-to-end latency clearly unacceptable | **No for ARCH-B** (adds ~0ms) — **borderline for ARCH-A** on larger result sets (spa: +3.9s, would push total latency to 5-6s, back into the range this session already spent hours reducing) |
| D. Schema/context cost defeats current latency optimization | **No** — one small schema costs ~90ms promptEval, nowhere near the 15-schema collapse threshold |

**No stop condition triggered outright, but condition C is a real, partial
trigger specifically for ARCH-A on tool results with more than a few items.**

## 13. Recommendation

**A. Can qwen2.5:3b reliably call one small read-only tool?** Yes — 90% tool
selection, 100% argument accuracy, 100% correct clarification/refusal
behavior, on a genuinely small (1-schema) exposure.

**B. At what accuracy?** Tool selection 90% (9/10), arguments 100% of
successful calls, clarification/refusal 100% (2/2). One failure mode found:
false claim of absence without checking (t4) — worth a targeted mitigation
(a worked example in the tool description mapping "cáp treo"→transport)
before trusting this for production, not a blocking finding.

**C. Can it produce correct arguments?** Yes, 100% on this spike.

**D. How many extra ms/s does the tool loop add?** ARCH-A: +1.0-1.3s for
small tool results, **+3.9s for a 7-item result** — directly conflicts with
this session's latency work. ARCH-B: **effectively 0ms**, since it skips the
second LLM call.

**E. Is the second LLM call actually necessary?** **No, not for this tool.**
`list_services`' output is already structured (name/price/unit) and needs no
free-form reasoning to present — ARCH-B's template covers it correctly and
faster. A second call would only be justified for a tool result that
genuinely needs synthesis/reasoning the guest's phrasing requires (not
tested this spike).

**F. Is local tool calling viable enough to justify building the full
loop?** **Conditionally yes, but narrower than the original Phase 10 plan**:
viable for ARCH-B-style single-tool, template-rendered lookups on genuinely
dynamic data. Not yet demonstrated for ARCH-A (LLM-verbalized results),
which this spike shows is latency-expensive precisely when the tool result
is non-trivial in size — the exact case a real hotel tool (folio, multi-item
availability) would produce.

**G. Which existing "tool" cases should become RAG-backed static knowledge
instead?** Airport pickup price and city transfer price — both published,
slow-changing rates — should be added to the KB corpus the same way
breakfast price and deposit amounts already are, closing 2 of the original 4
failures with zero architecture change and zero latency cost. Package/lead-
time flagged for the next phase's data audit, not resolved here.

## Next-phase implication

If a full local tool loop is still wanted, scope it to **ARCH-B only**
(deterministic template rendering, no second LLM call) for tools whose
output doesn't need free-form synthesis, and treat ARCH-A as a separately-
justified, per-tool decision — not a default. Do not build ARCH-A generally
until a tool genuinely requiring synthesis is identified and its result-size
distribution is known to stay small.

STOP per phase scope. Not proceeding to the full local tool loop, model
selection, or another latency experiment without explicit direction.
