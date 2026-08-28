/**
 * Remove the booking left behind by `bench/booking-core-probe.ts`.
 *
 * Proving the booking core works meant actually booking something: a real
 * service_bookings row, a real approval, and a real 520.000 charge on Yuki
 * Tanaka's folio. None of that should stay in a dataset shown to a customer.
 *
 * Matched by the charge id the booking itself records, not by guessing at
 * descriptions — the booking row is the authoritative link.
 *
 * Stop the dev server first.
 *
 *   npx tsx scripts/purge-booking-probe.ts            # dry run
 *   npx tsx scripts/purge-booking-probe.ts --apply
 */
import Database from "better-sqlite3";

const db = new Database(process.env.DB_FILE || "data.db");
db.pragma("busy_timeout = 8000");

const bookings = db.prepare("SELECT * FROM service_bookings").all() as any[];
console.log(`${bookings.length} service_booking.`);
bookings.forEach((b) =>
  console.log(`  #${b.id} service=${b.service_id} ${b.date} ${b.slot} status=${b.status} charge=${b.charge_id ?? "—"}`),
);

if (!bookings.length || !process.argv.includes("--apply")) {
  if (bookings.length) console.log("\n-- DRY RUN. Them --apply de xoa. --");
  process.exit(0);
}

db.transaction(() => {
  for (const b of bookings) {
    if (b.charge_id) db.prepare("DELETE FROM folio_charges WHERE id = ?").run(b.charge_id);
    db.prepare("DELETE FROM service_approvals WHERE payload LIKE ?").run(`%"bookingId":${b.id}%`);
    db.prepare("DELETE FROM service_bookings WHERE id = ?").run(b.id);
  }
  /* The audit events the probe generated name the booking; leaving them would
     be a trail pointing at rows that no longer exist. */
  db.prepare("DELETE FROM audit_events WHERE type LIKE 'book_service%' OR type LIKE 'service_booking%'").run();
})();
db.pragma("wal_checkpoint(TRUNCATE)");

console.log(`\nda xoa ${bookings.length} booking, khoan phi va approval kem theo.`);
console.log(`  con lai: ${(db.prepare("SELECT COUNT(*) n FROM service_bookings").get() as any).n} booking, ` +
  `${(db.prepare("SELECT COUNT(*) n FROM service_approvals").get() as any).n} approval.`);
process.exit(0);
