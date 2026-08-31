# Aurea — chạy trên máy của bạn

Trợ lý lễ tân khách sạn chạy **hoàn toàn trên máy bạn**. Không gọi API bên ngoài,
không cần khoá OpenAI, không gửi giọng nói của khách đi đâu cả.

---

## 1. Cần cài trước

| | Bắt buộc | Ghi chú |
|---|---|---|
| **Node.js 20+** | có | [nodejs.org](https://nodejs.org). Trên Windows nhớ tick **"Tools for Native Modules"** — `better-sqlite3` cần biên dịch. Trên macOS: `xcode-select --install`. |
| **Ollama** | có | [ollama.com](https://ollama.com). Đây là thứ chạy model trả lời. |
| **Python 3.8+** | không | Chỉ để đọc tiếng Nhật thành tiếng. Thiếu thì 5 ngôn ngữ kia vẫn đủ. |

Không cần khoá API nào. `.env` đã có sẵn trong repo và đã cấu hình chạy cục bộ.

---

## 2. Năm lệnh

```bash
git clone https://github.com/pham-ng/P228-G24.git
cd P228-G24
npm install
ollama pull qwen3.5:4b && ollama pull bge-m3
npm run setup
npm run dev
```

Mở **http://localhost:5000**.

- **Cổng khách** — nhập mã đặt phòng, ví dụ `VPNT-2M77VD`. (Trang chủ liệt kê sẵn
  mọi mã đang ở, bấm một phát là vào.)
- **Cổng nhân viên** — bấm *Hotel team sign-in*, chọn một nhân viên, PIN **1234**.

`npm run setup` tải 1,19 GB model giọng nói. Chạy lại bao nhiêu lần cũng được —
nó bỏ qua thứ đã có. Muốn xem thiếu gì mà không tải: `npm run setup:verify`.

---

## 3. Cái gì có sẵn trong repo, cái gì phải tải

**Có sẵn — clone về là có:**

- Toàn bộ mã nguồn server + client, 21 bảng, bộ benchmark, tài liệu kiến trúc.
- `data.db` — cơ sở dữ liệu đầy đủ: 9 hạng phòng, 68 gói giá, 7 nhà hàng, chính
  sách, tri thức, phòng, khách và đặt phòng mẫu, kèm lịch sử hội thoại demo.
  **Không phải chạy migration nào.**
- `.env` — đã cấu hình sẵn cho chế độ cục bộ, đã xoá hết khoá bí mật.

**Phải tải — `npm run setup` làm hộ:**

| | Dung lượng | Nguồn |
|---|---|---|
| Piper + 5 giọng đọc (vi en ko zh ru) | 413 MB | GitHub Releases + HuggingFace |
| PhoWhisper-small (nhận dạng tiếng Việt) | 241 MB | HuggingFace |
| whisper-small (nhận dạng 5 thứ tiếng còn lại) | 440 MB | HuggingFace |
| Kokoro-82M (giọng đọc tiếng Nhật) | 89 MB | HuggingFace |
| venv Python `misaki[ja]` (phiên âm tiếng Nhật) | ~100 MB | pip |

**Phải tải riêng — `ollama pull`:** `qwen3.5:4b` (~2,5 GB) và `bge-m3` (~1,2 GB).
Chúng nằm trong thư mục của Ollama, không nằm trong dự án.

> **Vì sao model không nằm trong git?** GitHub chặn tệp trên 100 MB, và Git LFS
> miễn phí chỉ có 1 GB lưu trữ + 1 GB băng thông mỗi tháng — tức **một lần clone
> của một người là hết hạn mức của cả tháng**. Tải từ nguồn gốc vừa nhanh hơn
> vừa không giới hạn.

---

## 4. Kiểm tra sau khi cài

```bash
curl http://localhost:5000/api/guest/voice
```

Mong đợi:

```json
{"stt":true,"maxSeconds":30,"sampleRate":16000,
 "tts":true,"ttsLangs":["vi","en","ko","zh","ru","ja"],"ttsMaxChars":600}
```

- `stt: false` → thiếu trọng số Whisper trong `models/hf/`
- `tts: false` → thiếu Piper trong `models/piper/`
- thiếu `"ja"` → chưa có venv Python, xem `docs/SETUP-VOICE.md` mục 3

Thiếu model **không gây lỗi**: nút mic 🎤 và nút loa 🔊 chỉ đơn giản không hiện.
Chat văn bản chạy bình thường.

Chạy bộ kiểm thử:

```bash
npm test          # toàn bộ test/*.test.ts, mỗi tệp một tiến trình
npx tsc --noEmit  # kiểm tra kiểu
```

---

## 5. Máy yếu thì sao

Số đo trên máy phát triển (i7-10870H, GPU 4 GB, RAM 8 GB):

| | thời gian |
|---|---|
| Trả lời một câu hỏi (LLM) | ~13,7 s |
| Nhận dạng một câu nói (STT) | 2,4 – 6,6 s |
| Đọc một câu trả lời (Piper: vi en ko zh ru) | 0,6 – 1,7 s |
| Đọc một câu trả lời (Kokoro: ja) | 9 – 28 s |

**Không có GPU?** Vẫn chạy, chỉ chậm hơn. Sửa `.env`:

```
LOCAL_NUM_GPU=0
```

**Hết VRAM (Ollama báo OOM)?** Hạ `LOCAL_NUM_GPU` từ 36 xuống 34, rồi 30.

**Máy yếu, chỉ muốn xem giao diện?** Bỏ qua `npm run setup`. Chat văn bản chạy
đủ, chỉ mất hai nút giọng nói.

---

## 6. Bản đồ thư mục

```
server/           Express + Drizzle + agent chạy cục bộ
  local-agent.ts    định tuyến ý định, vòng lặp gọi tool
  retrieval.ts      BM25 + embedding bge-m3, hợp nhất bằng RRF
  stt.ts            nhận dạng giọng nói (Whisper ONNX)
  tts.ts            đọc thành tiếng (Piper), 5 ngôn ngữ
  tts-ja.ts         đọc tiếng Nhật (Kokoro + phiên âm Python)
  seed.ts           seed toàn bộ dữ liệu, ngày tương đối theo hôm nay
  data/             room-types.json, venues.json, room-packages.json
client/src/       React + Tailwind + wouter (hash routing)
shared/schema.ts  21 bảng Drizzle
scripts/setup.mjs Tải model giọng nói — chính là `npm run setup`
bench/            Bộ đo: RAG eval, ASR/TTS eval, ablation
docs/             SETUP-VOICE.md, kiến trúc, ADR
KIEN-TRUC.md      Tài liệu kiến trúc đầy đủ
```

---

## 7. Ba điều nên biết trước

- **Router dùng hash.** Đường thật là `http://localhost:5000/#/staff/knowledge`.
  Gõ `/staff/knowledge` trực tiếp sẽ về trang khách.
- **Phiên nhân viên giữ trong bộ nhớ React.** Tải lại trang là phải đăng nhập lại.
- **Dữ liệu là dữ liệu vận hành mẫu.** Chính sách, mô tả phòng và trang ẩm thực
  trích từ nguồn thật của Vinpearl Nha Trang; phòng 101–508, danh sách khách, giá
  theo hạng và các đặt phòng mẫu là tự tạo để hệ thống chạy được. Chi tiết ở cuối
  chương 10 và 11 của `KIEN-TRUC.md`.

---

## 8. Khi gặp lỗi

| Hiện tượng | Nguyên nhân thường gặp |
|---|---|
| `npm install` hỏng ở `better-sqlite3` | thiếu build tool native — xem mục 1 |
| Agent không trả lời | Ollama chưa chạy, hoặc chưa `ollama pull qwen3.5:4b` |
| `EADDRINUSE :5000` | cổng bị chiếm — đặt `PORT=5100` trong `.env` |
| Không có nút mic / nút loa | chưa chạy `npm run setup` — kiểm bằng `npm run setup:verify` |
| Nút loa hiện nhưng im lặng | server khởi động **trước** khi model được cài. Khởi động lại `npm run dev`. |
| `ttsLangs` không có `"ja"` | chưa có Python hoặc venv — `npm run setup` lại sau khi cài Python |
| Piper thoát mã `0xC0000409` | đường dẫn dự án có ký tự ngoài ASCII. Piper 1.2.0 dùng API chuỗi hẹp; `server/tts.ts` đã gọi bằng đường dẫn tương đối để tránh, đừng sửa thành tuyệt đối. |
