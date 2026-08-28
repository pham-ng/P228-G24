/**
 * Give resolved tasks plausible durations instead of artefacts.
 *
 * BE CLEAR ABOUT WHAT THIS IS. Task content, department, priority and the turn
 * that raised each one are all genuine — produced by the real agent. The
 * RESOLUTION TIMES are not measured: in a dev database nobody works the board,
 * so closing tasks in bulk stamped every one of them at the moment the script
 * ran. That produced two useless shapes: the demo cohort resolved in exactly 42
 * minutes each (a constant, visibly synthetic), and older tasks in an average
 * of 1,437 minutes with outliers past 42 hours, because they had sat open for
 * days.
 *
 * So this models them, deterministically, from the task's own priority — the
 * way a hotel actually works a queue:
 *
 *   urgent  6-18 min    (a ten-minute SLA, sometimes missed)
 *   high    12-48 min
 *   normal  25-110 min
 *   low     60-240 min
 *
 * The spread is derived from the task id, so a rerun produces the same board.
 * The consequence worth stating out loud when demoing: "average resolution
 * time" and "SLA breaches" are therefore a MODEL of operations, not a
 * measurement of them. Every other figure on the Insights page is measured.
 *
 * Stop the dev server first.
 *
 *   npx tsx scripts/normalise-task-times.ts            # dry run
 *   npx tsx scripts/normalise-task-times.ts --apply
 */
import Database from "better-sqlite3";

const db = new Database(process.env.DB_FILE || "data.db");
db.pragma("busy_timeout = 8000");

const BANDS: Record<string, [number, number]> = {
  urgent: [6, 18],
  high: [12, 48],
  normal: [25, 110],
  low: [60, 240],
};

/* Deterministic pseudo-random in [0,1) from an integer — same board every run,
   and no Math.random() so the result is reproducible. */
const spread = (n: number) => {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

const done = db
  .prepare("SELECT id, priority, created_at, resolved_at FROM tasks WHERE status = 'done' AND resolved_at IS NOT NULL")
  .all() as { id: number; priority: string; created_at: string; resolved_at: string }[];

const before = done.map((t) => (new Date(t.resolved_at).getTime() - new Date(t.created_at).getTime()) / 60_000);
const mean = (a: number[]) => Math.round(a.reduce((x, y) => x + y, 0) / (a.length || 1));

const planned = done.map((t) => {
  const [lo, hi] = BANDS[t.priority] ?? BANDS.normal;
  const mins = Math.round(lo + spread(t.id) * (hi - lo));
  return { ...t, mins, at: new Date(new Date(t.created_at).getTime() + mins * 60_000).toISOString() };
});
const after = planned.map((p) => p.mins);

console.log(`${done.length} task da dong`);
console.log(`  truoc: trung binh ${mean(before)} phut  (min ${Math.min(...before)}, max ${Math.max(...before)})`);
console.log(`  sau:   trung binh ${mean(after)} phut  (min ${Math.min(...after)}, max ${Math.max(...after)})`);
const sla = (db.prepare("SELECT sla_minutes n FROM hotels LIMIT 1").get() as any)?.n ?? 10;
console.log(`  vi pham SLA ${sla}m: truoc ${before.filter((m) => m > sla).length} -> sau ${after.filter((m) => m > sla).length}`);

if (!process.argv.includes("--apply")) {
  console.log("\n-- DRY RUN. Chay lai voi --apply de ghi. --");
  process.exit(0);
}

db.transaction(() => {
  const stmt = db.prepare("UPDATE tasks SET resolved_at = ? WHERE id = ?");
  for (const p of planned) stmt.run(p.at, p.id);
})();
db.pragma("wal_checkpoint(TRUNCATE)");
console.log(`\nda cap nhat ${planned.length} task.`);
process.exit(0);
