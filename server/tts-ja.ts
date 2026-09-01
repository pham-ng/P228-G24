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
 *   · Phiên âm chạy bằng tiến trình con một-lần-rồi-thoát, giống Piper.
 *
 * VÌ SAO KOKORO CHẠY TRONG MỘT TIẾN TRÌNH RIÊNG, THƯỜNG TRÚ
 *
 * Bản đầu của tệp này chạy Kokoro thẳng trong luồng chính, kèm lập luận rằng
 * một tiến trình thường trú sẽ lấy mất RAM của Piper. **Lập luận đó sai**, và
 * phép đo cho thấy sai ở đâu: Node chạy mọi JavaScript trên MỘT luồng, nên suy
 * luận ONNX đồng bộ ngay trong luồng đó làm cả server đứng im. Đo được một câu
 * dài khoá **15–28 giây** — trong khoảng đó chỉ 5 lần ping lọt thay vì ~100.
 *
 * Bản sửa thứ hai dùng `worker_threads`. Nó GIẢI QUYẾT được chuyện khoá — cùng
 * phép đo cho 160 ping lọt, trung vị 2 ms, tệ nhất 161 ms. Nhưng nó mang theo
 * một khiếm khuyết riêng, và chỉ lộ ra khi chạy bộ kiểm thử:
 *
 *     `process.exit()` gọi trong lúc Kokoro đang nạp → tiến trình thoát **127**
 *
 * Tái hiện được bằng một script mười dòng, và `terminate()` trong handler `exit`
 * cũng không cứu được (đã thử, vẫn 127). Mã thoát bẩn không phải chuyện nhỏ: CI
 * và trình giám sát tiến trình đều đọc nó để biết lần chạy vừa rồi có sạch không.
 *
 * Tiến trình con không có vấn đề đó — bộ nhớ riêng, cha thoát thì nó chỉ bị mồ
 * côi rồi được hệ điều hành dọn. Và khác với Piper (chạy-một-lần-rồi-thoát vì
 * nhị phân nạp nhanh), tiến trình này **sống lâu** nên không phải trả 1,5–3,1
 * giây nạp model cho từng câu.
 *
 * Tổng hợp vẫn chậm như cũ (RTF ~1,4 trên CPU). Tách ra không làm nó nhanh hơn,
 * chỉ khiến nó không còn kéo theo ai.
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

/** Đường tới worker. Tệp rời trên đĩa, không nằm trong bản đóng gói — xem
 *  phần đầu `server/tts-ja-worker.mjs` để biết vì sao. */
const WORKER_FILE = join(process.cwd(), "server", "tts-ja-worker.mjs");

/**
 * Bỏ cuộc nếu worker không trả lời.
 *
 * Câu dài nhất đo được trên CPU của máy phát triển là 28 giây. 60 giây là rộng
 * gấp đôi, và vẫn đủ chặt để một worker kẹt bị phát hiện thay vì giữ lời hứa
 * treo mãi.
 */
const WORKER_TIMEOUT_MS = 60_000;

