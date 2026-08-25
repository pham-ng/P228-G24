import "dotenv/config";

/**
 * Part 5 (kiosk validation): full pipeline trace for every one of the 63
 * offline cases — not just pass/fail, every intermediate decision.
 *
 * Diagnostic only. Nothing here changes production behaviour; it calls the
 * same exported pipeline pieces (classifyLocal, hybridSearch, gateRetrieval,
 * answerFromPassages) that runLocalTurn itself composes, so the trace is the
 * real decision path, not a re-implementation of it.
 *
 *   DB_FILE=data.db LLM_MODE=local LOCAL_API=ollama LOCAL_AGENT_MODEL=qwen3.5:4b \
 *     npx tsx bench/root-cause-trace.ts --out bench/baselines/kiosk-validation/03-root-cause-trace.json
 */

import { writeFileSync } from "node:fs";
import { hybridSearch } from "../server/retrieval";
import {
  classifyLocal,
  gateRetrieval,
  answerFromPassages,
  isAbstention,
  LOCAL_MIN_SCORE,
  LOCAL_PASSAGES,
  MIN_COVERAGE,
  type ReplyLang,
} from "../server/local-agent";
import { extractClaims, buildGrounding } from "../server/numguard";
import { storage } from "../server/storage";
import { ANSWER, ESCALATE } from "./offline-cases";

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");
function factsPresent(text: string, expect: string[][] | undefined): { ok: boolean; missing: string[] } {
  if (!expect?.length) return { ok: true, missing: [] };
  const t = norm(text);
  const missing = expect.filter((g) => !g.some((alt) => t.includes(norm(alt)))).map((g) => g[0]);
  return { ok: missing.length === 0, missing };
}

type TraceRow = {
  id: string;
  lang: string;
  lane: "answer" | "escalate";
  q: string;
  route: string;
  retrieval: { title: string; score: number; matchedBy: string; quality: string; coverage: number | null }[];
  goldFactInTopK: boolean | null; // null when no expect[] to check
  gate: { ok: boolean; reason?: string; topScore: number; usedSemantic: boolean; bestCoverage: number };
  gateWouldPassOnScoreAlone: boolean;
  gateWouldPassOnCoverageAlone: boolean;
  llmCalled: boolean;
  rawReply: string;
  abstained: boolean;
  factsCheck: { ok: boolean; missing: string[] };
  ungroundedNumbers: string[];
  finalEscalated: boolean;
  finalCorrect: boolean;
  ms: number;
};

async function traceOne(c: { id: string; lang: string; lane: "answer" | "escalate"; q: string; expect?: string[][] }, basics: any): Promise<TraceRow> {
  const t0 = Date.now();
  const route = classifyLocal(c.q, false);

  if (route !== "knowledge") {
    return {
      id: c.id, lang: c.lang, lane: c.lane, q: c.q, route,
      retrieval: [], goldFactInTopK: null,
      gate: { ok: false, reason: "routed_away", topScore: 0, usedSemantic: false, bestCoverage: -1 },
      gateWouldPassOnScoreAlone: false, gateWouldPassOnCoverageAlone: false,
      llmCalled: false, rawReply: "", abstained: false,
      factsCheck: { ok: true, missing: [] }, ungroundedNumbers: [],
      finalEscalated: true,
      finalCorrect: c.lane === "escalate", // routed-away IS correct for escalate-lane cases
      ms: Date.now() - t0,
    };
  }

  const found = await hybridSearch(c.q, { k: LOCAL_PASSAGES });
  const retrieval = found.results.map((r) => ({
    title: r.title, score: r.relevance, matchedBy: r.matched_by, quality: r.quality,
    coverage: r.coverage ?? null,
  }));
  const goldFactInTopK = c.expect ? factsPresent(found.results.map((r) => r.content).join(" "), c.expect).ok : null;

  const gate = gateRetrieval(found.results, LOCAL_MIN_SCORE);
  const topScore = found.results[0]?.relevance ?? 0;
  const usedSemantic = found.results.some((r) => r.matched_by.includes("semantic"));
  const bestCoverage = Math.max(...found.results.map((r) => r.coverage ?? -1));
  const gateWouldPassOnScoreAlone = topScore >= LOCAL_MIN_SCORE;
  const gateWouldPassOnCoverageAlone = usedSemantic || bestCoverage < 0 || bestCoverage >= MIN_COVERAGE;

  if (!gate.ok) {
    return {
      id: c.id, lang: c.lang, lane: c.lane, q: c.q, route,
      retrieval, goldFactInTopK,
      gate: { ok: false, reason: gate.reason, topScore, usedSemantic, bestCoverage },
      gateWouldPassOnScoreAlone, gateWouldPassOnCoverageAlone,
      llmCalled: false, rawReply: "", abstained: false,
      factsCheck: { ok: true, missing: [] }, ungroundedNumbers: [],
      finalEscalated: true,
      finalCorrect: c.lane === "escalate",
      ms: Date.now() - t0,
    };
  }

  const answer = await answerFromPassages(c.q, gate.passages, c.lang as ReplyLang, undefined, basics);
  const reply = answer.reply ?? "";
  const abstained = answer.abstained;

  let ungroundedNumbers: string[] = [];
  if (!abstained && reply) {
    const grounding = buildGrounding({ toolResults: gate.passages.map((p) => p.content), guestText: c.q });
    const claims = extractClaims(reply);
    for (const claim of claims) {
      const pool = claim.kind === "money" ? grounding.money : claim.kind === "percent" ? grounding.percent : grounding.time;
      if (!pool.has(claim.value)) ungroundedNumbers.push(claim.raw);
    }
  }

  const factsCheck = abstained ? { ok: false, missing: c.expect?.map((g) => g[0]) ?? [] } : factsPresent(reply, c.expect);

  return {
    id: c.id, lang: c.lang, lane: c.lane, q: c.q, route,
    retrieval, goldFactInTopK,
    gate: { ok: true, topScore, usedSemantic, bestCoverage },
    gateWouldPassOnScoreAlone, gateWouldPassOnCoverageAlone,
    llmCalled: true, rawReply: reply, abstained,
    factsCheck, ungroundedNumbers,
    finalEscalated: abstained,
    finalCorrect: c.lane === "answer" ? factsCheck.ok && ungroundedNumbers.length === 0 : abstained,
    ms: Date.now() - t0,
  };
}

async function main() {
  const hotel = storage.getHotel();
  const basics = { checkIn: hotel.checkInTime, checkOut: hotel.checkOutTime, currency: hotel.currency };
  const all = [...ANSWER, ...ESCALATE];
  const rows: TraceRow[] = [];

  for (const [i, c] of all.entries()) {
    process.stderr.write(`\r  ${i + 1}/${all.length}  ${c.id.padEnd(24)}`);
    rows.push(await traceOne(c, basics));
  }
  process.stderr.write("\r" + " ".repeat(50) + "\r");

  console.log(`Tổng: ${rows.length} · đúng: ${rows.filter((r) => r.finalCorrect).length} · sai: ${rows.filter((r) => !r.finalCorrect).length}`);

  const oi = process.argv.indexOf("--out");
  if (oi >= 0) {
    writeFileSync(
      process.argv[oi + 1],
      JSON.stringify(
        {
          ranAt: new Date().toISOString(),
          config: { LOCAL_MIN_SCORE, LOCAL_PASSAGES, MIN_COVERAGE, model: process.env.LOCAL_AGENT_MODEL, embed: process.env.LOCAL_EMBED_MODEL },
          rows,
        },
        null,
        2,
      ),
    );
    console.log(`written to ${process.argv[oi + 1]}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
