/**
 * Migration 006: replace the hand-imported package documents with generated ones.
 *
 * An external tool had loaded 68 prose articles describing the rate packages.
 * Two problems made them unusable:
 *
 *   1. INACCURATE. At least one turned "Ưu đãi 20% Golf" (a 20% discount) into
 *      "02 vòng chơi Golf 18 hố" (two complimentary rounds) — verified against
 *      the source file, which contains no such benefit. Telling a guest their
 *      package includes something worth millions that it does not is the worst
 *      failure this system can have.
 *   2. DETACHED FROM THE SOURCE. Imported by hand, they would keep yesterday's
 *      prices after a rate change while `room_packages` moved on, and a stale
 *      price that looks sourced is worse than no price at all.
 *
 * They are removed and regenerated from the same parse that fills the pricing
 * table, so the two can never disagree, and one article per room category
 * replaces 68 near-duplicates (42 unique titles among them) that would otherwise
 * dominate a 109-chunk index.
 *
 *   PACKAGE_DIR="D:/DATA/Vin_Resort_NhaTrang/Các loại phòng" \
 *     DB_FILE=data.db npx tsx server/migrations/006-package-articles.ts
 */

import "dotenv/config";
import { migrate, storage, nowIso } from "../storage";
import { loadPackagesFrom, packageArticles } from "../packages";
import { reindex } from "../retrieval";

const DEFAULT_DIR = "D:/DATA/Vin_Resort_NhaTrang/Các loại phòng";

/** Marks of the superseded import: its own title prefix and tag set. */
function isImportedPackageDoc(a: { title: string; tags: string }): boolean {
  if (/^\[Gói Nghỉ Dưỡng\]/i.test(a.title)) return true;
  try {
    const tags = JSON.parse(a.tags || "[]") as string[];
    return tags.includes("upsell") && tags.includes("package") && tags.includes("room_rate");
  } catch {
    return false;
  }
}

async function main() {
  migrate();
  const dir = process.env.PACKAGE_DIR || DEFAULT_DIR;
  const { packages } = loadPackagesFrom(dir);
  if (!packages.length) {
    console.error(`No package files under ${dir}. Set PACKAGE_DIR if the data lives elsewhere.`);
    process.exit(2);
  }

  /* Remove the superseded import first, so a re-run cannot leave two generations
     of package documents competing in the index. */
  let removed = 0;
  for (const a of storage.listKb()) {
    if (isImportedPackageDoc(a)) {
      storage.deleteKb(a.id);
      removed++;
    }
  }

  const hotel = storage.getHotel();
  const ts = nowIso();
  const articles = packageArticles(packages);
  const existing = new Map(
    storage
      .listKb()
      .filter((a) => a.entity?.startsWith("package:"))
      .map((a) => [a.entity, a]),
  );

  let inserted = 0;
  let updated = 0;
  for (const art of articles) {
    const entity = `package:${art.roomCode ?? art.roomNameVi}`;
    const patch = {
      hotelId: hotel.id,
      category: "rate_package",
      title: art.title,
      body: art.body,
      tags: JSON.stringify(["package", "rate", "upsell", art.roomNameVi]),
      quality: "curated",
      /* The rate card was supplied by the property itself and confirmed accurate,
         which is a stronger warrant than anything a public page could give. */
      verified: "verified",
      /* Prices and cancellation deadlines move: flagged so the agent prefers the
         live pricing tool and never treats a figure here as permanent. */
      contentClass: "dynamic",
      entity,
      domain: "rate_package",
      sourceUrl: "https://booking.vinpearl.com",
      effectiveDate: null,
      lastVerified: ts.slice(0, 10),
      retrievable: 1,
      updatedAt: ts,
    };
    const prev = existing.get(entity);
    if (prev) {
      storage.updateKb(prev.id, patch);
      updated++;
    } else {
      storage.createKb(patch as any);
      inserted++;
    }
  }

  console.log(`[packages] removed ${removed} imported article(s); generated ${inserted} new, ${updated} updated.`);

  const r = await reindex();
  console.log(`[reindex] ${r.chunks} chunks, ${r.embedded} embedded.`);
  console.log(`[done] kb_articles now ${storage.listKb().length}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
