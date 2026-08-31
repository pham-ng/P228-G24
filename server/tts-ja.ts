/**
 * server/tts-ja.ts — TTS tiếng Nhật: âm vị từ Python, giọng từ Kokoro ONNX.
 *
 * VÌ SAO TIẾNG NHẬT KHÔNG ĐI CHUNG ĐƯỜNG VỚI NĂM NGÔN NGỮ KIA
 *
 * Piper đọc vi/en/ko/zh/ru tốt, nhưng giọng Nhật duy nhất trong kho
 * `rhasspy/piper-voices` khai `phoneme_type: "japanese"` — cần OpenJTalk, mà
 * Piper 1.2.0 không có. Đo được: câu tám chữ ra 7,9 giây âm thanh (tiếng Việt
 * cùng độ dài: 1,8 giây), kèm cảnh báo thiếu âm vị, và Whisper nghe lại ra
 * `チャイニゼート、チャイニゼート…` — âm tiết vô nghĩa lặp lại. Không phải chậm,
 * là sai hẳn.
 *
 * ĐƯỜNG ĐI HIỆN TẠI, VÀ HAI NGÕ CỤT ĐÃ LOẠI TRỪ TRƯỚC KHI CHỌN NÓ
 *
 *   1. `kokoro-js` + chữ Nhật thẳng → phiên âm bằng quy tắc tiếng Anh.
 *      Hiragana: 15,2 giây âm thanh cho câu 2,5 giây, Whisper nghe ra
 *      "japanese letter" — tức không nhận ra là tiếng nói.
 *   2. `kokoro-js` + romaji → đúng độ dài (2,3 giây) nhưng Whisper phiên ra
 *      `CHA-SHOKUWAITSUME DISUKA`: chữ Latin, giọng Anh đọc phiên âm. Khách
 *      Nhật không hiểu.
 *   3. **Cách đang dùng**: misaki[ja] + pyopenjtalk sinh âm vị tiếng Nhật thật,
 *      rồi đưa thẳng vào Kokoro bằng `generate_from_ids`. Whisper nghe lại
 *      `朝食は何時までですか` — nguyên văn.
 *
 * BA CHI TIẾT KHIẾN NÓ CHẠY ĐƯỢC
 *
 *   · `generate_from_ids` KHÔNG gọi `_validate_voice`. Bảng metadata của
 *     `kokoro-js` chỉ liệt kê 28 giọng en-us/en-gb, nên `generate()` từ chối
 *     `jf_alpha` — nhưng gói vẫn **có sẵn đủ 54 tệp giọng** trên đĩa, gồm năm
 *     giọng Nhật. Vào bằng cửa token là dùng được, không phải tải thêm gì.
 *   · Python chỉ làm PHIÊN ÂM, không tổng hợp. Không có torch trong venv, nên
 *     nạp nguội chỉ 371–523 ms và venv chỉ 94 MB.
 *   · Tiến trình con chạy một lần rồi thoát, giống Piper. Máy này còn khoảng
 *     1 GB RAM trống; một worker thường trú sẽ lấy chỗ của Piper và của model
 *     trả lời, mà chi phí tiết kiệm được chỉ là ~400 ms trên tổng ~3,6 giây.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log";

const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
/** Giọng nữ, hạng A trong bảng chất lượng của Kokoro. */
const JA_VOICE = "jf_alpha";
const KOKORO_DIR = join(process.cwd(), "models", "hf");

const VENV = process.env.JA_TTS_VENV ?? join(process.cwd(), ".venv-tts-ja");
const PY = join(VENV, "Scripts", process.platform === "win32" ? "python.exe" : "python");
const PY_POSIX = join(VENV, "bin", "python");
const G2P_SCRIPT = join(process.cwd(), "scripts", "ja-g2p.py");

/** Câu dài nhất chấp nhận, khớp với TTS_MAX_CHARS của Piper. */
const MAX_CHARS = 600;
/** Bỏ cuộc nếu phiên âm treo. Nạp nguội đo được 523 ms; 15 giây là rất rộng. */
const G2P_TIMEOUT_MS = 15_000;

