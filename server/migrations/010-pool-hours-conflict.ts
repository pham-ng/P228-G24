/**
 * Migration 010: resolve the pool-hours data conflict — the same failure
 * class migration 008 fixed for spa and migration 009 fixed for gym, found
 * live this time rather than in a benchmark.
 *
 * `canonical-facts.json`'s `facility.main_pool` entry deliberately withheld a
 * specific hour ("Giờ mở cửa hồ bơi có thể thay đổi theo mùa — vui lòng xác
 * nhận với lễ tân") while the FACILITY_HOURS policy row already stated
 * 06:00–20:00. Both are real corpus entries; the model, given both, correctly
 * preferred the VERIFIED source's caution over the unverified specific
 * number — so a guest asking "hồ bơi mở cửa mấy giờ?" right after a beach
 * question that resolved cleanly got "please confirm with the front desk"
 * instead of an hour. That is the retrieval/grounding layer working
 * correctly against genuinely conflicting evidence, not a bug in it.
 *
 * Confirmed with the user before making this change: 06:00–20:00 is the real,
 * trustworthy figure. The fix states it plainly and keeps the seasonal
 * caveat as a footnote rather than the whole answer — exactly the shape
 * migration 009 already used for the gym ("... 22:00 ... Giờ mở cửa có thể
 * điều chỉnh theo mùa — lễ tân sẽ xác nhận nếu có thay đổi.").
 *
 *   DB_FILE=data.db npx tsx server/migrations/010-pool-hours-conflict.ts
 */

import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrate } from "../storage";
import { ingestCanonicalFacts, type CanonicalFact } from "../canonical";
import { reindex } from "../retrieval";

const FACTS_PATH = join(process.cwd(), "server/data/canonical-facts.json");
const TODAY = "2026-08-25";
const POOL_HOURS = { from: "06:00", to: "20:00" };

const PATCH: Partial<CanonicalFact> = {
  verification_status: "VERIFIED",
  last_verified: TODAY,
  attributes: {
    highlight: "largest freshwater swimming pool in the region",
    setting: "within lush gardens, hammocks and loungers",
    hours: `${POOL_HOURS.from}-${POOL_HOURS.to}, may vary by season`,
  },
  languages: {
    vi: {
      title: "Hồ bơi nước ngọt",
      body:
        "Resort có hồ bơi nước ngọt lớn nhất khu vực, đặt giữa khu vườn xanh mát với võng và ghế nằm quanh hồ, không gian thư thái. " +
        `Hồ bơi mở cửa từ ${POOL_HOURS.from} đến ${POOL_HOURS.to}. Giờ có thể điều chỉnh theo mùa — lễ tân sẽ xác nhận nếu có thay đổi. (Nguồn chính thức Vinpearl, cập nhật ${TODAY}.)`,
    },
    en: {
      title: "Freshwater swimming pool",
      body:
        "The resort has the largest freshwater swimming pool in the region, set within lush gardens with hammocks and loungers around it for a relaxing atmosphere. " +
        `The pool is open from ${POOL_HOURS.from} to ${POOL_HOURS.to}. Hours may shift seasonally — front desk can confirm any change. (Official Vinpearl source, checked ${TODAY}.)`,
    },
    zh: null,
    ja: null,
    ko: null,
  },
};

function main() {
  migrate();

  const raw = JSON.parse(readFileSync(FACTS_PATH, "utf8")) as { facts: CanonicalFact[] };
  const fact = raw.facts.find((f) => f.fact_id === "facility.main_pool");
  if (!fact) {
    console.error("facility.main_pool not found in canonical-facts.json — nothing to patch.");
    process.exit(2);
  }
  if (fact.last_verified === TODAY && (fact as any).attributes?.hours?.includes(POOL_HOURS.from)) {
    console.log("Already patched — idempotent no-op.");
  } else {
    Object.assign(fact, PATCH);
    writeFileSync(FACTS_PATH, JSON.stringify(raw, null, 2) + "\n");
    console.log(`[canonical] facility.main_pool -> hours stated plainly (${POOL_HOURS.from}-${POOL_HOURS.to}, seasonal caveat kept as a footnote)`);
  }

  const stats = ingestCanonicalFacts();
  console.log(`\nIngested: ${stats.inserted} inserted, ${stats.updated} updated, ${stats.verified} verified, ${stats.placeholder} still placeholder`);

  console.log(`\nReindexing...`);
  reindex().then((r) => console.log(`  ${r.embedded}/${r.chunks} chunks embedded (${r.model})${r.embedError ? " — " + r.embedError : ""}`));
}

main();
