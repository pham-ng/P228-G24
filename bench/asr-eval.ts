/**
 * Score the recogniser against `bench/data/speech-testset.json`.
 *
 *   npx tsx bench/asr-eval.ts <audio-dir> [model] [dtype] [device]
 *
 * <audio-dir> holds one 16 kHz mono WAV per case id (vi-01.wav, …). Anything
 * missing is skipped and counted, so a partially recorded set still produces an
 * honest number over what exists.
 *
 * WHAT IT PRINTS AND WHY EACH ONE IS THERE
 *
 *   WER / CER   the two numbers any buyer will ask for and can compare against
 *               a published figure for Google, Azure or a PMS vendor.
 *   numbers     share of utterances where every figure came through intact. A
 *               transcript can be 92% right and still send housekeeping to 350
 *               instead of 305, and WER does not distinguish that from a lost
 *               "please".
 *   polarity    share where a negation survived. Both models here were caught
 *               turning "không mát" into "cũng mát", which converts a complaint
 *               into a compliment; a hotel cares about that far more than about
 *               two percentage points of WER.
 *   RTF p50/p95 compute time per second of speech. p95, not the mean — the
 *               slowest turns are the ones a guest abandons.
 *
 * HONESTY RULE. The report stamps the audio source. Synthetic speech from a
 * Windows voice is clean, unaccented, noise-free and roughly 30-50% easier than
 * a real guest in a lobby; numbers from it are a FLOOR for comparing two models
 * on the same clips, never a figure to put in front of a customer. Only a
 * recorded set earns that.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pipeline, env } from "@huggingface/transformers";
import {
  wer,
  cer,
  scoreEntities,
  summarise,
  pct,
  type CaseResult,
} from "./lib/speech-metrics";

type Case = { id: string; lang: string; ref: string; why: string };

const audioDir = process.argv[2];
if (!audioDir) {
  console.error("usage: npx tsx bench/asr-eval.ts <audio-dir> [model] [dtype] [device]");
  process.exit(2);
}
const forcedModel = process.argv[3];
const dtype = (process.argv[4] ?? "q8") as never;
const device = (process.argv[5] ?? "cpu") as never;

env.cacheDir = join(process.cwd(), "models", "hf");

const WHISPER_LANG: Record<string, string> = {
  vi: "vietnamese", en: "english", ko: "korean", ja: "japanese", zh: "chinese", ru: "russian",
};

/** Same routing the product uses, so the benchmark measures the shipped choice. */
const modelFor = (lang: string) =>
  forcedModel ?? (lang === "vi" ? "huuquyet/PhoWhisper-small" : "onnx-community/whisper-small");

function readWav(path: string) {
  const buf = readFileSync(path);
  let off = 12;
  let rate = 0;
  let channels = 1;
  let bits = 16;
  let data: Buffer | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, Math.min(off + 8 + size, buf.length));
    if (id === "fmt " && body.length >= 16) {
      channels = body.readUInt16LE(2);
      rate = body.readUInt32LE(4);
      bits = body.readUInt16LE(14);
    } else if (id === "data") data = body;
    off += 8 + size + (size % 2);
  }
  if (!data) throw new Error(`${path}: no data chunk`);
  if (bits !== 16) throw new Error(`${path}: expected 16-bit PCM, got ${bits}`);
  /* A silent rate mismatch transcribes time-stretched audio rather than
     failing, and it already invalidated one full round of these numbers. */
  if (rate !== 16000)
    throw new Error(`${path} is ${rate} Hz — resample first: ffmpeg -i in.wav -ar 16000 -ac 1 out.wav`);
  const frames = Math.floor(data.length / 2 / channels);
  const pcm = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += data.readInt16LE((i * channels + c) * 2);
    pcm[i] = sum / channels / 32768;
  }
  return { pcm, seconds: frames / 16000 };
}

const set = JSON.parse(readFileSync(join(process.cwd(), "bench", "data", "speech-testset.json"), "utf8")) as {
  cases: Case[];
};

/* The source label is read from the audio directory, not guessed, and it is the
   first thing printed — a number without it is unquotable. */
const sourceFile = join(audioDir, "SOURCE.txt");
const source = existsSync(sourceFile)
  ? readFileSync(sourceFile, "utf8").trim()
  : "UNLABELLED — put a one-line SOURCE.txt in the audio directory saying who or what produced these recordings";

const available = new Set(readdirSync(audioDir).filter((f) => f.endsWith(".wav")).map((f) => f.replace(/\.wav$/, "")));
const todo = set.cases.filter((c) => available.has(c.id));
const missing = set.cases.filter((c) => !available.has(c.id));

