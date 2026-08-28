/**
 * Remove the synthetic conversations left behind by the benchmark harnesses.
 *
 * The probes in `bench/` drive real turns through the real API, which is the
 * point — they measure the shipped path, not a mock. The cost is that every run
 * leaves a guest row, a conversation, its messages, its tasks and its trace
 * spans in the database. After the August evaluation runs that came to 432
 * conversations against 103 real ones, which is enough to drown the operations
 * board and skew every number on the insights dashboard.
 *
 * WHAT IT DELETES: conversations whose guest name begins with "Test Guest",
 * their child rows in every table that references a conversation, and the
 * throwaway guest rows themselves.
 *
 * WHAT IT KEEPS, deliberately:
 *   - conversations 1-8, the seeded demo guests with real transcripts;
 *   - conversations 9-103, seeded history with no messages. Those exist to give
 *     the dashboard fourteen days of volume, and deleting them would empty
 *     every chart. Note their `sentiment` is assigned by `rand()` in seed.ts —
 *     see the warning printed at the end.
 *
 * Dry run by default. Pass --apply to actually delete.
 *
 *   npx tsx scripts/cleanup-test-data.ts            # show what would go
 *   npx tsx scripts/cleanup-test-data.ts --apply    # delete it
 *
 * Stop the dev server first, and keep the backup this prints the name of.
 */
import Database from "better-sqlite3";

const APPLY = process.argv.includes("--apply");
const DB_PATH = process.env.DB_PATH || "data.db";

/* Every table carrying a conversation_id. Kept as a list rather than relying on
   ON DELETE CASCADE because the schema does not declare foreign keys, so an
   orphaned trace span would simply linger and be counted forever. */
const CHILD_TABLES = [
  "messages",
  "tasks",
  "trace_spans",
  "audit_events",
  "guest_requests",
  "service_approvals",
  "feedback",
];

const db = new Database(DB_PATH);
db.pragma("wal_checkpoint(TRUNCATE)");

const junkConvs = db
  .prepare(
    `SELECT c.id FROM conversations c
     JOIN guests g ON g.id = c.guest_id
     WHERE g.name LIKE 'Test Guest%'`,
  )
  .all()
  .map((r: any) => r.id as number);

const junkGuests = db
  .prepare(`SELECT id FROM guests WHERE name LIKE 'Test Guest%'`)
  .all()
  .map((r: any) => r.id as number);

const before = Object.fromEntries(
  ["conversations", "guests", ...CHILD_TABLES].map((t) => [
    t,
    (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as any).n as number,
  ]),
);

console.log(`${DB_PATH}: ${junkConvs.length} hoi thoai test, ${junkGuests.length} guest gia`);
if (!junkConvs.length) {
  console.log("khong co gi de don.");
  process.exit(0);
}

if (!APPLY) {
  console.log("\n-- DRY RUN, chua xoa gi. Chay lai voi --apply de thuc su xoa. --\n");
  for (const t of CHILD_TABLES) {
    const n = (
      db
        .prepare(`SELECT COUNT(*) n FROM ${t} WHERE conversation_id IN (${junkConvs.join(",")})`)
        .get() as any
    ).n;
    if (n) console.log(`  ${t.padEnd(18)} se xoa ${n} / ${before[t]}`);
  }
  console.log(`  ${"conversations".padEnd(18)} se xoa ${junkConvs.length} / ${before.conversations}`);
  console.log(`  ${"guests".padEnd(18)} se xoa ${junkGuests.length} / ${before.guests}`);
  process.exit(0);
}

const ids = junkConvs.join(",");
const gids = junkGuests.join(",");
db.transaction(() => {
  for (const t of CHILD_TABLES) {
    const n = db.prepare(`DELETE FROM ${t} WHERE conversation_id IN (${ids})`).run().changes;
    if (n) console.log(`  ${t.padEnd(18)} -${n}`);
  }
  console.log(`  ${"conversations".padEnd(18)} -${db.prepare(`DELETE FROM conversations WHERE id IN (${ids})`).run().changes}`);
  console.log(`  ${"guests".padEnd(18)} -${db.prepare(`DELETE FROM guests WHERE id IN (${gids})`).run().changes}`);
})();

db.pragma("wal_checkpoint(TRUNCATE)");
db.exec("VACUUM");

console.log("\n--- con lai ---");
for (const t of ["conversations", "messages", "tasks", "trace_spans", "audit_events", "guests"]) {
  console.log(`  ${t.padEnd(16)} ${(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as any).n}`);
}

/* The dashboard cannot tell these apart on its own, so say it here. */
const seeded = (
  db.prepare(`SELECT COUNT(*) n FROM conversations WHERE id BETWEEN 9 AND 103`).get() as any
).n;
if (seeded) {
  console.log(
    `\nLUU Y: ${seeded} hoi thoai seed (id 9-103) van con va sentiment cua chung do rand() gan\n` +
      `trong seed.ts, khong phai model phan loai. Bieu do "Guest sentiment" tron ca hai nguon.`,
  );
}
process.exit(0);
