/**
 * Offline speech-to-text.
 *
 * This is the half of "voice" that genuinely needs a model on the server. The
 * other half does not: reading a reply aloud is done by the guest's own device
 * (`client/src/lib/speech.ts`), instantly and for free. Recognition cannot be,
 * unless the audio is shipped to Google — which is what the browser's Web
 * Speech API quietly does, and is the reason it was rejected.
 *
 * WHAT WAS MEASURED, on this box (i7-10870H, CPU only, q8, 4-5s clips of
 * Vietnamese; real-time factor = seconds of compute per second of speech):
 *
 *     whisper-tiny        RTF 0.31   unusable — "trả phòng muộn" came back
 *                                    as "Đúng rồi, mọi người"
 *     whisper-base        RTF 0.55   still wrong on most content words
 *     whisper-small       RTF 0.89   usable
 *     PhoWhisper-small    RTF 0.76   best Vietnamese: "cho tôi đặt bàn ăn tối
 *                                    lúc bảy giờ cho hai người" exactly right
 *
 * So the floor for usable Vietnamese is a `small`, and a `small` costs roughly
 * three quarters of the utterance in wall clock. A ten-second question is ~8s
 * of recognition BEFORE the concierge starts thinking. That is the number to
 * design around; it is not going to be hidden by a spinner.
 *
 * WHY TWO MODELS. PhoWhisper is a Vietnamese fine-tune of Whisper — it is not
 * multilingual, and Korean spoken into it comes back as Vietnamese-shaped
 * nonsense rather than as an error. So the model is chosen by the language the
 * conversation is already in, and only Vietnamese gets the specialist.
 *
 * WHY ONE AT A TIME. This machine has under 1 GB of RAM free against 23 GB
 * committed. Holding both pipelines is ~500 MB of resident weights it does not
 * have, so the cache keeps `STT_MODEL_CACHE` (default 1) and evicts the rest.
 * A language switch therefore costs one reload, measured at 1.7s warm.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as OpenCC from "opencc-js";
import { log } from "./log";

/**
 * Whisper's Chinese output defaults toward Traditional characters regardless
 * of what script the audio's SPEAKER actually uses — Mandarin pronunciation is
 * identical either way, so this is purely a training-data-mix artefact, not a
 * recognition error. Bắt được qua audit 2026-09-05: vòng khép kín tiếng Trung
 * đo CER 21%, nhưng phần lớn "sai" hoá ra chỉ là biến thể chữ viết —
 * "供应"→"供應", "点"→"點", "两"→"兩", "厅"→"廳" — nghĩa giống hệt, chỉ khác
 * phồn thể/giản thể. Tài liệu và nội dung của resort này viết bằng giản thể
 * (xem final_benchmark_zh.csv, kb tiếng Trung), nên đưa STT về cùng quy ước
 * TRƯỚC khi văn bản tới LLM — nếu không, một câu khách dictate đúng 100% vẫn
 * có thể làm lệch truy xuất chỉ vì khác bộ chữ với tài liệu.
 *
 * Chỉ chuyển ĐÚNG MỘT CHIỀU (phồn → giản). Không đoán ngược lại vì Chuẩn hoá
 * hai chiều dễ phá hỏng những câu đã đúng giản thể từ đầu.
 */
const zhConverter = OpenCC.Converter({ from: "tw", to: "cn" });

/** Sample rate every Whisper variant expects. Audio arrives already resampled. */
export const STT_SAMPLE_RATE = 16000;

/** Longest clip accepted, in seconds. Whisper's own window is 30s. */
export const STT_MAX_SECONDS = 30;

export type SttLang = "vi" | "en" | "ko" | "ja" | "zh" | "ru";

const MULTILINGUAL = process.env.STT_MODEL ?? "onnx-community/whisper-small";
const VIETNAMESE = process.env.STT_MODEL_VI ?? "huuquyet/PhoWhisper-small";
/**
 * Đo trực tiếp trên máy này, 10 câu tiếng Hàn thật (bench/voice-eval.ts),
 * so với whisper-small đa ngôn ngữ đang dùng cho mọi ngôn ngữ khác:
 *
 *   whisper-small (đa ngôn ngữ)   WER 45,2%  CER 17,6%  số liệu 50%
 *   moonshine-tiny-ko (chuyên)    WER 32,1%  CER 11,3%  số liệu 70%   RTF ~4-5 lần nhanh hơn
 *
 * Thắng ở MỌI chỉ số, đúng lý do PhoWhisper tồn tại cho tiếng Việt — model
 * chuyên biệt cho một ngôn ngữ luôn thắng model đa ngôn ngữ dùng chung khi có
 * sẵn. Đã thử cả `moonshine-base-ko` (61M, gấp đôi tham số): WER 38,1% — THUA
 * bản tiny (27M) trên cùng bộ 10 câu, nên chọn tiny (nhỏ hơn, nhanh hơn, đo
 * tốt hơn — không có lý do chọn bản lớn hơn).
 */
