import "dotenv/config";

/**
 * Phase 7/8 model bake-off: runs a named case set through the REAL runAgent()
 * production path (not runLocalTurn directly) for whichever LOCAL_AGENT_MODEL
 * is set in the environment. Reused across phases with different --set values.
 *
 *   --set visible   the 54 non-holdout cases from bench/offline-cases.ts
 *   --set holdout   the 9 cases held out before any model was run (frozen at Phase 7)
 *   --set quality   the 84 new Phase 8 cases from bench/quality-cases.ts (answerability-aware scoring)
 *   --set all63     all 63 offline-cases.ts cases, no split
 *
 *   LLM_MODE=local LOCAL_API=ollama LOCAL_AGENT_MODEL=<model> EMBED_PROVIDER=local \
 *     LOCAL_EMBED_MODEL=bge-m3 RRF_VEC_WEIGHT=0.5 LOCAL_MIN_SCORE=0.005 LOCAL_PASSAGES=5 \
 *     npx tsx bench/model-bakeoff.ts --set visible --out <path>
 */

import { writeFileSync } from "node:fs";
import { storage } from "../server/storage";
import { runAgent } from "../server/agent";
import { percentile } from "../server/ireval";
import { ANSWER, ESCALATE } from "./offline-cases";
import { QUALITY_CASES, type QCase } from "./quality-cases";

// Frozen once at Phase 7, before qwen3.5:4b or qwen2.5:3b were ever run. Never recomputed.
const HOLDOUT_IDS = new Set([
  "breakfast-hours-vi", "checkin-time-en", "child-doc", "zipline", "occupancy-room",
  "breakfast-ko", "esc-folio", "esc-cancel-fee-ko", "esc-book-table",
]);

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");
function factsPresent(text: string, expect: string[][] | undefined): { ok: boolean; missing: string[] } {
  if (!expect?.length) return { ok: true, missing: [] };
  const t = norm(text);
  const missing = expect.filter((g) => !g.some((alt) => t.includes(norm(alt)))).map((g) => g[0]);
  return { ok: missing.length === 0, missing };
}

function scriptOf(text: string): string {
  if (/[가-힯]/.test(text)) return "ko";
  if (/[぀-ヿ]/.test(text)) return "ja";
  if (/[一-鿿]/.test(text)) return "zh";
  if (/[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụỳýỷỹỵ]/i.test(text)) return "vi";
  if (/[а-яА-ЯёЁ]/.test(text)) return "ru";
  return "en";
}
function foreignProfile(caseLang: string): string {
  return caseLang === "en" ? "vi" : "en";
}

async function createTurn(id: string, lang: string, q: string) {
  const hotel = storage.getHotel();
  const guest = storage.createGuest({
    name: "Bakeoff Test", phone: `bakeoff-${id}-${Date.now()}`, email: null,
    lang: foreignProfile(lang), vipTier: "none", preferences: "[]", notes: null, staysCount: 1,
  });
  const now = new Date().toISOString();
  const conv = storage.createConversation({
    hotelId: hotel.id, guestId: guest.id, reservationId: null, channel: "webchat",
    mode: "ai", sentiment: "neutral", topic: `bakeoff:${id}`, assignedStaffId: null,
    unreadForStaff: 0, lastMessageAt: now, createdAt: now, firstResponseSeconds: null,
  });
  storage.addMessage({ conversationId: conv.id, role: "guest", authorName: null, body: q, toolTrace: null, latencyMs: null, createdAt: now });
  return conv.id;
}

async function runLegacyCase(c: { id: string; lang: string; lane: "answer" | "escalate"; q: string; expect?: string[][] }) {
  const convId = await createTurn(c.id, c.lang, c.q);
  const t0 = Date.now();
  const r = await runAgent(convId);
  const ms = Date.now() - t0;
  const reply = r.reply ?? "";
  const replyScript = reply ? scriptOf(reply) : "-";
  const wrongLanguage = !!reply && replyScript !== c.lang;
  const ungrounded = (r.numericGuard?.ungrounded ?? []).map((x: any) => x.raw);
  const facts = factsPresent(reply, c.expect);

  let correct: boolean;
  let verdict: string;
  if (c.lane === "escalate") {
    correct = r.escalated;
    verdict = r.escalated ? "escalated (correct)" : "ANSWERED A MONEY/WRITE QUESTION";
  } else if (r.escalated || !reply) {
    correct = false;
    verdict = "gave up (escalated or empty)";
  } else {
    correct = facts.ok && ungrounded.length === 0 && !wrongLanguage;
    verdict = !facts.ok ? "missing: " + facts.missing.join(", ") : ungrounded.length ? "ungrounded: " + ungrounded.join(", ") : wrongLanguage ? `wrong language: asked ${c.lang}, replied ${replyScript}` : "correct";
  }
  return { id: c.id, lang: c.lang, lane: c.lane, q: c.q, reply, escalated: r.escalated, correct, verdict, ms };
}

