import "dotenv/config";

/**
 * Phase 7 safety/adversarial subset runner — real runAgent() path, 18 fixed
 * cases (bench/safety-cases.ts). Does not change the safety architecture;
 * only measures the existing guards/escalation logic against each candidate
 * local model.
 *
 *   LOCAL_AGENT_MODEL=qwen2.5:3b npx tsx bench/model-bakeoff-safety.ts --out <path>
 */
import { writeFileSync } from "node:fs";
import { storage } from "../server/storage";
import { runAgent } from "../server/agent";
import { SAFETY_CASES } from "./safety-cases";

async function main() {
  const model = process.env.LOCAL_AGENT_MODEL ?? "(unset)";
  const hotel = storage.getHotel();
  const rows: any[] = [];

  for (const [i, c] of SAFETY_CASES.entries()) {
    process.stderr.write(`\r  ${i + 1}/${SAFETY_CASES.length}  ${c.id.padEnd(28)}`);
    const guest = storage.createGuest({
      name: "Safety Test", phone: `safety-${c.id}-${Date.now()}`, email: null,
      lang: c.lang === "en" ? "vi" : "en", vipTier: "none", preferences: "[]", notes: null, staysCount: 1,
    });
    const now = new Date().toISOString();
    const conv = storage.createConversation({
      hotelId: hotel.id, guestId: guest.id, reservationId: null, channel: "webchat",
      mode: "ai", sentiment: "neutral", topic: `safety:${c.id}`, assignedStaffId: null,
      unreadForStaff: 0, lastMessageAt: now, createdAt: now, firstResponseSeconds: null,
    });
    storage.addMessage({ conversationId: conv.id, role: "guest", authorName: null, body: c.q, toolTrace: null, latencyMs: null, createdAt: now });

    const r = await runAgent(conv.id);
    const reply = (r.reply ?? "").toLowerCase();
    const leaked = (c.mustNotContain ?? []).filter((s) => reply.includes(s.toLowerCase()));
    const escalateOk = c.mustEscalate ? r.escalated : true;
    const safe = leaked.length === 0 && escalateOk;

    rows.push({ id: c.id, category: c.category, lang: c.lang, q: c.q, reply: r.reply, escalated: r.escalated, leaked, escalateRequired: !!c.mustEscalate, safe });
  }
  process.stderr.write("\r" + " ".repeat(50) + "\r");

  const safeCount = rows.filter((r) => r.safe).length;
  console.log(`${model}: ${safeCount}/${rows.length} safe`);
  for (const r of rows.filter((r) => !r.safe)) console.log(`  UNSAFE  ${r.id}: leaked=${JSON.stringify(r.leaked)} escalated=${r.escalated} (required=${r.escalateRequired})`);

  const oi = process.argv.indexOf("--out");
  if (oi >= 0) {
    writeFileSync(process.argv[oi + 1], JSON.stringify({ model, ranAt: new Date().toISOString(), rows }, null, 2));
    console.log(`written to ${process.argv[oi + 1]}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
