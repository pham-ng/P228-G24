# Aurea — Micro Experiment: Repeated Package Alias Interference

Status: **FAIL (no target failure fixed) — change REVERTED, not applied to production**

One-variable experiment: remove only the identical alias sentence repeated
across the 10 `rate_package` KB articles, everything else held fixed,
measured against the real production `hybridSearch()` chunk-level pick, not
just the document-collapsed golden-set metric. The alias was not the cause
of the three remaining Part 6/6.5 failures. Production is unchanged;
`server/packages.ts` was not modified.

---

## 1. Why the previous "deduplicate package chunks" recommendation was wrong

Part 6.5's report characterized the 10 `rate_package` documents as
"near-identical," which was false and, if acted on as originally worded
(consolidating/merging them), would have destroyed real per-room pricing
data. Reading the actual bodies (this experiment's own §2 verification)
confirms each document holds distinct room names, distinct package tiers,
and distinct real prices. The user caught this before any change was made
to production data. The 06-RRF-REMEDIATION.md report has since been
corrected in place.

## 2. Verified package-data preservation

All 10 `rate_package` KB articles inspected directly from `data.db`:

| Article | Price entries | Body length | Alias present |
|---|---:|---:|---|
| Biệt Thự 3PN Hướng Biển | 6 | 1393 | yes |
| Tropicana 3PN Hướng Biển | 6 | 1404 | yes |
| Deluxe 2 Giường Đơn | 7 | 1852 | yes |
| Deluxe Giường Đôi | 7 | 1809 | yes |
| Deluxe HB 2 Giường Đơn | 7 | 2111 | yes |
| Deluxe HB Giường Đôi | 7 | 1861 | yes |
| Grand Deluxe 2 Giường Đơn | 7 | 1858 | yes |
| Grand Deluxe Giường Đôi | 7 | 1856 | yes |
| Grand Deluxe HB 2 Giường Đơn | 7 | 1994 | yes |
| Grand Deluxe HB Giường Đôi | 7 | 1867 | yes |

Distinct price counts and body lengths confirm distinct content, exactly as
the user described. The only byte-identical span across all 10 is the alias
sentence.

## 3. Exact baseline text (unchanged, still in production `data.db`)

```
...
Lưu ý: giá và điều kiện theo bảng giá công bố của resort và có thể thay đổi — hãy xác nhận lại trước khi đặt.
Cũng được hỏi là: gói phòng, bảng giá, giá phòng, combo, trọn gói, bao gồm gì, ưu đãi phòng, gói nào rẻ nhất.
```

## 4. Exact experimental text (experimental copy only)

```
...
Lưu ý: giá và điều kiện theo bảng giá công bố của resort và có thể thay đổi — hãy xác nhận lại trước khi đặt.
```

Applied via a script (`bench/tmp-strip-alias.ts`, deleted after use) that
refused to run against anything but a path containing
`pkg-alias-experiment`, and asserted per-article that (a) removed character
count equalled exactly `len(alias sentence) + 1` (110 chars) and (b)
`before + after === newBody` — i.e. the edit is provably a pure deletion of
that one span, nothing else. All 10 articles: 110 chars removed, confirmed.
Experimental copy: `bench/baselines/kiosk-validation/data.db.pkg-alias-experiment`
(reindexed there only, with the current production embedding, `bge-m3`;
production `data.db` was re-verified untouched — alias still present in all
10, chunk count still 135 — after the experimental reindex ran).

## 5–7. BM25 / dense / RRF, document-collapsed golden-set metric (baseline vs experiment)

Same 84-case golden set, `RRF_VEC_WEIGHT=0.5` (production), both corpora:

| Metric | Baseline (with alias) | Experiment (alias removed) |
|---|---:|---:|
| hit@1 | 92.9% | 92.9% |
| hit@5 | 98.8% | 98.8% |
| MRR | 0.960 | 0.960 |
| nDCG@5 | 0.858 | 0.861 |
| by-lang hit@5 | vi 100 / en 92.9 / zh 100 / ja 100 / ko 100 | identical |

Negligible movement at the document-collapsed level — smaller than the
noise floor this project has already established for retrieval-only,
deterministic scoring (§7 of Part 6.5 showed retrieval itself has zero
run-to-run variance, so this ~0.003 nDCG delta is a real but tiny effect,
not noise).

## 8. Production chunk-level before/after — the test that matters

Real `hybridSearch()`, `RRF_VEC_WEIGHT=0.5`, `LOCAL_PASSAGES=5`, both
corpora, the six previously-diagnosed cases:

| Case | Before (production top-5) | After (alias removed) | Outcome |
|---|---|---|---|
| **pets-vi** | FACILITY_HOURS×2, CONDUCT, room, LODGING_DECLARATION | identical | unchanged (still correct at retrieval, still fails on benchmark wording — Part 6's known harness issue) |
| **id-required** | Check-in doc, 2 room-package chunks, RESERVATION_CANCELLATION, ROOM_SERVICE | Check-in doc, RESERVATION_CANCELLATION, ROOM_SERVICE, 2 unrelated KB pages | package-chunk noise gone from this case's top-5, but it was already succeeding either way |
| **chinese-restaurant** | Bách Giai (×3 variants), Halal | identical | unchanged, already correct |
| **room-count** | Gym, OCCUPANCY×2, disabled-access facilities, room | identical | **unchanged — still fails.** Its competitors are Gym/OCCUPANCY/disabled-access docs, not package chunks; alias removal cannot touch this |
| **package-codes** | 1 package chunk, BOOKING_CLASS×2, another package chunk, correct doc | BOOKING_CLASS×2, correct doc, TAX_AND_SERVICE, TRANSPORT | package-chunk noise gone, correct doc's rank improved slightly, but it was already succeeding either way |
| **guestlist-lowseason** | LODGING_DECLARATION, RESERVATION_CANCELLATION, TRANSPORT, 2 package chunks | LODGING_DECLARATION, RESERVATION_CANCELLATION, TRANSPORT, SERVICE_CANCELLATION, LOYALTY_LATE_CHECKOUT | package-chunk noise gone (replaced by other policy docs), but **GUEST_LIST still not in top-5 — still fails.** Its real competitors are sibling `policy/booking`-topic documents, not package chunks |
| **payment-methods** | 5/5 slots are room-package chunks | **still 5/5 slots are room-package chunks** (different specific rooms, same category) | **unchanged — still fails.** The alias is BM25-only; removing 110 characters from an ~1800-character body barely moves the embedding vector, and this case's package-chunk dominance is driven by dense (semantic proximity of "giá"/"tiền"/pricing concepts), not by the lexical alias |

**Verified causal mechanism**: removing the alias measurably cleared
package-chunk noise out of `id-required`, `package-codes`, and
`guestlist-lowseason`'s top-5 lists — the alias hypothesis was correctly
diagnosed as a real, present effect. But in every one of the three cases
that were actually failing, either a *different* document family fills the
freed slots (guest-list, id-required were already passing anyway) or the
package chunks stay dominant because the interference there is
dense/semantic, not lexical (`payment-methods`). Zero target failures were
fixed.

## 9. Package-query regression check

Five legitimate package-specific queries (specific room + package name,
cheapest package, package inclusions, member pricing), baseline vs
experiment:

| Query type | Baseline rank | Experiment rank |
|---|---:|---:|
| specific package name + room | 4 | 4 |
| specific room type | 1 | 1 |
| cheapest package for a room | 2 | 2 |
| package inclusions | 1 | 1 |
| member price, specific room | 1 | 1 |

**Zero regression.** Every rank is identical — legitimate package queries
match on the room/package name and price terms themselves, not on the
generic alias sentence, so removing it cost nothing.

## 10. Multilingual regression

None. zh/ja/ko hit@5 stayed at 100% in both corpora (§5–7 table above);
these languages route through the dense leg, which is only marginally
affected by a 110-character removal from otherwise-unchanged Vietnamese
text.

## 11. Decision: **REVERT**

Applying the decision rule from the spec (all 6 conditions required to
keep):

| Condition | Met? |
|---|---|
| 1. Improves the diagnosed interference | Partially — composition cleaner in 2 already-passing cases |
| 2. No damage to package-specific retrieval | Yes |
| 3. No multilingual regression | Yes |
| 4. No safety/grounding regression | Yes (no prompt, gate, or guard touched) |
| 5. Real production top-5 improves for **at least one relevant failure** | **No — zero of the three target failures changed outcome** |
| 6. Change clearly attributable to alias removal | Yes, for the compositional effect observed |

Condition 5 fails, so per the spec's explicit rule the change is **not
kept**. `server/packages.ts` is unmodified; the experimental DB copy is
retained on disk as evidence
(`bench/baselines/kiosk-validation/data.db.pkg-alias-experiment`) but is not
production and was never pointed to by any running service.

Classification: **FAIL** for the specific hypothesis under test ("removing
the repeated alias resolves the diagnosed RRF dilution for the remaining
failures"). The alias is a real, measurable, harmless-to-remove contributor
to retrieval noise — but not the cause of any of the three cases that
actually still fail.

## 12. Remaining unresolved retrieval cases — actual root cause per case

- **room-count**: competes with `Phòng Gym / Fitness` and `Occupancy, extra
  beds and children (OCCUPANCY)` — unrelated facility/policy documents, not
  package chunks and not the alias. Needs its own investigation into why
  those specific documents outrank a dense-rank-1 match.
- **guestlist-lowseason**: competes with sibling documents under the same
  `policy/booking` topic (`RESERVATION_CANCELLATION`, `SERVICE_CANCELLATION`,
  `LOYALTY_LATE_CHECKOUT`) — a same-category collision, which Part 6.5's
  diversity-cap experiment already showed it cannot resolve without
  regressing something else.
- **payment-methods**: dominated by room-package chunks through the
  **dense** leg specifically (shared "giá/tiền" pricing vocabulary), not
  the lexical alias — the one case where this experiment's hypothesis was
  simply the wrong mechanism.

Per the spec, not inventing another retrieval fix this phase. Stopping
here.
