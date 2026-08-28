/**
 * Remove the 22:00 "early check-in" produced by the tôi/tối folding collision.
 *
 * Testing through the real endpoint is what found the bug, and testing through
 * the real endpoint leaves real rows. This clears that one approval and the
 * task behind it so the demo dataset does not carry an obviously wrong request.
 *
 * Stop the dev server first.
 *
 *   npx tsx scripts/purge-bad-approval.ts --apply
 */
import Database from "better-sqlite3";

const db = new Database(process.env.DB_FILE || "data.db");
db.pragma("busy_timeout = 8000");

/* An early check-in at or after the standard check-in time is definitionally
   impossible, which makes it a safe signature to match on. */
/* The hour is pulled out in JS, not SQL. An earlier version used
   `substr(summary, instr(summary,' ')+1, 2)`, which lands on the second WORD of
   a Vietnamese summary ("phòng") rather than on the time, casts to 0, and
   matched nothing at all — a filter that silently selects nothing looks exactly
   like a clean database. */
const bad = (
  db
    .prepare("SELECT id, task_id, summary FROM service_approvals WHERE kind = 'request_early_checkin' AND status = 'pending'")
    .all() as { id: number; task_id: number | null; summary: string }[]
).filter((a) => {
  const hh = a.summary.match(/\b(\d{2}):(\d{2})\b/)?.[1];
  return hh !== undefined && Number(hh) >= 14;
});

console.log(`${bad.length} approval sai:`);
bad.forEach((b) => console.log(`  #${b.id} ${b.summary}`));

if (!bad.length || !process.argv.includes("--apply")) {
  if (bad.length) console.log("\n-- DRY RUN. Them --apply de xoa. --");
  process.exit(0);
}

db.transaction(() => {
  for (const b of bad) {
    if (b.task_id) db.prepare("DELETE FROM tasks WHERE id = ?").run(b.task_id);
    db.prepare("DELETE FROM service_approvals WHERE id = ?").run(b.id);
    db.prepare("DELETE FROM audit_events WHERE type = 'approval.queued_offline' AND payload LIKE ?").run(
      `%"approvalId":${b.id},%`,
    );
  }
})();
db.pragma("wal_checkpoint(TRUNCATE)");
console.log(`\nda xoa ${bad.length} approval (va task kem theo).`);
process.exit(0);
