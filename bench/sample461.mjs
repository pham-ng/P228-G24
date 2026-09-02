// Rút mẫu phân tầng ~100 ca từ 461-run.jsonl để Claude chấm tay (correctness +
// faithfulness). Phân tầng theo expected_behavior; trong mỗi tầng trộn
// real/synthetic và ưu tiên giữ tỷ lệ numeric/adversarial. Seed cố định.
import fs from "fs";
const rows = fs.readFileSync("bench/461-run.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));

// PRNG seeded (mulberry32)
let s = 42;
const rnd = () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const shuffle = (a) => { const x = a.slice(); for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; };

const TARGET = { answer_directly: 60, ask_clarification: 20, abstain: 20 };
const picked = [];
for (const beh of Object.keys(TARGET)) {
  const pool = shuffle(rows.filter((r) => r.expected_behavior === beh));
  // ưu tiên: đảm bảo có numeric + adversarial trong tầng answer
  const want = TARGET[beh];
  const num = pool.filter((r) => r.is_numeric).slice(0, Math.floor(want * 0.4));
  const adv = pool.filter((r) => r.is_adversarial && !num.includes(r)).slice(0, Math.floor(want * 0.25));
  const rest = pool.filter((r) => !num.includes(r) && !adv.includes(r));
  const chosen = [...num, ...adv, ...rest].slice(0, want);
  picked.push(...chosen);
}

const out = picked.map((r) => ({
  test_id: r.test_id,
  expected_behavior: r.expected_behavior,
  must_abstain: r.must_abstain,
  is_numeric: r.is_numeric,
  is_adversarial: r.is_adversarial,
  is_multi_turn: r.is_multi_turn,
  question: r.question,
  ground_truth: r.ground_truth,
  actual_answer: r.actual_answer,
  det_behaviour: r.behaviour,
  det_numeric_ok: r.numeric_ok,
  passages_text: (r.passages || []).map((p, i) => `[${i + 1}] ${p.title ?? ""}: ${(p.content ?? "").replace(/\s+/g, " ").slice(0, 420)}`).join("\n"),
}));

fs.writeFileSync("bench/461-judge-sample.jsonl", out.map((r) => JSON.stringify(r)).join("\n"));
const by = {};
for (const r of out) by[r.expected_behavior] = (by[r.expected_behavior] || 0) + 1;
console.log(`Mẫu ${out.length} ca:`, JSON.stringify(by),
  `| numeric ${out.filter((r) => r.is_numeric).length} | adversarial ${out.filter((r) => r.is_adversarial).length} | multi-turn ${out.filter((r) => r.is_multi_turn).length}`);
