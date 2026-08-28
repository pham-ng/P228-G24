/**
 * Delete tasks that belong to no conversation.
 *
 * `seed.ts` writes 42 tasks with `conversation_id = NULL` to give the operations
 * board volume. They are fixtures in the same sense the empty conversations
 * were: nothing raised them, and a manager clicking one cannot open the thread
 * behind it, because there is none.
 *
 * They also corrupt the resolution-time card. Their `createdAt` is seed time,
 * so closing them today stamped a duration of days — average resolution read
 * 5,322 minutes when the demo cohort's real figure is about 40.
 *
 * Stop the dev server first; SQLite will not take the write lock otherwise.
 *
 *   npx tsx scripts/purge-orphan-tasks.ts            # dry run
 *   npx tsx scripts/purge-orphan-tasks.ts --apply
 */
import Database from "better-sqlite3";

const db = new Database(process.env.DB_FILE || "data.db");
db.pragma("busy_timeout = 8000");

const orphans = db.prepare("SELECT COUNT(*) n FROM tasks WHERE conversation_id IS NULL").get() as any;
const total = db.prepare("SELECT COUNT(*) n FROM tasks").get() as any;
console.log(`${orphans.n}/${total.n} task khong gan voi hoi thoai nao.`);

if (!process.argv.includes("--apply")) {
  console.log("\n-- DRY RUN. Chay lai voi --apply de xoa. --");
  for (const r of db
    .prepare(
      `SELECT source, status, COUNT(*) n FROM tasks WHERE conversation_id IS NULL
       GROUP BY source, status ORDER BY n DESC`,
    )
    .all() as any[]) {
    console.log(`  source=${r.source} status=${r.status} -> ${r.n}`);
  }
  process.exit(0);
}

const removed = db.prepare("DELETE FROM tasks WHERE conversation_id IS NULL").run().changes;
db.pragma("wal_checkpoint(TRUNCATE)");
console.log(`da xoa ${removed} task.`);

const done = db
  .prepare("SELECT created_at, resolved_at FROM tasks WHERE status='done' AND resolved_at IS NOT NULL")
  .all() as any[];
const mins = done.map((t) => (new Date(t.resolved_at).getTime() - new Date(t.created_at).getTime()) / 60_000);
console.log(
  `con lai ${(db.prepare("SELECT COUNT(*) n FROM tasks").get() as any).n} task · ` +
    `thoi gian xu ly trung binh ${Math.round(mins.reduce((a, b) => a + b, 0) / (mins.length || 1))} phut`,
);
process.exit(0);
