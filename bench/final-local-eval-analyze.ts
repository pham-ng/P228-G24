import { readFileSync, writeFileSync } from "node:fs";

const cases = JSON.parse(readFileSync("bench/baselines/kiosk-validation/FINAL-LOCAL-EVAL-CASES.json", "utf8"));
const results = JSON.parse(readFileSync("bench/baselines/kiosk-validation/FINAL-LOCAL-PRODUCT-EVALUATION.json", "utf8"));

const atomic = results.atomic as any[];
const convs = results.conversations as any[];

function pct(n: number, d: number) {
  return d ? +((100 * n) / d).toFixed(1) : null;
}
function percentile(arr: number[], p: number) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1);
  return s[Math.max(0, idx)];
}

function summarize(rows: any[]) {
  const n = rows.length;
  const correct = rows.filter((r) => r.verdict === "CORRECT").length;
  const partial = rows.filter((r) => r.verdict === "PARTIAL").length;
  const wrong = rows.filter((r) => r.verdict === "WRONG").length;
  const critical = rows.filter((r) => r.verdict === "CRITICAL_FAIL").length;
  const ksCorrect = rows.filter((r) => r.knowledge_state_correct).length;
  const langOk = rows.filter((r) => r.language_ok).length;
  const fabricated = rows.filter((r) => r.fabricated_numbers?.length).length;
  const ms = rows.map((r) => r.ms).filter((x) => typeof x === "number");
  return {
    n, correct, partial, wrong, critical,
    correct_pct: pct(correct, n), partial_pct: pct(partial, n), wrong_pct: pct(wrong, n), critical_pct: pct(critical, n),
    knowledge_state_accuracy_pct: pct(ksCorrect, n),
    language_accuracy_pct: pct(langOk, n),
    fabrication_count: fabricated, fabrication_pct: pct(fabricated, n),
    latency_p50: percentile(ms, 50), latency_p95: percentile(ms, 95), latency_p99: percentile(ms, 99),
  };
}

const overall = summarize(atomic);
const bySplit: any = {};
for (const split of ["dev", "holdout"]) bySplit[split] = summarize(atomic.filter((r) => r.split === split));

const byCategory: any = {};
for (const cat of [...new Set(atomic.map((r: any) => r.category))]) byCategory[cat as string] = summarize(atomic.filter((r) => r.category === cat));

const byLanguage: any = {};
for (const lang of [...new Set(atomic.map((r: any) => r.language))]) byLanguage[lang as string] = summarize(atomic.filter((r) => r.language === lang));

const byAnswerability: any = {};
for (const a of [...new Set(atomic.map((r: any) => r.expected_answerability))]) byAnswerability[a as string] = summarize(atomic.filter((r) => r.expected_answerability === a));

// Failure taxonomy
const layerCounts: Record<string, number> = {};
for (const r of atomic.filter((r) => r.verdict !== "CORRECT")) {
  const l = r.failing_layer ?? "UNSPECIFIED";
  layerCounts[l] = (layerCounts[l] ?? 0) + 1;
}

// Critical failures list
const criticalFailures = atomic.filter((r) => r.verdict === "CRITICAL_FAIL").map((r) => ({
  case_id: r.case_id, category: r.category, language: r.language, query: r.user_query,
  reply: (r.reply ?? "").slice(0, 200), forbidden_present: r.forbidden_present, fabricated_numbers: r.fabricated_numbers,
}));

// Multi-turn metrics
const convSuccess = convs.filter((c) => c.conversation_success).length;
const convByPattern: Record<string, { total: number; success: number }> = {};
for (const c of convs) {
  for (const p of c.patterns) {
    convByPattern[p] = convByPattern[p] ?? { total: 0, success: 0 };
    convByPattern[p].total++;
    if (c.conversation_success) convByPattern[p].success++;
  }
}
let allTurns = 0, okTurns = 0;
for (const c of convs) for (const t of c.turns) { allTurns++; if (t.turn_ok) okTurns++; }

// Dev vs holdout usefulness on ANSWERABLE-only cases (the core "usefulness" metric)
function usefulness(rows: any[]) {
  const answerable = rows.filter((r) => r.expected_answerability === "answerable");
  const correct = answerable.filter((r) => r.verdict === "CORRECT").length;
  return { n: answerable.length, correct, pct: pct(correct, answerable.length) };
}
const usefulnessOverall = usefulness(atomic);
const usefulnessDev = usefulness(atomic.filter((r) => r.split === "dev"));
const usefulnessHoldout = usefulness(atomic.filter((r) => r.split === "holdout"));

const report = {
  overall, bySplit, byCategory, byLanguage, byAnswerability,
  usefulness: { overall: usefulnessOverall, dev: usefulnessDev, holdout: usefulnessHoldout },
  failure_taxonomy: layerCounts,
  critical_failures: criticalFailures,
  multi_turn: {
    conversations_total: convs.length,
    conversations_success: convSuccess,
    conversation_success_pct: pct(convSuccess, convs.length),
    turn_level_accuracy_pct: pct(okTurns, allTurns),
    by_pattern: convByPattern,
    failed_conversations: convs.filter((c) => !c.conversation_success).map((c) => ({
      conv_id: c.conv_id, patterns: c.patterns,
      failing_turns: c.turns.filter((t: any) => t.turn_ok === false).map((t: any) => ({ turn: t.turn, message: t.message, reply: (t.reply ?? "").slice(0, 200), facts_missing: t.facts_missing, forbidden_present: t.forbidden_present })),
    })),
  },
};

writeFileSync("bench/baselines/kiosk-validation/FINAL-LOCAL-EVAL-METRICS.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify({ overall, usefulness: report.usefulness, multi_turn_success_pct: report.multi_turn.conversation_success_pct, failure_taxonomy: layerCounts, critical_failure_count: criticalFailures.length }, null, 2));
