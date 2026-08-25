/**
 * Migration 003: Services Consistency Patch
 *
 * Fixes two discrepancies in the live data.db services table:
 *   1. Updates "Cam Ranh Airport transfer" price from 0 to 750,000 VND
 *      so it matches DEFAULT_TRANSPORT in server/ops.ts (single source of truth).
 *   2. Removes / deactivates nonexistent dining services ("Groove & Grill — Saturday beach BBQ"
 *      and "Ozone Restaurant — seafood (Imperial Club)") which do not exist in dining_venues.
 *
 * Runs standalone: node server/migrations/003-services-consistency.ts
 * Reads DB from: process.env.DB_FILE || "data.db"
 * Idempotent: safe to run multiple times.
 */

import Database from "better-sqlite3";
import { join } from "node:path";

const DB_PATH = process.env.DB_FILE
  ? join(process.cwd(), process.env.DB_FILE)
  : join(process.cwd(), "data.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

console.log(`\n[003-services-consistency] DB: ${DB_PATH}\n`);

/* 1. Update Airport Transfer price */
const airportSvc = db
  .prepare("SELECT id, name, price FROM services WHERE name LIKE '%Cam Ranh Airport%' OR name LIKE '%Airport transfer%'")
  .all() as { id: number; name: string; price: number }[];

for (const s of airportSvc) {
  if (s.price !== 750000) {
    db.prepare("UPDATE services SET price = 750000 WHERE id = ?").run(s.id);
    console.log(`  UPDATED service #${s.id} "${s.name}": price 0 -> 750000 ₫`);
  } else {
    console.log(`  OK service #${s.id} "${s.name}": already 750000 ₫`);
  }
}

/* 2. Deactivate/delete nonexistent dining services */
const nonexistentNames = [
  "Groove & Grill — Saturday beach BBQ",
  "Ozone Restaurant — seafood (Imperial Club)",
];

for (const name of nonexistentNames) {
  const row = db.prepare("SELECT id, active FROM services WHERE name = ?").get(name) as
    | { id: number; active: number }
    | undefined;
  if (row) {
    db.prepare("DELETE FROM services WHERE id = ?").run(row.id);
    console.log(`  DELETED service #${row.id} "${name}"`);
  } else {
    console.log(`  OK service "${name}" already removed`);
  }
}

console.log("\n[003-services-consistency] done.\n");
db.close();
