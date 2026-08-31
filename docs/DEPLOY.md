# Mở Aurea cho người khác vào thử

Tài liệu này là để chạy bản demo trên **một máy cá nhân** và gửi link cho người
khác. Nó không phải hướng dẫn dựng hạ tầng sản xuất — mục "Giới hạn thật" ở cuối
nói rõ chỗ khác nhau.

---

## 1. Bốn lệnh

```bash
npm run deploy          # kéo code, kiểm thử, build  (bỏ qua nếu vừa clone)
HOST=0.0.0.0 npm start  # cửa sổ 1 — server
npm run tunnel          # cửa sổ 2 — in ra link công khai
```

`npm run tunnel` in ra một khung như thế này, và đó là link gửi đi:

```
╭─ Link gửi cho người khác ────────────────────────╮
│  https://xxx-yyy-zzz.trycloudflare.com
╰──────────────────────────────────────────────────╯
```

Kiểm tra trước khi gửi:

```bash
curl http://localhost:5000/api/health
```

Phải thấy `"status":"ok"` và `"engine":"up"`. Nếu `"degraded"` thì Ollama chưa
chạy — người nhận link sẽ mở được trang nhưng không hỏi được gì.

---

## 2. Phải làm gì trước khi gửi link ra Internet

`.env` trong repo đã đặt sẵn ba mục đầu. Ba mục sau là quyết định của anh/chị.

| | Trạng thái mặc định | |
|---|---|---|
| `TTS_JA=0` | **đã tắt** | Kokoro chạy ONNX trong tiến trình Node nên nó khoá vòng lặp sự kiện: đo được một câu tiếng Nhật dài làm **cả server đứng im 15–28 giây**. Một người bấm loa là cả nhóm mất kết nối. |
| `RL_GUEST_REQUESTS=20` | **đã siết** | 60/phút là con số cho mạng nội bộ. Mỗi lượt là một lần chạy model. |
| `/api/guest/speak` kiểm mã | **đã bật** | Một URL công khai bị máy quét tự động tìm ra trong vài phút. Mỗi lần gọi là một tiến trình Piper ăn CPU mà model trả lời đang cần. |
| `TRUST_PROXY=1` | **chưa bật** | Bật khi chạy qua tunnel. Không bật thì mọi khách trông như một địa chỉ, và một người bấm nhiều sẽ khoá cả nhóm. |
| `EXPOSE_GUEST_KEYS=1` | **đang bật** | Trang chủ liệt kê mã đặt phòng của mọi khách. Với dữ liệu mẫu thì đây là tiện lợi khi demo. Với dữ liệu thật thì phải tắt. |
| PIN nhân viên `1234` | **chưa đổi** | Mọi tài khoản chung một PIN. Ai vào cổng nhân viên cũng thành quản lý. Chấp nhận được cho demo; không chấp nhận được cho thật. |

---

## 3. Giới hạn thật — đọc trước khi mời mười người

Số đo trên máy phát triển (i7-10870H, GPU 4 GB, RAM 8 GB):

| Số người bấm gửi cùng lúc | Người cuối chờ |
|---|---|
| 1 | ~14 giây |
| 3 | ~41 giây |
| 5 | ~69 giây |
| 10 | ~2 phút 17 |

**Ollama phục vụ tuần tự trên một GPU.** Đây không phải lỗi cấu hình, và không
có tham số nào sửa được nó trên phần cứng này.

Hàng đợi (`server/queue.ts`) không làm máy nhanh hơn — nó làm cái chậm đó **nói
ra được**: kiosk hiển thị "đang có 3 người hỏi trước bạn — khoảng 42 giây nữa".
Người thứ mười bị từ chối thẳng bằng 429 kèm `Retry-After`, thay vì chờ bốn phút
rồi mới biết.

Theo dõi lúc đang có người dùng:

```bash
curl http://localhost:5000/api/queue
# {"dangChay":1,"dangCho":3,"truocBan":4,"uocGiay":56}
```

**Muốn phục vụ nhiều người thật sự nhanh thì phải đổi phần cứng**, không phải
đổi code. Xem mục 6.

---

## 4. Máy phải bật liên tục — bốn thứ hay quên

1. **Tắt sleep và hibernate.** Đóng nắp laptop là link chết.
   `Settings → System → Power & battery → Screen and sleep` → đặt tất cả về *Never*.
