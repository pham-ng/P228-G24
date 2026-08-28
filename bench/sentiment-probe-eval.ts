/**
 * A trained linear head on bge-m3 embeddings — SetFit's final step, without
 * the dependency stack.
 *
 * SetFit is two things: contrastive fine-tuning of a sentence transformer, then
 * a linear classification head on the resulting embeddings. This project
 * already serves bge-m3 (1024-d, multilingual) for retrieval, and the query
 * vector for a guest turn is ALREADY computed before this would run — so the
 * head costs one dot product: no model file, no VRAM, no extra forward pass.
 *
 * What it skips is the encoder fine-tuning, which is where SetFit's extra
 * points come from. This measures how far the free half gets, so the decision
 * to install the expensive half is made against a number rather than a claim.
 *
 * Baselines on the same set:
 *   18 hand-written prototypes  acc 54.0%  recall  8.3%   F1 ~15
 *   k-NN (k=5) over the labels  acc 77.9%  recall 74.2%   F1 77.1
 *
 * MEASUREMENT NOTE: the six language blocks are parallel translations in the
 * same order, so an item held out in one language is held out in all six. The
 * split is therefore made on the item's index within its cell — 600 rows are
 * only ~100 independent items, and treating the rows as independent would
 * overstate what this set can tell us.
 *
 *   npx tsx bench/sentiment-probe-eval.ts [file.jsonl] [--errors] [--emit]
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { embed } from "../server/llm";
import { fold, hasVietnameseDiacritics } from "../server/retrieval";

const ARG = process.argv[2];
const FILE = !ARG || ARG.startsWith("--") ? "sentiment_benchmark_600.jsonl" : ARG;
const EMIT = process.argv.includes("--emit");

type Row = { text: string; label: "negative" | "not_negative"; phenomenon: string; lang: string };
const rows = readFileSync(FILE, "utf8").trim().split("\n")
  .map((l) => { try { return JSON.parse(l) as Row; } catch { return null; } })
  .filter((r): r is Row => !!r?.text && !!r.label);

/* Split on the item's index WITHIN its cell. Because the cells are parallel
   translations, item 3 of `sarcasm` is the same sentence in all six languages,
   so this keeps every language of one item on the same side of the split. */
const cells = new Map<string, Row[]>();
rows.forEach((r) => {
  const k = `${r.phenomenon}|${r.lang}`;
  if (!cells.has(k)) cells.set(k, []);
  cells.get(k)!.push(r);
});
const slot = new Map<Row, number>();
for (const list of cells.values()) list.forEach((r, i) => slot.set(r, i));

const train = rows.filter((r) => slot.get(r)! % 3 !== 0);
const test = rows.filter((r) => slot.get(r)! % 3 === 0);
console.log(`${rows.length} dong · ${cells.size} o · train ${train.length} / test ${test.length}`);
console.log(`(~${Math.round(rows.length / 6)} muc doc lap; test giu lai ~${Math.round(test.length / 6)} muc)\n`);

async function embedAll(list: Row[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < list.length; i += 32) {
    out.push(...(await embed(list.slice(i, i + 32).map((r) => r.text))));
    process.stderr.write(`\r  nhung ${Math.min(i + 32, list.length)}/${list.length}   `);
  }
  process.stderr.write("\r" + " ".repeat(28) + "\r");
  return out;
}

/* L2-normalise so the dot product is a cosine and the weights stay comparable
   across examples of different length. */
const norm = (v: number[]) => {
  let s = 0;
  for (const x of v) s += x * x;
  const m = Math.sqrt(s) || 1;
  return v.map((x) => x / m);
};

/* Vietnamese guests type without diacritics roughly a quarter of the time,
   and bge-m3 places `phong ban qua` far from `phòng bẩn quá`. Training on the
   folded form of every accented Vietnamese example teaches the head both
   spellings from the labels already present — no new data, and TEST is left
   untouched so the number stays honest. */
