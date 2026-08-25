/**
 * Migration 005: ingest the published rate packages.
 *
 * Reads the property's package files (one folder per room category, one .txt per
 * package), parses them into structured rows, and replaces the room_packages
 * table. Idempotent: the table is rebuilt from source every run, so re-running
 * after the property republishes its rate card is the intended update path.
 *
 *   PACKAGE_DIR="D:/DATA/Vin_Resort_NhaTrang/Các loại phòng" \
 *     DB_FILE=data.db npx tsx server/migrations/005-rate-packages.ts
 */

import "dotenv/config";
import { migrate, storage, nowIso } from "../storage";
import { loadPackagesFrom } from "../packages";

const DEFAULT_DIR = "D:/DATA/Vin_Resort_NhaTrang/Các loại phòng";

function main() {
  migrate();
  const dir = process.env.PACKAGE_DIR || DEFAULT_DIR;
  const { packages, unmappedRooms, skippedFiles } = loadPackagesFrom(dir);

  if (!packages.length) {
    console.error(`No package files found under ${dir}. Set PACKAGE_DIR if the data lives elsewhere.`);
    process.exit(2);
  }

  const hotel = storage.getHotel();
  const ts = nowIso();
  const n = storage.replaceRoomPackages(
    packages.map((p) => ({
      hotelId: hotel.id,
      roomCode: p.roomCode ?? p.roomNameVi,
      roomNameVi: p.roomNameVi,
      name: p.name,
      publicPrice: p.publicPrice,
      memberPrice: p.memberPrice,
      mealPlan: p.facets.mealPlan,
      vinwonders: p.facets.vinwonders ? 1 : 0,
      golfRounds: p.facets.golfRounds,
      hotelCredit: p.facets.hotelCredit,
      aquafield: p.facets.aquafield ? 1 : 0,
      saunaJacuzzi: p.facets.saunaJacuzzi ? 1 : 0,
      cableCar: p.facets.cableCar ? 1 : 0,
      spaDiscountPct: p.facets.spaDiscountPct,
      fnbDiscountPct: p.facets.fnbDiscountPct,
      golfDiscountPct: p.facets.golfDiscountPct,
      inclusions: JSON.stringify(p.inclusions),
      conditions: JSON.stringify(p.conditions),
      hasBlackout: p.hasBlackout ? 1 : 0,
      sourceFile: `${p.roomNameVi}/${p.sourceFile}.txt`,
      updatedAt: ts,
    })),
  );

  console.log(`[packages] ingested ${n} packages across ${storage.packagedRoomCodes().length} room categories.`);
  if (unmappedRooms.length) console.warn(`[packages] folders with no room_types mapping: ${unmappedRooms.join(", ")}`);
  if (skippedFiles.length) console.warn(`[packages] files with no price (skipped): ${skippedFiles.join(", ")}`);

  /* A package whose room category is missing from room_types is still sellable
     knowledge, but occupancy and view facets cannot be applied to it — worth
     naming loudly rather than letting it silently under-match. */
  const known = new Set(storage.listRoomTypes().map((r) => r.code));
  const orphan = storage.packagedRoomCodes().filter((c) => !known.has(c));
  if (orphan.length) {
    console.warn(`[packages] room codes not present in room_types (facet filtering limited): ${orphan.join(", ")}`);
  }
}

main();
