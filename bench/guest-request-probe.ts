/**
 * Can a guest raise a TIMED request offline, and does the staff board show it?
 *
 * Most operational tools degrade acceptably on the offline path — an escalation
 * opens a task routed to the right department. What escalation cannot carry is
 * WHEN (a wake-up at 06:30) and WHAT (three shirts), and it leaves no
 * `guest_requests` row, which is where the status a guest can be told about
 * lives. This drives the picker endpoint and the new staff board.
 *
 * It checks the whitelist hardest: `runOpsTool` also owns `settle_folio`,
 * `create_payment_link` and `declare_lodging`, and a confirmation code must not
 * reach any of them.
 *
 *   npx tsx bench/guest-request-probe.ts
 */
import { storage, db } from "../server/storage";
import { guestRequests, tasks } from "@shared/schema";
import { inArray } from "drizzle-orm";

const BASE = process.env.PROBE_BASE || "http://localhost:5000";
const TOKEN = process.env.STAFF_API_TOKEN || "";
let failures = 0;
const ok = (c: boolean, m: string) => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${m}`);
  if (!c) failures++;
};

const beforeR = new Set(storage.listRequests(500).map((r) => r.id));
const beforeT = new Set(storage.listTasks().map((t) => t.id));

/* A stay that is still RUNNING. `status === "in_house"` is not enough: the
   demo database carries in-house rows whose checkOut is already in the past, and
   `request_wake_up_call` correctly refuses a date after checkout — which read as
   a broken endpoint on the first run. Pick by the date, not by the label. */
const TODAY = new Date().toISOString().slice(0, 10);
const resv = storage
  .listReservations()
  .find((r) => r.checkOut > TODAY && !!storage.getConversationForReservation(r.id))!;
if (!resv) {
  console.error("no reservation is still running in this database — cannot probe");
  process.exit(1);
}
const CODE = resv.confirmationCode;
const staffH = { "content-type": "application/json", ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) };

const post = (p: string, b: unknown) =>
  fetch(`${BASE}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(
    async (r) => ({ s: r.status, j: (await r.json().catch(() => ({}))) as any }),
  );
const staffGet = (p: string) => fetch(`${BASE}${p}`, { headers: staffH }).then(async (r) => ({ s: r.status, j: (await r.json().catch(() => ({}))) as any }));
const staffPatch = (p: string, b: unknown) =>
  fetch(`${BASE}${p}`, { method: "PATCH", headers: staffH, body: JSON.stringify(b) }).then(async (r) => ({ s: r.status, j: (await r.json().catch(() => ({}))) as any }));

const cleanup = () => {
  const r = storage.listRequests(500).filter((x) => !beforeR.has(x.id)).map((x) => x.id);
  const t = storage.listTasks().filter((x) => !beforeT.has(x.id)).map((x) => x.id);
  if (r.length) db.delete(guestRequests).where(inArray(guestRequests.id, r)).run();
  if (t.length) db.delete(tasks).where(inArray(tasks.id, t)).run();
  return { r: r.length, t: t.length };
};

async function main() {
  console.log(`reservation ${CODE}, checkout ${resv.checkOut}\n`);

  console.log("=== A WAKE-UP CALL CARRIES A TIME ===");
  const wake = await post("/api/guest/request", { code: CODE, kind: "wake_up", time: "06:30" });
  ok(wake.s === 200, `accepted (got ${wake.s})`);
  ok(wake.j.request_id > 0 && wake.j.task_id > 0, "a request AND a task are created");
  const wreq = storage.listRequests(500).find((r) => r.id === wake.j.request_id)!;
  ok(wreq.kind === "wake_up", "recorded under the right kind");
  ok(!!wreq.scheduledFor && wreq.scheduledFor.includes("06:30"), `the TIME is stored (${wreq.scheduledFor})`);
  ok(wreq.dept === "front_desk", "routed to the front desk");
  const wtask = storage.listTasks().find((t) => t.id === wake.j.task_id)!;
  ok(wtask.dueAt === wreq.scheduledFor, "and the task is due when the guest asked, not in an SLA window");

  console.log("=== HOUSEKEEPING CARRIES THE ITEMS ===");
  const hk = await post("/api/guest/request", {
    code: CODE, kind: "housekeeping", serviceType: "towels", items: ["2 khăn tắm", "1 bàn chải"], time: "15:00",
  });
  ok(hk.s === 200, `accepted (got ${hk.s})`);
  const hreq = storage.listRequests(500).find((r) => r.id === hk.j.request_id)!;
  const hpay = JSON.parse(hreq.payload || "{}");
  ok(Array.isArray(hpay.items) && hpay.items.length === 2, "both items are kept, not flattened into prose");
  ok(hreq.dept === "housekeeping", `routed to housekeeping (got ${hreq.dept})`);

  console.log("=== IT DECLINES ===");
  const badTime = await post("/api/guest/request", { code: CODE, kind: "wake_up", time: "99:99" });
  ok(badTime.s === 400 || badTime.s === 409, `an impossible time is refused (got ${badTime.s})`);
  const afterOut = await post("/api/guest/request", { code: CODE, kind: "wake_up", time: "06:30", date: "2030-01-01" });
  ok(afterOut.s === 409, `a date after checkout is refused (got ${afterOut.s})`);
  const noItems = await post("/api/guest/request", { code: CODE, kind: "laundry", items: [] });
  ok(noItems.s === 409, `laundry with nothing to wash is refused (got ${noItems.s})`);
  const badCode = await post("/api/guest/request", { code: "VPNT-NOPE99", kind: "wake_up", time: "06:30" });
  ok(badCode.s === 404 || badCode.s === 429, `an invalid code cannot raise anything (got ${badCode.s})`);

  console.log("=== THE WHITELIST IS THE POINT ===");
  /* runOpsTool owns money and identity tools too. A confirmation code must not
     be able to name one of them. */
  for (const kind of ["settle_folio", "create_payment_link", "declare_lodging", "express_checkout"]) {
    const r = await post("/api/guest/request", { code: CODE, kind });
    ok(r.s === 400, `"${kind}" is rejected by the schema, not dispatched (got ${r.s})`);
  }

  console.log("=== THE STAFF BOARD FINALLY SHOWS THEM ===");
  const board = await staffGet("/api/requests");
  ok(board.s === 200, `staff can read the requests board (got ${board.s})`);
  const mine = board.j.find?.((r: any) => r.id === wake.j.request_id);
  ok(!!mine, "the wake-up call appears on it");
  ok(!!mine?.guestName && !!mine?.room, "with the guest and room a person needs to act");
  ok(typeof mine?.payload === "object" && mine?.payload !== null, "payload is parsed, not a JSON string the page must re-parse");

  const done = await staffPatch(`/api/requests/${wake.j.request_id}`, { status: "done" });
  ok(done.s === 200 && done.j.status === "done", "it can be closed");
  const closedTask = storage.listTasks().find((t) => t.id === wake.j.task_id);
  ok(closedTask?.status === "done", "and the paired task closes with it, so the board does not fill with finished work");

  const c = cleanup();
  console.log(`\ncleaned up ${c.r} request(s), ${c.t} task(s)`);
  console.log(failures === 0 ? "\nALL GUEST REQUEST CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  const c = cleanup();
  console.error("probe threw:", e?.message ?? e, `(cleaned up ${c.r} request(s), ${c.t} task(s))`);
  process.exit(1);
});
