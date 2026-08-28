/**
 * Every read endpoint the staff UI depends on, and whether it answers with
 * anything.
 *
 * A page that renders is not a page that works. This calls each endpoint as a
 * manager and reports the shape of what comes back, so "empty" and "broken" and
 * "real" stop looking the same from the outside.
 *
 * Requires the dev server on :5000.
 *
 *   npx tsx scripts/audit-surface.ts
 */
import "dotenv/config";

const BASE = process.env.DEMO_BASE || "http://localhost:5000";

/** Signing in as a real person, because the API is role-scoped now. */
async function managerToken(): Promise<string> {
  const r = await fetch(`${BASE}/api/staff/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Nguyễn Thị Lan", pin: "1234" }),
  });
  const j = (await r.json()) as { staffApiToken?: string };
  if (!j.staffApiToken) throw new Error("login failed");
  return j.staffApiToken;
}

const PAGES: { page: string; endpoints: string[] }[] = [
  { page: "Inbox", endpoints: ["/api/conversations", "/api/conversations/3"] },
  { page: "Tasks", endpoints: ["/api/tasks"] },
  { page: "Approvals", endpoints: ["/api/approvals"] },
  { page: "Rooms", endpoints: ["/api/rooms"] },
  { page: "Reservations", endpoints: ["/api/reservations"] },
  { page: "Insights", endpoints: ["/api/insights"] },
  { page: "Knowledge", endpoints: ["/api/kb"] },
  { page: "Policies", endpoints: ["/api/policies", "/api/retrieval"] },
  { page: "Campaigns", endpoints: ["/api/campaigns", "/api/campaigns/audience"] },
  { page: "Benchmark", endpoints: ["/api/bench/report"] },
  { page: "Guardrails", endpoints: ["/api/guardrails"] },
  { page: "Traces", endpoints: ["/api/traces", "/api/tracer/traces"] },
  { page: "Activity", endpoints: ["/api/events"] },
  { page: "Settings", endpoints: ["/api/hotel", "/api/observability/config"] },
  { page: "(guest)", endpoints: ["/api/room-types", "/api/dining-venues", "/api/services", "/api/offers"] },
  { page: "(khác)", endpoints: ["/api/staff", "/api/bookings", "/api/metrics", "/api/restrictions", "/api/observability/signals"] },
];

/** Describe a payload without dumping it: size is what tells you if it is real. */
function describe(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return v.length === 0 ? "MẢNG RỖNG" : `${v.length} phần tử`;
  if (typeof v === "object") {
    const keys = Object.keys(v as object);
    if (!keys.length) return "OBJECT RỖNG";
    const counts = keys
      .filter((k) => Array.isArray((v as Record<string, unknown>)[k]))
      .map((k) => `${k}=${((v as Record<string, unknown>)[k] as unknown[]).length}`);
    return counts.length ? `${keys.length} trường (${counts.slice(0, 4).join(" ")})` : `${keys.length} trường`;
  }
  return String(v).slice(0, 40);
}

const token = await managerToken();
let empty = 0;
let failed = 0;

for (const { page, endpoints } of PAGES) {
  console.log(`\n${page}`);
  for (const ep of endpoints) {
    try {
      const r = await fetch(`${BASE}${ep}`, { headers: { "x-staff-token": token } });
      if (!r.ok) {
        failed++;
        console.log(`  ${String(r.status).padEnd(4)} ${ep.padEnd(34)} ${(await r.text()).slice(0, 60)}`);
        continue;
      }
      /* Not everything speaks JSON. `/metrics` serves Prometheus text, and
         parsing it as JSON reported a healthy endpoint as an error — a false
         alarm in an audit is worse than no audit, because it trains you to
         ignore the output. */
      const ct = r.headers.get("content-type") ?? "";
      if (!ct.includes("json")) {
        const text = await r.text();
        console.log(`  200  ${ep.padEnd(34)} ${ct.split(";")[0]}, ${text.length} ký tự`);
        if (!text.trim()) empty++;
        continue;
      }
      const body = await r.json();
      const d = describe(body);
      if (d.includes("RỖNG")) empty++;
      console.log(`  200  ${ep.padEnd(34)} ${d}`);
    } catch (e: any) {
      failed++;
      console.log(`  ERR  ${ep.padEnd(34)} ${e?.message ?? e}`);
    }
  }
}

console.log(`\n${empty} endpoint trả về rỗng · ${failed} lỗi`);
process.exit(0);