const augmented = process.argv.includes("--augment")
  ? [...train, ...train.filter((r) => r.lang === "vi" && hasVietnameseDiacritics(r.text))
      .map((r) => { const c = { ...r, text: fold(r.text) }; slot.set(c, slot.get(r)!); return c; })]
  : train;
if (augmented.length !== train.length) console.log(`bo sung ${augmented.length - train.length} bien the khong dau -> train ${augmented.length}
`);
const Xtr = (await embedAll(augmented)).map(norm);
const Xte = (await embedAll(test)).map(norm);
const D = Xtr[0].length;

type Head = { w: Float64Array; b: number };

/* Logistic regression, full-batch gradient descent with L2. 400x1024 is small
   enough that this converges in well under a second, so the hyperparameters can
   be chosen by cross-validation rather than by taste. */
function fit(X: number[][], y: number[], l2: number, epochs: number, lr: number): Head {
  const w = new Float64Array(D);
  let b = 0;
  for (let e = 0; e < epochs; e++) {
    const gw = new Float64Array(D);
    let gb = 0;
    for (let i = 0; i < X.length; i++) {
      let z = b;
      for (let d = 0; d < D; d++) z += w[d] * X[i][d];
      const p = 1 / (1 + Math.exp(-z));
      const err = p - y[i];
      for (let d = 0; d < D; d++) gw[d] += err * X[i][d];
      gb += err;
    }
    for (let d = 0; d < D; d++) w[d] -= lr * (gw[d] / X.length + l2 * w[d]);
    b -= lr * (gb / X.length);
  }
  return { w, b };
}

const prob = (h: Head, v: number[]) => {
  let z = h.b;
  for (let d = 0; d < D; d++) z += h.w[d] * v[d];
  return 1 / (1 + Math.exp(-z));
};

function f1of(h: Head, X: number[][], rs: Row[], t: number) {
  let tp = 0, fp = 0, fn = 0;
  rs.forEach((r, i) => {
    const got = prob(h, X[i]) >= t;
    const want = r.label === "negative";
    if (want && got) tp++; else if (!want && got) fp++; else if (want && !got) fn++;
  });
  const p = tp / (tp + fp || 1);
  const rc = tp / (tp + fn || 1);
  return (2 * p * rc) / (p + rc || 1);
}

/* Choose l2 / epochs / threshold by cross-validation on TRAIN ONLY — picking
   them on the test set is how a benchmark ends up flattering itself. */
const ytr = augmented.map((r) => (r.label === "negative" ? 1 : 0));
const foldOf = augmented.map((r) => slot.get(r)! % 3);  /* a folded copy inherits its source fold, so it never leaks across the CV split */
const idx = augmented.map((_, i) => i);
let bestCfg = { l2: 1e-4, epochs: 400, t: 0.5, f1: -1 };
console.log("chon sieu tham so bang cross-validation tren tap train:");
for (const l2 of [1e-5, 1e-4, 1e-3, 1e-2]) {
  for (const epochs of [400, 1500, 4000]) {
    const heads = [1, 2].map((f) => {
      const tr = idx.filter((i) => foldOf[i] !== f);
      return { f, h: fit(tr.map((i) => Xtr[i]), tr.map((i) => ytr[i]), l2, epochs, 0.5) };
    });
    for (const t of [0.4, 0.5, 0.6]) {
      let sum = 0;
      for (const { f, h } of heads) {
        const va = idx.filter((i) => foldOf[i] === f);
        sum += f1of(h, va.map((i) => Xtr[i]), va.map((i) => augmented[i]), t);
      }
      const f1 = sum / heads.length;
      if (f1 > bestCfg.f1) bestCfg = { l2, epochs, t, f1 };
    }
  }
}
console.log(`  -> l2=${bestCfg.l2} epochs=${bestCfg.epochs} nguong=${bestCfg.t}  (CV F1 ${(100 * bestCfg.f1).toFixed(1)})\n`);

const head = fit(Xtr, ytr, bestCfg.l2, bestCfg.epochs, 0.5);
const T = bestCfg.t;

