/**
 * Can a guest order in-room dining offline, and does the shared core enforce
 * the rules the tool used to skip?
 *
 * Two halves. The HTTP half proves the kiosk path works end to end with no
 * model. The CORE half calls `orderRoomService` directly to check the four
 * defects that extracting it fixed — kitchen hours, the real ETA, structured
 * payload items, and the allergy warning — because some of those need a clock
 * or a guest profile the HTTP path cannot pose from outside.
 *
 * Cleans up everything it creates.
 *
 *   npx tsx bench/room-service-probe.ts
 */
import { storage, db } from "../server/storage";
import { orderRoomService, roomServiceWindow } from "../server/ops";
import { serviceApprovals, tasks, messages } from "@shared/schema";
import { inArray } from "drizzle-orm";

const BASE = process.env.PROBE_BASE || "http://localhost:5000";
let failures = 0;
const ok = (c: boolean, m: string) => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${m}`);
  if (!c) failures++;
};

const beforeA = new Set(storage.listApprovals().map((x) => x.id));
const beforeT = new Set(storage.listTasks().map((x) => x.id));

const res0 = storage.listReservations().find((r) => r.status === "in_house")!;
const CODE = res0.confirmationCode;
const MENU = storage.listServices().filter((s) => s.category === "roomservice" && s.active);

const get = (p: string) => fetch(`${BASE}${p}`).then(async (r) => ({ s: r.status, j: (await r.json().catch(() => ({}))) as any }));
const post = (p: string, body: unknown) =>
  fetch(`${BASE}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(
    async (r) => ({ s: r.status, j: (await r.json().catch(() => ({}))) as any }),
  );

const ctxFor = (r: typeof res0) => ({
  hotel: storage.getHotel(),
  guest: storage.getGuest(r.guestId)!,
  res: r,
  room: storage.getRoom(r.roomId),
  conv: storage.getConversationForReservation(r.id)!,
});

