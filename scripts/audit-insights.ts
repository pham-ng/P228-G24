/**
 * Which numbers on the Insights dashboard mean anything?
 *
 * The page renders a dozen figures with equal confidence. Some are computed
 * from things that actually happened; some are computed from `seed.ts`
 * fixtures; and a few are computed correctly from the wrong definition. Staff
 * cannot tell which is which by looking, so this prints, per metric, the value
 * the API serves alongside what it would be if the seeded rows were excluded.
 *
 * A metric whose two columns are far apart is measuring the fixtures, not the
 * hotel.
 *
 *   npx tsx scripts/audit-insights.ts
 */
import Database from "better-sqlite3";

const db = new Database(process.env.DB_FILE || "data.db", { readonly: true });
const all = <T>(sql: string): T[] => db.prepare(sql).all() as T[];
const one = (sql: string): any => db.prepare(sql).get();

const convs = all<any>("SELECT * FROM conversations");
const tasks = all<any>("SELECT * FROM tasks");
const rooms = all<any>("SELECT * FROM rooms");
const reservations = all<any>("SELECT * FROM reservations");
const charges = all<any>("SELECT * FROM folio_charges");
const sla = one("SELECT sla_minutes FROM hotels LIMIT 1")?.sla_minutes ?? 10;

/* A conversation with no transcript never happened as far as the AI is
   concerned — it is a row seed.ts wrote to give the charts a shape. */
const withMsgs = new Set(all<any>("SELECT DISTINCT conversation_id id FROM messages").map((r) => r.id));
const realConvs = convs.filter((c) => withMsgs.has(c.id));
const seedConvs = convs.filter((c) => !withMsgs.has(c.id));

/* Same for tasks: seeded ones were never raised by a turn. Tasks carrying a
   conversation_id that points at a seeded conversation, or none at all, are
   fixtures. */
const realTasks = tasks.filter((t) => t.conversation_id != null && withMsgs.has(t.conversation_id));
const seedTasks = tasks.filter((t) => !realTasks.includes(t));

const line = (label: string, served: string | number, real: string | number, note = "") =>
  console.log(`  ${label.padEnd(26)} ${String(served).padStart(12)}  ${String(real).padStart(12)}   ${note}`);

console.log(`hoi thoai: ${convs.length} (${realConvs.length} co tin nhan, ${seedConvs.length} seed rong)`);
console.log(`task:      ${tasks.length} (${realTasks.length} tu hoi thoai that, ${seedTasks.length} seed)\n`);
console.log(`  ${"chi so".padEnd(26)} ${"API tra ve".padStart(12)}  ${"neu bo seed".padStart(12)}   ghi chu`);
console.log("  " + "-".repeat(74));

/* ---- AI performance: contaminated by rows that never met the AI ---- */
const aiHandled = (list: any[]) => list.filter((c) => c.assigned_staff_id == null && c.mode !== "human");
line(
  "AI deflection",
  `${Math.round((100 * aiHandled(convs).length) / convs.length)}%`,
  `${Math.round((100 * aiHandled(realConvs).length) / (realConvs.length || 1))}%`,
  seedConvs.length > realConvs.length ? "<-- chu yeu dem seed" : "",
);

const avg = (l: any[]) =>
  l.length ? Math.round(l.reduce((n, c) => n + (c.first_response_seconds ?? 0), 0) / l.length) : 0;
const resp = convs.filter((c) => c.first_response_seconds != null);
const respReal = realConvs.filter((c) => c.first_response_seconds != null);
line("First response (s)", avg(resp), avg(respReal), `n=${resp.length} vs n=${respReal.length}`);

/* ---- Tasks ---- */
const doneOf = (l: any[]) => l.filter((t) => t.status === "done" && t.resolved_at);
line(
  "Resolution rate",
  `${Math.round((100 * doneOf(tasks).length) / tasks.length)}%`,
  `${Math.round((100 * doneOf(realTasks).length) / (realTasks.length || 1))}%`,
);

const mins = (l: any[]) =>
  doneOf(l).map((t) => (new Date(t.resolved_at).getTime() - new Date(t.created_at).getTime()) / 60_000);
