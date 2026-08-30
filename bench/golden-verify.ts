/**
 * Verify the golden set against the corpus BEFORE anything is scored with it.
 *
 *   npx tsx bench/golden-verify.ts
 *
 * This is the check the previous eval set never had, and its absence is why the
 * old 46% figure cannot be trusted: case F-013 demanded the phrase "khai sinh",
 * which appears nowhere in `doc_chunks`, and then graded the model WRONG for not
 * producing it. A test that asks for facts the system was never given measures
 * the test author, not the system.
 *
 * Three assertions, all deterministic:
 *
 *   1. Every `contexts` title resolves to a real chunk.
 *   2. Every `anchors` value actually occurs in one of that case's chunks — so
 *      a numeric anchor can never demand a figure the corpus does not hold.
 *   3. Cases marked `abstain` have NO contexts, and cases marked `answer` have
 *      at least one. A grounded question filed as unanswerable (or the reverse)
 *      silently inverts what the run is measuring.
 *
 * Anchors are compared after `normalise()` from the speech metrics module —
 * shared on purpose. It already canonicalises Vietnamese numbers and times
 * ("16h" = "16:00" = "mười sáu giờ", "2.640.000" = "2640000"), which is exactly
 * the substring unfairness that made the old set punish correct answers for
 * their wording.
 */
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalise } from "./lib/speech-metrics";

type Case = {
  id: string;
  category: string;
  behaviour: "answer" | "clarify" | "abstain" | "escalate";
  question: string;
  ground_truth: string;
  contexts: string[];
  anchors: string[];
  why: string;
};

const set = JSON.parse(readFileSync(join(process.cwd(), "bench", "data", "golden-vi.json"), "utf8")) as {
  cases: Case[];
};
const db = new Database("data.db", { readonly: true });
const chunks = db.prepare("SELECT id, title, body FROM doc_chunks").all() as {
  id: number;
  title: string;
  body: string;
}[];

/** All chunk bodies sharing a title, joined — a fact may sit in any of them. */
const byTitle = new Map<string, string>();
for (const c of chunks) byTitle.set(c.title, (byTitle.get(c.title) ?? "") + " " + c.body);

let problems = 0;
const fail = (id: string, msg: string) => {
  problems++;
  console.error(`  FAIL  ${id}  ${msg}`);
};

const counts: Record<string, number> = {};
const behaviours: Record<string, number> = {};

for (const c of set.cases) {
  counts[c.category] = (counts[c.category] ?? 0) + 1;
  behaviours[c.behaviour] = (behaviours[c.behaviour] ?? 0) + 1;

  const grounded = c.behaviour === "answer";
  if (grounded && c.contexts.length === 0) fail(c.id, "được đánh dấu 'answer' nhưng không có contexts");
  if (c.behaviour === "abstain" && c.contexts.length > 0)
    fail(c.id, "được đánh dấu 'abstain' nhưng lại có contexts — mâu thuẫn");

  let corpus = "";
  for (const t of c.contexts) {
    const body = byTitle.get(t);
    if (body === undefined) {
      fail(c.id, `contexts "${t}" KHÔNG có trong doc_chunks`);
      continue;
    }
    corpus += " " + body;
  }

  if (!corpus.trim()) continue;
  const hay = normalise(corpus);
  for (const a of c.anchors) {
    const needle = normalise(a);
    if (!needle) continue;
    if (!hay.includes(needle)) fail(c.id, `neo "${a}" KHÔNG xuất hiện trong contexts của chính nó`);
  }
}

console.log(`\n${set.cases.length} ca · ${Object.keys(counts).length} hạng mục\n`);
console.log("  hạng mục:");
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1]))
  console.log(`    ${k.padEnd(20)} ${String(v).padStart(3)}`);
console.log("  hành vi mong đợi:");
for (const [k, v] of Object.entries(behaviours).sort((a, b) => b[1] - a[1]))
  console.log(`    ${k.padEnd(20)} ${String(v).padStart(3)}`);

/* An eval set that is all answerable is a set that cannot catch a system which
   answers everything — which is the failure mode this product actually has. */
const answerable = behaviours.answer ?? 0;
const share = answerable / set.cases.length;
console.log(
  `\n  tỉ lệ ca 'phải trả lời': ${(share * 100).toFixed(0)}%  ` +
    `(còn lại ${100 - Math.round(share * 100)}% là hỏi lại / từ chối / chuyển người)`,
);
if (share > 0.8) console.log("  CẢNH BÁO: quá thiên về câu trả lời được — bộ này sẽ không bắt được thói trả lời bừa.");

console.log(problems === 0 ? "\nBỘ VÀNG HỢP LỆ — mọi ground truth đều có gốc trong corpus" : `\n${problems} VẤN ĐỀ`);
process.exit(problems === 0 ? 0 : 1);
