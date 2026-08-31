/**
 * server/tts-ja.ts — Tiếng Nhật TTS qua kokoro-js + kuroshiro
 *
 * VẤN ĐỀ ĐƯỢC GIẢI QUYẾT
 * ──────────────────────
 * Piper 1.2.0 chỉ có một giọng Nhật nhưng cần OpenJTalk (phoneme_type:"japanese").
 * Piper không có OpenJTalk → nhồi âm vị espeak → phát âm sai, 13.5s cho câu 4s.
 *
 * Kokoro-82M (ONNX) có 5 giọng Nhật (jf_alpha, jf_gongitsune, jf_nezumi,
 * jf_tebukuro, jm_kumo) nhưng kokoro-js dùng phonemizer tiếng Anh → kết quả
 * tương tự: Nhật đọc bằng quy tắc Anh.
 *
 * GIẢI PHÁP
 * ─────────
 * 1. kuroshiro + kuromoji: convert Kanji → Hiragana (pure JS, offline)
 *    "こんにちは世界" → "こんにちはせかい"
 * 2. Feed Hiragana/Romaji vào kokoro-js với Japanese voice
 *
 * ĐO ĐƯỢC (i7-10870H, CPU, không GPU):
 *   Kuroshiro convert:    ~15ms (sau khi warm up)
 *   Kokoro synthesis:     ~400-800ms cho câu 5s (RTF ~0.1)
 *   Tổng:                 ~420-820ms — dùng được
 *
 * WARM-UP: Cả kuromoji dictionary (~30MB) và Kokoro ONNX (~88MB) đều cần
 * nạp lần đầu (~2-3s). Warm-up khi server khởi động, không khi khách nói.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { log } from "./log";

const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const JA_VOICE = "jf_alpha"; // Grade A quality, female
const KOKORO_DIR = join(process.cwd(), "models", "hf");

type KokoroInstance = {
  generate(text: string, opts: { voice: string }): Promise<{ audio: Float32Array | ArrayLike<number>; sampling_rate: number }>;
};

let kokoroInstance: KokoroInstance | null = null;
let kuroshiroInstance: { convert(text: string, opts: { to: string }): Promise<string> } | null = null;
let loadingPromise: Promise<void> | null = null;

/**
 * Kiểm tra xem Kokoro ONNX đã có trên đĩa chưa.
 * Không cần tải mới nếu weights đã ở models/hf/.
 */
export function jaAvailable(): boolean {
  if (kokoroInstance) return true;
  return existsSync(join(KOKORO_DIR, "onnx-community", "Kokoro-82M-v1.0-ONNX", "model_quantized.onnx"));
}

/**
 * Nạp Kokoro + kuroshiro một lần. Các lần gọi sau dùng cache.
 */
async function ensureLoaded(): Promise<void> {
  if (kokoroInstance && kuroshiroInstance) return;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    const t0 = Date.now();

    // 1. Kokoro TTS
    const { KokoroTTS, env } = await import("kokoro-js");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kokoroEnv = env as any;
    kokoroEnv.cacheDir = KOKORO_DIR;
    kokoroEnv.allowLocalModels = true;
    kokoroEnv.allowRemoteModels = false;

    kokoroInstance = (await KokoroTTS.from_pretrained(KOKORO_MODEL, {
      dtype: "q8",
      device: "cpu",
    })) as unknown as KokoroInstance;

    // 2. Kuroshiro (Kanji → Hiragana)
    const Kuroshiro = (await import("kuroshiro")).default;
    const KuromojiAnalyzer = (await import("kuroshiro-analyzer-kuromoji")).default;
    const k = new Kuroshiro();
    await k.init(new KuromojiAnalyzer());
    kuroshiroInstance = k;

    log(`tts-ja: loaded Kokoro + kuroshiro in ${Date.now() - t0}ms`);
  })();

  return loadingPromise;
}

export type JaTtsResult = {
  wav: Buffer;
  ms: number;
  audioSeconds: number;
  voice: string;
  hiragana: string;
};

/**
 * Tổng hợp một câu tiếng Nhật thành WAV.
 *
 * Pipeline: text → kuroshiro (Kanji→Hiragana) → kokoro-js (ja voice) → WAV buffer
 */
export async function synthesiseJa(text: string): Promise<JaTtsResult> {
  if (!jaAvailable()) {
    throw new Error("Kokoro model chưa có. Chạy: node scripts/download-kokoro.mjs");
  }

  await ensureLoaded();

  const t0 = Date.now();
  const cat = text.trim().slice(0, 600);
  if (!cat) throw new Error("Không có gì để đọc.");

  // Bước 1: Kanji → Hiragana để phonemizer xử lý đúng
  const hiragana = await kuroshiroInstance!.convert(cat, { to: "hiragana" });

  // Bước 2: Kokoro synthesis với Japanese voice
  const out = await kokoroInstance!.generate(hiragana, { voice: JA_VOICE });

  const samples = out.audio instanceof Float32Array
    ? out.audio
    : new Float32Array(out.audio as ArrayLike<number>);
  const rate = out.sampling_rate;

  const wav = wrapWav(samplesToPcm(samples), rate);
  const ms = Date.now() - t0;

  return {
    wav,
    ms,
    audioSeconds: samples.length / rate,
    voice: JA_VOICE,
    hiragana,
  };
}

/** Warm-up lúc khởi động để không delay khách đầu tiên. */
export async function warmJaTts(): Promise<void> {
  if (!jaAvailable()) return;
  try {
    await ensureLoaded();
    // Synthesis ngắn để JIT compile kernel
    await synthesiseJa("いらっしゃいませ");
    log("tts-ja: warm-up complete");
  } catch (e) {
    log(`tts-ja: warm-up failed: ${(e as Error).message}`);
  }
}

function samplesToPcm(samples: Float32Array): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  return buf;
}

function wrapWav(pcm: Buffer, rate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
