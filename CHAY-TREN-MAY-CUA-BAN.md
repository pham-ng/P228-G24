# Aurea — chạy trên máy cá nhân

Toàn bộ mã nguồn nằm trong `aurea-source.zip`. Không có gì bị lược bỏ: server, client, dữ liệu đã bóc từ các trang thật, bộ benchmark 40 case, tài liệu kiến trúc và cả lịch sử git.

## 1. Cần có sẵn

- **Node.js 20 trở lên** ([nodejs.org](https://nodejs.org/en/download)). Bản đang chạy trong sandbox là Node 20.20.1.
- **Một khoá OpenAI API** của bạn (bắt đầu bằng `sk-`). Ứng dụng gọi thẳng `api.openai.com`.
- Trên macOS: Xcode Command Line Tools (`xcode-select --install`). Trên Windows: cài Node bằng bộ cài chính thức và tick "Tools for Native Modules". Lý do là `better-sqlite3` cần biên dịch native.

## 2. Bốn câu lệnh

```bash
unzip aurea-source.zip && cd aurea
npm install                 # khoảng 1-3 phút
cp .env.example .env        # rồi mở .env, dán OPENAI_API_KEY của bạn
npm run build && npm start
```

Mở [http://localhost:5000](http://localhost:5000).

- Cổng khách: nhập mã đặt phòng, ví dụ `VPNT-2M77VD`.
- Cổng nhân viên: bấm "Hotel team sign-in", chọn một nhân viên, mã PIN **1234**.

Trên Windows PowerShell, `npm start` có thể báo lỗi vì lệnh gốc đặt biến môi trường theo cú pháp Unix. Dùng thay bằng:

```powershell
$env:NODE_ENV="production"; node dist/index.cjs
```

## 3. Tính năng giọng nói (tuỳ chọn, cần tải thêm)

Chat văn bản chạy ngay sau 4 lệnh trên. **Nút mic 🎤 và nút đọc 🔊 chỉ hiện khi có model**.

| Tính năng | Model | Kích thước | Bắt buộc? |
|---|---|---|---|
| Nhận dạng giọng nói (STT) | Whisper ONNX q8 | ~430 MB/model | Không |
| Đọc câu trả lời (TTS) | Piper VITS | ~412 MB | Không |

**Hướng dẫn tải đầy đủ**: xem [`docs/SETUP-VOICE.md`](docs/SETUP-VOICE.md)

**Kiểm tra nhanh** sau khi tải:
```bash
curl http://localhost:5000/api/guest/voice
# {"stt":true,"tts":true,"ttsLangs":["vi","en","ko","zh","ru"]}
```

> Nếu `stt: false` → chưa có weights trong `models/hf/`  
> Nếu `tts: false` → chưa có Piper trong `models/piper/`  
> Cả hai `false` → chat vẫn chạy bình thường, chỉ không có nút mic/đọc

## 4. Chế độ phát triển

```bash
npm run dev      # Vite HMR cho client + tsx cho server, cùng cổng 5000
npx tsc --noEmit # kiểm tra kiểu, phải sạch trước khi build
```

## 4. Cơ sở dữ liệu

SQLite tại `data.db` ngay trong thư mục dự án, tự tạo và tự seed ở lần chạy đầu: 21 bảng, 9 hạng phòng, 7 outlet ẩm thực, chính sách, tri thức, phòng, khách, đặt phòng mẫu. Muốn làm lại từ đầu:

```bash
rm -f data.db data.db-wal data.db-shm && npm start
```

Lần chạy đầu tiên sẽ gọi OpenAI để tạo embedding cho toàn bộ index (khoảng 60 chunk), nên mất vài giây và tốn một lượng token rất nhỏ. Nếu không có mạng hoặc khoá sai, ứng dụng vẫn chạy: tầng truy xuất tự rơi về BM25 thuần từ khoá, chỉ kém chính xác hơn — nó không bịa.

## 5. Chạy lại benchmark

Cần server đang chạy ở cổng 5000, mở một cửa sổ terminal thứ hai:

```bash
node bench/run.mjs                        # cả 40 case, khoảng 25-30 phút
node bench/run.mjs --only V1,V2 --gap 6000  # một nhóm
node bench/run.mjs --no-judge             # chỉ assertion tất định, nhanh hơn
```

Kết quả ghi vào `bench/report.md` và `bench/report.json`. Nếu phiên OpenAI bị ngắt giữa run, chạy lại các case bị lỗi bằng `--only` rồi gộp: `node bench/merge-report.mjs part1.json part2.json`.

Lưu ý về chi phí: mỗi case gọi agent thật (và mặc định thêm một lần chấm bằng LLM), nên một run đầy đủ tiêu tốn token thật trên khoá của bạn. `--no-judge` giảm khoảng một nửa.

## 6. Bản đồ thư mục

```
server/         Express + Drizzle + agent
  agent.ts        doctrine 12 luật, 21 tool, vòng lặp gọi tool
  dining.ts       tầng chống bịa về nhà hàng: findVenue, matchDish, windowFor
  catalogue.ts    tầng chống bịa về hạng phòng
  booking.ts      tồn phòng, rate calendar, mã lỗi nghiệp vụ
  retrieval.ts    BM25 + embedding, hợp nhất bằng RRF
  policy.ts       chính sách trích từ trang điều khoản thật
  seed.ts         seed toàn bộ dữ liệu, ngày tương đối theo hôm nay
  data/           room-types.json, venues.json — dữ liệu đã bóc
scripts/        parse-room-types.py, parse-venues.py — bóc lại từ tệp gốc
client/src/     React + Tailwind v3 + wouter (hash routing)
shared/schema.ts  21 bảng Drizzle
bench/          cases.json (40 case), run.mjs, merge-report.mjs, report.md
research/       hotel-edge-cases.md — 45 luật, 84 tình huống, có nguồn
KIEN-TRUC.md    tài liệu kiến trúc đầy đủ, 12 chương
```

## 7. Ba điều nên biết trước

- **Router dùng hash.** Đường dẫn thật là `http://localhost:5000/#/staff/knowledge`. Gõ `/staff/knowledge` trực tiếp sẽ về trang khách.
- **Không có localStorage.** Phiên đăng nhập nhân viên giữ trong bộ nhớ React, nên tải lại trang là phải đăng nhập lại. Đây là giới hạn cố ý của khung dự án, không phải lỗi.
- **Dữ liệu là dữ liệu vận hành mẫu.** Chính sách, mô tả phòng và trang ẩm thực trích từ nguồn thật của Vinpearl Nha Trang; còn phòng 101–508, danh sách khách, giá theo hạng và các đặt phòng mẫu là do tôi tạo để hệ thống chạy được. Danh sách những chỗ tôi tự tạo nằm ở cuối các chương 10 và 11 của `KIEN-TRUC.md`.

## 8. Khi gặp lỗi

| Hiện tượng | Nguyên nhân thường gặp |
| --- | --- |
| `npm install` lỗi ở `better-sqlite3` | thiếu build tool native — xem mục 1 |
| Trang trắng, console báo lỗi module | chưa `npm run build` trước `npm start` |
| Agent trả lời "hệ thống AI đang không phản hồi" | `OPENAI_API_KEY` sai, hết hạn, hoặc hết quota |
| `EADDRINUSE :5000` | cổng đang bị chiếm — đặt `PORT=5100` trong `.env` |
| Benchmark trả 401 giữa run | khoá bị thu hồi hoặc hết quota giữa lúc chạy |
