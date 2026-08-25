/**
 * Migration 013: set Ozone's images (already copied into
 * client/public/dining/ozone-seafood-restaurant/1..4.webp) — every other
 * venue already had this field populated; Ozone was the one added this
 * session (migration 012) without photos on hand yet.
 *
 *   DB_FILE=data.db npx tsx server/migrations/013-ozone-images.ts
 */
import "dotenv/config";
import { migrate, storage } from "../storage";

const SLUG = "ozone-seafood-restaurant";
const IMAGES = [1, 2, 3, 4].map((n) => `/dining/${SLUG}/${n}.webp`);

function main() {
  migrate();
  const v = storage.listDiningVenues().find((x) => x.slug === SLUG);
  if (!v) {
    console.error(`${SLUG} not found — run migration 012 first.`);
    process.exit(2);
  }
  storage.updateDiningVenue(v.id, { images: JSON.stringify(IMAGES) });
  console.log(`[dining] ${v.nameVi} images set: ${IMAGES.join(", ")}`);
}
main();
