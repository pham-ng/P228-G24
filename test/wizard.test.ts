/**
 * Confirmation-parsing tests for the offline form wizard.
 *
 * Every case marked REGRESSION is a phrasing the previous implementation read as
 * consent and acted on — cancelling a reservation, which is irreversible and
 * chargeable. They are pinned here so that class of bug cannot return.
 *
 *   npx tsx test/wizard.test.ts
 */

import { readConfirmation, detectPendingTransaction } from "../server/wizard";
import type { Message } from "../shared/schema";

let failures = 0;
function is(input: string, expected: string, note = "") {
  const got = readConfirmation(input);
  if (got === expected) console.log(`  PASS  "${input}" -> ${got}${note ? ` (${note})` : ""}`);
  else {
    failures++;
    console.error(`  FAIL  "${input}" -> ${got}, expected ${expected}${note ? ` (${note})` : ""}`);
  }
}
function ok(cond: boolean, msg: string) {
  if (cond) console.log(`  PASS  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}

console.log("=== REGRESSIONS: phrasings that used to execute a cancellation ===");
is("tôi không muốn hủy nữa", "no", "REGRESSION");
is("khoan đã, đừng hủy", "no", "REGRESSION");
is("thôi đừng hủy nữa", "no", "REGRESSION");
is("phí hủy là bao nhiêu?", "unclear", "REGRESSION — a question is not consent");
is("tôi muốn book thêm 1 phòng", "unclear", "REGRESSION — 'book' contains 'ok'");
is("cho tôi xem lại hoá đơn", "unclear", "REGRESSION");
/* "nothing" must not match the bare word "no". Landing on unclear is the right
   outcome: it is a conversational close, not an answer to the question we asked,
   so it falls through to the normal agent. */
is("nothing else thanks", "unclear", "'nothing' does not contain the whole word 'no'");

console.log("=== CLEAR CONSENT ===");
is("đồng ý", "yes");
is("Đồng ý ạ", "yes");
is("xác nhận", "yes");
is("ok", "yes");
is("OK bạn nhé", "yes");
is("yes please", "yes");
is("dong y", "yes", "no diacritics");

console.log("=== CLEAR REFUSAL ===");
is("không", "no");
is("thôi", "no");
is("không cần đâu", "no");
is("no thanks", "no");
is("stop", "no");

console.log("=== REFUSAL WINS OVER A STRAY AFFIRMATIVE ===");
/* A guest who might be declining is declining. */
is("ok thôi, đừng hủy", "no");
is("ok nhưng khoan đã", "no");

console.log("=== QUESTIONS ARE NEVER CONSENT ===");
is("đồng ý thì mất bao nhiêu tiền?", "unclear");
is("xác nhận kiểu gì?", "unclear");
is("how much is it?", "unclear");

console.log("=== AMBIGUOUS FALLS THROUGH TO THE NORMAL AGENT ===");
is("mấy giờ ăn sáng", "unclear");
is("tôi bị đau ngực", "unclear", "an emergency must not be swallowed by the form");
is("", "unclear");
is("   ", "unclear");

console.log("=== PENDING DETECTION ===");
const msg = (toolTrace: any): Message =>
  ({ id: 1, conversationId: 1, role: "ai", authorName: null, body: "", toolTrace: JSON.stringify(toolTrace), latencyMs: 0, createdAt: "" }) as Message;

const quoted = detectPendingTransaction([
  msg([{ name: "quote_cancellation", args: { confirmation_code: "VPNT-1" }, result: { fee: 100 } }]),
]);
ok(quoted?.type === "cancellation", "an uncommitted quote is pending");
ok(quoted?.details.args?.confirmation_code === "VPNT-1", "the quote's arguments are carried forward");

const committed = detectPendingTransaction([
  msg([{ name: "quote_cancellation", args: {}, result: {} }]),
  msg([{ name: "cancel_reservation", args: {}, result: { cancelled: true } }]),
]);
ok(committed === null, "a committed action is no longer pending");

ok(detectPendingTransaction([]) === null, "empty history has nothing pending");
ok(
  detectPendingTransaction([msg([{ name: "get_folio", args: {}, result: {} }])]) === null,
  "an unrelated tool call is not a pending transaction",
);

/* Only recent messages count: a quote the guest has long moved past must not
   keep hijacking later turns. */
const stale = detectPendingTransaction([
  msg([{ name: "quote_late_checkout", args: { requested_time: "14:00" }, result: {} }]),
  msg([{ name: "search_knowledge", args: {}, result: {} }]),
  msg([{ name: "get_folio", args: {}, result: {} }]),
  msg([{ name: "list_services", args: {}, result: {} }]),
  msg([{ name: "get_weather", args: {}, result: {} }]),
]);
ok(stale === null, "a quote older than the recent window is not pending");

console.log(failures === 0 ? "\nALL WIZARD TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