console.log(`audio source : ${source}`);
console.log(`cases        : ${todo.length} scored, ${missing.length} missing${missing.length ? ` (${missing.map((m) => m.id).join(", ")})` : ""}`);
console.log(`dtype/device : ${dtype}/${device}\n`);

const pipes = new Map<string, Awaited<ReturnType<typeof pipeline>>>();
const results: CaseResult[] = [];
const refs: string[] = [];
const hyps: string[] = [];

for (const c of todo) {
  const modelId = modelFor(c.lang);
  if (!pipes.has(modelId)) {
    process.stdout.write(`loading ${modelId}… `);
    const t = Date.now();
    pipes.set(modelId, await pipeline("automatic-speech-recognition", modelId, { dtype, device }));
    console.log(`${((Date.now() - t) / 1000).toFixed(1)}s`);
  }
  const asr = pipes.get(modelId)! as unknown as (
    a: Float32Array,
    o: Record<string, unknown>,
  ) => Promise<{ text?: string }>;

  const { pcm, seconds } = readWav(join(audioDir, `${c.id}.wav`));
  const t0 = Date.now();
  const out = await asr(pcm, { language: WHISPER_LANG[c.lang], task: "transcribe", do_sample: false });
  const ms = Date.now() - t0;
  const hyp = String(out.text ?? "").trim();

  const w = wer(c.ref, hyp);
  const ch = cer(c.ref, hyp);
  const ent = scoreEntities(c.ref, hyp);

  results.push({
    id: c.id, ref: c.ref, hyp,
    wer: w.rate, cer: ch.rate,
    numbersRight: ent.numbersRight, polarityRight: ent.polarityRight,
    ms, audioSeconds: seconds,
  });
  refs.push(c.ref);
  hyps.push(hyp);

  const flag = [!ent.numbersRight ? "NUM" : "", !ent.polarityRight ? "POL" : ""].filter(Boolean).join("+");
  console.log(
    `  ${c.id}  WER ${pct(w.rate).padStart(6)}  CER ${pct(ch.rate).padStart(6)}  ${(ms / 1000).toFixed(2)}s  ${flag}`,
  );
  if (w.rate > 0) console.log(`      got: ${hyp}`);
}

/* Per language, because one corpus number hides that Vietnamese runs on a
   different model from everything else. */
const langs = [...new Set(todo.map((c) => c.lang))];
console.log("\n  lang | cases |    WER |    CER | numbers | polarity | RTF p50 | RTF p95");
console.log("  " + "-".repeat(74));
for (const l of [...langs, "ALL"]) {
  const idx = todo.map((c, i) => (l === "ALL" || c.lang === l ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) continue;
  const s = summarise(idx.map((i) => results[i]), idx.map((i) => refs[i]), idx.map((i) => hyps[i]));
  console.log(
    `  ${l.padEnd(4)} | ${String(s.cases).padStart(5)} | ${pct(s.wer).padStart(6)} | ${pct(s.cer).padStart(6)} | ` +
      `${pct(s.numberAccuracy).padStart(7)} | ${pct(s.polarityAccuracy).padStart(8)} | ` +
      `${s.rtfP50.toFixed(2).padStart(7)} | ${s.rtfP95.toFixed(2).padStart(7)}`,
  );
}

const report = {
  source,
  dtype,
  device,
  model: forcedModel ?? "routed: vi=PhoWhisper-small, other=whisper-small",
  scored: todo.length,
  missing: missing.map((m) => m.id),
  overall: summarise(results, refs, hyps),
  perLanguage: Object.fromEntries(
    langs.map((l) => {
      const idx = todo.map((c, i) => (c.lang === l ? i : -1)).filter((i) => i >= 0);
      return [l, summarise(idx.map((i) => results[i]), idx.map((i) => refs[i]), idx.map((i) => hyps[i]))];
    }),
  ),
  cases: results,
};
/* Named after the audio directory, so scoring a second engine does not silently
   overwrite the first and leave two runs claiming to be the same file. */
const slug = audioDir.replace(/[\/]+$/, "").split(/[\/]/).pop()!.replace(/[^a-z0-9._-]/gi, "-");
const out = join(process.cwd(), "bench", `asr-eval-${slug}.json`);
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`\n  written: ${out}`);
if (source.startsWith("UNLABELLED"))
  console.log("  WARNING: unlabelled audio source — these numbers cannot be quoted to a customer.");
process.exit(0);