type KokoroInstance = {
  tokenizer(text: string, opts: { truncation: boolean }): { input_ids: unknown };
  generate_from_ids(
    ids: unknown,
    opts: { voice: string },
  ): Promise<{ audio: Float32Array; sampling_rate: number }>;
};

let kokoro: KokoroInstance | null = null;
let loading: Promise<void> | null = null;

/**
 * Đặt `true` CHỈ SAU KHI một lần tổng hợp thật đã thành công.
 *
 * Sự tồn tại của tệp không chứng minh được gì, và bản trước của tệp này đã dạy
 * đúng bài đó theo cả hai chiều: một phép kiểm sai một đoạn đường dẫn (`onnx/`)
 * khiến toàn bộ phần tích hợp đúng đắn nằm im, rồi khi sửa đường dẫn thì nó
 * quảng cáo `ja` trong lúc `generate()` vẫn ném `Voice "jf_alpha" not found` —
 * nút loa hiện ra và im lặng, tệ hơn là không có nút.
 *
 * Cờ này biến `jaAvailable()` thành câu hỏi "đã đọc được một câu chưa", và đó
 * là câu hỏi duy nhất đáng hỏi.
 */
let jaReady = false;

function pythonBin(): string | null {
  if (existsSync(PY)) return PY;
  if (existsSync(PY_POSIX)) return PY_POSIX;
  return null;
}

/** Điều kiện CẦN để bõ công warm-up — không phải điều kiện đủ để công bố. */
function prerequisitesOnDisk(): boolean {
  return (
    !!pythonBin() &&
    existsSync(G2P_SCRIPT) &&
    existsSync(join(KOKORO_DIR, "onnx-community", "Kokoro-82M-v1.0-ONNX", "onnx", "model_quantized.onnx"))
  );
}

export function jaAvailable(): boolean {
  return jaReady;
}

/* ------------------------------------------------------------- phiên âm */

/**
 * Chữ Nhật → âm vị, qua tiến trình con Python.
 *
 * Văn bản đi qua **stdin**, không qua tham số dòng lệnh: đường dẫn dự án này có
 * dấu tiếng Việt và gạch dài, và cùng lớp lỗi mã hoá đó đã từng làm Piper chết
 * với `0xC0000409` và stderr rỗng. stdin là luồng byte, không đi qua bộ phân
 * tích dòng lệnh của Windows.
 */
function toPhonemes(text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const bin = pythonBin();
    if (!bin) return reject(new Error("Chưa có venv tiếng Nhật — xem docs/SETUP-VOICE.md"));

    const p = spawn(bin, [G2P_SCRIPT], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error("phiên âm tiếng Nhật quá hạn"));
    }, G2P_TIMEOUT_MS);

    p.stdout.setEncoding("utf8");
    p.stderr.setEncoding("utf8");
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`g2p thoát ${code}: ${err.slice(0, 200)}`));
      const ps = out.trim();
      if (!ps) return reject(new Error("g2p trả về chuỗi rỗng"));
      resolve(ps);
    });

    p.stdin.end(text, "utf8");
  });
}

/* ------------------------------------------------------------ tổng hợp */

async function ensureKokoro(): Promise<void> {
  if (kokoro) return;
  if (loading) return loading;
  loading = (async () => {
    const t0 = Date.now();
    const { KokoroTTS, env } = await import("kokoro-js");
    const e = env as unknown as { cacheDir: string; allowLocalModels: boolean; allowRemoteModels: boolean };
    e.cacheDir = KOKORO_DIR;
    e.allowLocalModels = true;
    /* Ngoại tuyến là một lời hứa của sản phẩm này, không phải tuỳ chọn. */
    e.allowRemoteModels = false;
    kokoro = (await KokoroTTS.from_pretrained(KOKORO_MODEL, {
      dtype: "q8",
      device: "cpu",
    })) as unknown as KokoroInstance;
    log(`tts-ja: nạp Kokoro trong ${Date.now() - t0}ms`);
  })();
  return loading;
}

