/**
 * Đọc câu trả lời thành tiếng, bằng model chạy trên máy này.
 *
 * VÌ SAO CÓ FILE NÀY. Trước đây việc đọc hoàn toàn dựa vào `speechSynthesis`
 * của trình duyệt khách. Nó miễn phí và tức thì, nhưng phụ thuộc voice pack mà
 * khách sạn không kiểm soát: **máy demo đo được đúng 4 giọng — 3 tiếng Anh, 1
 * tiếng Việt.** Nhật, Hàn, Trung, Nga không có, nên nút đọc biến mất ở 4 trong
 * 6 ngôn ngữ sản phẩm hỗ trợ. "Bảo khách sạn cài voice pack" không phải câu trả
 * lời cho một sản phẩm bán được.
 *
 * VÌ SAO PIPER, KHÔNG PHẢI F5-TTS. Đã đo trên chính máy này, CPU, không GPU:
 *
 *     F5-TTS (viet)   RTF 25,26   câu 9 giây mất ~4 PHÚT tổng hợp
 *     Piper           RTF  0,09   câu 9 giây mất ~0,8 giây
 *
 * Gấp 275 lần. F5-TTS nhân bản được giọng và nghe hay hơn nhiều, nhưng nó là mô
 * hình khuếch tán — cần GPU, mà 4 GB VRAM của máy này đã bị `qwen3.5:4b` chiếm
 * 3,1 GB. Piper là VITS nhỏ, chạy CPU, **không đụng một byte VRAM nào**.
 *
 * VÌ SAO GỌI TIẾN TRÌNH CON, KHÔNG PHẢI ONNX TRONG NODE. Piper cần espeak-ng để
 * chuyển chữ thành âm vị, và espeak-ng là thư viện C. Bản phát hành chính thức
 * đóng gói sẵn cả hai cùng dữ liệu ngôn ngữ; nhúng lại bằng tay là dựng lại một
 * chuỗi phụ thuộc nhị phân đã có người dựng đúng.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "./log";

export type TtsLang = "vi" | "en" | "ko" | "zh" | "ru";

/**
 * Tiếng Nhật KHÔNG có ở đây, và đó là kết luận từ phép đo chứ không phải bỏ sót.
 *
 * `rhasspy/piper-voices` chỉ có một giọng Nhật, và nó khai
 * `phoneme_type: "japanese"` — tức cần OpenJTalk để phiên âm. Piper 1.2.0 không
 * có OpenJTalk nên nó nhồi âm vị espeak vào, KHÔNG báo lỗi, và sinh ra 13,5 giây
 * âm thanh cho một câu lẽ ra 4 giây. Đó là phát âm sai chứ không phải chậm.
 *
 * Một giọng đọc sai tệ hơn không có giọng, nên tiếng Nhật rơi về
 * `speechSynthesis` của máy khách — và điện thoại Nhật thì luôn có giọng Nhật.
 */
const VOICES: Record<TtsLang, string> = {
  vi: "vi_VN-vais1000-medium",
  en: "en_US-lessac-medium",
  ko: "ko_KR-kss-medium",
  zh: "zh_CN-huayan-medium",
  ru: "ru_RU-irina-medium",
};

export const TTS_LANGS = Object.keys(VOICES) as TtsLang[];

const ROOT = process.env.PIPER_DIR ?? join(process.cwd(), "models", "piper");
const BIN = join(ROOT, "piper", process.platform === "win32" ? "piper.exe" : "piper");
const VOICE_DIR = join(ROOT, "voices");

/** Câu dài nhất ĐỌC. `synthesise()`/`synthesiseJa()` tự cắt về đúng độ dài này. */
export const TTS_MAX_CHARS = 600;

/**
 * Câu dài nhất CHẤP NHẬN ở tầng request, rộng hơn hẳn `TTS_MAX_CHARS`.
 *
 * Audit 2026-08-31 bắt được: route dùng `z.string().max(TTS_MAX_CHARS)` để xác
 * thực THÂN request, nên một câu trả lời dài hơn 600 ký tự (đo được ~1% câu trả
 * lời thật) bị từ chối thẳng bằng 400 kèm thông điệp Zod tiếng Anh — thay vì
 * được ĐỌC 600 ký tự đầu, đúng như `synthesise()` đã tự làm nếu request lọt
 * qua được. Trên máy đo, ko/zh/ru/ja không có giọng thiết bị nên nút rơi về
 * hoàn toàn im lặng. Ranh giới xác thực và ranh giới đọc là hai việc khác nhau:
 * cái sau đã đúng, chỉ cái trước sai. 4000 chỉ để chặn spam (một cuốn tiểu
 * thuyết dán vào ô chat), không phải để đọc hết 4000 ký tự.
 */
export const TTS_REQUEST_MAX_CHARS = 4000;

export function ttsAvailable(): boolean {
  return existsSync(BIN);
}

export function ttsLangs(): TtsLang[] {
  if (!existsSync(BIN)) return [];
  return TTS_LANGS.filter((l) => existsSync(join(VOICE_DIR, `${VOICES[l]}.onnx`)));
}

