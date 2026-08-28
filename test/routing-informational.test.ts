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
// This assertion used to read "transaction", documented as a residual
// conservatism in 09-ROUTING-AND-HALLUCINATION-REMEDIATION.md
// §remaining-limitations. Commit 1b58a44 deliberately lifted that limitation
// (isPolicyInfoOnly) but did not update this line, so the suite went red and
// stayed red — which is how the two genuine routing regressions in the same
// commit went unnoticed. The published late-checkout bands are a static KB
// fact with no guest-specific number in them, so "knowledge" is the intended
// behaviour and this now asserts it.
ok(classifyLocal("Trả phòng muộn tính phí thế nào?", false) === "knowledge", "4. Late checkout policy question -> knowledge (published band, no guest-specific figure)");

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

console.log("\n=== wifi false-escalation — bare amenity noun collides with fault lexicon (found live) ===");
// "Có wifi miễn phí không?" escalated with ZERO retrieval: toolrouter's
// housekeeping lexicon lists bare "wifi" alongside real fault words (so
// "wifi không hoạt động" can still be caught as a dispatchable complaint),
// and housekeeping is a TRANSACTION_FAMILIES member — so any wifi mention at
// all forced "transaction" before retrieval ever ran, even though a real
// "Wi-Fi / Internet" KB article exists. Fixed by requiring an actual
// fault/request cue alongside a bare "wifi" mention, mirroring the
// "tầm giá"/room_shopping fix above — never a broad rewrite of the shared
// housekeeping lexicon, which other bare nouns (khăn, điều hoà...) still need
// to force-escalate since no KB article answers those.
ok(classifyLocal("Có wifi miễn phí không?", false) === "knowledge", "informational wifi question no longer force-escalated");
ok(classifyLocal("Mật khẩu wifi là gì?", false) === "knowledge", "wifi password question no longer force-escalated");
// Must still escalate: a genuine fault report needs a real dispatch.
ok(classifyLocal("Wifi phòng tôi không hoạt động", false) === "transaction", "wifi fault report still escalates");
ok(classifyLocal("Wifi yếu quá, sửa giúp tôi", false) === "transaction", "wifi complaint still escalates");
// Bare amenity nouns with no KB fact behind them are unaffected by this fix.
ok(classifyLocal("Khăn tắm bẩn quá", false) === "transaction", "unrelated housekeeping noun (towel) still escalates — fix is wifi-specific");

console.log("\n=== fault reports phrased as a question — isPolicyInfoOnly over-reach (found live) ===");
// isPolicyInfoOnly was added unscoped and applied to EVERY transaction family.
// It fires on the bare words "thế nào" / "bao nhiêu" / "mấy giờ", which is how
// a guest phrases a FAULT REPORT at least as often as a policy lookup — so
// every sentence below was released to the knowledge lane. Reproduced end to
// end in the running kiosk: the guest is answered "vui lòng liên hệ lễ tân",
// NO task is written to the ops board, and nobody is dispatched to the room.
// It also silently overrode the isWifiInfoOnly carve-out directly above —
// every cue in WIFI_FAULT_CUES had become unreachable, including the literal
// "không vào được" in the second case here. Now scoped to stay_changes only.
ok(classifyLocal("Điều hoà phòng tôi bị hỏng, xử lý thế nào?", false) === "transaction", "broken air-con phrased as a question still dispatches");
ok(classifyLocal("Wifi phòng tôi không vào được, phải làm thế nào?", false) === "transaction", "wifi fault phrased as a question still dispatches (WIFI_FAULT_CUES reachable again)");
ok(classifyLocal("Bồn cầu phòng tôi bị tắc, xử lý thế nào?", false) === "transaction", "blocked toilet phrased as a question still dispatches");
ok(classifyLocal("Phòng tôi hết khăn tắm, bao giờ có thêm?", false) === "transaction", "amenity request phrased as a question still dispatches");

console.log("\n=== extending the stay is arithmetic, not a rate lookup (found live) ===");
// "Ở thêm 2 ngày mất bao nhiêu tiền?" reached the model, which answered with
// the LATE CHECKOUT bands (50% / 100%) — a different policy entirely — plus a
// nightly rate taken from an unrelated package passage. The numeric guard
// passed it because those figures do appear in some retrieved passage.
// Answering needs nightly rate × the guest's own number, which this path
// never improvises, so it goes to a person with zero model calls.
ok(classifyLocal("Ở thêm 2 ngày mất bao nhiêu tiền?", false) === "complex", "extra-nights cost -> complex");
ok(classifyLocal("Ở thêm 1 đêm giá bao nhiêu?", false) === "complex", "extra-nights cost, singular -> complex");
ok(classifyLocal("Tôi ở thêm 3 đêm nữa thì hết bao nhiêu?", false) === "complex", "extra-nights with no money word ('hết bao nhiêu') -> complex");
// toolrouter's stay_changes lexicon is Vietnamese-only, so these scored ZERO
// families and fell straight through to knowledge — the Vietnamese sentence
// had a safety net and the English one never did. Decided before family
// scoring now, so it holds in every language the kiosk serves.
ok(classifyLocal("How much for one more night?", false) === "complex", "en extra-night cost -> complex (no family cue exists for it)");
ok(classifyLocal("I want to stay one more night, how much?", false) === "complex", "en extra-night cost, verbose -> complex");
ok(classifyLocal("연장해서 1박 더 하면 요금이 얼마인가요?", false) === "complex", "ko extra-night cost -> complex");
// Must NOT catch an ordinary per-night rate lookup — the cue requires an
// explicit extra/more word next to the unit.
ok(classifyLocal("Phòng này bao nhiêu tiền một đêm?", false) === "knowledge", "per-night rate lookup is untouched");
ok(classifyLocal("How much does a room cost per night?", false) === "knowledge", "per-night rate lookup is untouched (en)");
ok(classifyLocal("Danh sách khách phải gửi trước bao nhiêu ngày?", false) === "knowledge", "a counting question about days is untouched");

console.log(failures === 0 ? "\nALL ROUTING TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
