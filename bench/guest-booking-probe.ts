/**
 * Can a guest actually complete a booking from the kiosk, offline?
 *
 * The whole point of this path is that it works with LLM_MODE=local, where
 * `book_service` (a tool) is unreachable. So this probe drives the real HTTP
 * endpoints with a real confirmation code and no model at all — if it passes,
 * a guest tapping a card gets a pending booking, a staff task and an approval.
 *
 * It also checks the refusals, because an endpoint that books is only safe if
 * it declines: a wrong code, someone else's code, a slot that does not exist,
 * a date in the past, and a full slot.
 *
 * Cleans up everything it creates.
 *
 *   npx tsx bench/guest-booking-probe.ts
 */
import { storage, db } from "../server/storage";
import { serviceBookings, serviceApprovals, tasks, messages } from "@shared/schema";
import { inArray } from "drizzle-orm";

const BASE = process.env.PROBE_BASE || "http://localhost:5000";
let failures = 0;
const ok = (c: boolean, m: string) => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${m}`);
  if (!c) failures++;
};

const snap = () => ({
  b: new Set(storage.listBookings().map((x) => x.id)),
  a: new Set(storage.listApprovals().map((x) => x.id)),
  t: new Set(storage.listTasks().map((x) => x.id)),
});
const before = snap();

const res0 = storage.listReservations().find((r) => r.status === "in_house")!;
const CODE = res0.confirmationCode;
const other = storage.listReservations().find((r) => r.id !== res0.id)!;

/* A dated slot far enough ahead to clear the lead-time rule. */
const svc = storage.listServices().find((s) => s.active && s.category === "spa" && (JSON.parse(s.slots || "[]") as string[]).length)!;
const SLOTS: string[] = JSON.parse(svc.slots || "[]");
const d = new Date(Date.now() + 3 * 86_400_000);
const DATE = d.toISOString().slice(0, 10);

const get = (p: string) => fetch(`${BASE}${p}`).then(async (r) => ({ s: r.status, j: await r.json().catch(() => ({})) }));
const post = (p: string, body: unknown) =>
  fetch(`${BASE}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(
    async (r) => ({ s: r.status, j: (await r.json().catch(() => ({}))) as any }),
  );

