/**
 * Does a labelled k-NN over bge-m3 beat the hand-written prototypes?
 *
 * The shipped centroid uses 18 prototypes someone wrote by hand. Measured on
 * the 600-case labelled set it scores 54.0% accuracy at 8.3% recall — it finds
 * one complaint in twelve. The obvious question before reaching for an ONNX
 * head is whether the SAME embedding, given real labelled examples instead of
 * invented ones, is enough on its own.
 *
 * This is the SetFit idea minus the fine-tuning step: embed the labelled set,
 * classify by nearest neighbours. No new dependency, no model file, no VRAM —
 * bge-m3 is already running for retrieval.
 *
 * Split is stratified by CELL (phenomenon × language), so every one of the 60
 * cells contributes to both train and test. A random split would leave whole
 * cells untested at 10 examples each.
 *
 *   npx tsx bench/sentiment-knn-eval.ts [file.jsonl] [k]
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { embed } from "../server/llm";

const FILE = process.argv[2] || "sentiment_benchmark_600.jsonl";
const K = Number(process.argv[3] || 5);
const TEST_FRACTION = 0.3;

type Row = { text: string; label: "negative" | "not_negative"; phenomenon: string; lang: string };
const rows = readFileSync(FILE, "utf8").trim().split("\n")
  .map((l) => { try { return JSON.parse(l) as Row; } catch { return null; } })
  .filter((r): r is Row => !!r?.text && !!r.label);

/* Deterministic stratified split: within each cell, every Nth example goes to
   test. No RNG, so the numbers are reproducible without seeding. */
const cells = new Map<string, Row[]>();
rows.forEach((r) => {
  const k = `${r.phenomenon}|${r.lang}`;
  if (!cells.has(k)) cells.set(k, []);
  cells.get(k)!.push(r);
});
const train: Row[] = [], test: Row[] = [];
for (const list of cells.values()) {
  const every = Math.max(2, Math.round(1 / TEST_FRACTION));
  list.forEach((r, i) => ((i % every === 0 ? test : train).push(r)));
}
console.log(`${rows.length} ví dụ · ${cells.size} ô · train ${train.length} / test ${test.length} · k=${K}\n`);

const cos = (a: number[], b: number[]) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const m = Math.sqrt(na) * Math.sqrt(nb);
  return m === 0 ? 0 : d / m;
};

async function embedAll(list: Row[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < list.length; i += 32) {
    out.push(...(await embed(list.slice(i, i + 32).map((r) => r.text))));
    process.stderr.write(`\r  nhúng ${Math.min(i + 32, list.length)}/${list.length}   `);
  }
  process.stderr.write("\r" + " ".repeat(30) + "\r");
  return out;
}

const trainVecs = await embedAll(train);
const testVecs = await embedAll(test);

/* Vote among the k nearest, weighted by similarity so a close neighbour counts
   for more than a distant one. `margin` is the winning side's share minus the
   other's — the same shape the shipped net thresholds on. */
function predict(v: number[]): { label: Row["label"]; margin: number } {
  const sims = trainVecs.map((tv, i) => ({ s: cos(v, tv), label: train[i].label }));
  sims.sort((a, b) => b.s - a.s);
  const top = sims.slice(0, K);
  let neg = 0, pos = 0;
  for (const t of top) (t.label === "negative" ? (neg += t.s) : (pos += t.s));
  const total = neg + pos || 1;
  return neg >= pos
    ? { label: "negative", margin: (neg - pos) / total }
    : { label: "not_negative", margin: (pos - neg) / total };
}

for (const MARGIN of [0, 0.1, 0.2, 0.3, 0.5]) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  const byPhen: Record<string, { n: number; ok: number }> = {};
  test.forEach((r, i) => {
    const p = predict(testVecs[i]);
    const gotNeg = p.label === "negative" && p.margin >= MARGIN;
    const wantNeg = r.label === "negative";
    if (wantNeg && gotNeg) tp++; else if (!wantNeg && gotNeg) fp++;
    else if (!wantNeg && !gotNeg) tn++; else fn++;
    byPhen[r.phenomenon] ??= { n: 0, ok: 0 };
    byPhen[r.phenomenon].n++;
    if (wantNeg === gotNeg) byPhen[r.phenomenon].ok++;
  });
  const acc = (100 * (tp + tn)) / test.length;
  const prec = (100 * tp) / (tp + fp || 1);
  const rec = (100 * tp) / (tp + fn || 1);
  const f1 = (2 * prec * rec) / (prec + rec || 1);
  console.log(
    `margin=${MARGIN.toFixed(2)}  acc=${acc.toFixed(1)}%  precision=${prec.toFixed(1)}%  recall=${rec.toFixed(1)}%  F1=${f1.toFixed(1)}  (TP${tp} FP${fp} TN${tn} FN${fn})`,
  );
  if (MARGIN === 0.2) {
    console.log("     theo hiện tượng:");
    Object.entries(byPhen).map(([k, v]) => [k, (100 * v.ok) / v.n] as [string, number])
      .sort((a, b) => a[1] - b[1])
      .forEach(([k, p]) => console.log(`       ${k.padEnd(20)} ${p.toFixed(1)}%`));
  }
}
process.exit(0);
