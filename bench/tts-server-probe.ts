/**
 * Giọng đọc trên máy chủ có thật sự đọc được không, và đọc bằng gì?
 *
 * Bài kiểm thử thuần không thay được probe này: Piper là một tiến trình con,
 * nên mọi thứ hỏng được đều nằm ở mối nối — đường dẫn, thư mục làm việc, mã
 * thoát, định dạng WAV trả về. Cả bốn đều đã hỏng ít nhất một lần khi dựng.
 *
 * ĐÁNG NHỚ NHẤT: đường dẫn TUYỆT ĐỐI làm Piper 1.2.0 trên Windows chết với
 * `0xC0000409` và **stderr rỗng** — vì thư mục dự án này có dấu gạch dài và dấu
 * tiếng Việt trong tên, mà Piper dùng API chuỗi hẹp. Không thông điệp, không
 * manh mối. Probe chạy qua HTTP nên nó bắt được đúng lỗi đó.
 *
 *   npx tsx bench/tts-server-probe.ts
 */
import { ttsLangs, ttsAvailable, TTS_MAX_CHARS } from "../server/tts";

const BASE = process.env.PROBE_BASE || "http://localhost:5000";
let failures = 0;
const ok = (c: boolean, m: string) => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${m}`);
  if (!c) failures++;
};

const CAU: Record<string, string> = {
  vi: "Hồ bơi ngoài trời mở cửa từ sáu giờ sáng đến mười giờ tối ạ.",
  en: "The outdoor pool is open from six in the morning until ten at night.",
  ko: "수영장은 아침 여섯 시부터 밤 열 시까지 운영합니다.",
  zh: "室外泳池的开放时间是早上六点到晚上十点。",
  ru: "Бассейн работает с шести утра до десяти вечера.",
};

const speak = (body: unknown) =>
  fetch(`${BASE}/api/guest/speak`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** Đọc phần đầu WAV. Nếu nó không phải WAV hợp lệ thì trình duyệt sẽ im lặng. */
function docWav(buf: Buffer) {
  return {
    riff: buf.toString("ascii", 0, 4),
    wave: buf.toString("ascii", 8, 12),
    channels: buf.readUInt16LE(22),
    rate: buf.readUInt32LE(24),
    bits: buf.readUInt16LE(34),
    dataBytes: buf.readUInt32LE(40),
  };
}

async function main() {
  console.log(`Piper cài đặt: ${ttsAvailable() ? "có" : "KHÔNG"} · ngôn ngữ: ${ttsLangs().join(", ") || "(không có)"}\n`);
  if (!ttsAvailable()) {
    console.log("SKIP  chưa cài Piper — xem models/piper/README.md");
    process.exit(0);
  }

  console.log("=== SERVER TỰ KHAI ĐÚNG NHỮNG GÌ NÓ LÀM ĐƯỢC ===");
  const cap = await fetch(`${BASE}/api/guest/voice`).then((r) => r.json());
  ok(cap.tts === true, "endpoint năng lực báo có giọng đọc");
  ok(Array.isArray(cap.ttsLangs) && cap.ttsLangs.length > 0, `và liệt kê ${cap.ttsLangs?.length} ngôn ngữ`);
  const effectiveLangs = cap.ttsLangs ?? [];
  ok(
    effectiveLangs.includes("vi") && effectiveLangs.includes("en"),
    "danh sách khai ra chứa các ngôn ngữ chính (vi, en)",
  );

  console.log("=== ĐỌC ĐƯỢC THẬT, TỪNG NGÔN NGỮ ===");
  for (const lang of ttsLangs()) {
    const r = await speak({ text: CAU[lang] ?? "Xin chào.", lang });
    if (r.status !== 200) {
      ok(false, `${lang}: nhận ${r.status} — ${(await r.text()).slice(0, 80)}`);
      continue;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    const w = docWav(buf);
    const giay = w.dataBytes / (w.rate * w.channels * (w.bits / 8));
    const ms = Number(r.headers.get("x-tts-ms") ?? 0);
    ok(
      w.riff === "RIFF" && w.wave === "WAVE" && w.bits === 16 && w.channels === 1 && w.dataBytes > 0,
      `${lang}: WAV hợp lệ (${w.rate} Hz, ${giay.toFixed(1)}s, ${ms}ms tính toán, RTF ${(ms / 1000 / giay).toFixed(2)})`,
    );
    /**
     * Ngưỡng 3,0 là để bắt "HỎNG", không phải để bắt "chậm".
     *
     * Ba con số đo được, cùng một máy:
     *     Piper gọi thẳng, máy rảnh     RTF 0,09
     *     qua HTTP, một yêu cầu         RTF 0,26
     *     qua HTTP, 5 yêu cầu liên tiếp RTF 0,78 – 1,33
     *
     * Chênh hơn mười lần, và nó thật: mỗi lượt là một tiến trình mới (~300ms
     * khởi động), Ollama đang giữ CPU, và probe không chờ giữa các lượt. Đặt
     * ngưỡng 1,0 làm probe báo đỏ cho một hệ thống chạy đúng — đúng kiểu cảnh
     * báo mà người ta học cách phớt lờ.
     *
     * Mốc so sánh cho biết 3,0 là rộng tới đâu: F5-TTS trên cùng máy đo được
     * RTF 25. Bất cứ thứ gì dưới 3 vẫn nhanh hơn nó gần mười lần.
     */
    ok(ms / 1000 / giay < 3.0, `${lang}: tổng hợp không chậm bất thường`);
  }

  console.log("=== KIỂM TRA TIẾNG NHẬT (KOKORO / SERVER TTS) ===");
  const ja = await speak({ text: "こんにちは。", lang: "ja" });
  if (ja.status === 200) {
    const buf = Buffer.from(await ja.arrayBuffer());
    const w = docWav(buf);
    ok(w.riff === "RIFF" && w.wave === "WAVE" && w.dataBytes > 0, "tiếng Nhật: WAV hợp lệ từ Kokoro TTS");
  } else {
    ok(ja.status === 415, `tiếng Nhật rơi về giọng thiết bị (nhận status ${ja.status})`);
  }

  const la = await speak({ text: "hello", lang: "de" });
  ok(la.status === 415, `ngôn ngữ không hỗ trợ bị từ chối (nhận ${la.status})`);

  const rong = await speak({ text: "", lang: "vi" });
  ok(rong.status === 400, `chuỗi rỗng bị từ chối (nhận ${rong.status})`);

  const dai = await speak({ text: "a".repeat(TTS_MAX_CHARS + 50), lang: "vi" });
  ok(dai.status === 400, `văn bản quá dài bị từ chối (nhận ${dai.status}) — tổng hợp tốn CPU`);

  console.log("=== KHÔNG CẦN TOKEN, ĐÚNG NHƯ KIOSK ===");
  /* Mọi lời gọi ở trên đều không có token nhân viên. Nếu tuyến này lọt vào sau
     `staffApiGuard` thì khách bấm nghe sẽ nhận 401 và nút trông như hỏng. */
  ok(true, "tất cả phép thử trên chạy không kèm token và vẫn qua");

  console.log(failures === 0 ? "\nALL TTS CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
