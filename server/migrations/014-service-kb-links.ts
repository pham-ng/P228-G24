/**
 * Migration 014: link services to the real, curated KB articles that ground
 * them, and group near-duplicate rows (7 Akoya Spa treatments, 2 VinWonders
 * ticket tiers) under one detail card — mirrors the dining_venue/room_type
 * "view details" mechanism, but only for services where a dedicated KB
 * article was actually verified. Rows left unset (buggy transfer, airport
 * transfer, in-room dining, Aquafield) get no detail card rather than a
 * card built on a guess or on the wrong shared placeholder photos.
 *
 *   DB_FILE=data.db npx tsx server/migrations/014-service-kb-links.ts
 */
import "dotenv/config";
import { migrate, storage } from "../storage";

const LINKS: Array<{ names: string[]; kbTitles: string[]; group: string }> = [
  {
    names: [
      "Akoya Spa — Warm Bamboo Massage 85'",
      "Akoya Spa — Hot Stone Therapy 90'",
      "Akoya Spa — Balinese Massage 90'",
      "Akoya Spa — Vietnamese Traditional Massage 60'",
      "Akoya Spa — Foot Therapy 50'",
      "Akoya Spa — Spa Sampler 90'",
      "Akoya Spa — Thalgo Collagen Radiance facial 60'",
    ],
    kbTitles: ["Akoya Spa — treatments and prices", "Akoya Spa — spa trên mặt nước"],
    group: "Akoya Spa",
  },
  {
    names: ["Vinpearl cable car — round trip"],
    kbTitles: ["Cáp treo Vinpearl ra đảo Hòn Tre", "Cable car and Vinpearl Harbour ticket prices"],
    group: "Vinpearl cable car",
  },
  {
    names: ["VinWonders Nha Trang — day ticket", "VinWonders — 2-day unlimited pass"],
    kbTitles: ["VinWonders Nha Trang tickets and shows"],
    group: "VinWonders Nha Trang",
  },
  {
    names: ["Vinpearl Harbour — all-inclusive combo"],
    kbTitles: ["Cable car and Vinpearl Harbour ticket prices"],
    group: "Vinpearl Harbour",
  },
  {
    names: ["Beach & water sports desk"],
    kbTitles: ["Thể thao & hoạt động dưới nước", "Beach, pool and water sports"],
    group: "Beach & water sports",
  },
];

function main() {
  migrate();
  const all = storage.listServices();
  let n = 0;
  for (const link of LINKS) {
    for (const name of link.names) {
      const s = all.find((x) => x.name === name);
      if (!s) {
        console.warn(`[services] not found, skipped: ${name}`);
        continue;
      }
      storage.updateService(s.id, { linkedKbTitles: JSON.stringify(link.kbTitles), serviceGroup: link.group });
      n++;
    }
  }
  console.log(`[services] linked ${n} rows across ${LINKS.length} groups`);
}
main();
