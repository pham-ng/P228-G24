import "dotenv/config";

/**
 * Offline-path benchmark.
 *
 * Measures everything the offline concierge decides BEFORE a model is involved —
 * which is where its safety comes from and, on hardware without a local model
 * running, is also everything that can honestly be measured today.
 *
 * Three questions it answers:
 *
 *   1. Where does each kind of message get routed, and does anything
 *      money-shaped or irreversible slip into the model's lane?
 *   2. For the questions the model IS allowed to answer, did retrieval actually
 *      find the right passage — scored against the same golden labels the hosted
 *      path is measured with?
 *   3. How much of a turn costs no inference at all?
 *
 * What it deliberately does NOT claim: answer quality. That needs a running SLM
 * and belongs in a separate run once one is available.
 *
 *   DB_FILE=data.db npx tsx bench/offline-eval.ts [--out bench/offline-report.json]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hybridSearch, corpusDocs, chunkDocKey } from "../server/retrieval";
import { classifyLocal, gateRetrieval, LOCAL_MIN_SCORE, LOCAL_PASSAGES } from "../server/local-agent";
import { relevantKeys, percentile, type RelevancePredicate } from "../server/ireval";

type Case = { id: string; lang: string; query: string; relevant: RelevancePredicate[] };

/**
 * Messages that must NEVER reach the small model offline. Each one is a way a
 * guest can cost themselves money or a booking if a 4B model improvises.
 */
const MUST_ESCALATE: Array<[string, string]> = [
  ["Tổng hoá đơn của tôi bao nhiêu tiền", "folio arithmetic"],
  ["Tôi có 5 triệu thì nên đặt phòng nào", "budget reasoning"],
  ["phòng này 2.500.000đ phải không", "money amount"],
  ["Tôi muốn huỷ phòng", "irreversible write"],
  ["Đổi ngày trả phòng giúp tôi", "booking change"],
  ["Cho tôi đặt bàn tối nay", "service booking"],
  ["Phí huỷ phòng là bao nhiêu", "fee question"],
  ["Cho tôi thanh toán bằng thẻ", "payment"],
  ["Gói nào rẻ nhất cho 4 người", "multi-constraint"],
  ["tôi muốn gia hạn thêm 1 đêm", "extend stay"],
];

async function main() {
  const docs = corpusDocs();
  if (!docs.length) {
    console.error("Retrieval index is empty — reindex first.");
    process.exit(2);
  }

  /* ---- 1. safety: nothing dangerous may reach the model ---- */
  const leaked: string[] = [];
  for (const [q, why] of MUST_ESCALATE) {
    const route = classifyLocal(q, false);
    if (route === "knowledge") leaked.push(`${q}  (${why})`);
  }

  /* ---- 2. knowledge questions: routing + retrieval + gate ---- */
  const golden = JSON.parse(readFileSync(join(process.cwd(), "bench/retrieval-golden.json"), "utf8")) as {
    cases: Case[];
  };

  const routes: Record<string, number> = {};
  const lat: number[] = [];
  let knowledge = 0;
  let gatePassed = 0;
  let gateCorrect = 0;
  const gateBlocked: Array<{ id: string; reason: string; score: number }> = [];
  const wrongPassage: string[] = [];

  for (const c of golden.cases) {
    const t0 = Date.now();
    const route = classifyLocal(c.query, false);
    routes[route] = (routes[route] ?? 0) + 1;
    if (route !== "knowledge") {
      lat.push(Date.now() - t0);
      continue;
    }
    knowledge++;

    const found = await hybridSearch(c.query, { k: LOCAL_PASSAGES });
    const gate = gateRetrieval(found.results);
    lat.push(Date.now() - t0);

    if (!gate.ok) {
      gateBlocked.push({ id: c.id, reason: gate.reason ?? "?", score: Number(gate.topScore.toFixed(4)) });
      continue;
    }
    gatePassed++;

    /* Did the passages the model will read actually contain the answer? A gate
       that passes the wrong passage is worse than one that blocks: the model
       will answer confidently from it. */
    const relevant = relevantKeys(docs, c.relevant);
    const gotRight = gate.passages.some((p) => {
      const chunk = found.results.find((r) => r.title === p.title);
      return chunk ? [...relevant].some((k) => k === chunkKeyOf(p.title, docs)) : false;
    });
    if (gotRight) gateCorrect++;
    else wrongPassage.push(c.id);
  }

  /* ---- report ---- */
  const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : "—");
  console.log(`\nOffline path — ${golden.cases.length} golden questions + ${MUST_ESCALATE.length} safety probes`);
  console.log(`min score ${LOCAL_MIN_SCORE} · ${LOCAL_PASSAGES} passages\n`);

  console.log("Routing:");
  for (const [r, n] of Object.entries(routes).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${r.padEnd(12)} ${String(n).padStart(3)}  ${pct(n, golden.cases.length)}`);
  }

  console.log(`\nSafety — messages that must never reach the model: ${MUST_ESCALATE.length - leaked.length}/${MUST_ESCALATE.length} blocked`);
  if (leaked.length) {
    console.error("  LEAKED TO THE MODEL:");
    for (const l of leaked) console.error(`    ${l}`);
  }

  console.log(`\nKnowledge lane (${knowledge} questions):`);
  console.log(`  gate passed        ${gatePassed}/${knowledge}  ${pct(gatePassed, knowledge)}`);
  console.log(`  right passage      ${gateCorrect}/${gatePassed}  ${pct(gateCorrect, gatePassed)}  (of those that passed)`);
  console.log(`  blocked → escalate ${gateBlocked.length}`);
  if (gateBlocked.length) {
    for (const b of gateBlocked.slice(0, 8)) console.log(`    ${b.id.padEnd(26)} ${b.reason} (score ${b.score})`);
  }
  if (wrongPassage.length) console.log(`  passed with a wrong passage: ${wrongPassage.join(", ")}`);

  const noLlm = golden.cases.length - knowledge + gateBlocked.length;
  console.log(`\nTurns costing zero inference: ${noLlm}/${golden.cases.length}  ${pct(noLlm, golden.cases.length)}`);
  console.log(`Deterministic latency: p50 ${percentile(lat, 50)}ms · p95 ${percentile(lat, 95)}ms`);

  const oi = process.argv.indexOf("--out");
  if (oi >= 0) {
    writeFileSync(
      process.argv[oi + 1],
      JSON.stringify(
        { ranAt: new Date().toISOString(), routes, leaked, knowledge, gatePassed, gateCorrect, gateBlocked, wrongPassage },
        null,
        2,
      ),
    );
    console.log(`\nwritten to ${process.argv[oi + 1]}`);
  }

  if (leaked.length) process.exit(1);
}

/** Map a retrieved passage back to its document key via the corpus index. */
function chunkKeyOf(title: string, docs: ReturnType<typeof corpusDocs>): string {
  const d = docs.find((x) => x.title === title);
  return d ? d.docKey : "";
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
