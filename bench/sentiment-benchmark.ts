/**
 * Score the centroid sentiment net against a labelled benchmark.
 *
 * The 20-case check inside `test/sentiment-net.test.ts` was written by whoever
 * wrote the prototypes, which makes it evidence of nothing. This reads an
 * external JSONL set — text, label, phenomenon, lang — and reports accuracy
 * broken down BY PHENOMENON, because the interesting question is not the
 * headline number but which linguistic shapes a cosine-over-prototypes
 * classifier cannot represent at all.
 *
 *   npx tsx bench/sentiment-benchmark.ts [file.jsonl]
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { embed } from "../server/llm";
import { classifyVector, SENTIMENT_PROTOTYPES, SENTIMENT_MARGIN } from "../server/sentiment-net";

const FILE = process.argv[2] || "sentiment_benchmark_400.jsonl";
type Row = { text: string; label: "negative" | "not_negative"; phenomenon: string; lang: string };

const rows = readFileSync(FILE, "utf8")
  .trim()
  .split("\n")
  .map((l) => {
    try {
      return JSON.parse(l) as Row;
    } catch {
      return null;
    }
  })
  .filter((r): r is Row => !!r?.text && !!r.label);

console.log(`${rows.length} ví dụ · margin=${SENTIMENT_MARGIN}\n`);

const protoVecs = await embed(SENTIMENT_PROTOTYPES.map((p) => p.text));
const preds: boolean[] = [];
const BATCH = 32;
for (let i = 0; i < rows.length; i += BATCH) {
  const slice = rows.slice(i, i + BATCH);
  const vecs = await embed(slice.map((r) => r.text));
  slice.forEach((_, j) => {
    const v = classifyVector(vecs[j], SENTIMENT_PROTOTYPES, protoVecs);
    preds.push(!!v && v.label === "negative" && v.margin >= SENTIMENT_MARGIN);
  });
  process.stderr.write(`\r  ${Math.min(i + BATCH, rows.length)}/${rows.length}   `);
}
process.stderr.write("\r" + " ".repeat(30) + "\r");

let tp = 0, fp = 0, tn = 0, fn = 0;
const byPhen: Record<string, { n: number; ok: number }> = {};
const byLang: Record<string, { n: number; ok: number }> = {};
rows.forEach((r, i) => {
  const wantNeg = r.label === "negative";
  const gotNeg = preds[i];
  if (wantNeg && gotNeg) tp++;
  else if (!wantNeg && gotNeg) fp++;
  else if (!wantNeg && !gotNeg) tn++;
  else fn++;
  const ok = wantNeg === gotNeg ? 1 : 0;
  byPhen[r.phenomenon] ??= { n: 0, ok: 0 };
  byPhen[r.phenomenon].n++;
  byPhen[r.phenomenon].ok += ok;
  byLang[r.lang] ??= { n: 0, ok: 0 };
  byLang[r.lang].n++;
  byLang[r.lang].ok += ok;
});

const pct = (a: number, b: number) => `${((100 * a) / (b || 1)).toFixed(1)}%`;
console.log("=== TỔNG ===");
console.log(`  accuracy  ${pct(tp + tn, rows.length)}   (${tp + tn}/${rows.length})`);
console.log(`  precision ${pct(tp, tp + fp)}   — trong số ca báo động, bao nhiêu đúng`);
console.log(`  recall    ${pct(tp, tp + fn)}   — trong số ca phàn nàn thật, bắt được bao nhiêu`);
console.log(`  TP=${tp} FP=${fp} TN=${tn} FN=${fn}`);

console.log("\n=== THEO HIỆN TƯỢNG NGÔN NGỮ (kém nhất trước) ===");
Object.entries(byPhen)
  .map(([k, v]) => [k, v.n, (100 * v.ok) / v.n] as [string, number, number])
  .sort((a, b) => a[2] - b[2])
  .forEach(([k, n, p]) => console.log(`  ${k.padEnd(20)} n=${String(n).padStart(3)}  ${p.toFixed(1)}%`));

console.log("\n=== THEO NGÔN NGỮ ===");
Object.entries(byLang)
  .map(([k, v]) => [k, v.n, (100 * v.ok) / v.n] as [string, number, number])
  .sort((a, b) => b[2] - a[2])
  .forEach(([k, n, p]) => console.log(`  ${k.padEnd(4)} n=${String(n).padStart(3)}  ${p.toFixed(1)}%`));
process.exit(0);
