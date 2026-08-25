import "dotenv/config";

/**
 * Part 5.5: the mandatory production-path regression.
 *
 * Every prior CJK measurement in this project — including Part 5's own trace
 * — called `runLocalTurn()` directly with the guest's real language, which is
 * NOT what a live guest message does. A real turn goes through `runAgent()` ->
 * `runOfflineTurn()` -> `offlineReplyLang()` -> `runLocalTurn()`. This script
 * is the first one in the project to exercise that exact chain for the 63-case
 * set, so its numbers are the first ones that can be trusted to describe what
 * a real kiosk guest receives, not what the pipeline is capable of in
 * isolation.
 *
 * The guest's PROFILE language is deliberately set to something other than
 * the message's language on every case (a guest whose profile says English
 * asking a question in Korean), because that is exactly the situation
 * `offlineReplyLang()` has to get right — the message must win over the
 * profile, and if it silently fell back to the profile instead, this would
 * catch it.
 *
 *   DB_FILE=data.db LLM_MODE=local LOCAL_API=ollama LOCAL_AGENT_MODEL=qwen3.5:4b \
 *     npx tsx bench/offline-production-path.ts --out bench/baselines/kiosk-validation/04-production-path.json
 */

import { writeFileSync } from "node:fs";
import { storage } from "../server/storage";
import { runAgent } from "../server/agent";
import { percentile } from "../server/ireval";
import { ANSWER, ESCALATE } from "./offline-cases";

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");
function factsPresent(text: string, expect: string[][] | undefined): { ok: boolean; missing: string[] } {
  if (!expect?.length) return { ok: true, missing: [] };
  const t = norm(text);
  const missing = expect.filter((g) => !g.some((alt) => t.includes(norm(alt)))).map((g) => g[0]);
  return { ok: missing.length === 0, missing };
}

/** Which script the reply is written in — the thing offlineReplyLang exists to protect. */
function scriptOf(text: string): string {
  if (/[가-힯]/.test(text)) return "ko";
  if (/[぀-ヿ]/.test(text)) return "ja";
  if (/[一-鿿]/.test(text)) return "zh";
  if (/[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụỳýỷỹỵ]/i.test(text)) return "vi";
  if (/[а-яА-ЯёЁ]/.test(text)) return "ru";
  return "en";
}

/** A profile language that deliberately does NOT match the case's real language. */
function foreignProfile(caseLang: string): string {
  return caseLang === "en" ? "vi" : "en";
}

type Row = {
  id: string; lang: string; lane: "answer" | "escalate"; q: string;
  reply: string; replyScript: string; wrongLanguage: boolean;
  escalated: boolean; correct: boolean; verdict: string;
  ungrounded: string[]; ms: number;
};

async function runOne(c: { id: string; lang: string; lane: "answer" | "escalate"; q: string; expect?: string[][] }): Promise<Row> {
  const hotel = storage.getHotel();
  const guest = storage.createGuest({
    name: "Kiosk Test", phone: `prodpath-${c.id}-${Date.now()}`, email: null,
    lang: foreignProfile(c.lang), vipTier: "none", preferences: "[]", notes: null, staysCount: 1,
  });
  const now = new Date().toISOString();
  const conv = storage.createConversation({
    hotelId: hotel.id, guestId: guest.id, reservationId: null, channel: "webchat",
    mode: "ai", sentiment: "neutral", topic: `prodpath:${c.id}`, assignedStaffId: null,
    unreadForStaff: 0, lastMessageAt: now, createdAt: now, firstResponseSeconds: null,
  });
  storage.addMessage({
    conversationId: conv.id, role: "guest", authorName: null, body: c.q,
    toolTrace: null, latencyMs: null, createdAt: now,
  });

  const t0 = Date.now();
  const r = await runAgent(conv.id);
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
    verdict = !facts.ok ? "missing: " + facts.missing.join(", ")
      : ungrounded.length ? "ungrounded: " + ungrounded.join(", ")
      : wrongLanguage ? `wrong language: asked ${c.lang}, replied ${replyScript}`
      : "correct";
  }

  return { id: c.id, lang: c.lang, lane: c.lane, q: c.q, reply, replyScript, wrongLanguage, escalated: r.escalated, correct, verdict, ungrounded, ms };
}

async function main() {
  const all = [...ANSWER, ...ESCALATE];
  const rows: Row[] = [];
  for (const [i, c] of all.entries()) {
    process.stderr.write(`\r  ${i + 1}/${all.length}  ${c.id.padEnd(24)}`);
    rows.push(await runOne(c));
  }
  process.stderr.write("\r" + " ".repeat(50) + "\r");

  const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : "—");
  console.log(`\n${"=".repeat(74)}\nPRODUCTION-PATH REGRESSION — runAgent() end to end, 63 cases\n${"=".repeat(74)}`);

  console.log(`\nOVERALL`);
  console.log(`  correct           ${rows.filter((r) => r.correct).length}/${rows.length}  ${pct(rows.filter((r) => r.correct).length, rows.length)}`);
  console.log(`  wrong-language    ${rows.filter((r) => r.wrongLanguage).length}`);
  console.log(`  numeric fabrication  ${rows.filter((r) => r.ungrounded.length).length}`);

  console.log(`\nBY LANGUAGE`);
  for (const L of ["vi", "en", "zh", "ja", "ko"]) {
    const pool = rows.filter((r) => r.lang === L);
    if (!pool.length) continue;
    const answerPool = pool.filter((r) => r.lane === "answer");
    console.log(
      `  ${L}  n=${pool.length}  correct=${pool.filter((r) => r.correct).length}  ` +
        `answered=${answerPool.filter((r) => !r.escalated).length}/${answerPool.length}  ` +
        `abstained=${answerPool.filter((r) => r.escalated).length}  ` +
        `wrong-language=${pool.filter((r) => r.wrongLanguage).length}`,
    );
  }

  const lat = rows.map((r) => r.ms);
  console.log(`\nLATENCY  p50 ${percentile(lat, 50)}ms · p95 ${percentile(lat, 95)}ms`);

  console.log(`\nFAILURES (${rows.filter((r) => !r.correct).length})`);
  for (const r of rows.filter((x) => !x.correct)) {
    console.log(`  ${r.id.padEnd(24)} [${r.lang}]  ${r.verdict}`);
    console.log(`     Q: ${r.q}`);
    if (r.reply) console.log(`     A: ${r.reply.replace(/\s+/g, " ").slice(0, 150)}`);
  }

  const oi = process.argv.indexOf("--out");
  if (oi >= 0) {
    writeFileSync(process.argv[oi + 1], JSON.stringify({ ranAt: new Date().toISOString(), rows }, null, 2));
    console.log(`\nwritten to ${process.argv[oi + 1]}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
