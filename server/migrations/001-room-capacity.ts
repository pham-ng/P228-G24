/**
 * Migration 001: Patch room_type capacity data for 5 records that were seeded
 * with NULL max_guests and empty combinations.
 *
 * Runs standalone: node server/migrations/001-room-capacity.ts
 * Reads DB from: process.env.DB_FILE || "data.db"
 * Idempotent: a second run detects already-set values and skips them.
 *
 * Capacity values match the published Vinpearl pages and are consistent with
 * the existing reservation VPNT-1D40TG (6 adults + 2 children in a 3BR villa).
 */

import Database from "better-sqlite3";
import { join } from "node:path";

const DB_PATH = process.env.DB_FILE
  ? join(process.cwd(), process.env.DB_FILE)
  : join(process.cwd(), "data.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// ---------------------------------------------------------------------------
// Patch data — must be consistent with room-types.json and live reservations.
// Villa 3BR: max 8 so that VPNT-1D40TG (6A+2C) is within limits.
// ---------------------------------------------------------------------------
const patches: Array<{
  code: string;
  max_guests: number;
  combinations: Array<{ adults: number; children: number }>;
}> = [
  {
    code: "Deluxe Ocean View Twin Bed",
    max_guests: 4,
    combinations: [
      { adults: 3, children: 1 },
      { adults: 2, children: 2 },
    ],
  },
  {
    code: "Grand Deluxe Twin Bed",
    max_guests: 4,
    combinations: [
      { adults: 3, children: 1 },
      { adults: 2, children: 2 },
    ],
  },
  {
    code: "Grand Deluxe Queen Bed",
    max_guests: 4,
    combinations: [
      { adults: 3, children: 1 },
      { adults: 2, children: 2 },
    ],
  },
  {
    code: "Villa 3-Bedroom Ocean View",
    max_guests: 8,
    combinations: [
      { adults: 6, children: 2 },
      { adults: 4, children: 4 },
      { adults: 8, children: 0 },
    ],
  },
  {
    code: "Tropicana Beachfront Villa 3-Bedroom",
    max_guests: 8,
    combinations: [
      { adults: 6, children: 2 },
      { adults: 4, children: 4 },
      { adults: 8, children: 0 },
    ],
  },
];

console.log(`\n[001-room-capacity] DB: ${DB_PATH}\n`);

let updated = 0;
let skipped = 0;

for (const patch of patches) {
  const row = db
    .prepare("SELECT id, code, max_guests, combinations FROM room_types WHERE code = ?")
    .get(patch.code) as
    | { id: number; code: string; max_guests: number | null; combinations: string }
    | undefined;

  if (!row) {
    console.log(`  SKIP  "${patch.code}" — not found in DB (may not be seeded yet)`);
    skipped++;
    continue;
  }

  const alreadySet =
    row.max_guests !== null && row.max_guests !== undefined && row.combinations !== "[]";

  const before = {
    max_guests: row.max_guests,
    combinations: row.combinations,
  };
  const after = {
    max_guests: patch.max_guests,
    combinations: JSON.stringify(patch.combinations),
  };

  if (alreadySet) {
    console.log(`  SKIP  "${patch.code}" — already set (max_guests=${row.max_guests})`);
    skipped++;
    continue;
  }

  db.prepare(
    "UPDATE room_types SET max_guests = ?, combinations = ? WHERE id = ?"
  ).run(patch.max_guests, JSON.stringify(patch.combinations), row.id);

  console.log(`  PATCH "${patch.code}":`);
  console.log(`         before  max_guests=${before.max_guests}  combinations=${before.combinations}`);
  console.log(`         after   max_guests=${after.max_guests}  combinations=${after.combinations}`);
  updated++;
}

console.log(
  `\n[001-room-capacity] done — ${updated} patched, ${skipped} skipped.\n`
);

db.close();