const KOREAN = process.env.STT_MODEL_KO ?? "onnx-community/moonshine-tiny-ko-ONNX";

/** Whisper's own language names, which are not the ISO codes used elsewhere. */
const WHISPER_LANG: Record<SttLang, string> = {
  vi: "vietnamese",
  en: "english",
  ko: "korean",
  ja: "japanese",
  zh: "chinese",
  ru: "russian",
};

export const STT_LANGS = Object.keys(WHISPER_LANG) as SttLang[];

export function isSttLang(v: unknown): v is SttLang {
  return typeof v === "string" && (STT_LANGS as string[]).includes(v);
}

export function modelFor(lang: SttLang): string {
  return lang === "vi" ? VIETNAMESE : lang === "ko" ? KOREAN : MULTILINGUAL;
}

/** Moonshine models need their own loading path — see `pipelineFor`. */
function isMoonshine(modelId: string): boolean {
  return modelId.includes("moonshine");
}

/* ------------------------------------------------------------------ audio */

export type Pcm = { samples: Float32Array; rate: number; seconds: number };

/**
 * Decode 16-bit PCM WAV.
 *
 * The client sends WAV rather than the browser's native webm/opus on purpose:
 * decoding opus on the server would mean an ffmpeg dependency and a subprocess
 * per utterance, while the browser already has a decoder and a resampler in
 * `AudioContext`. Doing it there costs the phone a few milliseconds and costs
 * this server nothing.
 */
export function decodeWav(buf: Buffer): Pcm {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE")
    throw new Error("Not a WAV file.");

  let off = 12;
  let rate = 0;
  let bits = 0;
  let channels = 0;
  let format = 0;
  let data: Buffer | null = null;

  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    /* A truncated final chunk is a broken upload, not a reason to read past the
       end of the buffer. */
    const body = buf.subarray(off + 8, Math.min(off + 8 + size, buf.length));
    if (id === "fmt " && body.length >= 16) {
      format = body.readUInt16LE(0);
      channels = body.readUInt16LE(2);
      rate = body.readUInt32LE(4);
      bits = body.readUInt16LE(14);
    } else if (id === "data") {
      data = body;
    }
    off += 8 + size + (size % 2);
  }

  if (format !== 1) throw new Error(`Only uncompressed PCM is accepted (format ${format}).`);
  if (bits !== 16) throw new Error(`Only 16-bit samples are accepted (got ${bits}).`);
  if (!channels) throw new Error("WAV declares no channels.");
  if (!data || data.length < 2) throw new Error("WAV carries no audio.");

  /* Mix to mono. A phone can hand us stereo, and Whisper's feature extractor
     silently takes only the first channel — which on some devices is the
     quieter one. */
  const frames = Math.floor(data.length / 2 / channels);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += data.readInt16LE((i * channels + c) * 2);
    samples[i] = sum / channels / 32768;
  }
  return { samples, rate, seconds: frames / rate };
}

/**
 * Is there any speech here at all?
 *
 * A guest who taps the mic and says nothing should get silence back, not
 * Whisper's opinion of thirty seconds of room tone — the model pads short input
 * and then narrates the padding. RMS is crude but it is the cheap half of the
 * defence; `cleanTranscript` is the other half.
 */
export function hasSignal(pcm: Pcm, floor = 0.005): boolean {
  let sum = 0;
  for (let i = 0; i < pcm.samples.length; i++) sum += pcm.samples[i] * pcm.samples[i];
  return pcm.samples.length > 0 && Math.sqrt(sum / pcm.samples.length) >= floor;
}

/* ---------------------------------------------------------------- runtime */

type Asr = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text?: string }>;

const CACHE_SIZE = Math.max(1, Number(process.env.STT_MODEL_CACHE ?? 1));
const loaded = new Map<string, Asr>();
/* Concurrent requests for the same cold model must not each start a download. */
const loading = new Map<string, Promise<Asr>>();

