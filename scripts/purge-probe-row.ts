/**
 * Remove a feedback row left by probing the guest thumbs-down path.
 *
 * Pass --mark=TEXT to target a different probe comment; the default is the
 * original one. Verifying through the real endpoint is the only way to prove
 * the path works, and it leaves a real row behind every time.
 *
 * The check had to go through the real endpoint to prove it, which means it
 * left a real row, a real escalation task and a real mode flip behind. Its
 * comment reads "kiem tra nut thumbs-down", which has no business sitting in a
 * dataset shown to a customer.
 *
 * Stop the dev server first.
 *
 *   npx tsx scripts/purge-probe-row.ts --apply
 */
import Database from "better-sqlite3";

const db = new Database(process.env.DB_FILE || "data.db");
db.pragma("busy_timeout = 8000");

const MARK = process.argv.find((a) => a.startsWith("--mark="))?.slice(7) ?? "kiem tra nut thumbs-down";
const rows = db.prepare("SELECT * FROM feedback WHERE comment = ?").all(MARK) as any[];
console.log(`${rows.length} dong feedback thu nghiem.`);
if (!rows.length || !process.argv.includes("--apply")) {
  if (rows.length) console.log("-- DRY RUN. Them --apply de xoa. --");
  process.exit(0);
}

db.transaction(() => {
  for (const r of rows) {
    /* The task the thumbs-down opened, matched on the title that path uses. */
    db.prepare(
      "DELETE FROM tasks WHERE conversation_id = ? AND title LIKE 'Phản hồi%' OR (conversation_id = ? AND detail LIKE ?)",
    ).run(r.conversation_id, r.conversation_id, `%${MARK}%`);
    db.prepare("DELETE FROM feedback WHERE id = ?").run(r.id);
  }
})();
db.pragma("wal_checkpoint(TRUNCATE)");
console.log(`da xoa ${rows.length} dong (va task kem theo).`);
process.exit(0);