let worker: import("node:child_process").ChildProcessWithoutNullStreams | null = null;
let idKe = 0;
type DangCho = { resolve: (v: { pcm: Buffer; rate: number }) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
const dangCho = new Map<number, DangCho>();

/** Huỷ mọi lời hứa còn treo khi worker chết, rồi mở đường cho lần sau dựng lại.
 *  Thiếu bước này thì một worker sập biến thành một loạt yêu cầu treo vĩnh viễn. */
function workerChet(ly: string) {
  worker = null;
  for (const [, c] of dangCho) {
    clearTimeout(c.timer);
    c.reject(new Error(`worker tiếng Nhật dừng: ${ly}`));
  }
  dangCho.clear();
}

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

/**
 * Dựng worker nếu chưa có. Model nằm THƯỜNG TRÚ trong đó.
 *
 * Không nạp lại mỗi câu — Kokoro nạp mất 1,5–3,1 giây (đo được), và trả cái giá
 * đó cho từng lượt là đúng lý do người ta hay chọn nhầm tiến trình con ở đây.
 * Đổi lại là ~88 MB thường trú, rẻ trên bất kỳ máy nào chạy nổi model trả lời.
 */
function ensureWorker() {
  if (worker) return worker;
  const w = spawn(process.execPath, [WORKER_FILE], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      /* Cấu hình đi qua biến môi trường, không qua tham số dòng lệnh: đường dẫn
         dự án này có dấu tiếng Việt và gạch dài, và cùng lớp lỗi mã hoá đó đã
         từng làm Piper chết với `0xC0000409` và stderr rỗng. */
      JA_WORKER_CONFIG: JSON.stringify({
        cacheDir: KOKORO_DIR,
        model: KOKORO_MODEL,
        dtype: "q8",
        device: "cpu",
      }),
    },
  });

  /* Gom theo DÒNG, không theo chunk. Một phản hồi là ~2,5 MB base64 nên nó
     chắc chắn tới thành nhiều mảnh, và xử lý từng chunk sẽ cắt đôi JSON. */
  let dem = "";
  w.stdout.setEncoding("utf8");
  w.stdout.on("data", (chunk: string) => {
    dem += chunk;
    let i: number;
    while ((i = dem.indexOf("\n")) >= 0) {
      const line = dem.slice(0, i);
      dem = dem.slice(i + 1);
      if (!line.trim()) continue;
      let m: { id: number; ok: boolean; rate?: number; pcm?: string; error?: string };
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      const cho = dangCho.get(m.id);
      if (!cho) continue;
      dangCho.delete(m.id);
      clearTimeout(cho.timer);
      if (m.ok && m.pcm && m.rate) cho.resolve({ pcm: Buffer.from(m.pcm, "base64"), rate: m.rate });
      else cho.reject(new Error(m.error ?? "worker tiếng Nhật không nói lý do"));
    }
  });

  /* stderr là nơi worker và các thư viện của nó nói chuyện. Ghi lại để một lần
     nạp model hỏng còn có manh mối, nhưng đừng để nó lẫn vào giao thức. */
  w.stderr.setEncoding("utf8");
  w.stderr.on("data", (d: string) => {
    const s = d.trim();
    if (s) log(`tts-ja[worker]: ${s.slice(0, 200)}`);
  });

  w.on("error", (e) => {
    log(`tts-ja: không chạy được worker — ${e.message}`);
    workerChet(e.message);
  });
  w.on("close", (code) => {
    if (code !== 0) log(`tts-ja: worker thoát ${code}`);
    workerChet(`thoát ${code}`);
  });
  /* Đừng giữ tiến trình cha sống chỉ vì worker còn đó. Khác với worker thread,
     tiến trình con không kéo theo cha khi cha thoát đột ngột — đó chính là lý
     do đổi sang cách này. */
  w.unref();
  worker = w;
  return w;
}

/** Gửi một câu sang worker và chờ âm thanh. */
function tongHopTrongWorker(phonemes: string, voice: string): Promise<{ pcm: Buffer; rate: number }> {
  const w = ensureWorker();
  const id = ++idKe;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      dangCho.delete(id);
      reject(new Error("worker tiếng Nhật quá thời gian."));
    }, WORKER_TIMEOUT_MS);
    dangCho.set(id, { resolve, reject, timer });
    w.stdin.write(JSON.stringify({ id, phonemes, voice }) + "\n");
  });
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
  const out = await tongHopTrongWorker(phonemes, JA_VOICE);

  const rate = out.rate;
  return {
    /* PCM 16-bit da duoc tien trinh con doi san — gui Float32 qua ong la gap
       doi so byte cho cung mot doan am thanh. */
    wav: wrapWav(out.pcm, rate),
    ms: Date.now() - t0,
    audioSeconds: out.pcm.length / 2 / rate,
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
    worker?.kill();
    worker = null;
    log(`tts-ja: KHÔNG dùng được, đã trả lại bộ nhớ — ${(e as Error).message}`);
  }
}

/* ---------------------------------------------------------------- WAV */

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
