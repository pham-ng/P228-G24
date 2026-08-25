import "dotenv/config";

/**
 * Phase 8: preliminary concurrency probe (1/2/4 concurrent), real production
 * path (runAgent). Small and diagnostic — the full load test is a later phase.
 *
 *   LLM_MODE=local LOCAL_AGENT_MODEL=<model> npx tsx bench/model-concurrency.ts --out <path>
 */
import { writeFileSync } from "node:fs";
import { storage } from "../server/storage";
import { runAgent } from "../server/agent";
import { percentile } from "../server/ireval";

const PROBE_QUESTIONS = [
  "Spa mở cửa mấy giờ?", "Mấy giờ trả phòng?", "Ăn sáng ở nhà hàng nào?", "Resort có hồ bơi không?",
];

async function oneCall(idx: number) {
  const hotel = storage.getHotel();
  const guest = storage.createGuest({
    name: "Concurrency Test", phone: `conc-${idx}-${Date.now()}-${Math.random()}`, email: null,
    lang: "vi", vipTier: "none", preferences: "[]", notes: null, staysCount: 1,
  });
  const now = new Date().toISOString();
  const conv = storage.createConversation({
    hotelId: hotel.id, guestId: guest.id, reservationId: null, channel: "webchat",
    mode: "ai", sentiment: "neutral", topic: `conc:${idx}`, assignedStaffId: null,
    unreadForStaff: 0, lastMessageAt: now, createdAt: now, firstResponseSeconds: null,
  });
  storage.addMessage({ conversationId: conv.id, role: "guest", authorName: null, body: PROBE_QUESTIONS[idx % PROBE_QUESTIONS.length], toolTrace: null, latencyMs: null, createdAt: now });
  const t0 = Date.now();
  try {
    await runAgent(conv.id);
    return { ok: true, ms: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, ms: Date.now() - t0, error: e?.message ?? String(e) };
  }
}

async function main() {
  const model = process.env.LOCAL_AGENT_MODEL ?? "unknown";
  const results: any[] = [];
  for (const concurrency of [1, 2, 4]) {
    const t0 = Date.now();
    const calls = await Promise.all(Array.from({ length: concurrency }, (_, i) => oneCall(i)));
    const wallMs = Date.now() - t0;
    const lat = calls.map((c) => c.ms);
    const errors = calls.filter((c) => !c.ok).length;
    const summary = {
      model, concurrency, wallMs,
      p50: percentile(lat, 50), p95: percentile(lat, 95),
      throughputPerSec: +(concurrency / (wallMs / 1000)).toFixed(3),
      errors,
    };
    console.log(`concurrency=${concurrency} wall=${wallMs}ms p50=${summary.p50}ms p95=${summary.p95}ms throughput=${summary.throughputPerSec}/s errors=${errors}`);
    results.push(summary);
  }
  const oi = process.argv.indexOf("--out");
  if (oi >= 0) {
    writeFileSync(process.argv[oi + 1], JSON.stringify({ model, ranAt: new Date().toISOString(), results }, null, 2));
    console.log(`written to ${process.argv[oi + 1]}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
