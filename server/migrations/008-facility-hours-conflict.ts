/**
 * Migration 008: stop the seeded facility-hours table contradicting a verified fact.
 *
 * `FACILITY_HOURS` is a register of system-generated placeholder values, seeded
 * so operational tools have something to answer with and carrying an explicit
 * note that management must confirm them. That is tolerable for a gap. It is not
 * tolerable when an invented value contradicts a fact the corpus has a source
 * for, because retrieval cannot tell the two apart — it just ranks them.
 *
 * The spa was seeded 09:00–21:00. The curated page "Akoya Spa — treatments and
 * prices" says "open 09:00–22:00", checked against the official Vinpearl source
 * during Phase B. Both chunks are in the index, the placeholder outranked the
 * verified page, and the offline model told guests the spa closes at 21:00 — in
 * Vietnamese, Korean and Chinese, each time correctly quoting the wrong document.
 * The answer benchmark caught it as four separate "wrong fact" failures.
 *
 * This only ever rewrites 21:00 → 22:00 for the spa row. Every other facility
 * here is still an unconfirmed default and is left exactly as it is: replacing a
 * placeholder with a sourced value is deleting a fact nobody established, while
 * inventing hours for the gym or the kids club would be the opposite.
 *
 *   DB_FILE=data.db npx tsx server/migrations/008-facility-hours-conflict.ts
 */

import "dotenv/config";
import { migrate, storage } from "../storage";

const CODE = "FACILITY_HOURS";
const SOURCE_PAGE = "Akoya Spa — treatments and prices";
const VERIFIED_FROM = "09:00";
const VERIFIED_TO = "22:00";

type Facility = { key: string; name: string; from: string; to: string; note?: string };

function main() {
  migrate();

  const policy = storage.getPolicy(CODE);
  if (!policy) {
    console.log(`[${CODE}] not present in this database — nothing to do.`);
    return;
  }

  let rules: { facilities?: Facility[]; note?: string };
  try {
    rules = typeof policy.rules === "string" ? JSON.parse(policy.rules) : (policy.rules as any);
  } catch (e) {
    console.error(`[${CODE}] rules are not readable JSON; refusing to guess. ${String(e)}`);
    process.exit(2);
  }

  const spa = rules.facilities?.find((f) => f.key === "spa");
  if (!spa) {
    console.log(`[${CODE}] no spa row — nothing to do.`);
    return;
  }

  if (spa.from === VERIFIED_FROM && spa.to === VERIFIED_TO) {
    console.log(`[${CODE}] spa already ${VERIFIED_FROM}–${VERIFIED_TO} — nothing to do.`);
    return;
  }

  const before = `${spa.from}–${spa.to}`;
  spa.from = VERIFIED_FROM;
  spa.to = VERIFIED_TO;

  storage.updatePolicyRules(CODE, JSON.stringify(rules));
  console.log(`[${CODE}] spa hours ${before} -> ${VERIFIED_FROM}–${VERIFIED_TO}`);
  console.log(`  source: curated page "${SOURCE_PAGE}"`);
  console.log(`\nReindex so the corpus carries the corrected value:`);
  console.log(`  DB_FILE=${process.env.DB_FILE ?? "data.db"} npx tsx reindex.ts`);
}

main();
