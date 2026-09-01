/**
 * Kokoro chạy ở đây — trong một TIẾN TRÌNH RIÊNG, không phải luồng chính của Node.
 *
 * VÌ SAO PHẢI TÁCH RA. Node chạy toàn bộ JavaScript trên một luồng duy nhất, và
 * luồng đó chính là vòng lặp sự kiện. Trong lúc nó bận, server không nhận được
 * kết nối mới, không đọc được yêu cầu, không gửi được phản hồi.
 *
 * `kokoro-js` làm mọi việc ngay trong luồng đó: tokenizer bằng JS, suy luận ONNX
 * qua native binding, rồi đổi Float32Array sang PCM. Nó có trả về `Promise`,
 * nhưng phần tính toán đã xong TRƯỚC khi trả quyền điều khiển — bọc trong
 * Promise không làm nó thành bất đồng bộ.
 *
 * Đo được: một câu tiếng Nhật dài khoá cả server **15–28 giây**. Ping
 * `/api/hotel` mỗi 150 ms thì chỉ 5 lần lọt thay vì ~100, một lần mất 15.068 ms.
 *
 * VÌ SAO TIẾN TRÌNH CON CHỨ KHÔNG PHẢI WORKER THREAD. Bản đầu tiên dùng
 * `worker_threads` và nó CÓ giải quyết chuyện khoá — đo được 160 ping lọt,
 * trung vị 2 ms. Nhưng nó mang theo một khiếm khuyết riêng: **`process.exit()`
 * gọi trong lúc Kokoro đang nạp làm tiến trình chết bẩn, thoát 127 thay vì 0.**
 * Tái hiện được bằng một script mười dòng. Đó không phải chuyện nhỏ — CI và
 * trình giám sát tiến trình đều đọc mã thoát, và `terminate()` trong handler
 * `exit` thì đã quá muộn (đã thử, vẫn 127).
 *
 * Tiến trình con không có vấn đề đó: nó có bộ nhớ riêng, cha thoát thì nó chỉ
 * bị mồ côi rồi bị hệ điều hành dọn. Và khác với Piper — chạy-một-lần-rồi-thoát
 * vì nhị phân nạp nhanh — tiến trình này **sống lâu**, giữ model thường trú, nên
 * không phải trả 1,5–3,1 giây nạp lại cho từng câu.
 *
 * GIAO THỨC. Mỗi yêu cầu là MỘT dòng JSON trên stdin; mỗi phản hồi là MỘT dòng
 * JSON trên stdout, âm thanh đi kèm dưới dạng base64. Một câu 20 giây là ~2,5 MB
 * base64 — tốn vài mili giây mã hoá, không đáng kể so với 25 giây tổng hợp, và
 * đổi lại là không phải tự viết khung nhị phân trên ống, thứ rất dễ sai.
 */
import { createInterface } from "node:readline";

const { cacheDir, model, dtype, device } = JSON.parse(process.env.JA_WORKER_CONFIG ?? "{}");

/**
 * stdout CHỈ dành cho giao thức.
 *
 * `kokoro-js` và `@huggingface/transformers` in cảnh báo bằng `console.log`, và
 * một dòng lạ lọt vào stdout sẽ làm hỏng bản tin JSON mà tiến trình cha đang
 * đọc. Đẩy hết sang stderr TRƯỚC khi nạp thư viện.
 */
const stdoutWrite = process.stdout.write.bind(process.stdout);
console.log = (...a) => process.stderr.write(a.join(" ") + "\n");
console.info = console.log;
console.warn = console.log;

let kokoro = null;

async function nap() {
  if (kokoro) return kokoro;
  const { KokoroTTS, env } = await import("kokoro-js");
  env.cacheDir = cacheDir;
  env.allowLocalModels = true;
  /* Ngoại tuyến là một lời hứa của sản phẩm này, không phải tuỳ chọn. Trọng số
     đã nằm trong models/hf; thiếu thì phải hỏng ngay và ồn ào, chứ không lặng lẽ
     tải 88 MB giữa lúc có khách đang chờ. */
  env.allowRemoteModels = false;
  const t0 = Date.now();
  kokoro = await KokoroTTS.from_pretrained(model, { dtype, device });
  process.stderr.write(`tts-ja-worker: nạp Kokoro trong ${Date.now() - t0}ms\n`);
  return kokoro;
}

function traLoi(obj) {
  stdoutWrite(JSON.stringify(obj) + "\n");
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return; /* dòng rác — bỏ qua, không làm chết tiến trình */
  }
  try {
    const k = await nap();
    const { input_ids } = k.tokenizer(req.phonemes, { truncation: true });
    /* `generate_from_ids` KHÔNG gọi `_validate_voice`. Bảng metadata của
       kokoro-js chỉ liệt kê 28 giọng en-us/en-gb nên `generate()` từ chối
       `jf_alpha`, dù gói vẫn có đủ 54 tệp giọng trên đĩa, gồm năm giọng Nhật.
       Vào bằng cửa token là dùng được, không phải tải thêm gì. */
    const out = await k.generate_from_ids(input_ids, { voice: req.voice });

    /* Đổi sang PCM 16-bit ngay tại đây: gửi Float32 qua ống là gấp đôi số byte
       cho cùng một đoạn âm thanh, và tiến trình cha dù sao cũng cần PCM. */
    const s = out.audio;
    const pcm = Buffer.alloc(s.length * 2);
    for (let i = 0; i < s.length; i++) {
      const v = Math.max(-1, Math.min(1, s[i]));
      pcm.writeInt16LE(Math.round(v * 32767), i * 2);
    }
    traLoi({ id: req.id, ok: true, rate: out.sampling_rate, pcm: pcm.toString("base64") });
  } catch (e) {
    traLoi({ id: req.id, ok: false, error: String(e?.message ?? e) });
  }
});

/* Cha đóng ống là không còn ai để phục vụ. Thoát sạch thay vì nằm lại thành
   tiến trình mồ côi giữ 88 MB. */
process.stdin.on("close", () => process.exit(0));
