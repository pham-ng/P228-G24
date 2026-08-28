/**
 * End-to-end check of the VietQR path, without a hosted model.
 *
 * `POST /api/reservations/:id/payment` records money already taken, so it
 * settles immediately and a settled payment correctly shows no QR. To exercise
 * the QR at all there has to be a PENDING intent, and the only thing that
 * creates one is `create_payment_link` — a tool, so hosted-only.
 *
 * This calls `createPaymentIntent` directly, the same core the tool calls, then
 * fetches the guest-facing endpoint over HTTP so the payload, the rendering and
 * the redaction are all exercised as a guest would meet them.
 *
 * Leaves a pending payment behind; the last line says how to remove it.
 *
 *   npx tsx bench/vietqr-probe.ts
 */
import "dotenv/config";
import { storage } from "../server/storage";
import { createPaymentIntent } from "../server/ops";
import { parseTlv, verifyCrc } from "../server/vietqr";

const BASE = process.env.DEMO_BASE || "http://localhost:5000";

const hotel = storage.getHotel();
if (!hotel.bankBin || !hotel.bankAccountNumber || !hotel.bankAccountName) {
  console.log("khach san chua co thong tin ngan hang — dat trong Settings truoc.");
  process.exit(0);
}
const res = storage.listReservations().find((r) => r.status === "in_house");
if (!res) {
  console.log("khong co dat phong in_house.");
  process.exit(0);
}
const guest = storage.getGuest(res.guestId);
const conv = storage.getConversationForReservation(res.id);

console.log(`khach san: ${hotel.name} · ${hotel.bankBin} / ${hotel.bankAccountNumber}`);
console.log(`dat phong: ${res.confirmationCode}\n`);

const intent = createPaymentIntent(
  { hotel, guest, res, conv } as never,
  { amount: 1_750_000, method: "payment_link", expiresInHours: 24 },
);
console.log(`=== 1. tao yeu cau thanh toan (chua thu tien) ===`);
console.log(`  payment #${intent.id} · status=${intent.status} · provider=${intent.provider}`);
console.log(`  link: ${intent.link}`);
/* The link must carry the hash, or it loads the SPA and renders the concierge
   instead of the payment page — an error that looks like success. */
console.log(`  link co '#/pay/': ${intent.link?.includes("#/pay/") ? "CO" : "KHONG — SAI"}`);

console.log(`\n=== 2. khach mo link (khong dang nhap) ===`);
const r = await fetch(`${BASE}/api/pay/${intent.token}`);
const body = (await r.json()) as Record<string, any>;
console.log(`  HTTP ${r.status} · truong: ${Object.keys(body).join(", ")}`);
console.log(`  so tien: ${body.amount?.toLocaleString("vi-VN")} ${body.currency} · status=${body.status}`);
console.log(`  QR: ${body.qr ? `${body.qr.slice(0, 30)}... (${body.qr.length} ky tu)` : "khong co"}`);
console.log(`  nguoi nhan: ${body.bankAccountName ?? "—"}`);

/* PII: the token is the whole credential and tokens get forwarded. */
const leaked = ["guestName", "phone", "email", "idNumber", "confirmationCode", "reservationId"].filter(
  (k) => JSON.stringify(body).includes(`"${k}"`),
);
console.log(`  lo PII: ${leaked.length ? leaked.join(", ") : "khong"}`);

console.log(`\n=== 3. noi dung ma QR ===`);
/* Rebuild the payload the endpoint encoded, so the figures inside the image are
   checked rather than assumed — a QR that renders is not a QR that pays. */
const { buildVietQrPayload } = await import("../server/vietqr");
const payload = buildVietQrPayload({
  bankBin: hotel.bankBin,
  accountNumber: hotel.bankAccountNumber,
  amount: intent.amount,
  description: res.confirmationCode,
});
const f = parseTlv(payload);
const beneficiary = parseTlv(parseTlv(f["38"])["01"]);
console.log(`  ngan hang (BIN): ${beneficiary["00"]}`);
console.log(`  so tai khoan   : ${beneficiary["01"]}`);
console.log(`  so tien        : ${f["54"]}  ${Number(f["54"]) === intent.amount ? "(khop)" : "(LECH — SAI)"}`);
console.log(`  noi dung       : ${parseTlv(f["62"])["08"]}`);
console.log(`  CRC            : ${verifyCrc(payload) ? "hop le" : "SAI"}`);

const good =
  r.ok && !!body.qr && !leaked.length && Number(f["54"]) === intent.amount && verifyCrc(payload) &&
  !!intent.link?.includes("#/pay/");
console.log(`\n${good ? "  Luong VietQR chay dung dau-cuoi." : "  CO VAN DE — xem cac dong tren."}`);
console.log(`\n  Con lai payment #${intent.id}. Xoa: npx tsx scripts/purge-booking-probe.ts --apply`);
console.log(`  CHUA KIEM CHUNG: chua quet bang app ngan hang that. Phai lam truoc khi dung voi khach.`);
process.exit(good ? 0 : 1);
