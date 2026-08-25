import "dotenv/config";

/**
 * Phase 7 multi-turn subset runner — real runAgent() path, one conversation
 * per case, turns sent in order with the AI's reply persisted back to
 * storage between turns (runAgent() does not persist its own output — the
 * caller does, same as the real route handler) so each turn actually sees
 * prior context, not a fresh conversation.
 *
 *   LOCAL_AGENT_MODEL=qwen2.5:3b npx tsx bench/model-bakeoff-multiturn.ts --out <path>
 */
import { writeFileSync } from "node:fs";
import { storage } from "../server/storage";
import { runAgent } from "../server/agent";
import { MULTITURN_CASES } from "./multiturn-cases";

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");
function factsPresent(text: string, expect: string[][] | undefined) {
  if (!expect?.length) return { ok: true, missing: [] as string[] };
  const t = norm(text);
  const missing = expect.filter((g) => !g.some((alt) => t.includes(norm(alt)))).map((g) => g[0]);
  return { ok: missing.length === 0, missing };
}

async function main() {
  const model = process.env.LOCAL_AGENT_MODEL ?? "(unset)";
  const hotel = storage.getHotel();
  const convRows: any[] = [];

  for (const [ci, convo] of MULTITURN_CASES.entries()) {
    process.stderr.write(`\r  ${ci + 1}/${MULTITURN_CASES.length}  ${convo.id.padEnd(28)}`);
    const guest = storage.createGuest({
      name: "Multiturn Test", phone: `mt-${convo.id}-${Date.now()}`, email: null,
      lang: convo.lang, vipTier: "none", preferences: "[]", notes: null, staysCount: 1,
    });
    const now = new Date().toISOString();
    const conv = storage.createConversation({
      hotelId: hotel.id, guestId: guest.id, reservationId: null, channel: "webchat",
      mode: "ai", sentiment: "neutral", topic: `mt:${convo.id}`, assignedStaffId: null,
      unreadForStaff: 0, lastMessageAt: now, createdAt: now, firstResponseSeconds: null,
    });

    const turnRows: any[] = [];
    for (const [ti, turn] of convo.turns.entries()) {
      const t0 = new Date().toISOString();
      storage.addMessage({ conversationId: conv.id, role: "guest", authorName: null, body: turn.q, toolTrace: null, latencyMs: null, createdAt: t0 });
      const r = await runAgent(conv.id);
      const t1 = new Date().toISOString();
      storage.addMessage({ conversationId: conv.id, role: "ai", authorName: null, body: r.reply ?? "", toolTrace: null, latencyMs: r.latencyMs ?? null, createdAt: t1 });

      let correct = true;
      let verdict = "unscored (context-setting turn)";
      if (turn.mustEscalate !== undefined) {
        correct = turn.mustEscalate ? r.escalated : true;
        verdict = correct ? "ok" : "should have escalated but answered";
      } else if (turn.expect) {
        const facts = factsPresent(r.reply ?? "", turn.expect);
        correct = facts.ok && !r.escalated;
        verdict = correct ? "correct" : r.escalated ? "unnecessary abstention" : "missing: " + facts.missing.join(", ");
      }
      turnRows.push({ turn: ti + 1, q: turn.q, reply: r.reply, escalated: r.escalated, correct, verdict });
    }
    convRows.push({ id: convo.id, lang: convo.lang, kind: convo.kind, turns: turnRows });
  }
  process.stderr.write("\r" + " ".repeat(50) + "\r");

  const scoredTurns = convRows.flatMap((c) => c.turns).filter((t) => t.verdict !== "unscored (context-setting turn)");
  const correctTurns = scoredTurns.filter((t) => t.correct).length;
  console.log(`${model}: ${correctTurns}/${scoredTurns.length} scored turns correct across ${convRows.length} conversations`);
  for (const c of convRows) for (const t of c.turns) if (!t.correct) console.log(`  FAIL ${c.id} turn${t.turn}: ${t.verdict}`);

  const oi = process.argv.indexOf("--out");
  if (oi >= 0) {
    writeFileSync(process.argv[oi + 1], JSON.stringify({ model, ranAt: new Date().toISOString(), conversations: convRows }, null, 2));
    console.log(`written to ${process.argv[oi + 1]}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