async function main() {
  const win = roomServiceWindow();
  console.log(`kitchen ${win.open ? "OPEN" : "CLOSED"} ${win.hours} · eta ${win.eta_minutes}m · peak=${win.peak} · menu ${MENU.length} dishes\n`);

  console.log("=== THE MENU IS REACHABLE AT ALL ===");
  const menu = await get(`/api/guest/menu?code=${CODE}`);
  ok(menu.s === 200, "a guest with a valid code can read the in-room dining menu");
  ok(menu.j.items?.length === MENU.length, `all ${MENU.length} dishes are listed`);
  ok(typeof menu.j.open === "boolean" && !!menu.j.hours, "the kiosk is told whether the kitchen is taking orders");
  ok(menu.j.etaMinutes === win.eta_minutes, "the ETA comes from policy, not a constant");
  const badMenu = await get(`/api/guest/menu?code=NOPE-000000`);
  /* 429 cũng tính là từ chối. Assertion ở đây là "mã sai KHÔNG lọt", chứ không
   phải "server trả đúng mã lỗi nào": khi các probe chạy nối nhau, probe trước
   đốt hết ngân sách rate limit của địa chỉ này và probe sau nhận 429 thay vì
   404 — báo đỏ cho một hệ thống đang chặn đúng. */
  ok([401, 404, 429].includes(badMenu.s), `a wrong code cannot read it (got ${badMenu.s})`);

  console.log("=== ORDERING A BASKET ===");
  const order = await post("/api/guest/order", {
    code: CODE,
    items: [
      { serviceId: MENU[0].id, quantity: 2 },
      { serviceId: MENU[1].id, quantity: 1 },
    ],
  });
  if (!win.open) {
    ok(order.s === 409, `the kitchen is shut, so the order is refused (got ${order.s})`);
    ok(/khung|hours/i.test(JSON.stringify(order.j)), "and the guest is told the serving hours");
  } else {
    ok(order.s === 200, `the order is accepted (got ${order.s})`);
    ok(order.j.pending_approval === true && order.j.ordered === false, "PENDING — never 'ordered' on the guest's say-so");
    const expect = MENU[0].price * 2 + MENU[1].price;
    ok(order.j.pending_amount === expect, `the total is the sum of the lines (${expect})`);
    ok(order.j.eta_minutes === win.eta_minutes, "the ETA quoted is the policy's, matching peak or not");

    const ap = storage.listApprovals().find((a) => a.id === order.j.approval_id)!;
    ok(ap.status === "pending" && ap.kind === "order_room_service", "an approval is waiting");
    const task = storage.listTasks().find((t) => t.id === ap.taskId)!;
    ok(task?.dept === "fnb", "the task went to F&B");

    /* The defect that made an approved order unreconcilable. */
    const payload = JSON.parse(ap.payload || "{}");
    ok(Array.isArray(payload.items) && payload.items.length === 2, "the payload keeps both lines");
    ok(
      payload.items.every((i: any) => typeof i.serviceId === "number" && typeof i.quantity === "number" && typeof i.unitPrice === "number"),
      "each line carries serviceId, quantity and unit price — not just a display string",
    );
    ok(payload.items.every((i: any) => typeof i.line === "string"), "and keeps `line`, which finalizeApproval builds the folio description from");

    /* Nothing may reach the folio before a human approves. */
    const folio = storage.listCharges(res0.id);
    ok(!folio.some((c) => c.description?.includes(MENU[0].name)), "NOTHING is on the folio yet");
  }

  console.log("=== IT DECLINES ===");
  const empty = await post("/api/guest/order", { code: CODE, items: [] });
  ok(empty.s === 400 || empty.s === 409, `an empty basket is refused (got ${empty.s})`);
  const notFood = storage.listServices().find((s) => s.category === "spa")!;
  const wrongCat = await post("/api/guest/order", { code: CODE, items: [{ serviceId: notFood.id, quantity: 1 }] });
  ok(wrongCat.s === 409, `a spa treatment cannot be ordered as a dish (got ${wrongCat.s})`);
  const noCode = await post("/api/guest/order", { code: "NOPE-000000", items: [{ serviceId: MENU[0].id, quantity: 1 }] });
  ok([401, 404, 429].includes(noCode.s), `an invalid code cannot order (got ${noCode.s})`);

  console.log("=== THE CORE ENFORCES WHAT THE TOOL USED TO SKIP ===");
  /* Kitchen hours: posed directly, because the probe cannot move the clock. */
  const closed = roomServiceWindow("03:00");
  ok(!closed.open, "03:00 is outside the serving window, per policy");
  const peak = roomServiceWindow("19:00");
  ok(peak.eta_minutes > roomServiceWindow("15:00").eta_minutes, "a peak-hour ETA is longer than an off-peak one");

  /**
   * Allergy warning on the ticket — the whole point of putting it on food.
   *
   * No guest in the demo database records one, so the guest is POSED in memory
   * rather than written: `orderRoomService` reads `ctx.guest.preferences` and
   * nothing else, so passing a modified copy exercises the real code path
   * without inventing a medical fact about a real row.
   */
  {
    const base = ctxFor(res0);
    const ctx = {
      ...base,
      guest: { ...base.guest, preferences: JSON.stringify(["Dị ứng hải sản", "Phòng yên tĩnh"]) },
    };
    const out = orderRoomService(ctx, { items: [{ serviceId: MENU[0].id, quantity: 1 }] }) as any;
    if (out.error) ok(!win.open, `core refused (${String(out.error).slice(0, 50)}) — expected only when the kitchen is shut`);
    else {
      ok(Array.isArray(out.allergy_notes) && out.allergy_notes.length > 0, "an order from an allergic guest carries the note");
      const t = storage.listTasks().find((x) => x.id === out.task_id)!;
      ok(/⚠/.test(t.detail), "and the KITCHEN's ticket shows the warning, not just the API response");
      ok(/h[aả]i s[aả]n/i.test(t.detail), "naming the actual allergy");
    }

    /* The other half: a guest with ordinary preferences must not get a bogus
       warning, or the kitchen learns to ignore the symbol. */
    const plain = orderRoomService(
      { ...base, guest: { ...base.guest, preferences: JSON.stringify(["Phòng yên tĩnh", "High floor"]) } },
      { items: [{ serviceId: MENU[0].id, quantity: 1 }] },
    ) as any;
    if (!plain.error) {
      ok(plain.allergy_notes.length === 0, "a guest with no allergy produces no warning");
      const t2 = storage.listTasks().find((x) => x.id === plain.task_id)!;
      ok(!/⚠/.test(t2.detail), "and their ticket is clean");
    }
  }

  /* --- cleanup --- */
  const newA = storage.listApprovals().filter((a) => !beforeA.has(a.id));
  const newT = storage.listTasks().filter((t) => !beforeT.has(t.id));
  const newM: number[] = [];
  for (const c of storage.listConversations())
    for (const m of storage.listMessages(c.id))
      if (m.role === "system" && m.body.includes("Khách gọi đồ qua thực đơn")) newM.push(m.id);
  if (newA.length) db.delete(serviceApprovals).where(inArray(serviceApprovals.id, newA.map((x) => x.id))).run();
  if (newT.length) db.delete(tasks).where(inArray(tasks.id, newT.map((x) => x.id))).run();
  if (newM.length) db.delete(messages).where(inArray(messages.id, newM)).run();
  console.log(`\ncleaned up ${newA.length} approval(s), ${newT.length} task(s), ${newM.length} message(s)`);

  console.log(failures === 0 ? "\nALL ROOM SERVICE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