async function main() {
  console.log(`service #${svc.id} "${svc.name}" cap=${svc.capacityPerSlot} on ${DATE}\n`);

  console.log("=== AVAILABILITY ===");
  const av = await get(`/api/guest/availability?code=${CODE}&serviceId=${svc.id}&date=${DATE}`);
  ok(av.s === 200, "a guest with a valid code can read availability");
  ok(Array.isArray(av.j.slots) && av.j.slots.length === SLOTS.length, "every published slot is offered");
  ok(typeof av.j.memberPrice === "number" && av.j.memberPrice > 0, "the guest's own member price is quoted");
  ok(av.j.seatsLeft === undefined && av.j.slots[0].seatsLeft === svc.capacityPerSlot, "an unbooked slot is fully free");
  ok(!JSON.stringify(av.j).includes(res0.confirmationCode), "the response does not echo the code back");

  const bad = await get(`/api/guest/availability?code=NOPE-000000&serviceId=${svc.id}&date=${DATE}`);
  ok(bad.s === 401 || bad.s === 404, `a wrong code cannot read availability (got ${bad.s})`);

  console.log("=== BOOKING ===");
  const r1 = await post("/api/guest/book", { code: CODE, serviceId: svc.id, date: DATE, slot: SLOTS[0], partySize: 1 });
  ok(r1.s === 200, `the booking is accepted (got ${r1.s})`);
  ok(r1.j.pending_approval === true && r1.j.booked === false, "it is PENDING, never confirmed by the guest alone");
  ok(typeof r1.j.pending_amount === "number", "an amount is quoted");

  const bk = storage.listBookings().find((b) => b.id === r1.j.booking_id);
  ok(bk?.status === "pending_approval", "the row is written as pending_approval");
  ok(bk?.chargeId === null, "NOTHING is charged to the folio yet");
  const ap = storage.listApprovals().find((a) => a.id === r1.j.approval_id);
  ok(ap?.status === "pending" && ap?.kind === "book_service", "a staff approval is waiting");
  ok(!!storage.listTasks().find((t) => t.id === ap?.taskId), "a department task was opened");
  const sys = storage.listMessages(ap!.conversationId!).filter((m) => m.role === "system" && m.body.includes(svc.name));
  ok(sys.length === 1, "the thread records what was booked, as system rather than as words the guest never typed");

  console.log("=== IT DECLINES ===");
  const wrongSlot = await post("/api/guest/book", { code: CODE, serviceId: svc.id, date: DATE, slot: "03:00", partySize: 1 });
  ok(wrongSlot.s === 409, `a slot the service does not run is refused (got ${wrongSlot.s})`);
  const past = await post("/api/guest/book", { code: CODE, serviceId: svc.id, date: "2020-01-01", slot: SLOTS[0], partySize: 1 });
  ok(past.s === 409, `a date in the past is refused (got ${past.s})`);
  const noCode = await post("/api/guest/book", { code: "NOPE-000000", serviceId: svc.id, date: DATE, slot: SLOTS[1], partySize: 1 });
  ok(noCode.s === 401 || noCode.s === 404, `an invalid code cannot book (got ${noCode.s})`);
  const overCap = await post("/api/guest/book", {
    code: CODE, serviceId: svc.id, date: DATE, slot: SLOTS[1], partySize: svc.capacityPerSlot + 5,
  });
  ok(overCap.s === 409, `a party larger than the slot is refused (got ${overCap.s})`);

  /* The booking above belongs to res0. Booking the SAME slot from another
     guest's code must be allowed only while seats remain — what must never
     happen is one code acting on another guest's stay. */
  const cross = await post("/api/guest/book", { code: other.confirmationCode, serviceId: svc.id, date: DATE, slot: SLOTS[0], partySize: 1 });
  if (cross.s === 200) {
    const cb = storage.listBookings().find((b) => b.id === cross.j.booking_id);
    ok(cb?.reservationId === other.id, "another guest's code books against THEIR OWN stay, never res0's");
  } else ok(cross.s === 409, `or is refused on capacity (got ${cross.s})`);

  console.log("=== A CODE CANNOT BE ENUMERATED THROUGH THESE ROUTES ===");
  /* Runs LAST on purpose: it deliberately spends this address's guest budget,
     so any probe run against the same server afterwards sees 429s that look
     like product bugs. Restart the server between probe runs. */
  /**
   * The first version of these routes resolved the code inside `isGuestRoute`
   * and returned false on a miss. That read as stricter and was the opposite: a
   * bad code never reached a handler, so neither the guest throttle nor the
   * codeFailures budget ever ran — 40 wrong codes in a row drew 40 plain 401s
   * while a good one drew 200. An unthrottled oracle, and these routes are the
   * authority to charge a folio.
   */
  const statuses: Record<number, number> = {};
  for (let i = 0; i < 35; i++) {
    const r = await fetch(`${BASE}/api/guest/availability?code=VPNT-PROBE${String(i).padStart(3, "0")}&serviceId=${svc.id}&date=${DATE}`);
    statuses[r.status] = (statuses[r.status] ?? 0) + 1;
  }
  ok((statuses[429] ?? 0) > 0, `wrong codes are throttled, not answered forever (${JSON.stringify(statuses)})`);
  /* And the half that is easy to break while fixing the first half: a hotel is
     a NAT, so one stranger mistyping must never lock out the building. */
  const stillWorks = await get(`/api/guest/availability?code=${CODE}&serviceId=${svc.id}&date=${DATE}`);
  ok(stillWorks.s === 200, "a CORRECT code is still served while the miss budget is spent");

  /* --- cleanup --- */
  const after = snap();
  const newB = [...after.b].filter((x) => !before.b.has(x));
  const newA = [...after.a].filter((x) => !before.a.has(x));
  const newT = [...after.t].filter((x) => !before.t.has(x));
  const newM = storage
    .listMessages(ap!.conversationId!)
    .filter((m) => m.role === "system" && m.body.includes("Khách đặt qua thẻ dịch vụ"))
    .map((m) => m.id);
  if (newB.length) db.delete(serviceBookings).where(inArray(serviceBookings.id, newB)).run();
  if (newA.length) db.delete(serviceApprovals).where(inArray(serviceApprovals.id, newA)).run();
  if (newT.length) db.delete(tasks).where(inArray(tasks.id, newT)).run();
  if (newM.length) db.delete(messages).where(inArray(messages.id, newM)).run();
  console.log(`\ncleaned up ${newB.length} booking(s), ${newA.length} approval(s), ${newT.length} task(s), ${newM.length} message(s)`);

  console.log(failures === 0 ? "\nALL GUEST BOOKING CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
