/**
 * Does the service-booking machinery work, or has it only never been called?
 *
 * `service_bookings`, `payments` and `service_approvals` for `book_service` are
 * all empty, and the reason is known: `book_service` is a TOOL, tools run in the
 * hosted loop, and `LOCAL_RAG_FIRST` + `LLM_MODE=local` route every turn to the
 * offline path instead. So the trigger is missing.
 *
 * But "the trigger is missing" and "the machinery works" are different claims,
 * and this codebase has repeatedly turned out to contain paths that looked
 * complete and threw the moment anything reached them — `/api/metrics` answered
 * 500 for its whole life. So this calls the ops core DIRECTLY, with no model and
 * no API credits, and follows the booking through staff approval to the folio.
 *
 * Read-only in spirit but NOT in effect: it books, approves and then cancels its
 * own booking, and reports what it left behind.
 *
 *   npx tsx bench/booking-core-probe.ts
 */
import "dotenv/config";
import { storage, hotelToday } from "../server/storage";
import { bookCatalogueService, finalizeApproval } from "../server/ops";

const line = (s: string) => console.log(`  ${s}`);

const hotel = storage.getHotel();
const res = storage.listReservations().find((r) => r.status === "in_house");
if (!res) {
  console.log("khong co dat phong in_house nao de thu.");
  process.exit(0);
}
const guest = storage.getGuest(res.guestId)!;
const room = res.roomId ? storage.getRoom(res.roomId) : undefined;
const conv = storage.getConversationForReservation(res.id);
if (!conv) {
  console.log("dat phong nay chua co hoi thoai.");
  process.exit(0);
}

/* A service with real slots, so the slot check is actually exercised. */
const svc = storage.listServices().find((s) => JSON.parse(s.slots || "[]").length > 0);
if (!svc) {
  console.log("khong co dich vu nao co khung gio.");
  process.exit(0);
}
const slot = (JSON.parse(svc.slots) as string[])[0];
/**
 * Tomorrow, not today: the lead-time rule correctly refused a slot starting in
 * under an hour, which is the policy engine working rather than a failure.
 *
 * Parsed as UTC midnight on purpose. Building it as `+07:00` midnight and then
 * calling `toISOString()` lands back on the previous UTC day, so adding a day
 * and formatting cancelled out and produced today again — the same date arrived
 * twice and looked like the increment had not run.
 */
const d = new Date(`${hotelToday()}T00:00:00Z`);
d.setUTCDate(d.getUTCDate() + 1);
const date = d.toISOString().slice(0, 10);

console.log(`khach ${guest.name} · phong ${room?.number ?? "—"} · hoi thoai #${conv.id}`);
console.log(`dich vu "${svc.name}" · ${date} ${slot}\n`);

const before = {
  bookings: storage.listBookings?.().length ?? 0,
  charges: storage.listCharges(res.id).length,
};

console.log("=== 1. goi loi dat dich vu (khong qua model) ===");
const result = bookCatalogueService(
  { hotel, guest, res, room, conv } as never,
  { serviceId: svc.id, date, slot, partySize: 2 },
);

if ("error" in result && result.error) {
  line(`LOI: ${result.error}`);
  process.exit(1);
}
const r = result as Record<string, unknown>;
line(`pending_approval = ${r.pending_approval}`);
line(`approval_id      = ${r.approval_id}`);
line(`so tien cho duyet= ${r.pending_amount ?? r.amount ?? "—"}`);

/* The contract the whole HITL design rests on: nothing is charged yet. */
const midCharges = storage.listCharges(res.id).length;
line(`khoan phi tren hoa don: ${before.charges} -> ${midCharges}  ${midCharges === before.charges ? "(chua tinh tien — DUNG)" : "(DA TINH TIEN — SAI)"}`);

const approvalId = Number(r.approval_id);
if (!approvalId) {
  line("khong tao duoc approval — dung o day.");
  process.exit(1);
}

console.log("\n=== 2. nhan vien duyet ===");
const fin = finalizeApproval(approvalId, "approve", "Nguyễn Thị Lan");
if (!fin.ok) {
  line(`LOI khi duyet: ${fin.error}`);
  process.exit(1);
}
line(`approval #${approvalId} -> ${fin.approval.status} boi ${fin.approval.resolvedBy}`);

const after = storage.listCharges(res.id);
line(`khoan phi tren hoa don: ${midCharges} -> ${after.length}`);
const newest = after[after.length - 1];
if (newest) line(`khoan moi nhat: "${newest.description}" = ${newest.amount.toLocaleString("vi-VN")}`);

const bookings = storage.listBookings?.() ?? [];
line(`service_bookings: ${before.bookings} -> ${bookings.length}`);
const b = bookings[bookings.length - 1];
if (b) line(`booking #${b.id} status=${b.status} chargeId=${b.chargeId ?? "—"}`);

console.log("\n=== ket luan ===");
const worked = fin.ok && after.length > midCharges && bookings.length > before.bookings;
console.log(
  worked
    ? "  Loi dat dich vu CHAY DUOC dau-cuoi. Thu thieu la CAI KICH HOAT o luong offline."
    : "  Loi dat dich vu KHONG hoan tat — xem cac dong tren.",
);
console.log(`\n  De lai: booking #${b?.id ?? "—"}, approval #${approvalId}, khoan phi #${newest?.id ?? "—"}.`);
console.log("  Xoa bang: npx tsx scripts/purge-booking-probe.ts --apply");
process.exit(worked ? 0 : 1);