console.log("=== TAP TEST (chua he nhin thay) ===");
let tp = 0, fp = 0, tn = 0, fn = 0;
test.forEach((r, i) => {
  const got = prob(head, Xte[i]) >= T;
  const want = r.label === "negative";
  if (want && got) tp++; else if (!want && got) fp++; else if (!want && !got) tn++; else fn++;
});
const prec = (100 * tp) / (tp + fp || 1);
const rec = (100 * tp) / (tp + fn || 1);
console.log(`  accuracy  ${((100 * (tp + tn)) / test.length).toFixed(1)}%`);
console.log(`  precision ${prec.toFixed(1)}%   recall ${rec.toFixed(1)}%   F1 ${((2 * prec * rec) / (prec + rec || 1)).toFixed(1)}`);
console.log(`  TP=${tp} FP=${fp} TN=${tn} FN=${fn}`);

console.log("\nduong cong nguong (de chon diem van hanh):");
console.log("  nguong   acc     precision  recall");
for (const t of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
  let a = 0, b2 = 0, c = 0, d2 = 0;
  test.forEach((r, i) => {
    const got = prob(head, Xte[i]) >= t;
    const want = r.label === "negative";
    if (want && got) a++; else if (!want && got) b2++; else if (!want && !got) c++; else d2++;
  });
  console.log(`   ${t.toFixed(2)}   ${((100 * (a + c)) / test.length).toFixed(1)}%   ${((100 * a) / (a + b2 || 1)).toFixed(1)}%     ${((100 * a) / (a + d2 || 1)).toFixed(1)}%`);
}

const group = (key: (r: Row) => string) => {
  const m: Record<string, { n: number; ok: number }> = {};
  test.forEach((r, i) => {
    const k = key(r);
    m[k] ??= { n: 0, ok: 0 };
    m[k].n++;
    if ((prob(head, Xte[i]) >= T) === (r.label === "negative")) m[k].ok++;
  });
  return Object.entries(m).map(([k, v]) => [k, (100 * v.ok) / v.n] as [string, number]);
};
console.log(`\n=== theo hien tuong (nguong ${T}) ===`);
group((r) => `${r.phenomenon} [${r.label === "negative" ? "neg" : "not"}]`)
  .sort((a, b) => a[1] - b[1])
  .forEach(([k, p]) => console.log(`  ${k.padEnd(30)} ${p.toFixed(1)}%`));
console.log("=== theo ngon ngu ===");
group((r) => r.lang).sort((a, b) => b[1] - a[1]).forEach(([k, p]) => console.log(`  ${k.padEnd(4)} ${p.toFixed(1)}%`));

if (process.argv.includes("--errors")) {
  console.log("\n=== cac ca sai (nhan that -> du doan) ===");
  test.forEach((r, i) => {
    const p = prob(head, Xte[i]);
    const got = p >= T ? "negative" : "not_negative";
    if (got !== r.label) console.log(`  [${r.lang}/${r.phenomenon}] ${r.label} -> ${got} (p=${p.toFixed(2)})\n      ${r.text}`);
  });
}

if (EMIT) {
  /* Retrain on ALL rows before emitting — the held-out split existed to produce
     an honest number, not to ship a head that only ever saw two thirds. */
  const allX = [...Xtr, ...Xte];
  const allY = [...augmented, ...test].map((r) => (r.label === "negative" ? 1 : 0));
  const final = fit(allX, allY, bestCfg.l2, bestCfg.epochs, 0.5);
  writeFileSync("server/data/sentiment-head.json", JSON.stringify({
    dim: D,
    bias: final.b,
    threshold: T,
    weights: Array.from(final.w),
    trainedOn: rows.length,
    source: FILE,
    embedModel: process.env.LOCAL_EMBED_MODEL || "bge-m3",
  }));
  console.log(`\n-> server/data/sentiment-head.json (dim=${D}, nguong=${T}, ${rows.length} vi du)`);
}
process.exit(0);
