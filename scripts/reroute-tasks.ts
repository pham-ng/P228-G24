/**
 * Apply the department routing and load balancing to tasks that predate them.
 *
 * `escalate_to_human` used to hardcode `dept: "front_desk"`, so every task in
 * the database landed there — 46 of 46, including broken air-conditioning and a
 * leaking shower. And the demo builder assigned with `staff.find(dept)`, which
 * always returns the first match, so all of them went to one person.
 *
 * This re-runs the now-correct rules over the existing rows: `departmentFor` on
 * the guest message that raised each task, then least-loaded assignment within
 * that department. It is the same logic `server/department.ts` and
 * `storage.createTask` apply to new work, not a special case for demo data.
 *
 * Stop the dev server first.
 *
 *   npx tsx scripts/reroute-tasks.ts            # dry run
 *   npx tsx scripts/reroute-tasks.ts --apply
 */
import Database from "better-sqlite3";
import { departmentFor } from "../server/department";

const db = new Database(process.env.DB_FILE || "data.db");
db.pragma("busy_timeout = 8000");
const APPLY = process.argv.includes("--apply");

const staff = db.prepare("SELECT id, name, dept FROM staff WHERE active = 1").all() as {
  id: number; name: string; dept: string;
}[];
const tasks = db.prepare("SELECT * FROM tasks ORDER BY id").all() as any[];

/* The message that raised the task. The unhappy-guest task quotes it verbatim
   in `detail`; everything else routes on the last thing the guest said before
   the task was created, which is what the live code sees. */
const triggerFor = (t: any): string | null => {
  const quoted = t.detail?.match(/"([^"]+)"/)?.[1];
  if (quoted) return quoted;
  if (t.conversation_id == null) return null;
  const m = db
    .prepare(
      `SELECT body FROM messages
       WHERE conversation_id = ? AND role = 'guest' AND created_at <= ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(t.conversation_id, t.created_at) as any;
  return m?.body ?? null;
};

const plan = tasks.map((t) => ({ t, dept: departmentFor(triggerFor(t)) }));

/* Least-loaded within the target department, counting only work still open —
   a closed task is not a burden on anybody. */
const load = new Map<number, number>();
const assignments = new Map<number, number>();
for (const { t, dept } of plan) {
  const pool = staff.filter((s) => s.dept === dept);
  if (!pool.length) continue;
  const owner = pool.reduce((best, s) => ((load.get(s.id) ?? 0) < (load.get(best.id) ?? 0) ? s : best));
  assignments.set(t.id, owner.id);
  if (t.status !== "done" && t.status !== "cancelled") load.set(owner.id, (load.get(owner.id) ?? 0) + 1);
}

const before: Record<string, number> = {};
const after: Record<string, number> = {};
for (const { t, dept } of plan) {
  before[t.dept] = (before[t.dept] ?? 0) + 1;
  after[dept] = (after[dept] ?? 0) + 1;
}
console.log("bo phan:");
for (const d of new Set([...Object.keys(before), ...Object.keys(after)])) {
  console.log(`  ${d.padEnd(14)} ${String(before[d] ?? 0).padStart(3)} -> ${String(after[d] ?? 0).padStart(3)}`);
}
console.log("\nnguoi phu trach (task dang mo):");
for (const s of staff) {
  const mineBefore = tasks.filter((t) => t.assigned_staff_id === s.id && t.status !== "done").length;
  console.log(`  ${s.name.padEnd(20)} ${String(mineBefore).padStart(3)} -> ${String(load.get(s.id) ?? 0).padStart(3)}`);
}

if (!APPLY) {
  console.log("\n-- DRY RUN. Chay lai voi --apply de ghi. --");
  process.exit(0);
}

db.transaction(() => {
  const stmt = db.prepare("UPDATE tasks SET dept = ?, assigned_staff_id = ? WHERE id = ?");
  for (const { t, dept } of plan) stmt.run(dept, assignments.get(t.id) ?? null, t.id);
})();
db.pragma("wal_checkpoint(TRUNCATE)");
console.log(`\nda cap nhat ${plan.length} task.`);
process.exit(0);
