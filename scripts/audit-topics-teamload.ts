/**
 * "What guests ask about" and "Team load" — how much of each is real?
 *
 * Both panels look like measurements of the operation. This prints their exact
 * inputs, split by provenance, so the answer is a number rather than an
 * impression.
 *
 *   npx tsx scripts/audit-topics-teamload.ts
 */
import Database from "better-sqlite3";

const db = new Database(process.env.DB_FILE || "data.db", { readonly: true });
const all = <T>(sql: string): T[] => db.prepare(sql).all() as T[];

const withMsgs = new Set(all<any>("SELECT DISTINCT conversation_id id FROM messages").map((r) => r.id));
const convs = all<any>("SELECT * FROM conversations");
const tasks = all<any>("SELECT * FROM tasks");
const staff = all<any>("SELECT id, name, dept FROM staff");

/* ------------------------------------------------ What guests ask about */
console.log('=== "What guests ask about" ===');
console.log("cong thuc: dem conversations.topic tren MOI hang, ke ca hang khong co tin nhan\n");

const byTopic = new Map<string, { seed: number; real: number; empty: number }>();
for (const c of convs) {
  const t = c.topic ?? "(null -> dem la 'other')";
  if (!byTopic.has(t)) byTopic.set(t, { seed: 0, real: 0, empty: 0 });
  const b = byTopic.get(t)!;
  if (!withMsgs.has(c.id)) b.empty++;
  else if (c.sentiment_source === "seed") b.seed++;
  else b.real++;
}
console.log(`  ${"chu de".padEnd(30)} ${"tong".padStart(5)} ${"rong".padStart(6)} ${"that".padStart(6)}`);
console.log("  " + "-".repeat(50));
[...byTopic.entries()]
  .sort((a, b) => b[1].seed + b[1].real + b[1].empty - (a[1].seed + a[1].real + a[1].empty))
  .forEach(([t, b]) => {
    const total = b.seed + b.real + b.empty;
    console.log(`  ${t.padEnd(30)} ${String(total).padStart(5)} ${String(b.empty).padStart(6)} ${String(b.real).padStart(6)}`);
  });
const realTopics = convs.filter((c) => withMsgs.has(c.id) && c.topic).length;
console.log(`\n  -> ${realTopics}/${convs.length} nhan chu de den tu hoi thoai co tin nhan that.`);

/* ---------------------------------------------------------- Team load */
console.log('\n=== "Team load" ===');
console.log("cong thuc: dem tasks.assigned_staff_id, khong loc nguon\n");

const realTaskIds = new Set(
  tasks.filter((t) => t.conversation_id != null && withMsgs.has(t.conversation_id)).map((t) => t.id),
);
console.log(`  ${"nhan vien".padEnd(22)} ${"open".padStart(5)} ${"done".padStart(5)} ${"tu hoi thoai that".padStart(20)}`);
console.log("  " + "-".repeat(56));
for (const s of staff) {
  const mine = tasks.filter((t) => t.assigned_staff_id === s.id);
  console.log(
    `  ${s.name.padEnd(22)} ${String(mine.filter((t) => t.status !== "done").length).padStart(5)} ` +
      `${String(mine.filter((t) => t.status === "done").length).padStart(5)} ` +
      `${String(mine.filter((t) => realTaskIds.has(t.id)).length).padStart(20)}`,
  );
}

const assigned = tasks.filter((t) => t.assigned_staff_id != null);
const unassigned = tasks.filter((t) => t.assigned_staff_id == null);
console.log(`\n  da giao: ${assigned.length} · chua giao: ${unassigned.length}`);
console.log(
  `  trong so ${assigned.length} task da giao, ${assigned.filter((t) => realTaskIds.has(t.id)).length} den tu hoi thoai that.`,
);

/* Who creates tasks, and does anything set an assignee automatically? */
console.log("\n  task theo nguon (cot source) va trang thai giao viec:");
for (const r of all<any>(
  `SELECT source,
          COUNT(*) n,
          SUM(CASE WHEN assigned_staff_id IS NULL THEN 1 ELSE 0 END) chua_giao
   FROM tasks GROUP BY source ORDER BY n DESC`,
)) {
  console.log(`    source=${String(r.source).padEnd(8)} ${String(r.n).padStart(4)} task, ${r.chua_giao} chua giao`);
}
process.exit(0);
