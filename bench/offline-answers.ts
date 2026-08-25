import "dotenv/config";

/**
 * Offline ANSWER-QUALITY benchmark — does the small model actually answer, and
 * is it right?
 *
 * The existing benchmarks measure the two things that surround the model:
 * `bench/offline-eval.ts` scores routing and retrieval (no model at all), and
 * `bench.ts` scores ten hand-built traps against the HOSTED agent's contract.
 * Neither answers the only question that decides whether a self-hosted model is
 * worth shipping: on the questions it is allowed to take, does it answer, and is
 * the answer true?
 *
 * That gap flattered an earlier report. Of ten gold cases the model wrote real
 * content on two; the rest were handoff templates, and two of those templates
 * scored as PASSES because their cases carried an empty assertion list. A
 * benchmark that cannot fail cannot measure anything.
 *
 * So this run separates two lanes and refuses to average them:
 *
 *   ANSWER lane — ordinary questions whose answer is in the corpus. Escalating
 *   here is a FAILURE, however polite the sentence. This is the number that says
 *   whether the offline deployment is useful.
 *
 *   ESCALATE lane — money, arithmetic and writes. Answering here is a failure.
 *   This is the number that says whether it is safe.
 *
 * Every expected fact below was read out of this property's own corpus — nothing
 * here is invented for the test, and a case whose fact is absent from the corpus
 * would be measuring the benchmark rather than the model.
 *
 *   DB_FILE=data.db LLM_MODE=local LOCAL_API=ollama LOCAL_AGENT_MODEL=qwen3.5:4b \
 *     npx tsx bench/offline-answers.ts [--out bench/offline-answers.json]
 */

import { writeFileSync } from "node:fs";
import { runLocalTurn, type LocalTurn, type ReplyLang } from "../server/local-agent";
import { storage } from "../server/storage";
import { percentile } from "../server/ireval";

import { ANSWER, ESCALATE, type Case, type Lane } from "./offline-cases";

/* --------------------------------------------------------------- assertions */

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");

function factsPresent(reply: string, expect: string[][]): boolean {
  const r = norm(reply);
  return expect.every((group) => group.some((alt) => r.includes(norm(alt))));
}

/**
 * Which script the text is written in. Catches the failure a guest notices
 * first: being answered in a language they did not write in.
 */
function script(text: string): string {
  if (/[가-힯]/.test(text)) return "ko";
  if (/[぀-ヿ]/.test(text)) return "ja";
  if (/[一-鿿]/.test(text)) return "zh";
  if (/[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụỳýỷỹỵ]/i.test(text)) return "vi";
  return "en";
}

/**
 * Numbers in the reply that appear in neither the passages nor the injected
 * property basics. Digit grouping is stripped on both sides so 650.000 and
 * 650,000 compare equal; one- and two-digit numbers are ignored, since they are
 * almost always list positions or small counts restated from prose.
 */
function fabricatedNumbers(reply: string, turn: LocalTurn, basics: string): string[] {
  const flat = (s: string) => s.replace(/[.,\s]/g, "");
  const evidence = flat(turn.passages.map((p) => p.content).join(" ") + " " + basics);
  const out: string[] = [];
  for (const m of reply.matchAll(/\d[\d.,:]*\d|\d/g)) {
    const f = flat(m[0]);
    if (f.length <= 2) continue;
    if (!evidence.includes(f)) out.push(m[0]);
  }
  return [...new Set(out)];
}

/* --------------------------------------------------------------------- run */

type Row = {
  id: string; lang: string; lane: Lane; q: string;
  route: string; escalated: boolean; llmCalls: number; ms: number;
  reply: string; correct: boolean; verdict: string;
  replyLang: string; langOk: boolean; fabricated: string[];
  retrievalMs?: number;
  loadMs?: number; promptEvalMs?: number; evalMs?: number; evalTokens?: number;
};

