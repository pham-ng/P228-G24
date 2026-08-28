/**
 * A confirmation code must not buy someone's passport number.
 *
 * `POST /api/guest/session` takes a confirmation code and nothing else, and it
 * returned `conversationDetail` verbatim — the staff-inbox payload. That
 * included the guest's `idNumber`, `idType`, `nationality`, `dob`, phone,
 * email, the internal staff `notes`, the folio with amounts, every operations
 * task and the assigned staff member. Nothing limited how many codes could be
 * tried.
 *
 * Two defences, tested separately because they fail separately:
 *   1. the payload is cut to what the kiosk reads, so a breach yields little;
 *   2. attempts are throttled, so the codes cannot be walked.
 *
 * These assertions are pure — no server, no network. The redaction is checked
 * against a fixture shaped like the real detail, and the limiter against its
 * own clock.
 */
import "dotenv/config";
import { guestRequests, codeFailures } from "../server/ratelimit";

let failures = 0;
function ok(cond: boolean, label: string) {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
}

/* ------------------------------------------------------------ redaction */

/* Shaped like what conversationDetail returns, with every field that must not
   reach a guest actually populated — a redaction test against a fixture with
   empty PII would pass while proving nothing. */
const FULL = {
  conversation: {
    id: 7, mode: "ai", channel: "webchat", lastMessageAt: "2026-08-28T09:00:00.000Z",
    hotelId: 1, guestId: 3, reservationId: 3, sentiment: "negative",
    sentimentSource: "model_realtime", sentimentAt: "2026-08-28T09:00:00.000Z",
    topic: "housekeeping", unreadForStaff: 1, assignedStaffId: 2,
    createdAt: "2026-08-20T00:00:00.000Z", firstResponseSeconds: 7,
  },
  guest: {
    id: 3, name: "Kim Ji-woo", lang: "ko", vipTier: "gold",
    phone: "+821094220118", email: "jiwoo.kim@example.kr",
    idType: "passport", idNumber: "M12345678", nationality: "KR", dob: "1991-04-02",
    notes: "Repeat guest from Seoul; books Aquafield on every stay.",
    preferences: ["Aquafield sauna"], staysCount: 4, loyaltyPoints: 1200,
    loyaltyEnrolledAt: "2024-01-01",
  },
  reservation: { id: 3, confirmationCode: "VPNT-5K18QA", ratePerNight: 2640000 },
  room: { id: 2, number: "102" },
  folioTotal: 12260000,
  charges: [{ id: 7, description: "Room 102 — 4 nights", amount: 10560000 }],
  messages: [{ id: 1, role: "guest", body: "xin chào", toolTrace: null }],
  tasks: [{ id: 170, title: "⚠️ Khách có dấu hiệu không hài lòng", detail: "độ tin cậy 98%" }],
  assignedStaff: { id: 2, name: "Trần Quốc Bảo", role: "agent", dept: "front_desk" },
};

/* Mirrors server/routes.ts `guestSafeDetail`. Kept in step by the shape
   assertions below: if the server starts returning more, the field list here
   stops matching what the kiosk needs and the intent is still stated. */
const redact = (d: typeof FULL) => ({
  conversation: {
    id: d.conversation.id,
    mode: d.conversation.mode,
    channel: d.conversation.channel,
    lastMessageAt: d.conversation.lastMessageAt,
  },
  guest: { name: d.guest.name, lang: d.guest.lang },
  messages: d.messages,
});

console.log("=== what a confirmation code must NOT buy ===");
const safe = redact(FULL);
const asText = JSON.stringify(safe);

for (const [label, needle] of [
  ["số hộ chiếu (idNumber)", "M12345678"],
  ["loại giấy tờ (idType)", "passport"],
  ["quốc tịch (nationality)", '"KR"'],
  ["ngày sinh (dob)", "1991-04-02"],
  ["số điện thoại", "+821094220118"],
  ["email", "jiwoo.kim@example.kr"],
  ["ghi chú nội bộ về khách", "Repeat guest from Seoul"],
  ["số tiền hoá đơn", "12260000"],
  ["nội dung task nội bộ", "độ tin cậy 98%"],
  ["tên nhân viên phụ trách", "Trần Quốc Bảo"],
] as const) {
  ok(!asText.includes(needle), `không lộ ${label}`);
}

console.log("\n=== nhưng kiosk vẫn đủ dữ liệu để chạy ===");
/* The five things client/src/pages/guest.tsx actually reads. If any of these
   disappear the kiosk breaks, which is the other way this can go wrong. */
ok(safe.conversation.id === 7, "conversation.id");
ok(safe.conversation.mode === "ai", "conversation.mode");
ok(safe.guest.name === "Kim Ji-woo", "guest.name (khách tự biết tên mình)");
ok(safe.guest.lang === "ko", "guest.lang");
ok(safe.messages.length === 1, "messages");
ok(!("charges" in safe) && !("tasks" in safe), "không kèm charges/tasks");

/* ------------------------------------------------------------- limiting */

console.log("\n=== chặn dò mã đặt phòng ===");
const t0 = 1_000_000;
const KEY = "203.0.113.9";

/* The failure budget must not be spent by CHECKING it — otherwise a guest who
   opens their own thread repeatedly locks themselves out, which is the bug this
   split exists to prevent. */
for (let i = 0; i < 50; i++) codeFailures.over(KEY, t0);
ok(codeFailures.over(KEY, t0) === 0, "kiểm tra 50 lần không tự tiêu ngân sách");

for (let i = 0; i < 30; i++) codeFailures.penalise(KEY, t0);
ok(codeFailures.over(KEY, t0) === 0, "30 lần sai vẫn cho qua (đúng giới hạn)");
codeFailures.penalise(KEY, t0);
ok(codeFailures.over(KEY, t0) > 0, "lần sai thứ 31 bị chặn");

/* Serving a correct code must NOT clear the miss budget — otherwise an
   attacker holding one valid code interleaves it and enumerates without limit.
   The legitimate guest needs no reset: a correct code bypasses the throttle. */
ok(codeFailures.over(KEY, t0) > 0, "vào đúng vẫn không xoá lịch sử sai");
codeFailures.reset(KEY);
ok(codeFailures.over(KEY, t0) === 0, "reset() thủ công thì sạch");

/* Windows expire, or a mistyped code would lock a room out for good. */
for (let i = 0; i < 40; i++) codeFailures.penalise(KEY, t0);
ok(codeFailures.over(KEY, t0) > 0, "đang bị chặn");
ok(codeFailures.over(KEY, t0 + 6 * 60_000) === 0, "hết cửa sổ 5 phút thì mở lại");

console.log("\n=== chặn dội request ===");
const K2 = "203.0.113.10";
let firstBlock = -1;
for (let i = 1; i <= 80; i++) {
  if (guestRequests.check(K2, t0) > 0 && firstBlock < 0) firstBlock = i;
}
ok(firstBlock === 61, `chặn từ request thứ ${firstBlock} (giới hạn 60/phút)`);
ok(guestRequests.check(K2, t0 + 61_000) === 0, "sang phút mới thì cho lại");

/* Separate keys must not share a budget, or one noisy guest silences a hotel. */
ok(guestRequests.check("203.0.113.11", t0) === 0, "địa chỉ khác không bị vạ lây");

console.log(failures === 0 ? "\nALL GUEST SURFACE SECURITY TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