export function isTtsLang(x: string): x is TtsLang {
  return (TTS_LANGS as string[]).includes(x);
}

/** Tần số lấy mẫu của giọng, đọc từ chính file cấu hình chứ không đoán. */
export function ttsSampleRate(lang: TtsLang): number {
  try {
    const cfg = JSON.parse(readFileSync(join(VOICE_DIR, `${VOICES[lang]}.onnx.json`), "utf8"));
    return cfg?.audio?.sample_rate ?? 22050;
  } catch {
    return 22050;
  }
}

export type TtsResult = { wav: Buffer; ms: number; audioSeconds: number; voice: string };

/**
 * Tổng hợp một câu thành WAV.
 *
 * Mỗi lần gọi là một tiến trình mới. Nghe có vẻ lãng phí, nhưng đo được: khởi
 * động + nạp giọng + tổng hợp một câu hết ~800ms tổng, trong đó phần tính toán
 * chỉ 300ms. Giữ tiến trình sống để tiết kiệm 500ms đó sẽ đổi lấy việc phải
 * quản lý vòng đời, xử lý treo, và giữ 60 MB thường trú cho MỖI ngôn ngữ trên
 * một máy còn 0,6 GB RAM trống. Không đáng.
 */
export function synthesise(text: string, lang: TtsLang): Promise<TtsResult> {
  return new Promise((resolve, reject) => {
    const voice = VOICES[lang];
    const model = join(VOICE_DIR, `${voice}.onnx`);
    if (!existsSync(BIN)) return reject(new Error("Chưa cài Piper — xem models/piper/README.md"));
    if (!existsSync(model)) return reject(new Error(`Chưa có giọng ${voice}`));

    const cat = text.trim().slice(0, TTS_MAX_CHARS);
    if (!cat) return reject(new Error("Không có gì để đọc."));

    const t0 = Date.now();
    /**
     * ĐƯỜNG DẪN TƯƠNG ĐỐI, và đây không phải sở thích.
     *
     * Piper 1.2.0 trên Windows dùng API chuỗi hẹp, nên nó **không mở nổi tệp có
     * ký tự ngoài ASCII trong đường dẫn**. Thư mục dự án này tên là
     * `Aurea — mã nguồn đầy đủ (...)` — có gạch dài và dấu tiếng Việt — nên mọi
     * đường dẫn tuyệt đối đều làm tiến trình chết với `0xC0000409`
     * (tràn bộ đệm ngăn xếp) và **stderr rỗng**. Không thông điệp, không manh mối.
     *
     * Đặt `cwd` ở gốc Piper rồi truyền đường tương đối thì Windows tự phân giải
     * ở tầng hệ điều hành, và chuỗi mà Piper nhận được toàn ASCII. Đo được:
     * tuyệt đối → exit 3221226505, tương đối → exit 0, 29.300 byte PCM.
     *
     * `--output_raw` cho PCM thô ra stdout, tránh ghi tệp tạm rồi đọc lại — vừa
     * nhanh hơn vừa không để lại rác khi tiến trình bị giết giữa chừng.
     */
    const p = spawn(
      process.platform === "win32" ? "./piper/piper.exe" : "./piper/piper",
      ["--model", `./voices/${voice}.onnx`, "--output_raw"],
      { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] },
    );

    const chunks: Buffer[] = [];
    let err = "";
    p.stdout.on("data", (d) => chunks.push(d));
    p.stderr.on("data", (d) => (err += String(d)));

    /* Giết tiến trình nếu nó treo. Không có chốt này thì một câu hỏng có thể
       giữ một tiến trình con sống mãi, và chúng dồn lại cho tới khi hết RAM. */
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      reject(new Error("Piper quá thời gian."));
    }, 30_000);

    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });

    p.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        logger.warn("piper thoát khác 0", { code, lang, err: err.slice(0, 200) }, "tts");
        return reject(new Error(`Piper lỗi (${code}).`));
      }
      const pcm = Buffer.concat(chunks);
      if (!pcm.length) return reject(new Error("Piper không sinh ra âm thanh."));

      const rate = ttsSampleRate(lang);
      resolve({
        wav: wrapWav(pcm, rate),
        ms: Date.now() - t0,
        audioSeconds: pcm.length / (rate * 2),
        voice,
      });
    });

    p.stdin.write(cat);
    p.stdin.end();
  });
}

/**
 * Bọc PCM 16-bit mono thành WAV.
 *
 * Trình duyệt không phát được PCM thô — nó cần phần đầu 44 byte để biết tần số
 * và độ sâu bit. Viết tay vì đây là 44 byte cố định; kéo một thư viện âm thanh
 * vào để làm việc này là đổi một hàm mười dòng lấy một phụ thuộc phải theo dõi.
 */
function wrapWav(pcm: Buffer, rate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); // độ dài khối fmt
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); // byte mỗi giây
  h.writeUInt16LE(2, 32); // khối căn chỉnh
  h.writeUInt16LE(16, 34); // bit mỗi mẫu
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
