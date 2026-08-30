/**
 * Is the identical system prompt being re-read on every turn?
 *
 *   npx tsx bench/prefix-cache-probe.ts [pairs]
 *
 * The system instruction is byte-identical on every turn that has no history
 * and no rate block — about 300 of ~900 prompt tokens. If llama.cpp reuses the
 * cached prefix across requests, those 300 tokens are free and there is nothing
 * to win here. If it does not, a third of every turn's prompt is being
 * recomputed for no reason, and recovering it costs NO change to the prompt
 * text — which matters because every other latency idea trades accuracy.
 *
 * WHY THIS IS MEASURED IN PAIRS, ALTERNATING, AND REPORTED AS A MEDIAN.
 * A first attempt compared one call against one other call and read a 7%
 * difference as the answer. On this box the same 900 tokens has been measured
 * at 740ms and at 16980ms — a 23x spread caused by the machine paging, not by
 * anything in the prompt. A single pair cannot see a 47% effect through that,
 * and neither can a mean. Alternating A/B and taking medians is the cheapest
 * design that can.
 *
 * READ THE OUTPUT LIKE THIS
 *   ms-per-token roughly EQUAL for shared-prefix and fresh-prefix
 *       -> no reuse. ~300 tokens per turn are being wasted; worth fixing.
 *   ms-per-token much LOWER for shared-prefix
 *       -> reuse already works, and there is nothing to win. Stop here.
 *   spread (p95/p50) still large after this runs
 *       -> the box is the bottleneck, not the prompt. Fix memory first; no
 *          prompt change can be measured reliably until then.
 */
import "dotenv/config";
import { buildAnswerPrompt } from "../server/local-agent";
import type { Retrieved } from "../server/retrieval";
import { chat } from "../server/llm";
import { percentile } from "./lib/speech-metrics";

const pairs = Number(process.argv[2] ?? 8);

const P = (n: number, filler: string): Retrieved =>
  ({
    title: `Tài liệu ${n}`,
    category: "general",
    source_url: null,
    content: filler,
    relevance: 0.9,
    matched_by: "probe",
    coverage: 0.8,
  }) as Retrieved;

/* Two question sets whose PASSAGES differ, so only the system instruction is
   shared. Sharing the passages too would measure a cache hit this product never
   gets: retrieval returns different text for every question. */
const A = {
  q: "Bữa sáng phục vụ đến mấy giờ ạ?",
  filler: "Nhà hàng Lotus phục vụ buffet sáng từ 06:00 đến 10:30 hằng ngày tại tầng trệt. Giá người lớn 650.000 VNĐ.",
};
const B = {
  q: "Hồ bơi mở cửa lúc nào ạ?",
  filler: "Hồ bơi ngoài trời mở từ 06:00 đến 20:00. Sau 19:00 không có nhân viên cứu hộ trực tại hồ.",
};

async function once(spec: { q: string; filler: string }) {
  const passages = Array.from({ length: 5 }, (_, i) => P(i + 1, spec.filler));
  const { system, user } = buildAnswerPrompt(spec.q, passages, "vi", undefined, "", "");
  const res = await chat({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0,
  });
  return { system, timing: res.timing };
}

/* The claim under test is that the system string does not change. Assert it
   rather than assume it: `buildAnswerPrompt` varies the instruction with the
   rate block and with history, and a probe that quietly compared two DIFFERENT
   system prompts would report "no reuse" for the wrong reason. */
const seen = new Set<string>();

const shared: number[] = []; // second call of a pair: system already seen
const fresh: number[] = []; // first call after a different prompt
const perTokenShared: number[] = [];
const perTokenFresh: number[] = [];

console.log(`alternating ${pairs} pairs (A, B, A, B, …)\n`);
console.log("  #  | which | prompt tok | đọc prompt |  ms/tok");
console.log("  " + "-".repeat(52));

for (let i = 0; i < pairs * 2; i++) {
  const spec = i % 2 === 0 ? A : B;
  const { system, timing } = await once(spec);
  seen.add(system);
  if (!timing) {
    console.log("  transport reported no timing — cannot measure");
    process.exit(1);
  }
  const perTok = timing.promptEvalMs / Math.max(1, timing.promptEvalTokens);
  /* The first two calls prime the cache; from the third on, the system prefix
     has definitely been through the model at least once. */
  const warm = i >= 2;
  if (warm) {
    (i % 2 === 0 ? shared : fresh).push(timing.promptEvalMs);
    (i % 2 === 0 ? perTokenShared : perTokenFresh).push(perTok);
  }
  console.log(
    `  ${String(i + 1).padStart(2)} | ${(i % 2 === 0 ? "A" : "B").padEnd(5)} | ${String(timing.promptEvalTokens).padStart(10)} | ` +
      `${String(timing.promptEvalMs + "ms").padStart(10)} | ${perTok.toFixed(2).padStart(7)}${warm ? "" : "  (priming)"}`,
  );
}

console.log("\n  " + "-".repeat(52));
if (seen.size !== 1)
  console.log(`  WARNING: the system prompt was NOT identical across calls (${seen.size} variants) — this run measures nothing.`);
else console.log(`  system prompt identical across all calls (${[...seen][0].length} chars) ✓`);

const all = [...shared, ...fresh];
const allPerTok = [...perTokenShared, ...perTokenFresh];
console.log(`\n  ms/token  A p50 ${percentile(perTokenShared, 50).toFixed(2)}   B p50 ${percentile(perTokenFresh, 50).toFixed(2)}`);
console.log(`  đọc prompt p50 ${percentile(all, 50)}ms   p95 ${percentile(all, 95)}ms   spread ${(percentile(all, 95) / Math.max(1, percentile(all, 50))).toFixed(1)}x`);

const spread = percentile(all, 95) / Math.max(1, percentile(all, 50));
if (spread > 3)
  console.log(
    `\n  Spread ${spread.toFixed(1)}x — the machine is the bottleneck, not the prompt.\n` +
      `  No prompt change can be measured reliably until that is fixed.`,
  );
else
  console.log(
    `\n  Spread ${spread.toFixed(1)}x is tight enough to attribute a difference to the prompt.\n` +
      `  If A and B ms/token match, the shared system prefix is NOT being reused.`,
  );
process.exit(0);
