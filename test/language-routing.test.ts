/**
 * Part 5.5 regression: the offline path must preserve a correctly detected
 * guest language instead of discarding it.
 *
 * `replyLang()` (server/agent.ts) collapses every non-Vietnamese language to
 * English — correct for the three hosted call sites that feed `compareRooms`,
 * whose comparison labels genuinely only exist in vi/en, but wrong for the
 * offline path's answer-language decision, which was silently reusing the
 * same narrow function. `offlineReplyLang()` is the fix: same detection order,
 * full range.
 *
 * This asserts the INTERNAL language value passed into the local pipeline,
 * not just a final answer — the bug this pins produced a value invisible from
 * the outside until it reached the model, exactly why it went unnoticed.
 *
 *   DB_FILE=<a copy> npx tsx test/language-routing.test.ts
 */

import { storage, migrate } from "../server/storage";
import { offlineReplyLang } from "../server/agent";

let failures = 0;
function ok(cond: boolean, msg: string) {
  if (cond) console.log(`  PASS  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}

migrate();
const hotel = storage.getHotel();
const guest = storage.listGuests?.()[0] ?? null;

/** A throwaway conversation whose last guest message is the given text. */
function convWithMessage(body: string, profileLang = "en") {
  const g = storage.createGuest({
    name: "Test Guest", phone: `test-${Date.now()}-${Math.random()}`, email: null,
    lang: profileLang, vipTier: "none", preferences: "[]", notes: null, staysCount: 1,
  });
  const now = new Date().toISOString();
  const conv = storage.createConversation({
    hotelId: hotel.id, guestId: g.id, reservationId: null, channel: "webchat",
    mode: "ai", sentiment: "neutral", topic: "lang-test", assignedStaffId: null,
    unreadForStaff: 0, lastMessageAt: now, createdAt: now, firstResponseSeconds: null,
  });
  storage.addMessage({
    conversationId: conv.id, role: "guest", authorName: null, body,
    toolTrace: null, latencyMs: null, createdAt: now,
  });
  return { conv, guest: g };
}

console.log("=== offlineReplyLang: full range preserved ===");
{
  const { conv, guest: g } = convWithMessage("Mấy giờ trả phòng?", "en");
  ok(offlineReplyLang(conv, g.lang) === "vi", "Vietnamese message -> vi");
}
{
  const { conv, guest: g } = convWithMessage("What time is checkout?", "vi");
  ok(offlineReplyLang(conv, g.lang) === "en", "English message -> en (ASCII detection)");
}
{
  const { conv, guest: g } = convWithMessage("退房时间是几点？", "en");
  ok(offlineReplyLang(conv, g.lang) === "zh", "Chinese message -> zh, NOT collapsed to en");
}
{
  const { conv, guest: g } = convWithMessage("チェックアウトは何時ですか？", "en");
  ok(offlineReplyLang(conv, g.lang) === "ja", "Japanese message -> ja, NOT collapsed to en");
}
{
  const { conv, guest: g } = convWithMessage("체크아웃은 몇 시인가요?", "en");
  ok(offlineReplyLang(conv, g.lang) === "ko", "Korean message -> ko, NOT collapsed to en");
}
{
  const { conv, guest: g } = convWithMessage("Во сколько выезд?", "en");
  ok(offlineReplyLang(conv, g.lang) === "ru", "Russian message -> ru, NOT collapsed to en");
}
{
  // No letters at all — detectMessageLang's ASCII rule requires 2+ letters,
  // so this has no script signal and falls back to the stored profile.
  const { conv, guest: g } = convWithMessage("123", "vi");
  ok(offlineReplyLang(conv, g.lang) === "vi", "no script signal falls back to vi profile");
}
{
  const { conv, guest: g } = convWithMessage("", "vi");
  ok(offlineReplyLang(conv, g.lang) === "vi", "empty message falls back to profile");
}

console.log("\n=== replyLang unchanged for the hosted tool-label call sites ===");
console.log(
  "  (replyLang itself is untouched and still typed \"vi\"|\"en\" — verified by",
);
console.log("   typecheck: compareRooms' narrower signature would fail to compile otherwise.)");

console.log(failures === 0 ? "\nALL LANGUAGE-ROUTING TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
