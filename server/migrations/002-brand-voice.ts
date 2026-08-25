/**
 * Migration 002: Rewrite hotels.brand_voice to remove fabricated figures.
 *
 * Two specific problems in the current value:
 *   (a) "2.300.000 ₫ -> 1.610.000 ₫" — an unconditional Platinum spa discount
 *       stated as a concrete amount. The 30% rate IS real (pricing.ts), but
 *       brand_voice must never contain amounts: it is embedded into the system
 *       prompt unchanged, so any number there is grounded nowhere.
 *   (b) "476-key island resort" — an unverified room count.
 *
 * The replacement keeps all tone and conduct guidance; it removes every
 * money amount, percentage and room-count claim.
 *
 * Runs standalone: node server/migrations/002-brand-voice.ts
 * Reads DB from: process.env.DB_FILE || "data.db"
 * Idempotent: a second run detects the updated text and skips.
 */

import Database from "better-sqlite3";
import { join } from "node:path";

const DB_PATH = process.env.DB_FILE
  ? join(process.cwd(), process.env.DB_FILE)
  : join(process.cwd(), "data.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// ---------------------------------------------------------------------------
// The fabricated strings we are looking for (used to detect "needs migration").
// ---------------------------------------------------------------------------
const FABRICATED_MARKERS = ["476-key", "2.300.000", "1.610.000"];

// ---------------------------------------------------------------------------
// The cleaned brand voice.
//
// Rules followed:
//   - No money amounts (₫, VND, triệu, etc.)
//   - No percentages
//   - No room or unit counts
//   - Tone guidance only: language register, brevity, naming convention,
//     escalation rule, grounding rule.
//   - Loyalty tier discounts must come from the pricing tool, not from this text.
// ---------------------------------------------------------------------------
const CLEAN_BRAND_VOICE =
  "Warm, hospitable and precise — the voice of an island resort on Hon Tre, Nha Trang, reached by cable car across the bay. " +
  "Vietnamese warmth without flourish. Short sentences. Use the guest's name once, not repeatedly. " +
  "Quote prices in Vietnamese dong, but only when those prices have been returned by a tool in this conversation. " +
  "Loyalty tier discounts are calculated by the pricing tool — never state a discounted amount or a discount percentage from memory. " +
  "Never invent facilities, prices, schedules or policies: if it is not in the knowledge base or the service list, say you will confirm with the team.";

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
console.log(`\n[002-brand-voice] DB: ${DB_PATH}\n`);

const row = db.prepare("SELECT id, brand_voice FROM hotels LIMIT 1").get() as
  | { id: number; brand_voice: string }
  | undefined;

if (!row) {
  console.log("  SKIP  hotels table is empty — nothing to migrate.\n");
  db.close();
  process.exit(0);
}

const alreadyClean = FABRICATED_MARKERS.every((m) => !row.brand_voice.includes(m));

if (alreadyClean) {
  console.log("  SKIP  brand_voice contains none of the fabricated markers — already clean.\n");
  db.close();
  process.exit(0);
}

console.log("  BEFORE:");
console.log("  " + row.brand_voice.replace(/\n/g, "\n  "));
console.log();

db.prepare("UPDATE hotels SET brand_voice = ? WHERE id = ?").run(CLEAN_BRAND_VOICE, row.id);

const updated = db.prepare("SELECT brand_voice FROM hotels WHERE id = ?").get(row.id) as {
  brand_voice: string;
};
console.log("  AFTER:");
console.log("  " + updated.brand_voice);
console.log();
console.log("[002-brand-voice] done — 1 row updated.\n");

db.close();
