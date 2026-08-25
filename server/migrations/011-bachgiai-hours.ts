/**
 * Migration 011: fill in Bách Giai's hours — the same DATA_GAP class as
 * migrations 008/009/010, this time with no internal source to reconcile
 * toward (unlike the pool, which had FACILITY_HOURS to check against).
 * `canonical-facts.json`'s `dining.bach_giai` entry withheld hours entirely
 * ("Giờ mở cửa và giá vui lòng xem danh sách dịch vụ hoặc hỏi lễ tân"), and
 * two separate model runs each invented a different wrong specific time —
 * one borrowed a different venue's real hours, the other stated its own
 * wrong range. Neither guessed from nothing; both filled a real gap the
 * corpus admitted having.
 *
 * The user supplied the real figures directly from the property's own page
 * (10:30–14:00, 17:00–22:00, A la Carte, 250 seats) — the same
 * source_type=official URL already on file
 * (vinpearl.com/en/nha-trang/cuisine/bach-giai-restaurant), just not yet
 * transcribed into the fact body. Not a guess with the hedge removed.
 *
 *   DB_FILE=data.db npx tsx server/migrations/011-bachgiai-hours.ts
 */

import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrate } from "../storage";
import { ingestCanonicalFacts, type CanonicalFact } from "../canonical";
import { reindex } from "../retrieval";

const FACTS_PATH = join(process.cwd(), "server/data/canonical-facts.json");
const TODAY = "2026-08-25";
const HOURS = { lunch: "10:30–14:00", dinner: "17:00–22:00" };
const SEATS = 250;
const STYLE = "A la Carte";

const PATCH: Partial<CanonicalFact> = {
  last_verified: TODAY,
  attributes: {
    cuisine: "Chinese",
    note: "the only Chinese restaurant on Hon Tre Island",
    dishes: "dim sum to signature specialties",
    ambiance: "Asian royal palace",
    location: "Imperial Club",
    style: STYLE,
    seats: SEATS,
    hours: `${HOURS.lunch}, ${HOURS.dinner}`,
  },
  languages: {
    vi: {
      title: "Nhà hàng Bách Giai (món Trung Hoa)",
      body:
        "Nhà hàng Bách Giai thuộc khu Imperial Club, là nhà hàng Trung Hoa duy nhất trên đảo Hòn Tre, phục vụ ẩm thực Trung Hoa đích thực từ dim sum tinh tế đến các món đặc sản trứ danh theo phong cách gọi món (A la Carte), sức chứa 250 chỗ, trong không gian sang trọng phong cách cung đình Á Đông. " +
        `Giờ mở cửa: ${HOURS.lunch} và ${HOURS.dinner}. (Nguồn chính thức Vinpearl, cập nhật ${TODAY}.)`,
    },
    en: {
      title: "Bach Giai Restaurant (Chinese)",
      body:
        "Bach Giai Restaurant at the Imperial Club is the only Chinese restaurant on Hon Tre Island, serving authentic Chinese cuisine à la carte from delicate dim sum to signature specialties, seating 250, in an Asian royal-palace ambiance. " +
        `Opening hours: ${HOURS.lunch} and ${HOURS.dinner}. (Official Vinpearl source, checked ${TODAY}.)`,
    },
    zh: null,
    ja: null,
    ko: null,
  },
};

function main() {
  migrate();

  const raw = JSON.parse(readFileSync(FACTS_PATH, "utf8")) as { facts: CanonicalFact[] };
  const fact = raw.facts.find((f) => f.fact_id === "dining.bach_giai");
  if (!fact) {
    console.error("dining.bach_giai not found in canonical-facts.json — nothing to patch.");
    process.exit(2);
  }
  if (fact.last_verified === TODAY && (fact as any).attributes?.hours?.includes(HOURS.lunch)) {
    console.log("Already patched — idempotent no-op.");
  } else {
    Object.assign(fact, PATCH);
    writeFileSync(FACTS_PATH, JSON.stringify(raw, null, 2) + "\n");
    console.log(`[canonical] dining.bach_giai -> hours stated plainly (${HOURS.lunch}, ${HOURS.dinner})`);
  }

  const stats = ingestCanonicalFacts();
  console.log(`\nIngested: ${stats.inserted} inserted, ${stats.updated} updated, ${stats.verified} verified, ${stats.placeholder} still placeholder`);

  console.log(`\nReindexing...`);
  reindex().then((r) => console.log(`  ${r.embedded}/${r.chunks} chunks embedded (${r.model})${r.embedError ? " — " + r.embedError : ""}`));
}

main();