async function loadPipeline(modelId: string): Promise<Asr> {
  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = modelDir();
  return (await pipeline("automatic-speech-recognition", modelId, {
    dtype: (process.env.STT_DTYPE ?? "q8") as never,
    device: (process.env.STT_DEVICE ?? "cpu") as never,
  })) as unknown as Asr;
}

/**
 * Moonshine không đi qua `pipeline()` được — bắt được qua đo thật, không phải
 * suy luận: `AutoProcessor.from_pretrained()` của Moonshine trong
 * `@huggingface/transformers@3.8.1` không gắn tokenizer con vào processor
 * (`processor.tokenizer` là `undefined` dù `tokenizer.json` có sẵn trên đĩa và
 * tự nạp riêng vẫn chạy tốt), nên bước giải mã nội bộ của pipeline luôn ném
 * `Unable to decode without a tokenizer`. Nạp ba phần riêng rồi tự giải mã.
 */
async function loadMoonshine(modelId: string): Promise<Asr> {
  const { AutoTokenizer, AutoProcessor, AutoModelForSpeechSeq2Seq, env } = await import("@huggingface/transformers");
  env.cacheDir = modelDir();
  const dtype = (process.env.STT_DTYPE ?? "q8") as never;
  const device = (process.env.STT_DEVICE ?? "cpu") as never;
  const [tokenizer, processor, model] = await Promise.all([
    AutoTokenizer.from_pretrained(modelId),
    AutoProcessor.from_pretrained(modelId),
    AutoModelForSpeechSeq2Seq.from_pretrained(modelId, { dtype, device }),
  ]);
  return async (audio: Float32Array) => {
    const inputs = await processor(audio);
    /**
     * Công thức của chính paper Moonshine ("6 token/giây âm thanh") cắt cụt
     * giữa câu trên câu hỏi khách sạn thật — đo được: "...왜 청구서에 포함되어
     * 있�" (mất chữ cuối). Model tự dừng ở token kết thúc câu nên nới rộng
     * ngân sách không tốn thêm gì khi câu ngắn; chỉ có hại khi ngân sách CHẶT.
     */
    const seconds = audio.length / STT_SAMPLE_RATE;
    const max_new_tokens = Math.max(32, Math.floor(seconds * 20) + 20);
    const outputs = await model.generate({ max_new_tokens, ...inputs });
    const text = tokenizer.batch_decode(outputs as any, { skip_special_tokens: true })[0] ?? "";
    return { text };
  };
}

async function pipelineFor(modelId: string): Promise<Asr> {
  const hit = loaded.get(modelId);
  if (hit) {
    /* Refresh recency so the LRU below evicts the model nobody is using. */
    loaded.delete(modelId);
    loaded.set(modelId, hit);
    return hit;
  }
  const inflight = loading.get(modelId);
  if (inflight) return inflight;

  const p = (async () => {
    /* Weights live with the repo, not in a user-profile cache, so a deployment
       is one directory and an air-gapped box can be seeded by copying it. */
    const t0 = Date.now();
    const asr = isMoonshine(modelId) ? await loadMoonshine(modelId) : await loadPipeline(modelId);
    log(`stt: loaded ${modelId} in ${Date.now() - t0}ms`);
    loaded.set(modelId, asr);
    while (loaded.size > CACHE_SIZE) {
      const oldest = loaded.keys().next().value as string;
      loaded.delete(oldest);
      log(`stt: evicted ${oldest} (cache ${CACHE_SIZE})`);
    }
    return asr;
  })();

  loading.set(modelId, p);
  try {
    return await p;
  } finally {
    loading.delete(modelId);
  }
}

export function modelDir(): string {
  return process.env.STT_MODEL_DIR ?? join(process.cwd(), "models", "hf");
}

export type Transcript = {
  text: string;
  model: string;
  lang: SttLang;
  audioSeconds: number;
  ms: number;
  /** Compute seconds per second of speech — the number that decides usability. */
  rtf: number;
};

/**
 * Transcribe one utterance.
 *
 * The language is passed explicitly rather than detected. Whisper's own
 * detection is a guess made from the first seconds of audio, and on a short
 * hotel utterance it guesses wrong often enough to matter; the kiosk already
 * knows which language the conversation is in, so it says so.
 */