2. **Tắt tự khởi động lại sau Windows Update.**
3. **Server sập là link chết im lặng.** Không có gì tự chạy lại. Cách đơn giản
   nhất là một vòng lặp trong PowerShell:
   ```powershell
   while ($true) { npm start; Write-Host "server thoát, chạy lại sau 5s"; Start-Sleep 5 }
   ```
4. **Đóng cửa sổ `npm run tunnel` là link chết**, kể cả khi server vẫn chạy.

---

## 5. Link cố định thay vì link đổi mỗi lần

`xxx.trycloudflare.com` là link dùng một lần, đổi mỗi lần chạy lại — gửi cho
mười người rồi khởi động lại máy là mười link chết.

Muốn cố định: cần một tài khoản Cloudflare (miễn phí) và một tên miền.

```bash
cloudflared tunnel login
cloudflared tunnel create aurea
cloudflared tunnel route dns aurea aurea.tenmiencuaban.com
cloudflared tunnel run --url http://localhost:5000 aurea
```

Từ đó `https://aurea.tenmiencuaban.com` luôn trỏ về máy này mỗi khi tunnel chạy.

---

## 6. Khi muốn phục vụ nhiều người cùng lúc

Nút thắt là GPU 4 GB: `qwen3.5:4b` chiếm 3,1 GB, không còn chỗ cho KV cache của
lượt thứ hai, nên Ollama không chạy song song được.

Thuê một GPU lớn hơn (RTX 4090 24 GB trở lên) mở ra hai thứ cùng lúc: mỗi lượt
nhanh hơn, **và** nhiều lượt chạy song song được. Khi đó nâng cả hai con số:

```bash
# trên máy chạy Ollama
OLLAMA_NUM_PARALLEL=8

# trong .env của Aurea
QUEUE_CHAT=8
```

Hai cách bố trí:

- **Chỉ Ollama trên máy thuê** — sửa `LOCAL_BASE` và `LOCAL_LLM_BASE` trong
  `.env` trỏ sang đó. Đơn giản nhất. Nhưng laptop vẫn phải bật vì nó vẫn chạy
  web, nhận dạng giọng nói và tổng hợp giọng đọc — và **STT sẽ thành nút thắt
  mới** (2,4–6,6 giây mỗi câu, trên CPU).
- **Cả ứng dụng trên máy thuê** — không cần tunnel nữa vì máy thuê có IP công
  khai, và STT/TTS chạy trên CPU mạnh hơn. Đây là lúc đóng gói Docker có giá trị.

Và một điều nên nói ra khi trình bày: cả câu chuyện sản phẩm này đứng trên
"dữ liệu khách không rời khỏi khách sạn" — đó là lý do từ chối `SpeechRecognition`
của Chrome. Chạy trên GPU thuê thì **kiến trúc** vẫn ngoại tuyến, nhưng **bản
demo này** đang mượn máy của người khác. Hai chuyện đó nên được tách rõ.

---

## 7. Xem số liệu vận hành (tuỳ chọn)

`ops/` có sẵn Prometheus + Grafana + 8 cảnh báo.

**Hai điều bắt buộc:**

- **Không bao giờ đưa Grafana hay Prometheus qua tunnel.** Chỉ cổng 5000 được ra
  ngoài. Grafana mặc định `admin/admin`.
- **Nên TẮT chúng trong lúc mở cho nhiều người thử.** Máy này còn khoảng 600 MB
  RAM trống; Prometheus và Grafana lấy mất vài trăm MB — đúng phần RAM mà model
  đang cần. Bật lên khi anh/chị ngồi xem số, tắt đi khi đang phục vụ người dùng.

```bash
docker compose -f ops/docker-compose.obs.yml up -d    # bật
docker compose -f ops/docker-compose.obs.yml down     # tắt
```

Người thử **không** dùng đến chúng, nên tắt không ảnh hưởng gì tới trải nghiệm.

---

## 8. Khi có sự cố

| Hiện tượng | Kiểm tra |
|---|---|
| Link mở ra trang lỗi Cloudflare | Server chết. `curl localhost:5000/api/health` |
| `/api/health` trả `degraded` | Ollama chưa chạy hoặc chưa `ollama pull qwen3.5:4b` |
| Ai cũng bị 429 | `TRUST_PROXY` chưa bật — cả nhóm đang dùng chung một địa chỉ |
| Trả lời rất chậm | `curl localhost:5000/api/queue` — xem `dangCho` |
| Không có nút mic / nút loa | `npm run setup:verify` |
| Nút loa im lặng với tiếng Nhật | Đúng như thiết kế khi `TTS_JA=0` — máy khách tự đọc |
