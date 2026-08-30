/**
 * Which Whisper actually works for Vietnamese on THIS machine?
 *
 *   npx tsx bench/stt-probe.ts [modelId] [dtype] [device]
 *
 * Prints wall-clock, real-time factor and the transcript so the trade between
 * size, speed and accuracy is a table rather than an opinion. Audio is 16 kHz
 * mono WAV; the clips are synthesised by the Windows Vietnamese voice, so WER
 * here is OPTIMISTIC — clean studio-ish speech, no accent, no room noise. It
 * separates "usable" from "unusable", it does not predict field accuracy.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pipeline, env } from "@huggingface/transformers";

env.cacheDir = join(process.cwd(), "models", "hf");
env.allowLocalModels = true;

/** Minimal 16-bit PCM WAV reader — enough for the clips this probe uses. */
function readWav(path: string): { pcm: Float32Array; rate: number; seconds: number } {
  const buf = readFileSync(path);
  let off = 12;
  let rate = 16000;
  let data: Buffer | null = null;
  let bits = 16;
  let channels = 1;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") {
      channels = buf.readUInt16LE(off + 10);
      rate = buf.readUInt32LE(off + 12);
      bits = buf.readUInt16LE(off + 22);
    } else if (id === "data") {
      data = buf.subarray(off + 8, off + 8 + size);
    }
    off += 8 + size + (size % 2);
  }
  if (!data) throw new Error(`no data chunk in ${path}`);
  if (bits !== 16) throw new Error(`expected 16-bit PCM, got ${bits}`);
  const n = Math.floor(data.length / 2 / channels);
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = data.readInt16LE(i * 2 * channels) / 32768;
  return { pcm, rate, seconds: n / rate };
}

const modelId = process.argv[2] ?? "onnx-community/whisper-base";
const dtype = (process.argv[3] ?? "q8") as any;
const device = (process.argv[4] ?? "cpu") as any;

const dir = process.env.STT_CLIPS!;
const clips = readdirSync(dir).filter((f) => f.endsWith(".wav")).sort();

console.log(`model=${modelId} dtype=${dtype} device=${device}`);
const t0 = Date.now();
const asr = await pipeline("automatic-speech-recognition", modelId, { dtype, device });
console.log(`  load: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

for (const c of clips) {
  const { pcm, rate, seconds } = readWav(join(dir, c));
  /* Feeding 22 kHz samples to a 16 kHz model does not fail, it transcribes
     time-stretched audio — which is how a whole round of these numbers was
     collected before anyone noticed the Windows voice writes 22050 Hz. A rate
     mismatch is silent, so it has to be an assertion, not a comment. */
  if (rate !== 16000)
    throw new Error(`${c} is ${rate} Hz — resample first: ffmpeg -i in.wav -ar 16000 -ac 1 out.wav`);
  const t = Date.now();
  const out: any = await asr(pcm, { language: "vietnamese", task: "transcribe" });
  const ms = Date.now() - t;
  console.log(
    `  ${c}  audio ${seconds.toFixed(1)}s → ${(ms / 1000).toFixed(2)}s  RTF ${(ms / 1000 / seconds).toFixed(2)}`,
  );
  console.log(`      ${String(out.text).trim()}`);
}
process.exit(0);
