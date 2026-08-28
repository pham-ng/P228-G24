/**
 * Add `sentiment_source` / `sentiment_at` to conversations, and backfill what
 * can honestly be recovered.
 *
 * The `sentiment` column has always been written by four different things —
 * seed fixtures, the LLM conversation analyser, the realtime head, and the
 * guest's own thumbs-down — with no record of which. That is why the insights
 * pie chart could claim "classified by the model" while mostly counting dice
 * rolls from `seed.ts`.
 *
 * BACKFILL RULES, in order of confidence:
 *   1. An audit event `conversation.sentiment_escalated` proves the realtime
 *      head fired -> model_realtime, stamped with the event's time.
 *   2. A conversation with NO messages cannot have been judged from anything a
 *      guest said -> seed.
 *   3. Everything else is left NULL. It is genuinely unknown, and guessing
 *      would recreate exactly the problem this column exists to fix.
 *
 * Idempotent: safe to run twice.
 *
 *   npx tsx scripts/migrate-sentiment-source.ts
 */
import Database from "better-sqlite3";

const db = new Database(process.env.DB_PATH || "data.db");

const cols = (db.prepare("PRAGMA table_info(conversations)").all() as any[]).map((c) => c.name);
for (const [col, type] of [["sentiment_source", "TEXT"], ["sentiment_at", "TEXT"]]) {
  if (cols.includes(col)) {
    console.log(`  ${col} da co, bo qua`);
    continue;
  }
  db.exec(`ALTER TABLE conversations ADD COLUMN ${col} ${type}`);
  console.log(`  + ${col}`);
}

/* 1. The realtime head leaves an audit trail; that is proof, not inference. */
const escalated = db
  .prepare(
    `SELECT conversation_id AS id, MAX(created_at) AS at FROM audit_events
     WHERE type = 'conversation.sentiment_escalated' AND conversation_id IS NOT NULL
     GROUP BY conversation_id`,
  )
  .all() as { id: number; at: string }[];

const setSrc = db.prepare(
  "UPDATE conversations SET sentiment_source = ?, sentiment_at = ? WHERE id = ? AND sentiment_source IS NULL",
);
let n1 = 0;
for (const e of escalated) n1 += setSrc.run("model_realtime", e.at, e.id).changes;

/* 2. No transcript means nothing was ever read to produce a label. */
const n2 = db
  .prepare(
    `UPDATE conversations SET sentiment_source = 'seed'
     WHERE sentiment_source IS NULL
       AND id NOT IN (SELECT DISTINCT conversation_id FROM messages)`,
  )
  .run().changes;

console.log(`\n  model_realtime  ${n1}`);
console.log(`  seed            ${n2}`);
const unknown = (
  db
    .prepare("SELECT COUNT(*) n FROM conversations WHERE sentiment_source IS NULL")
    .get() as any
).n;
console.log(`  chua ro         ${unknown}  (co tin nhan nhung khong truy duoc nguon — de NULL)`);

console.log("\n--- phan bo sau migrate ---");
for (const r of db
  .prepare(
    `SELECT COALESCE(sentiment_source,'(null)') src, sentiment, COUNT(*) n
     FROM conversations GROUP BY src, sentiment ORDER BY src, sentiment`,
  )
  .all() as any[]) {
  console.log(`  ${String(r.src).padEnd(16)} ${String(r.sentiment).padEnd(9)} ${r.n}`);
}
process.exit(0);
