/**
 * Migration 007: add the missing "Grand Deluxe Ocean View Queen Bed" category.
 *
 * The property publishes and sells this room — the rate-package import found
 * seven real packages for it — but it was absent from `room_types`. Without a
 * catalogue row the recommendation engine cannot apply occupancy or view
 * filters to it, and worse, it once told a guest an ocean-view room had no
 * ocean view, because "unknown" and "absent" looked the same.
 *
 * Facts verified against the official Vinpearl property page (42 m², ocean view,
 * queen bed, along the beach, suited to couples / small families / business
 * travellers). Capacity and amenities follow its published siblings, which share
 * the Grand Deluxe floor plan.
 *
 *   DB_FILE=data.db npx tsx server/migrations/007-missing-room-type.ts
 */

import "dotenv/config";
import { migrate, storage } from "../storage";

const CODE = "Grand Deluxe Ocean View Queen Bed";
const SOURCE = "https://vinpearl.com/en/hotels/vinpearl-resort-nha-trang";

function main() {
  migrate();
  if (storage.listRoomTypes().some((r) => r.code === CODE)) {
    console.log(`[room_types] "${CODE}" already present — nothing to do.`);
    return;
  }

  /* The twin of the same class is the right template: identical floor plan and
     view, differing only in bed configuration. Copying it keeps the catalogue
     internally consistent instead of inventing a second set of figures. */
  const twin = storage.listRoomTypes().find((r) => r.code === "Grand Deluxe Ocean View Twin Bed");
  if (!twin) {
    console.error("Template row 'Grand Deluxe Ocean View Twin Bed' not found; refusing to guess.");
    process.exit(2);
  }

  const created = storage.createRoomType({
    hotelId: twin.hotelId,
    code: CODE,
    nameVi: "Grand Deluxe Hướng Biển Giường Đôi",
    areaSqm: 42,
    bedrooms: null,
    bed: "double",
    oceanView: 1,
    privatePool: 0,
    maxGuests: 4,
    combinations: twin.combinations,
    description:
      "Với diện tích 42 m², Grand Deluxe Hướng Biển Giường Đôi là phòng khách sạn hiện đại với giường đôi sang trọng, " +
      "nằm dọc bãi biển và có tầm nhìn hướng biển. Phù hợp cho cặp đôi, gia đình nhỏ hoặc khách công tác.",
    amenities: twin.amenities,
    /* Not from a scraped page file: verified directly against the official
       property page, so the provenance says exactly that. */
    sourceFile: "web:vinpearl.com/en/hotels/vinpearl-resort-nha-trang",
    sourceUrl: SOURCE,
    images: JSON.stringify(
      Array.from({ length: 5 }, (_, i) => `/rooms/grand-deluxe-huong-bien-giuong-doi/${i + 1}.webp`),
    ),
  } as any);

  console.log(`[room_types] added "${created.code}" (42 m², ocean view, queen bed) — source: ${SOURCE}`);
  console.log(`[room_types] total categories: ${storage.listRoomTypes().length}`);
}

main();
