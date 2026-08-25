import "dotenv/config";
import { writeFileSync } from "node:fs";
import { storage } from "../server/storage";
import { runAgent } from "../server/agent";
import { HOURS_CASES } from "./hours-validation-cases";

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");
function factsPresent(text: string, expect: string[][]): { ok: boolean; missing: string[] } {
  const t = norm(text);
  const missing = expect.filter((g) => !g.some((alt) => t.includes(norm(alt)))).map((g) => g[0]);
  return { ok: missing.length === 0, missing };
}

async function main() {
  const model = process.env.LOCAL_AGENT_MODEL ?? "unknown";
  const hotel = storage.getHotel();
  const rows: any[] = [];
  for (const c of HOURS_CASES) {
    const guest = storage.createGuest({ name: "Hours Test", phone: `hours-${c.id}-${Date.now()}`, email: null, lang: c.lang === "en" ? "vi" : "en", vipTier: "none", preferences: "[]", notes: null, staysCount: 1 });
    const now = new Date().toISOString();
    const conv = storage.createConversation({ hotelId: hotel.id, guestId: guest.id, reservationId: null, channel: "webchat", mode: "ai", sentiment: "neutral", topic: `hours:${c.id}`, assignedStaffId: null, unreadForStaff: 0, lastMessageAt: now, createdAt: now, firstResponseSeconds: null });
    storage.addMessage({ conversationId: conv.id, role: "guest", authorName: null, body: c.q, toolTrace: null, latencyMs: null, createdAt: now });
    const r = await runAgent(conv.id);
    const reply = r.reply ?? "";
    const facts = factsPresent(reply, c.expect);
    const correct = !r.escalated && facts.ok;
    rows.push({ id: c.id, lang: c.lang, q: c.q, reply, escalated: r.escalated, correct, missing: facts.missing });
    console.log(`${correct ? "PASS" : "FAIL"}  ${c.id.padEnd(28)} ${correct ? "" : facts.missing.length ? "missing: " + facts.missing.join(",") : "escalated/empty"}`);
  }
  const correct = rows.filter((r) => r.correct).length;
  console.log(`\n${model}: ${correct}/${rows.length} correct (${((correct / rows.length) * 100).toFixed(1)}%)`);
  const oi = process.argv.indexOf("--out");
  if (oi >= 0) writeFileSync(process.argv[oi + 1], JSON.stringify({ model, rows }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
