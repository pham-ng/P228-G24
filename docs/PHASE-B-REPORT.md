# Phase B — Knowledge Recovery, Verification & Expansion

Property modelled: **Vinpearl Resort Nha Trang** (accommodation on Hòn Tre Island).
Date: 2026-08-23. All changes applied via `server/migrations/004-knowledge-hygiene.ts` (idempotent).

## §1 Property / Entity Mapping (critical finding)

The 21 quarantined docs are **not** one property's knowledge. They are scraped
**VinWonders / general-Nha-Trang-tourism** pages that conflate three scopes:

| Scope | Belongs to | Examples in the 21 docs |
|---|---|---|
| The **hotel/resort** | Vinpearl Resort Nha Trang (this property) | check-in procedure, room-types marketing, cable-car access |
| A **nearby attraction** | VinWonders Nha Trang (theme park, ≠ the hotel) | park zones, park rules, tickets, dining *inside the park* |
| **General destination** | Nha Trang city (not any single property) | 12 hospitals, flight prices, travel budgets, tourist maps |

→ Recovery therefore means extracting the genuinely useful *attraction/local/access*
facts and verifying them — **not** treating VinWonders park content as hotel content.

## §13-A Knowledge Recovery Report (all 21 quarantined docs)

Final action for **every** raw doc: **STAY QUARANTINED** (never restored to RAG).
Useful facts were extracted → verified → recovered as clean canonical facts.

| id | doc | classification | recovered into |
|---|---|---|---|
| 25 | Bến tàu / harbour | MARKETING_NOISE + access fact | → `vinpearl_cable_car` |
| 26 | Bản đồ Vinpearl | MARKETING_NOISE (SEO map) | — |
| 27 | Cáp treo (cable car) | **USEFUL** | → `vinpearl_cable_car` (VERIFIED) |
| 28 | Loại phòng | DUPLICATE (authoritative = `room_types` table) | — |
| 29 | Nhà hàng *trong VinWonders* | MARKETING_NOISE (park, not hotel) | — |
| 30 | Thẻ VIP Wonder Passport | MARKETING_NOISE (out of scope) | — |
| 31 | Premium VIP Tour | MARKETING_NOISE | — |
| 32 | Quy định trò chơi | POTENTIALLY_USEFUL (park rules, low prio) | — (deferred) |
| 33 | Review 5-sao | MARKETING_NOISE (SEO listicle) | — |
| 34 | 12 bệnh viện | POTENTIALLY_USEFUL (safety) | → `emergency_contact` note (REQUIRES_HUMAN_CONFIRMATION) |
| 35 | Chuyến bay Vinh–NT | OUTDATED/dynamic, out of scope | — |
| 36 | Thủ tục check-in | DUPLICATE (authoritative = policy register) | — |
| 37 | VinWonders 6 phân khu | **USEFUL** | → `vinwonders` zones (VERIFIED) |
| 38 | VinWonders giờ/giá | DYNAMIC | → `vinwonders_tickets` (REQUIRES_HUMAN_CONFIRMATION) |
| 39 | VinWonders official landing | MARKETING_NOISE (nav only) | — |
| 40 | Facebook nội quy | UNSUPPORTED (secondary source) | — (not recovered; non-authoritative) |
| 41 | Bản đồ du lịch NT | MARKETING_NOISE | — |
| 42 | Chi phí du lịch NT | OUTDATED/dynamic | — |
| 43 | Ăn gì ở Vinpearl | DUPLICATE (authoritative = `dining_venues`) | — |
| 44 | Đặt vé VinWonders | DYNAMIC prices + **USEFUL** access/location | → `vinwonders` / `vinwonders_tickets` |
| 45 | Địa chỉ Vinpearl | **USEFUL** (location) | → `vinwonders`, `vinpearl_cable_car` |

## §13-B Factual Verification Report

