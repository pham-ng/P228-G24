/**
 * Score a text-to-speech engine on the two things a buyer can check.
 *
 *   npx tsx bench/tts-eval.ts <out-dir> [voice]
 *
 * WHY THESE TWO AND NOT "DOES IT SOUND NICE"
 *
 * The published gold standard for TTS quality is MOS — a panel of listeners
 * rating each clip 1 to 5. It is the number in every paper and it needs people,
 * so it is not something a script can produce. What a script CAN produce, and
 * what the field uses as the objective stand-in, is:
 *
 *   intelligibility  synthesise the sentence, transcribe the result with a
 *                    FIXED recogniser, and measure the word error rate against
 *                    the text you started from. It answers "can this be
 *                    understood", which is the part a hotel actually needs; it
 *                    does not answer "is this pleasant", which is what MOS adds.
 *                    Published as ASR-WER or round-trip WER.
 *
 *   latency          RTF (compute seconds per second of audio) and, for anything
 *                    a guest waits on, time to FIRST audio. A guest hears the
 *                    first syllable, not the average.
 *
 * Reading the intelligibility number honestly: the recogniser has its own error
 * rate, so this is a FLOOR on the synthesis, not a clean measurement of it.
 * Run `bench/asr-eval.ts` on human recordings of the same sentences first, and
 * subtract — anything above that baseline is the synthesiser's contribution.
 * A round-trip WER at or below the ASR's own is as good as this method can see.
 *
 * This script only writes the audio and times it. Scoring is `asr-eval.ts`
 * pointed at the output directory, deliberately: the same scorer, the same
 * normalisation and the same test set, so the ASR and TTS numbers are directly
 * comparable instead of being two implementations that disagree.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { env } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
import { percentile } from "./lib/speech-metrics";

type Case = { id: string; lang: string; ref: string };

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: npx tsx bench/tts-eval.ts <out-dir> [voice]");
  process.exit(2);
}
const voice = process.argv[3] ?? "af_heart";

env.cacheDir = join(process.cwd(), "models", "hf");
mkdirSync(outDir, { recursive: true });

const set = JSON.parse(readFileSync(join(process.cwd(), "bench", "data", "speech-testset.json"), "utf8")) as {
  cases: Case[];
};

/**
 * Kokoro-82M's JS build ships en-us and en-gb and nothing else — checked in its
 * own voice table, not assumed. Handing it Vietnamese does not fail; it
 * phonemises through English rules and emits sixteen seconds of noise for a
 * one-line sentence, which is worse than refusing. So only English is scored.
 */
const cases = set.cases.filter((c) => c.lang === "en");
if (!cases.length) {
  console.error("No English cases in the test set — Kokoro's JS build has no other language.");
  process.exit(1);
}

const t0 = Date.now();
const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
  dtype: "q8",
  device: "cpu",
});
const loadMs = Date.now() - t0;
const langs = new Set(Object.values(tts.voices as Record<string, { language: string }>).map((v) => v.language));

console.log(`engine   : Kokoro-82M (kokoro-js) voice=${voice}`);
console.log(`languages: ${[...langs].join(", ")}  (${Object.keys(tts.voices as object).length} voices)`);
console.log(`load     : ${(loadMs / 1000).toFixed(1)}s\n`);

const rtfs: number[] = [];
const ttfas: number[] = [];

for (const c of cases) {
  const t = Date.now();
  const audio = (await tts.generate(c.ref, { voice: voice as never })) as {
    audio: Float32Array;
    sampling_rate: number;
    toWav: () => ArrayBuffer;
  };
  const ms = Date.now() - t;
  const seconds = audio.audio.length / audio.sampling_rate;

  writeFileSync(join(outDir, `${c.id}.wav`), Buffer.from(audio.toWav()));
  rtfs.push(ms / 1000 / seconds);
  /* Nothing here streams, so the guest waits for the whole clip before hearing
     a syllable — time to first audio IS the full synthesis time. Recorded as
     its own number because a streaming engine would separate them, and the
     comparison should not silently flatter whichever one is measured later. */
  ttfas.push(ms);
  console.log(
    `  ${c.id}  ${String(c.ref.length).padStart(3)} chars → ${(ms / 1000).toFixed(2)}s for ${seconds.toFixed(1)}s audio  RTF ${(ms / 1000 / seconds).toFixed(2)}`,
  );
}

writeFileSync(
  join(outDir, "SOURCE.txt"),
  `SYNTHETIC - Kokoro-82M v1.0 ONNX q8 CPU, voice ${voice}. Round-trip intelligibility set: ` +
    `score with 'npx tsx bench/asr-eval.ts <this dir> onnx-community/whisper-small' and compare ` +
    `against the same ASR on human recordings of the same sentences.`,
);

/* 24 kHz mono is what Kokoro emits; the scorer wants 16 kHz, and a silent rate
   mismatch has already invalidated one round of numbers in this project. */
console.log(
  `\n  RTF p50 ${percentile(rtfs, 50).toFixed(2)}  p95 ${percentile(rtfs, 95).toFixed(2)}` +
    `   time-to-first-audio p50 ${(percentile(ttfas, 50) / 1000).toFixed(2)}s  p95 ${(percentile(ttfas, 95) / 1000).toFixed(2)}s`,
);
console.log(`\n  wrote ${cases.length} clips to ${outDir}`);
console.log(`  next: ffmpeg -i <clip> -ar 16000 -ac 1 …  then  npx tsx bench/asr-eval.ts ${outDir} onnx-community/whisper-small`);
process.exit(0);
