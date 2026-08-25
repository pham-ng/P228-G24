/**
 * Phase A knowledge hygiene.
 *
 * Classifies every existing KB article — quality, freshness class, provenance,
 * canonical entity — and quarantines the scraped "vin_wonder" marketing dump from
 * the retrieval index (without deleting it, so it can be curated back later).
 *
 * The retrieval benchmark is the safety net: quarantining these 21 low-quality,
 * mixed-script pages must not lower hit@k, because the curated docs (with the
 * Vietnamese aliases added earlier) already answer the golden queries. Re-run
 * bench/retrieval-eval.ts after applying to confirm.
 *
 * `classifyArticle` is pure so it is unit-testable; `applyHygiene` writes.
 */

import { storage, nowIso } from "./storage";
import type { KbArticle } from "@shared/schema";

export type Hygiene = {
  quality: "curated" | "scraped" | "placeholder";
  contentClass: "static" | "dynamic" | "mixed";
  domain: string;
  entity: string | null;
  sourceUrl: string | null;
  retrievable: number;
};

/** Curated article title (substring, lowercased) → canonical entity slug. */
const ENTITY_BY_TITLE: Array<[RegExp, string]> = [
  [/akoya spa|spa/, "spa"],
  [/beach, pool and water sports/, "pool"],
  [/korean sauna|aquafield/, "sauna"],
  [/breakfast and buffet/, "breakfast"],
  [/restaurants and bars — hours/, "dining_hours"],
  [/payment methods and bank transfer/, "payment"],
  [/cable car and vinpearl harbour/, "cable_car"],
  [/vinwonders.*tickets|tickets and shows/, "vinwonders"],
  [/cam ranh airport/, "airport_transfer"],
  [/golf on hon tre|entertainment and golf/, "golf"],
  [/meetings and events|mice/, "mice"],
  [/pearl club member/, "member_benefits"],
  [/families and children/, "children"],
  [/occupancy limits/, "occupancy"],
  [/check-in deposit/, "deposit"],
  [/check-in, check-out and identification/, "checkin_checkout"],
  [/guest list deadlines and name changes/, "name_change"],
  [/package codes and booking classes/, "package_codes"],
  [/house rules — smoking/, "house_rules_smoking"],
  [/house rules — visitors/, "house_rules_visitors"],
  [/complaints and dispute/, "complaints"],
  [/personal data and privacy/, "privacy"],
  [/rooms and room types/, "room_types_overview"],
  [/contacting the resort/, "contact"],
];

const DOMAIN_BY_CATEGORY: Record<string, string> = {
  property: "facilities",
  policy: "policy",
  dining: "dining",
  neighborhood: "neighborhood",
  wayfinding: "wayfinding",
  vin_wonder: "neighborhood",
  facilities: "facilities",
  safety: "safety",
};

/** Title/category cues that mean the article states figures that drift over time. */
const DYNAMIC_CUES = /price|pricing|ticket|hours|menu|schedule|fee|rate|giá|vé|giờ|thực đơn|bảng giá/i;

/** Pull `Source: <url>` out of the body, matching how reindex already cites it. */
function sourceFromBody(body: string): string | null {
  const m = body.match(/Source:\s*(https?:\/\/\S+)/i);
  return m ? m[1] : null;
}

export function classifyArticle(a: Pick<KbArticle, "category" | "title" | "body">): Hygiene {
  const scraped = a.category === "vin_wonder";
  const title = a.title.toLowerCase();

  let entity: string | null = null;
  if (!scraped) {
    for (const [re, slug] of ENTITY_BY_TITLE) {
      if (re.test(title)) {
        entity = slug;
        break;
      }
    }
  }

  const isPolicy = a.category === "policy";
  const contentClass: Hygiene["contentClass"] = isPolicy
    ? "static"
    : DYNAMIC_CUES.test(a.title)
      ? "dynamic"
      : "mixed";

  return {
    quality: scraped ? "scraped" : "curated",
    contentClass,
    domain: DOMAIN_BY_CATEGORY[a.category] ?? "other",
    entity,
    sourceUrl: sourceFromBody(a.body),
    // Quarantine the scraped marketing dump from the index; keep it in the DB.
    retrievable: scraped ? 0 : 1,
  };
}

/** Articles owned by the canonical model carry a "canonical" tag. */
function isCanonical(a: { tags: string }): boolean {
  try {
    return (JSON.parse(a.tags || "[]") as string[]).includes("canonical");
  } catch {
    return false;
  }
}

export function applyHygiene(): {
  classified: number;
  quarantined: number;
  curated: number;
  withSource: number;
} {
  /* Canonical-model articles are owned by canonical-facts.json — their
     provenance (source, last_verified, verification status) comes from the
     fact file, not from title/body heuristics. Re-classifying them here would
     blank that provenance; ingestCanonicalFacts happens to restore it, but
     relying on call order is fragile, so they are skipped outright. */
  const articles = storage.listKb().filter((a) => a.quality !== "placeholder" && !isCanonical(a));
  let quarantined = 0;
  let curated = 0;
  let withSource = 0;
  for (const a of articles) {
    const h = classifyArticle(a);
    storage.updateKb(a.id, {
      quality: h.quality,
      contentClass: h.contentClass,
      domain: h.domain,
      entity: h.entity,
      sourceUrl: h.sourceUrl,
      retrievable: h.retrievable,
      // Freshness is unproven until Phase B verifies against a source.
      verified: a.category === "policy" ? "unverified" : "unverified",
      lastVerified: null,
      updatedAt: nowIso(),
    });
    if (h.retrievable === 0) quarantined++;
    else curated++;
    if (h.sourceUrl) withSource++;
  }
  return { classified: articles.length, quarantined, curated, withSource };
}
