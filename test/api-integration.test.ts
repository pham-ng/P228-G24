/**
 * API-level integration tests — the middle tier of the testing pyramid.
 * Unlike test/local-agent.test.ts (pure functions, no I/O), these boot the
 * real Express app on an ephemeral port and hit it over HTTP: request ->
 * routing -> validation -> storage -> response. No LLM is mocked — the one
 * AI-mode case below makes a real local-model call (LLM_MODE=local), the
 * same way the rest of this project prefers a real call over a stubbed one
 * wherever the call is fast enough to keep in the suite.
 *
 *   npx tsx test/api-integration.test.ts
 */
import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import { registerRoutes } from "../server/routes";
import { storage } from "../server/storage";

/* /api/* routes other than a guest's own "from":"guest" post require staff
 * auth when STAFF_API_TOKEN + API_AUTH_ENFORCE=1 are set (see server/
 * routes.ts's staffApiGuard) — a real guardrail added earlier in this
 * project, not a test-only concern, so a staff-role request in this suite
 * must present it exactly like a real staff client would. */
const STAFF_HEADERS = process.env.STAFF_API_TOKEN
  ? { "content-type": "application/json", "x-staff-token": process.env.STAFF_API_TOKEN }
  : { "content-type": "application/json" };

let failures = 0;
function ok(cond: boolean, msg: string) {
  if (cond) console.log(`  PASS  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}

async function main() {
  const app = express();
  app.use(express.json());
  const httpServer = createServer(app);
  await registerRoutes(httpServer, app);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = (httpServer.address() as any).port;
  const base = `http://127.0.0.1:${port}`;

  console.log("=== GET /api/hotel ===");
  {
    const r = await fetch(`${base}/api/hotel`);
    const body = await r.json();
    ok(r.status === 200, "returns 200");
    ok(typeof body.name === "string" && body.name.length > 0, "returns a hotel name");
    ok(typeof body.currency === "string", "returns a currency code");
  }

  console.log("\n=== POST /api/conversations/:id/messages — error paths ===");
  {
    const r = await fetch(`${base}/api/conversations/999999/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "hello", from: "guest" }),
    });
    ok(r.status === 404, "unknown conversation id returns 404, not a 500 or a silent success");
  }
  {
    // Set up a real conversation to post the invalid bodies against, so a
    // 404 from the id lookup can't be mistaken for the validation failure
    // this case is actually checking.
    const guest = storage.createGuest({
      name: "Test Guest — api-integration",
      phone: `test-${Date.now()}`,
      email: null,
      lang: "vi",
      vipTier: "none",
      preferences: "[]",
      notes: null,
      staysCount: 1,
    });
    const conv = storage.createConversation({
      hotelId: 1,
      guestId: guest.id,
      reservationId: null,
      channel: "webchat",
      mode: "human",
      assignedStaffId: null,
      sentiment: "neutral",
      topic: null,
      unreadForStaff: 0,
      lastMessageAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });

    const rEmpty = await fetch(`${base}/api/conversations/${conv.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "", from: "guest" }),
    });
    // Real behavior, not idealized REST: asyncH has no special case for a
    // thrown ZodError (only LlmError carries a .status), so a validation
    // failure surfaces as 500, not 400. Asserting the ACTUAL status keeps
    // this test honest about what a client really sees today, rather than
    // what a REST guide says it should see — if that's ever tightened to a
    // proper 400, this assertion should be updated deliberately, not left
    // silently passing against the old behavior.
    ok(rEmpty.status === 500, "empty message body is rejected (currently surfaces as 500 — see comment)");

    const rNoAuth = await fetch(`${base}/api/conversations/${conv.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "hello", from: "staff" }),
    });
    ok(
      rNoAuth.status === 401,
      "a staff-role post WITHOUT the staff token is rejected with 401 (real guardrail, not a test assumption)",
    );

    const rBadFrom = await fetch(`${base}/api/conversations/${conv.id}/messages`, {
      method: "POST",
      headers: STAFF_HEADERS,
      body: JSON.stringify({ body: "hello", from: "not-a-role" }),
    });
    ok(rBadFrom.status === 500, "invalid 'from' enum value is rejected");
  }

  console.log("\n=== POST /api/conversations/:id/messages — staff reply happy path ===");
  {
    const guest = storage.createGuest({
      name: "Test Guest 2 — api-integration",
      phone: `test-${Date.now()}-2`,
      email: null,
      lang: "vi",
      vipTier: "none",
      preferences: "[]",
      notes: null,
      staysCount: 1,
    });
    const conv = storage.createConversation({
      hotelId: 1,
      guestId: guest.id,
      reservationId: null,
      channel: "webchat",
      mode: "human",
      assignedStaffId: null,
      sentiment: "neutral",
      topic: null,
      unreadForStaff: 0,
      lastMessageAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
    const r = await fetch(`${base}/api/conversations/${conv.id}/messages`, {
      method: "POST",
      headers: STAFF_HEADERS,
      body: JSON.stringify({ body: "Xin chào, tôi cần hỗ trợ.", from: "staff" }),
    });
    const detail = await r.json();
    ok(r.status === 200, "staff message returns 200");
    ok(detail.conversation?.mode === "human", "posting a staff reply keeps/sets the conversation in human mode");
    ok(
      Array.isArray(detail.messages) && detail.messages.some((m: any) => m.role === "staff" && m.body === "Xin chào, tôi cần hỗ trợ."),
      "the posted staff message appears in the conversation's message list",
    );
  }

  if ((process.env.LLM_MODE || "").toLowerCase() === "local") {
    console.log("\n=== POST /api/conversations/:id/messages — guest message, AI mode (real local model call) ===");
    const guest = storage.createGuest({
      name: "Test Guest 3 — api-integration",
      phone: `test-${Date.now()}-3`,
      email: null,
      lang: "vi",
      vipTier: "none",
      preferences: "[]",
      notes: null,
      staysCount: 1,
    });
    const conv = storage.createConversation({
      hotelId: 1,
      guestId: guest.id,
      reservationId: null,
      channel: "webchat",
      mode: "ai",
      assignedStaffId: null,
      sentiment: "neutral",
      topic: null,
      unreadForStaff: 0,
      lastMessageAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
    const t0 = Date.now();
    const r = await fetch(`${base}/api/conversations/${conv.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Spa mở cửa mấy giờ?", from: "guest" }),
    });
    const ms = Date.now() - t0;
    const detail = await r.json();
    ok(r.status === 200, "guest message in AI mode returns 200");
    const aiReply = (detail.messages ?? []).find((m: any) => m.role === "ai");
    ok(!!aiReply, "an AI reply message was appended to the conversation");
    ok(!!aiReply && aiReply.body.length > 0, "the AI reply is non-empty");
    console.log(`  (end-to-end HTTP round trip: ${ms}ms — includes retrieval + one model call)`);
  } else {
    console.log("\n(skipping AI-mode HTTP round trip — LLM_MODE is not 'local'; set LLM_MODE=local to exercise it)");
  }

  httpServer.close();
  console.log(failures === 0 ? "\nALL API INTEGRATION TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