| fact | verified value | source | status | confidence | last_verified |
|---|---|---|---|---|---|
| Cable car route | mainland (Trần Phú St, Nam Nha Trang) ↔ Hòn Tre, ~8 min, 08:30–23:00 (23:00–02:00 boat), 2,643 m, Guinness longest sea-crossing | [vinwonders.com](https://vinwonders.com/en/wonderpedia/news/vinpearl-cable-car-nha-trang/) | **VERIFIED** | 0.95 | 2026-08-23 |
| VinWonders NT | theme park on Hòn Tre, ~5 km from centre, 6 zones (Adventure Land, King's Garden, World Garden, Tropical Paradise, Sea World, Fairy Land), cable-car access only | [vinwonders.com](https://vinwonders.com/en/vinwonders-nha-trang/) | **VERIFIED** | 0.95 | 2026-08-23 |
| Cam Ranh airport | ~35 km / ~30 min to Nha Trang | [vinpearl.com](https://vinpearl.com/en/cam-ranh-airport-of-vietnam) | **VERIFIED** | 0.90 | 2026-08-23 |
| VinWonders tickets/hours | (scraped 2026 figures rejected) — change daily/promo | official (dynamic) | **REQUIRES_HUMAN_CONFIRMATION** | 0.20 | — |

No **CONFLICTING** facts were found against existing production knowledge: the
recovered facts are attraction/local/access, complementary to the hotel policies.
No existing fact was silently overwritten.

## §13-C Knowledge Gap Report

| missing knowledge | priority | why | authoritative source found? | status |
|---|---|---|---|---|
| Wi-Fi (network/password/coverage) | High | very frequent guest ask | ✗ (property-internal, not public) | REQUIRES_HUMAN_CONFIRMATION |
| Parking (island access) | High | frequent, island logistics | ✗ | REQUIRES_HUMAN_CONFIRMATION |
| Accessibility | High (inclusion) | wheelchair/mobility guests | ✗ | REQUIRES_HUMAN_CONFIRMATION |
| Gym / fitness | Med | common facility ask | ✗ | REQUIRES_HUMAN_CONFIRMATION |
| Currency exchange / ATM | Med | foreign guests | ✗ | REQUIRES_HUMAN_CONFIRMATION |
| Emergency / contact numbers | High (safety) | safety-critical | partial (VN public 113/114/115) | REQUIRES_HUMAN_CONFIRMATION |
| Lost-and-found policy text | Med | tool exists, policy text doesn't | ✗ | REQUIRES_HUMAN_CONFIRMATION |

These are **property-internal** facts that do not appear on public official pages;
they need the hotel's fact sheet / duty manager. They are present as safe
placeholders that make the agent defer, never guess.

## §13-D Updated Knowledge Coverage Matrix

| domain | present | complete | verified | fresh | multilingual | production_ready | priority |
|---|---|---|---|---|---|---|---|
| Policies (checkin/out, cancel, occupancy, payment…) | ✅ register | ✅ | ⚠ synthetic/unverified | ⚠ | VI/EN | ✅ (structured) | — |
| Rooms / dining / services | ✅ tables+tools | ✅ | ⚠ synthetic | live | VI/EN | ✅ | — |
| Cable-car access to island | ✅ **new** | ✅ | ✅ official | ✅ | VI/EN | ✅ | done |
| VinWonders (nearby attraction) | ✅ **new** | ✅ | ✅ official | ✅ | VI/EN | ✅ | done |
| Cam Ranh airport distance | ✅ **new** | ✅ | ✅ official | ✅ | VI/EN | ✅ | done |
| VinWonders tickets/hours | ✅ defer | n/a (dynamic) | ✗ | n/a | VI/EN | ✅ (defers) | — |
| Wi-Fi / parking / accessibility / gym / currency / emergency | ✅ placeholder | ✗ | ✗ | — | VI/EN | ✅ (defers) | High |
| ZH / JA / KO renderings | ✗ | ✗ | — | — | ✗ | ✗ | High (Phase C) |

## §13-E Remaining Unverified Facts (need human/official/live)

1. **Six property-internal gaps** (wifi, parking, accessibility, gym, currency, emergency) — need hotel fact sheet.
2. **VinWonders live prices & hours** — need live/official lookup at ask time.
3. **All existing hotel operational data** (room rates, dining venues, policy numbers) is **synthetic demo data** adapted from Vinpearl terms; it was **not** web-verified this phase (see boundary below) and remains `verified=unverified`.
4. **Nearest hospital to the resort** — the scraped "12 hospitals" list is not authoritative for "nearest to Hòn Tre"; needs confirmation.

## Honest boundary (what Phase B did NOT do, and why)

I verified only genuinely **external, stable, property-defining** facts (location,
cable car, airport, the nearby attraction). I deliberately did **not** overwrite the
hotel's own operational data (rates, venue menus, policy bands) with real-world web
numbers, because (a) that data is synthetic demo data, and (b) the authoritative
source for prices/availability is the **live PMS/tool**, not a scraped page — per the
§9 hierarchy: live tool > structured DB > verified static > secondary > scraped.

## §15 Definition of Done

- **What do we know?** Structured policies, rooms, dining, services (live tools) + 3 newly VERIFIED external facts (cable car, VinWonders, airport).
- **What did we recover?** Access/attraction/location facts from the scraped docs — as clean canonical facts, cited to official sources.
- **What did we remove from retrieval?** All 21 scraped marketing/SEO/duplicate/outdated pages (kept in DB, quarantined).
- **What is missing?** Six property-internal gaps + ZH/JA/KO renderings.
- **What is dynamic?** VinWonders prices/hours, currency rates, availability, room rates → live source, never frozen.
- **What is production-ready?** Everything `verified=verified` or safely deferring; the index is clean.
- **What remains uncertain?** Everything in §13-E — surfaced, never hidden.

## Phase B+ — Real property crawl (official Vinpearl pages)

Scope confirmed by the user: **one property — Vinpearl Resort Nha Trang** — plus
service/activity introductions and VinWonders information.

**Multi-property discipline applied.** Searching the official site surfaces sibling
properties on the same island/bay. These were found and **deliberately excluded**
because they belong to *other* Vinpearl properties, not this resort:
`Marina Restaurant`, `Nha Trang Bay Restaurant` (→ Vinpearl Resort & Spa Nha Trang Bay),
"largest Kids' Club on Hon Tre" (→ Vinpearl Discovery 1). Mixing them in is exactly
the Resort-A-gets-Resort-B's-facts failure mode.

### Facts verified from official sources (8 new, all cited)

| entity | verified content | confidence |
|---|---|---|
| `resort_overview` | Hòn Tre island, Indochine architecture, rooms + villas, private beach, largest freshwater pool in the region, Akoya Spa, Imperial Club, VinWonders on the island | 0.90 |
| `bach_giai` | **Only Chinese restaurant on Hòn Tre**, at Imperial Club; dim sum → signature specialties; royal-palace ambiance | 0.90 |
| `imperial_club` | Royal-estate setting with bay views; fine dining + **disco floor, bowling alley, karaoke lounge** | 0.90 |
| `akoya_spa` | **Signature over-water spa rooms**; Balinese, Hawaiian Lomi Lomi, Japanese Shiatsu | 0.85 |
| `main_pool` | Largest freshwater pool in the region, in lush gardens, hammocks/loungers | 0.85 |
| `bars` | Pool Bar; Wave Bar (craft cocktails, sea breeze) | 0.80 |
| `water_sports` | Private beach; kayaking, snorkeling, scuba (Vinpearl Diving Club), jet ski, parasailing, beach volleyball | 0.70 |
| `mice_weddings` | Meeting & convention facilities for business functions and weddings | 0.80 |

Source: [vinpearl.com official property page](https://vinpearl.com/en/hotels/vinpearl-resort-nha-trang),
[Bach Giai](https://vinpearl.com/en/nha-trang/cuisine/bach-giai-restaurant),
[Imperial Club](https://vinpearl.com/en/dining/imperial-club). Checked 2026-08-23.

**Important cross-check:** the existing demo content was *not* fabricated nonsense —
Bách Giai, Akoya Spa, 3-bedroom villas (~370 m²) and VinWonders access all correspond
to the real property. The demo was a faithful model; Phase B+ upgraded the core of it
from `unverified` to `verified` **with citations**, and added the missing
service/activity/entertainment layer.

**Dynamic facts deliberately NOT frozen:** all hours, prices, menus and seasonal
availability point to the live service list / staff, per the §9 hierarchy.

### Robustness fix
`applyHygiene` now skips canonical-tagged articles. Previously it re-classified them
(blanking source/last_verified) and only `ingestCanonicalFacts` running afterwards
restored the provenance — correct by call order, but fragile.

## Metrics (regression-checked)

| | Pre-Phase-B (37 cases) | Phase B (43 cases) | **Phase B+ (52 cases)** |
|---|---|---|---|
| hit@3 | 97.3% | 97.7% | **98.1%** |
| hit@5 | 97.3% | 97.7% | **98.1%** |
| MRR | 0.948 | 0.909 | 0.912 |
| chunks | 91 | 97 | **109** |
| kb_articles | 51 | 55 | **63** |
| **verified facts** | 0 | 3 | **11** |

Every original golden case still holds; only the pre-existing `P-pets-en` misses top-5.
The corpus grew (91 → 109 chunks) while accuracy *improved* — recovery and expansion,
not shrinkage. MRR moved slightly from the 37-case baseline because 15 harder new cases
were added (placeholders and curated docs compete at rank 1), while hit@3/@5 rose.