export type JaTtsResult = {
  wav: Buffer;
  ms: number;
  audioSeconds: number;
  voice: string;
  phonemes: string;
};

export async function synthesiseJa(text: string): Promise<JaTtsResult> {
  if (!jaAvailable()) throw new Error("Tiếng Nhật chưa dùng được — xem log tts-ja lúc khởi động.");
  return synthesiseJaRaw(text);
}

/**
 * Lõi tổng hợp, KHÔNG kiểm `jaAvailable()`.
 *
 * Tách ra vì warm-up phải gọi được trước khi cờ sẵn sàng bật lên — nếu phép
 * kiểm và phép chứng minh cùng chờ nhau thì tiếng Nhật không bao giờ bật.
 */
async function synthesiseJaRaw(text: string): Promise<JaTtsResult> {
  const cat = text.trim().slice(0, MAX_CHARS);
  if (!cat) throw new Error("Không có gì để đọc.");

  const t0 = Date.now();
  const phonemes = await toPhonemes(cat);
  await ensureKokoro();

  const { input_ids } = kokoro!.tokenizer(phonemes, { truncation: true });
  const out = await kokoro!.generate_from_ids(input_ids, { voice: JA_VOICE });

  const samples = out.audio;
  const rate = out.sampling_rate;
  return {
    wav: wrapWav(samplesToPcm(samples), rate),
    ms: Date.now() - t0,
    audioSeconds: samples.length / rate,
    voice: JA_VOICE,
    phonemes,
  };
}

/**
 * Warm-up lúc khởi động — và đồng thời là bằng chứng.
 *
 * Một câu thật, không phải chuỗi rỗng: nếu nó trả về âm thanh thì cả đường
 * Python lẫn đường ONNX đều chạy, và chỉ khi đó `ja` mới được công bố.
 */
export async function warmJaTts(): Promise<void> {
  /**
   * Tắt được bằng một biến môi trường, và có lý do vận hành cụ thể.
   *
   * Kokoro chạy ONNX NGAY TRONG tiến trình Node, nên nó khoá vòng lặp sự kiện
   * suốt thời gian tổng hợp: đo được một câu trả lời tiếng Nhật dài làm cả
   * server đứng im **15–28 giây** — mọi khách khác, mọi trang nhân viên, đều
   * treo. Piper không bị vì nó là tiến trình con.
   *
   * Khi mở ra Internet cho nhiều người thử cùng lúc, một lượt tiếng Nhật là đủ
   * để cả nhóm nghĩ dịch vụ chết. Đặt `TTS_JA=0` cho tới khi Kokoro được đưa
   * sang worker thread; tiếng Nhật khi đó rơi về `speechSynthesis` của máy
   * khách — mà điện thoại Nhật thì luôn có giọng Nhật.
   */
  if (process.env.TTS_JA === "0") {
    log("tts-ja: TẮT theo TTS_JA=0 — tiếng Nhật dùng giọng của máy khách");
    return;
  }
  if (!prerequisitesOnDisk()) {
    log("tts-ja: thiếu venv hoặc trọng số Kokoro — tiếng Nhật tắt");
    return;
  }
  try {
    const probe = await synthesiseJaRaw("いらっしゃいませ");
    if (!probe.wav.length) throw new Error("tổng hợp trả về 0 byte");
    jaReady = true;
    log(`tts-ja: sẵn sàng — giọng ${JA_VOICE}, thử ${probe.ms}ms cho ${probe.audioSeconds.toFixed(1)}s`);
  } catch (e) {
    jaReady = false;
    /* Trả lại bộ nhớ: Kokoro có thể đã nạp xong trước khi bước sau hỏng, và
       giữ 88 MB trọng số cho một tính năng đã tự tuyên bố là hỏng là lấy chỗ
       của Piper. */
    kokoro = null;
    loading = null;
    log(`tts-ja: KHÔNG dùng được, đã trả lại bộ nhớ — ${(e as Error).message}`);
  }
}

/* ---------------------------------------------------------------- WAV */

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
