/**
 * Kokoro-82M in Node: how fast, and which languages does the JS port actually
 * ship? The answer to the second question decides whether it can replace the
 * device voices at all.
 *
 *   npx tsx bench/tts-probe.ts
 */
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { env } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";

env.cacheDir = join(process.cwd(), "models", "hf");

const t0 = Date.now();
const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
  dtype: "q8",
  device: "cpu",
});
console.log(`load: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const langs = new Set(Object.values(tts.voices as Record<string, any>).map((v) => v.language));
console.log(`voices: ${Object.keys(tts.voices as object).length}  languages: ${[...langs].join(", ")}`);

const CASES: Array<[string, string, string]> = [
  ["en-short", "af_heart", "Breakfast is served until half past ten in the Lotus Restaurant."],
  ["en-long", "af_heart", "Breakfast is served from six until half past ten in the Lotus Restaurant. The buffet is six hundred and fifty thousand dong for adults, and three hundred and seventy five thousand for children under twelve."],
  ["vi-through-en", "af_heart", "Bữa sáng phục vụ đến mười giờ rưỡi tại nhà hàng Lotus."],
];

for (const [name, voice, text] of CASES) {
  const t = Date.now();
  const audio: any = await tts.generate(text, { voice: voice as any });
  const ms = Date.now() - t;
  const seconds = audio.audio.length / audio.sampling_rate;
  console.log(
    `  ${name.padEnd(15)} ${text.length} chars → ${(ms / 1000).toFixed(2)}s synth for ${seconds.toFixed(1)}s audio  RTF ${(ms / 1000 / seconds).toFixed(2)}`,
  );
  writeFileSync(join(process.env.TTS_OUT!, `${name}.wav`), Buffer.from(audio.toWav()));
}
process.exit(0);