export async function transcribe(pcm: Pcm, lang: SttLang): Promise<Transcript> {
  if (pcm.rate !== STT_SAMPLE_RATE)
    throw new Error(`Audio must be ${STT_SAMPLE_RATE} Hz, got ${pcm.rate}.`);
  if (pcm.seconds > STT_MAX_SECONDS)
    throw new Error(`Clip is ${pcm.seconds.toFixed(1)}s; the limit is ${STT_MAX_SECONDS}s.`);

  const model = modelFor(lang);
  const base = { model, lang, audioSeconds: pcm.seconds };

  if (!hasSignal(pcm)) return { ...base, text: "", ms: 0, rtf: 0 };

  const asr = await pipelineFor(model);
  const t0 = Date.now();
  const out = await asr(pcm.samples, {
    language: WHISPER_LANG[lang],
    task: "transcribe",
    /* Greedy. Beam search costs multiples of the RTF above for a gain that does
       not survive on four-second requests. */
    do_sample: false,
  });
  const ms = Date.now() - t0;

  let text = String(out.text ?? "");
  if (lang === "zh") text = zhConverter(text);

  return {
    ...base,
    text: cleanTranscript(text),
    ms,
    rtf: pcm.seconds > 0 ? ms / 1000 / pcm.seconds : 0,
  };
}

/**
 * Strip the artefacts Whisper produces on near-silence.
 *
 * Three are common enough to be worth handling: bracketed non-speech tags such
 * as `[Music]` or `(tiếng nhạc)`, which are the model describing the audio
 * rather than transcribing it; a short phrase looped three or more times back
 * to back, which is the decoder repeating itself on padding; and the whole
 * utterance said exactly twice, which is a distinct failure mode caught in
 * moonshine-tiny-ko once its token budget was widened past the paper's own
 * "6 tokens/sec" cap to stop truncating real Korean sentences — bên dưới.
 * Neither is something a guest said.
 */
export function cleanTranscript(raw: string): string {
  let t = raw.replace(/[[(（【][^\])）】]{0,40}[\])）】]/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  if (!t) return "";

  const words = t.split(" ");
  if (words.length >= 6) {
    /* Collapse a short phrase repeated back to back three or more times. */
    for (let n = 1; n <= Math.min(6, Math.floor(words.length / 3)); n++) {
      const unit = words.slice(0, n).join(" ").toLowerCase();
      let reps = 1;
      while (
        reps * n + n <= words.length &&
        words
          .slice(reps * n, reps * n + n)
          .join(" ")
          .toLowerCase() === unit
      )
        reps++;
      if (reps >= 3 && reps * n === words.length) return words.slice(0, n).join(" ");
    }
  }

  /**
   * Collapse a whole sentence said exactly twice.
   *
   * A different shape from the loop above on purpose: that one needs three-plus
   * repeats of a SHORT unit (≤6 words) — real silence-padding loops repeat a
   * lot, so `reps>=3` filters out a guest genuinely saying "thank you thank
   * you". A hallucinated full-sentence echo repeats only ONCE more, so it needs
   * its own rule; and requiring at least 4 words per half is what keeps a real
   * short doubled phrase ("no no", "please please") from being swallowed here.
   * Caught live: moonshine-tiny-ko on "저희 방은 성인 두 명과 다섯 살
   * 어린이 한 명입니다." → the same 9-word sentence twice, back to back.
   */
  if (words.length >= 8 && words.length % 2 === 0) {
    const half = words.length / 2;
    if (half >= 4 && words.slice(0, half).join(" ").toLowerCase() === words.slice(half).join(" ").toLowerCase())
      return words.slice(0, half).join(" ");
  }

  return t;
}

/** Load the model the property will use most, so the first guest does not wait. */
export async function warmStt(lang: SttLang = "vi"): Promise<void> {
  try {
    await pipelineFor(modelFor(lang));
  } catch (e) {
    log(`stt: warm-up failed: ${(e as Error).message}`);
  }
}

/**
 * Are the weights on disk?
 *
 * The kiosk asks before showing a microphone. Offering one that would trigger a
 * 240 MB download mid-conversation, on hotel wifi, is worse than not offering
 * it — the guest taps, waits eight minutes, and concludes the product is broken.
 */
export function sttAvailable(): boolean {
  if (loaded.size > 0) return true;
  /* transformers.js lays the cache out as <cacheDir>/<org>/<name>. */
  const dir = modelDir();
  return STT_LANGS.some((l) => existsSync(join(dir, modelFor(l))));
}
