/**
 * Phase 9 §3: classifyLocal() must separate INFORMATIONAL_LOOKUP (a published
 * fact — never escalates on the presence of a money/percentage word alone)
 * from TRANSACTIONAL_ACTION / HIGH_RISK (a personal total, a supplied amount,
 * or a write verb — always escalates). The pre-fix router conflated these:
 * any money word forced escalation regardless of intent, discarding 48% of
 * a 102-case benchmark before retrieval ever ran.
 *
 *   npx tsx test/routing-informational.test.ts
 */
import { classifyLocal } from "../server/local-agent";

let failures = 0;
function ok(cond: boolean, msg: string) {
  if (cond) console.log(`  PASS  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}

console.log("=== INFORMATIONAL_LOOKUP — must NOT escalate ===");
ok(classifyLocal("Thuế VAT áp dụng bao nhiêu phần trăm?", false) === "knowledge", "1. VAT percentage question -> knowledge");
ok(classifyLocal("Deluxe giá bao nhiêu?", false) === "knowledge", "2. Room price question -> knowledge");
ok(classifyLocal("Gói HB giá bao nhiêu?", false) === "knowledge", "3. Package price question -> knowledge");
ok(classifyLocal("Hạng Platinum được giảm giá phòng bao nhiêu?", false) === "knowledge", "9. Informational membership-price question -> knowledge");
ok(classifyLocal("Resort nhận thanh toán bằng hình thức nào?", false) === "knowledge", "10. Informational payment-methods question -> knowledge");

console.log("\n=== TRANSACTIONAL_ACTION / HIGH_RISK — must escalate ===");
ok(classifyLocal("Cho tôi đặt phòng này.", false) !== "knowledge", "6. Booking request -> escalates");
ok(classifyLocal("Tôi muốn huỷ booking của tôi.", false) !== "knowledge", "7. Cancellation request -> escalates");
ok(classifyLocal("Hoàn tiền cho tôi.", false) !== "knowledge", "8. Refund request -> escalates");
ok(classifyLocal("Cho tôi thanh toán bằng thẻ", false) !== "knowledge", "8b. Payment execution request -> escalates");
ok(classifyLocal("Tổng hoá đơn của tôi bao nhiêu tiền?", false) !== "knowledge", "5. Personal folio total -> escalates");
ok(classifyLocal("What is my current bill total?", false) !== "knowledge", "5b. Personal folio total (en) -> escalates");

console.log("\n=== late checkout fee — informational band description ===");
// "Phí late checkout là bao nhiêu?" hits the stay_changes family (a real, still
// intentional escalation for anything checkout/date-shaped) — documented as a
// known residual conservatism in 09-ROUTING-AND-HALLUCINATION-REMEDIATION.md
// §remaining-limitations, not silently claimed fixed here.
ok(classifyLocal("Trả phòng muộn tính phí thế nào?", false) === "transaction", "4. Late checkout fee question -> still escalates (documented limitation, see report)");

console.log("\n=== case-shape regression: original ANSWER-lane 63-case set must never be blocked ===");
ok(classifyLocal("Mã BB trong bảng giá nghĩa là gì?", false) === "knowledge", "package-codes (was wrongly blocked pre-fix) -> knowledge");
ok(classifyLocal("Resort có tất cả mấy phòng?", false) === "knowledge", "room-count (counting unit, unaffected) -> knowledge");

console.log("\n=== menu dish-price lookup — \"tầm giá\" phrase collision (found live) ===");
// "Cá tầm giá bao nhiêu?" (how much is the sturgeon) scored room_shopping=4
// and force-escalated: toolrouter's room_shopping lexicon has the budget
// phrase "tầm giá" (price range), and "Cá tầm" (sturgeon) ending in "tầm"
// right before "giá" makes it appear adjacent — a genuine phrase collision,
// not a word-boundary bug. Fixed by requiring an actual recommendation cue
// (checked independently) alongside the score, not the score alone.
ok(classifyLocal("Cá tầm giá bao nhiêu?", false) === "knowledge", "dish-price lookup no longer force-escalated by the \"tầm giá\" collision");
// Must still escalate: genuine multi-constraint recommendation requests.
ok(classifyLocal("Gói nào rẻ nhất cho 4 người?", false) === "complex", "genuine recommendation request (rẻ nhất + gói nào) still escalates");
ok(classifyLocal("Tôi có 5 triệu thì nên đặt phòng nào?", false) === "complex", "budget recommendation request still escalates");

console.log(failures === 0 ? "\nALL ROUTING TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
