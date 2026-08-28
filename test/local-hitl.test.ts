/**
 * The offline path could never create an approval, and now it can.
 *
 * `service_approvals` had zero rows ever under `LLM_MODE=local`: the approval
 * tools live in the hosted tool loop, `runOfflineTurn` has none, and the wizard
 * that could call them only fires on a pending transaction that only a tool can
 * create. `/staff/approvals` was permanently empty.
 *
 * The dangerous way to fix that is to let the model fill in the form. These
 * assertions exist to make sure it was not done that way. The single most
 * important case in this file is the one where a time CANNOT be parsed: the
 * planner must return null so the turn falls through to a human, because an
 * approval carrying a guessed checkout time means somebody approves a departure
 * the guest never asked for.
 */
import "dotenv/config";
import { detectTransactionRequest, parseRequestedTime, pendingApprovalLine } from "../server/local-hitl";

let failures = 0;
function ok(cond: boolean, label: string) {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
}

console.log("=== nhận ra giao dịch, 6 ngôn ngữ ===");
for (const [text, kind] of [
  ["Tôi muốn trả phòng muộn lúc 16:00 được không ạ?", "request_late_checkout"],
  ["toi muon tra phong muon luc 16h", "request_late_checkout"],
  ["Can I have a late checkout at 4pm?", "request_late_checkout"],
  ["오후 4시에 늦게 체크아웃 가능할까요?", "request_late_checkout"],
  ["16時にレイトチェックアウトできますか", "request_late_checkout"],
  ["可以下午4点延迟退房吗", "request_late_checkout"],
  ["Можно поздний выезд в 16:00?", "request_late_checkout"],
  ["Tôi muốn nhận phòng sớm lúc 10:00", "request_early_checkin"],
  ["Can I do an early check-in at 10am?", "request_early_checkin"],
  ["Tôi muốn huỷ phòng", "cancel_reservation"],
  ["toi muon huy dat phong", "cancel_reservation"],
  ["I want to cancel my reservation", "cancel_reservation"],
  ["예약 취소하고 싶습니다", "cancel_reservation"],
  ["取消预订", "cancel_reservation"],
] as const) {
  const p = detectTransactionRequest(text);
  ok(p?.kind === kind, `${String(kind).padEnd(22)} <- "${text.slice(0, 40)}"`);
}

console.log("\n=== KHÔNG parse được giờ thì KHÔNG tạo yêu cầu ===");
/* The whole safety argument of this feature. A late-checkout request with no
   time must reach a person, not become an approval for a time nobody said. */
for (const text of [
  "Tôi muốn trả phòng muộn được không ạ?",
  "Can I have a late checkout tomorrow?",
  "늦게 체크아웃 하고 싶어요",
  "Tôi muốn nhận phòng sớm",
] as const) {
  ok(detectTransactionRequest(text) === null, `bỏ qua (không có giờ): "${text.slice(0, 40)}"`);
}

console.log("\n=== câu hỏi thường KHÔNG được tạo yêu cầu ===");
for (const text of [
  "Mấy giờ phải trả phòng ạ?",
  "Chính sách trả phòng muộn tính phí thế nào?",
  "What is your cancellation policy?",
  "Giá phòng Deluxe bao nhiêu?",
  "Hồ bơi mở cửa mấy giờ?",
] as const) {
  const p = detectTransactionRequest(text);
  ok(p === null, `bỏ qua: "${text.slice(0, 44)}"`);
}

console.log("\n=== đọc giờ ===");
ok(parseRequestedTime("trả phòng muộn 16:00", "request_late_checkout") === "16:00", "HH:MM");
ok(parseRequestedTime("tra phong muon 16h30", "request_late_checkout") === "16:30", "HHhMM");
ok(parseRequestedTime("late checkout at 4pm", "request_late_checkout") === "16:00", "4pm -> 16:00");
ok(parseRequestedTime("오후 4시", "request_late_checkout") === "16:00", "오후 4시 -> 16:00");
ok(parseRequestedTime("下午4点", "request_late_checkout") === "16:00", "下午4点 -> 16:00");

/* Ambiguity resolved by the transaction, not by chance: a late checkout at
   04:00 and an early arrival at 16:00 are both nonsense. */
ok(parseRequestedTime("trả phòng muộn lúc 4 giờ", "request_late_checkout") === "16:00", "trả phòng muộn '4 giờ' -> chiều");
ok(parseRequestedTime("nhận phòng sớm lúc 10 giờ", "request_early_checkin") === "10:00", "nhận phòng sớm '10 giờ' -> sáng");

/* The collision that a real request exposed and the unit tests missed:
   fold("Tôi") === fold("tối"), so an evening marker was found in the word "I". */
ok(
  parseRequestedTime("Tôi muốn nhận phòng sớm lúc 10:00", "request_early_checkin") === "10:00",
  "'Tôi' (tôi) không bị đọc thành 'tối' (buổi tối)",
);
ok(
  parseRequestedTime("toi muon nhan phong som luc 10:00", "request_early_checkin") === "10:00",
  "không dấu: 'toi muon' vẫn ra 10:00",
);
ok(
  parseRequestedTime("trả phòng muộn lúc 8 giờ tối", "request_late_checkout") === "20:00",
  "'8 giờ tối' (marker đứng sau) -> 20:00",
);
ok(parseRequestedTime("early check-in at 9am", "request_early_checkin") === "09:00", "9am -> 09:00");

ok(parseRequestedTime("không có giờ nào ở đây", "request_late_checkout") === null, "không có giờ -> null");
ok(parseRequestedTime("trả phòng muộn lúc 99:00", "request_late_checkout") === null, "giờ vô lý -> null");
ok(parseRequestedTime("huỷ phòng", "cancel_reservation") === null, "huỷ phòng không cần giờ");

console.log("\n=== câu trả lời KHÔNG được nói là đã xong ===");
/* A guest told "done" plans their morning around a checkout nobody approved. */
for (const lang of ["vi", "en", "ko", "ja", "zh", "ru"] as const) {
  const line = pendingApprovalLine(lang, 500000, "VND");
  ok(line.length > 20, `có câu trả lời tiếng ${lang}`);
  ok(line.includes("500.000"), `nêu phí dự kiến (${lang})`);
}
{
  const vi = pendingApprovalLine("vi", 500000, "VND");
  ok(/chưa phải xác nhận/i.test(vi), "vi nói rõ CHƯA xác nhận");
  const en = pendingApprovalLine("en", 500000, "VND");
  ok(/not a confirmation/i.test(en), "en nói rõ CHƯA xác nhận");
  ok(!/đã (xác nhận|áp dụng|hoàn tất)/i.test(vi), "vi không nói đã xong");
}
{
  const free = pendingApprovalLine("vi", 0, "VND");
  ok(!free.includes("phí dự kiến"), "miễn phí thì không nêu phí");
}
ok(pendingApprovalLine("de", 0, "VND").length > 20, "ngôn ngữ lạ vẫn có câu trả lời (rơi về vi)");

console.log(failures === 0 ? "\nALL LOCAL HITL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
