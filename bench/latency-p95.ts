/**
 * Latency distribution of the offline path, against the release evaluation set.
 *
 * Answers one question: does this deployment meet a p95 target, and if not,
 * where does the time go. Reports the split that matters — a turn that
 * escalates deterministically costs ZERO inference and finishes in
 * milliseconds, so a headline percentile over all turns hides whether the
 * model is fast or merely often skipped.
 *
 * Usage:  npx tsx bench/latency-p95.ts [sampleSize] [targetMs]
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runLocalTurn, type ReplyLang } from "../server/local-agent";
import { storage } from "../server/storage";

const SAMPLE = Number(process.argv[2] || 120);
const TARGET_MS = Number(process.argv[3] || 4000);

const CASES_PATH = join(process.cwd(), "bench/baselines/kiosk-validation/FINAL-LOCAL-EVAL-CASES.json");
const data = JSON.parse(readFileSync(CASES_PATH, "utf8")) as {
  atomic: Array<{ case_id: string; category: string; language: string; user_query: string }>;
};

/* Stratified by language and category so the sample keeps the real mix —
   the escalating categories are the fast ones, and over-sampling them would
   flatter the percentiles. */
function stratify<T>(items: T[], key: (t: T) => string, n: number): T[] {
  const buckets = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(it);
  }
  const out: T[] = [];
  let i = 0;
  while (out.length < n) {
    let added = false;
    for (const list of buckets.values()) {
      if (i < list.length) {
        out.push(list[i]);
        added = true;
        if (out.length >= n) break;
      }
    }
    if (!added) break;
    i++;
  }
  return out;
}

const sample = stratify(data.atomic, (c) => `${c.language}|${c.category}`, Math.min(SAMPLE, data.atomic.length));

const hotel = storage.getHotel();
const basics = { checkIn: hotel.checkInTime, checkOut: hotel.checkOutTime, currency: hotel.currency };

type Row = {
  ms: number;
  llmCalls: number;
  promptTok?: number;
  promptMs?: number;
  genTok?: number;
  genMs?: number;
};
const rows: Row[] = [];

console.log(`Running ${sample.length} of ${data.atomic.length} atomic cases (target p95 ≤ ${TARGET_MS}ms)\n`);

let done = 0;
for (const c of sample) {
  const t0 = Date.now();
  let turn;
  try {
    turn = await runLocalTurn({
      question: c.user_query,
      isEmergency: false,
      lang: (c.language as ReplyLang) ?? "vi",
      basics,
    });
  } catch {
    continue;
  }
  rows.push({
    ms: Date.now() - t0,
    llmCalls: turn.llmCalls,
    promptTok: turn.timing?.promptEvalTokens,
    promptMs: turn.timing?.promptEvalMs,
    genTok: turn.timing?.evalTokens,
    genMs: turn.timing?.evalMs,
  });
  if (++done % 20 === 0) console.log(`  ...${done}/${sample.length}`);
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const fmt = (n: number) => `${(n / 1000).toFixed(2)}s`;

const all = rows.map((r) => r.ms);
const inferred = rows.filter((r) => r.llmCalls > 0).map((r) => r.ms);
const skipped = rows.filter((r) => r.llmCalls === 0).map((r) => r.ms);

console.log(`\n===== LATENCY (n=${rows.length}) =====`);
for (const [label, xs] of [
  ["ALL turns          ", all],
  ["model ran          ", inferred],
  ["escalated, no model", skipped],
] as [string, number[]][]) {
  if (!xs.length) continue;
  console.log(
    `${label} n=${String(xs.length).padStart(3)}  p50=${fmt(pct(xs, 50))}  p90=${fmt(pct(xs, 90))}  ` +
      `p95=${fmt(pct(xs, 95))}  p99=${fmt(pct(xs, 99))}  max=${fmt(Math.max(...xs))}`,
  );
}

const withT = rows.filter((r) => r.promptMs && r.genMs);
if (withT.length) {
  const sum = (f: (r: Row) => number) => withT.reduce((a, r) => a + f(r), 0);
  const promptTps = sum((r) => r.promptTok!) / (sum((r) => r.promptMs!) / 1000);
  const genTps = sum((r) => r.genTok!) / (sum((r) => r.genMs!) / 1000);
  console.log(`\n===== THROUGHPUT (n=${withT.length} inference turns) =====`);
  console.log(`  prompt eval : ${promptTps.toFixed(1)} tok/s   (median ${Math.round(pct(withT.map((r) => r.promptTok!), 50))} tok in ${fmt(pct(withT.map((r) => r.promptMs!), 50))})`);
  console.log(`  generation  : ${genTps.toFixed(1)} tok/s   (median ${Math.round(pct(withT.map((r) => r.genTok!), 50))} tok in ${fmt(pct(withT.map((r) => r.genMs!), 50))})`);

  /* What the budget would have to look like to land under the target. */
  const medPromptTok = pct(withT.map((r) => r.promptTok!), 50);
  const medGenTok = pct(withT.map((r) => r.genTok!), 50);
  const needed = (medPromptTok / promptTps + medGenTok / genTps) * 1000;
  console.log(`\n  A median turn (${medPromptTok} prompt + ${medGenTok} generated tok) costs ${fmt(needed)} at these speeds.`);
  console.log(`  To fit ${fmt(TARGET_MS)} at the SAME token counts, throughput must rise ~${(needed / TARGET_MS).toFixed(1)}x.`);
}

const over = all.filter((x) => x > TARGET_MS).length;
console.log(`\n===== VERDICT =====`);
console.log(`  ${over}/${all.length} turns (${Math.round((100 * over) / all.length)}%) exceeded ${fmt(TARGET_MS)}.`);
console.log(`  p95 = ${fmt(pct(all, 95))} vs target ${fmt(TARGET_MS)} -> ${pct(all, 95) <= TARGET_MS ? "MET" : "NOT MET"}`);
process.exit(0);