const rawMins = mins(tasks);
const negatives = rawMins.filter((m) => m < 0).length;
const absAvg = Math.round(rawMins.reduce((a, b) => a + Math.abs(b), 0) / (rawMins.length || 1));
const trueAvg = Math.round(rawMins.reduce((a, b) => a + b, 0) / (rawMins.length || 1));
line(
  "Avg resolution (min)",
  absAvg,
  Math.round(mins(realTasks).reduce((a, b) => a + Math.abs(b), 0) / (mins(realTasks).length || 1)),
  negatives ? `<-- ${negatives} task "xong truoc khi tao", Math.abs() giau di (that: ${trueAvg})` : "",
);

/* ---- SLA. The endpoint counts a breach past `sla`; it used to allow sla*6,
       which showed a spotless board while the stated target was being blown.
       Both are printed so a regression back to the loose definition is
       visible rather than silent. ---- */
const breach1x = rawMins.filter((m) => Math.abs(m) > sla).length;
const breach6x = rawMins.filter((m) => Math.abs(m) > sla * 6).length;
line("SLA breaches", breach1x, breach6x, `dung sla=${sla}m (cot 2 = dinh nghia cu sla*6, chi de doi chieu)`);

/* ---- Money ---- */
const anc = charges.filter((c) => c.category !== "room");
const ancLive = anc.filter((c) => !c.voided_at);
line(
  "Ancillary revenue",
  anc.reduce((n, c) => n + c.amount, 0).toLocaleString("vi-VN"),
  ancLive.reduce((n, c) => n + c.amount, 0).toLocaleString("vi-VN"),
  anc.length !== ancLive.length ? `<-- ${anc.length - ancLive.length} khoan da huy VAN duoc cong` : "khong co khoan huy",
);

/* ---- Hotel state: reads the property tables, correct by construction ---- */
line(
  "Occupancy",
  `${Math.round((100 * reservations.filter((r) => r.status === "in_house").length) / (rooms.length || 1))}%`,
  "-",
  `${reservations.filter((r) => r.status === "in_house").length} in_house / ${rooms.length} phong`,
);

/* ---- The 14-day series: counts conversations CREATED that day ---- */
/* The endpoint now counts threads ACTIVE that day. The "created" column stays
   only so the gap that used to flatline the chart is still visible. */
console.log("\n  chuoi 14 ngay — bieu do dung cot 'co tin nhan':");
const days: string[] = [];
for (let i = 6; i >= 0; i--) {
  const d = new Date();
  d.setDate(d.getDate() - i);
  days.push(d.toISOString().slice(0, 10));
}
for (const d of days) {
  const created = convs.filter((c) => c.created_at.slice(0, 10) === d).length;
  const active = one(
    `SELECT COUNT(DISTINCT conversation_id) n FROM messages WHERE substr(created_at,1,10) = '${d}'`,
  ).n;
  const flag = created === 0 && active > 0 ? "  (truoc day bieu do ve 0 o day)" : "";
  console.log(`    ${d}   tao=${String(created).padStart(3)}   co tin nhan=${String(active).padStart(3)}${flag}`);
}

/* ---- Topics ---- */
console.log("\n  topics — nguon nhan:");
for (const r of all<any>(
  `SELECT COALESCE(topic,'(null)') t, COALESCE(sentiment_source,'(null)') src, COUNT(*) n
   FROM conversations GROUP BY t, src ORDER BY n DESC LIMIT 8`,
)) {
  console.log(`    ${String(r.t).padEnd(28)} ${String(r.src).padEnd(16)} ${r.n}`);
}

/* ---- Staff load ---- */
console.log("\n  staff load — task duoc gan:");
for (const s of all<any>("SELECT id, name FROM staff")) {
  const assigned = tasks.filter((t) => t.assigned_staff_id === s.id);
  const fromReal = assigned.filter((t) => realTasks.includes(t)).length;
  console.log(`    ${s.name.padEnd(20)} ${String(assigned.length).padStart(3)} task  (${fromReal} tu hoi thoai that)`);
}
process.exit(0);
