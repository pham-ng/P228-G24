/**
 * Migration 012: insert the Ozone Seafood Restaurant dining venue.
 *
 * Confirmed real Nha Trang venue (Đảo Hòn Tre, Imperial Club) — verified
 * directly against vinpearl.com's restaurant page AND against the venue's
 * own printed A3 menu (which independently states the same Hòn Tre address),
 * unlike four other restaurants surfaced in the same "similar restaurants"
 * carousel that turned out to belong to a different property (Almaz Hà Nội)
 * and were correctly excluded.
 *
 * `server/seed.ts` only runs once against an empty database — this reuses
 * its exact insert shape via `storage.createDiningVenue()` so a single venue
 * can be added to a live database without re-seeding everything else.
 *
 *   DB_FILE=data.db npx tsx server/migrations/012-add-ozone-venue.ts
 */

import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { migrate, storage } from "../storage";
import { reindex } from "../retrieval";

const SLUG = "ozone-seafood-restaurant";

function main() {
  migrate();

  const already = storage.listDiningVenues().find((v) => v.slug === SLUG);
  if (already) {
    console.log("Already present — idempotent no-op.");
    return;
  }

  const venues: any[] = JSON.parse(readFileSync(join(process.cwd(), "server/data/venues.json"), "utf8"));
  const v = venues.find((x) => x.slug === SLUG);
  if (!v) {
    console.error(`${SLUG} not found in venues.json — add it there first.`);
    process.exit(2);
  }

  storage.createDiningVenue({
    hotelId: 1,
    code: v.code,
    slug: v.slug,
    kind: v.kind,
    nameVi: v.name_vi,
    location: v.location,
    phone: v.phone,
    hours: JSON.stringify(v.hours),
    mealWindows: JSON.stringify(v.meal_windows),
    lastOrder: v.last_order,
    prepTime: v.prep_time,
    capacity: v.capacity,
    priceRange: v.price_range,
    priceMin: v.price_min,
    priceMax: v.price_max,
    priceNote: v.price_note,
    cuisine: JSON.stringify(v.cuisine),
    dishesServed: JSON.stringify(v.dishes_served),
    highlights: JSON.stringify(v.highlights),
    goodFor: JSON.stringify(v.good_for),
    amenities: JSON.stringify(v.amenities),
    menuGroups: JSON.stringify(v.menu_groups),
    description: v.description,
    sourceFile: v.source_file,
    sourceUrl: v.source_url,
  });
  console.log(`[dining] inserted ${v.name_vi} (${v.slug})`);

  reindex().then((r) => console.log(`[reindex] ${r.embedded}/${r.chunks} chunks embedded (${r.model})${r.embedError ? " — " + r.embedError : ""}`));
}

main();