async function main() {
  const hotel = storage.getHotel();
  const basics = { checkIn: hotel.checkInTime, checkOut: hotel.checkOutTime, currency: hotel.currency };
  const basicsText = `${basics.checkIn} ${basics.checkOut} ${basics.currency}`;
  const rows: Row[] = [];
  const all = [...ANSWER, ...ESCALATE];

  for (const [i, c] of all.entries()) {
    process.stderr.write(`\r  ${i + 1}/${all.length}  ${c.id.padEnd(24)}`);
    const t0 = Date.now();
    let turn: LocalTurn;
    try {
      turn = await runLocalTurn({
        question: c.q,
        isEmergency: false,
        /* The guest's own language, not a two-way vi/en collapse. Passing "vi"
           for every non-English case is what made Korean and Chinese questions
           come back in Vietnamese — a harness bug that hid a product bug. */
        lang: c.lang as ReplyLang,
        basics,
      });
    } catch (e) {
      rows.push({
        id: c.id, lang: c.lang, lane: c.lane, q: c.q, route: "ERROR", escalated: true,
        llmCalls: 0, ms: Date.now() - t0, reply: String(e), correct: false,
        verdict: "error", replyLang: "-", langOk: false, fabricated: [],
      });
      continue;
    }
    const ms = Date.now() - t0;
    const reply = turn.reply ?? "";

    let correct: boolean;
    let verdict: string;
    if (c.lane === "escalate") {
      correct = turn.escalate;
      verdict = turn.escalate ? "escalated (correct)" : "ANSWERED A MONEY/WRITE QUESTION";
    } else if (turn.escalate) {
      correct = false;
      verdict = `gave up: ${turn.escalateReason ?? "?"}`;
    } else if (factsPresent(reply, c.expect ?? [])) {
      correct = true;
      verdict = "answered, fact correct";
    } else {
      correct = false;
      verdict = "answered but the expected fact is missing";
    }

    const replyLang = reply ? script(reply) : "-";
    rows.push({
      id: c.id, lang: c.lang, lane: c.lane, q: c.q, route: turn.route,
      escalated: turn.escalate, llmCalls: turn.llmCalls, ms, reply,
      correct, verdict, replyLang, langOk: !reply || replyLang === c.lang,
      fabricated: reply ? fabricatedNumbers(reply, turn, basicsText) : [],
      retrievalMs: turn.retrievalMs,
      loadMs: turn.timing?.loadMs, promptEvalMs: turn.timing?.promptEvalMs,
      evalMs: turn.timing?.evalMs, evalTokens: turn.timing?.evalTokens,
    });
  }
  process.stderr.write("\r" + " ".repeat(50) + "\r");

  /* ------------------------------------------------------------- report */
  const A = rows.filter((r) => r.lane === "answer");
  const E = rows.filter((r) => r.lane === "escalate");
  const answered = A.filter((r) => !r.escalated);
  const useful = A.filter((r) => r.correct);
  const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : "—");

  console.log(`\n${"=".repeat(74)}`);
  console.log(`OFFLINE ANSWER QUALITY — ${rows.length} cases (${A.length} answerable · ${E.length} must-escalate)`);
  console.log(`model ${process.env.LOCAL_AGENT_MODEL ?? "?"} via ${process.env.LOCAL_API ?? "openai"}`);
  console.log("=".repeat(74));

  console.log(`\nANSWER LANE — escalating here is a failure`);
  console.log(`  answered by the model       ${answered.length}/${A.length}  ${pct(answered.length, A.length)}`);
  console.log(`  answered AND correct        ${useful.length}/${A.length}  ${pct(useful.length, A.length)}   <-- usefulness`);
  console.log(`  correct, of those answered  ${answered.filter((r) => r.correct).length}/${answered.length}  ${pct(answered.filter((r) => r.correct).length, answered.length)}`);
  console.log(`  gave up (escalated)         ${A.length - answered.length}`);

  console.log(`\nESCALATE LANE — answering here is a failure`);
  console.log(`  correctly escalated         ${E.filter((r) => r.correct).length}/${E.length}  ${pct(E.filter((r) => r.correct).length, E.length)}   <-- safety`);
  for (const l of E.filter((r) => !r.correct)) console.error(`    LEAK  ${l.id}: ${l.reply.slice(0, 120)}`);

  const fab = rows.filter((r) => r.fabricated.length);
  console.log(`\nFABRICATED NUMBERS (present in the reply, in no passage): ${fab.length}`);
  for (const f of fab) console.log(`    ${f.id.padEnd(24)} ${f.fabricated.join(", ")}`);

  const withReply = rows.filter((r) => r.reply);
  console.log(`\nREPLY LANGUAGE MATCHES THE QUESTION: ${withReply.filter((r) => r.langOk).length}/${withReply.length}`);
  for (const l of withReply.filter((r) => !r.langOk)) console.log(`    ${l.id.padEnd(24)} asked ${l.lang} -> replied ${l.replyLang}`);

  const modelLat = rows.filter((r) => r.llmCalls > 0).map((r) => r.ms);
  const detLat = rows.filter((r) => r.llmCalls === 0).map((r) => r.ms);
  console.log(`\nLATENCY`);
  if (modelLat.length) console.log(`  with a model call (${modelLat.length})  p50 ${percentile(modelLat, 50)}ms · p95 ${percentile(modelLat, 95)}ms · max ${Math.max(...modelLat)}ms`);
  if (detLat.length) console.log(`  no inference      (${detLat.length})  p50 ${percentile(detLat, 50)}ms · p95 ${percentile(detLat, 95)}ms`);

  /* Stage breakdown from Ollama's own reported durations — a true TTFT proxy
     (prompt_eval finishes before the first token can be emitted, streamed or
     not) without needing a separate streaming code path. */
  const withTiming = rows.filter((r) => r.evalMs != null);
  if (withTiming.length) {
    const retr = rows.map((r) => r.retrievalMs ?? 0).filter((x) => x > 0);
    const load = withTiming.map((r) => r.loadMs!);
    const ttft = withTiming.map((r) => r.promptEvalMs!);
    const gen = withTiming.map((r) => r.evalMs!);
    const toks = withTiming.reduce((a, r) => a + (r.evalTokens ?? 0), 0);
    const genSec = gen.reduce((a, b) => a + b, 0) / 1000;
    console.log(`\nSTAGE BREAKDOWN (n=${withTiming.length}, Ollama-reported)`);
    if (retr.length) console.log(`  retrieval        p50 ${percentile(retr, 50)}ms · p95 ${percentile(retr, 95)}ms`);
    console.log(`  model load       p50 ${percentile(load, 50)}ms · p95 ${percentile(load, 95)}ms · max ${Math.max(...load)}ms  (0 when already warm)`);
    console.log(`  TTFT (prompt eval) p50 ${percentile(ttft, 50)}ms · p95 ${percentile(ttft, 95)}ms`);
    console.log(`  generation       p50 ${percentile(gen, 50)}ms · p95 ${percentile(gen, 95)}ms`);
    console.log(`  throughput       ${(toks / (genSec || 1)).toFixed(1)} tok/s average (${toks} tokens / ${genSec.toFixed(1)}s)`);
  }

  console.log(`\nANSWER-LANE FAILURES (${A.length - useful.length})`);
  for (const r of A.filter((x) => !x.correct)) {
    console.log(`  ${r.id.padEnd(24)} ${r.verdict}`);
    console.log(`      Q: ${r.q}`);
    if (r.reply) console.log(`      A: ${r.reply.replace(/\s+/g, " ").slice(0, 160)}`);
  }

  const oi = process.argv.indexOf("--out");
  if (oi >= 0) {
    writeFileSync(
      process.argv[oi + 1],
      JSON.stringify(
        {
          ranAt: new Date().toISOString(),
          model: process.env.LOCAL_AGENT_MODEL ?? null,
          summary: {
            answerLaneCases: A.length,
            answerRate: +(answered.length / A.length).toFixed(3),
            usefulness: +(useful.length / A.length).toFixed(3),
            precisionWhenAnswering: answered.length ? +(answered.filter((r) => r.correct).length / answered.length).toFixed(3) : null,
            escalateLaneCases: E.length,
            safety: +(E.filter((r) => r.correct).length / E.length).toFixed(3),
            fabricatedNumberCases: fab.length,
            languageMismatches: withReply.filter((r) => !r.langOk).length,
            modelLatencyP50: percentile(modelLat, 50),
            modelLatencyP95: percentile(modelLat, 95),
            stage: withTiming.length
              ? {
                  loadMsP50: percentile(withTiming.map((r) => r.loadMs!), 50),
                  loadMsP95: percentile(withTiming.map((r) => r.loadMs!), 95),
                  ttftMsP50: percentile(withTiming.map((r) => r.promptEvalMs!), 50),
                  ttftMsP95: percentile(withTiming.map((r) => r.promptEvalMs!), 95),
                  genMsP50: percentile(withTiming.map((r) => r.evalMs!), 50),
                  genMsP95: percentile(withTiming.map((r) => r.evalMs!), 95),
                  toksPerSecAvg:
                    +(
                      withTiming.reduce((a, r) => a + (r.evalTokens ?? 0), 0) /
                      (withTiming.reduce((a, r) => a + (r.evalMs ?? 0), 0) / 1000 || 1)
                    ).toFixed(1),
                }
              : null,
          },
          rows,
        },
        null,
        2,
      ),
    );
    console.log(`\nwritten to ${process.argv[oi + 1]}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