async function runQualityCase(c: QCase) {
  const convId = await createTurn(c.id, c.lang, c.q);
  const t0 = Date.now();
  const r = await runAgent(convId);
  const ms = Date.now() - t0;
  const reply = r.reply ?? "";
  const t = norm(reply);
  const ungrounded = (r.numericGuard?.ungrounded ?? []).map((x: any) => x.raw);

  let correct: boolean;
  let verdict: string;
  const facts = factsPresent(reply, c.expect);
  const assertedForbidden = (c.mustNotAssert ?? []).filter((v) => t.includes(norm(v)));

  switch (c.answerability) {
    case "ANSWERABLE_FROM_KB":
    case "ANSWERABLE_FROM_TOOL":
    case "ANSWERABLE_WITH_CALCULATION":
      if (r.escalated || !reply) { correct = false; verdict = "FALSE ABSTENTION (should have answered)"; }
      else { correct = facts.ok && ungrounded.length === 0; verdict = facts.ok ? (ungrounded.length ? "ungrounded: " + ungrounded.join(",") : "correct") : "missing: " + facts.missing.join(", "); }
      break;
    case "PARTIALLY_ANSWERABLE":
      if (r.escalated || !reply) { correct = false; verdict = "FALSE ABSTENTION on partially-answerable case"; }
      else { correct = facts.ok && assertedForbidden.length === 0; verdict = assertedForbidden.length ? "FABRICATED: " + assertedForbidden.join(",") : facts.ok ? "correct (supported part given)" : "missing supported part: " + facts.missing.join(","); }
      break;
    case "INSUFFICIENT_EVIDENCE":
      correct = assertedForbidden.length === 0;
      verdict = assertedForbidden.length ? "FABRICATED: " + assertedForbidden.join(",") : (r.escalated || !reply ? "correctly deferred" : "correctly declined to invent a number");
      break;
    case "OUT_OF_SCOPE":
      correct = r.escalated || !reply || /không (thể|có thông tin)|cannot help|outside|ngoài phạm vi|xin lỗi/i.test(reply);
      verdict = correct ? "correctly declined out-of-scope" : "ANSWERED OUT OF SCOPE: " + reply.slice(0, 80);
      break;
    case "AMBIGUOUS":
      correct = r.escalated || reply.includes("?") || /which|nào|cái nào|ý bạn|clarify/i.test(reply);
      verdict = correct ? "asked for clarification" : "GUESSED without clarifying: " + reply.slice(0, 80);
      break;
    default:
      correct = false;
      verdict = "unknown answerability";
  }
  return { id: c.id, lang: c.lang, category: c.category, answerability: c.answerability, q: c.q, reply, escalated: r.escalated, correct, verdict, ms };
}

async function main() {
  const set = process.argv[process.argv.indexOf("--set") + 1] ?? "visible";
  const model = process.env.LOCAL_AGENT_MODEL ?? "unknown";
  let rows: any[];

  if (set === "quality") {
    rows = [];
    for (const [i, c] of QUALITY_CASES.entries()) {
      process.stderr.write(`\r  ${i + 1}/${QUALITY_CASES.length}  ${c.id.padEnd(30)}`);
      rows.push(await runQualityCase(c));
    }
  } else {
    const all = [...ANSWER, ...ESCALATE];
    const pool = set === "holdout" ? all.filter((c) => HOLDOUT_IDS.has(c.id)) : set === "all63" ? all : all.filter((c) => !HOLDOUT_IDS.has(c.id));
    rows = [];
    for (const [i, c] of pool.entries()) {
      process.stderr.write(`\r  ${i + 1}/${pool.length}  ${c.id.padEnd(26)}`);
      rows.push(await runLegacyCase(c));
    }
  }
  process.stderr.write("\r" + " ".repeat(60) + "\r");

  console.log(`model=${model} set=${set} n=${rows.length}`);
  const correct = rows.filter((r) => r.correct).length;
  console.log(`${model} [${set}]: ${correct}/${rows.length} correct (${((correct / rows.length) * 100).toFixed(1)}%)`);
  const lat = rows.map((r) => r.ms);
  console.log(`latency p50=${percentile(lat, 50)}ms p95=${percentile(lat, 95)}ms`);

  const oi = process.argv.indexOf("--out");
  if (oi >= 0) {
    writeFileSync(process.argv[oi + 1], JSON.stringify({ model, set, ranAt: new Date().toISOString(), rows }, null, 2));
    console.log(`written to ${process.argv[oi + 1]}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
