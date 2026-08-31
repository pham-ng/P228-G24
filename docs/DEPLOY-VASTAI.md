# Chạy Aurea trên GPU thuê (Vast.ai)

Để tắt được laptop, và để nhiều người dùng cùng lúc mà không phải xếp hàng.

---

## 0. Nói trước ba điều, vì chúng đổi kỳ vọng

**Thuê GPU mua được TỐC ĐỘ, không mua được "không bao giờ sập".** Vast.ai là chợ
máy của người khác: chủ máy có thể lấy lại máy, mạng nhà họ có thể rớt, và
Vast.ai **không cam kết thời gian hoạt động**. Về độ ổn định thì laptop ở nhà
anh/chị còn chắc hơn. Cái Vast.ai cho là 24 GB VRAM thay vì 4 GB.

**Container bị huỷ là mất sạch dữ liệu.** `data.db` nằm trong container. Mục 6
nói cách sao lưu — đọc trước khi có người dùng thật.

**Ước lượng tốc độ, chưa đo được.** Tôi không có 4090 để chạy thử. Con số dưới
đây suy ra từ thông số phần cứng, không phải phép đo như mọi số khác trong dự án
này. Đo lại bằng `/api/health` và `/api/queue` sau khi dựng xong.

| | laptop (4 GB, đã đo) | 4090 24 GB (ước lượng) |
|---|---|---|
| 1 người | 13,7 s | 3–4 s |
| 10 người cùng lúc | ~2 phút 17 | ~8–12 s |

---

## 1. Đẩy code lên GitHub TRƯỚC

Máy thuê lấy code bằng `git clone`. Còn commit nào chưa đẩy là máy thuê chạy bản cũ.

```bash
cd aurea
git push origin HEAD:master
git log origin/master..HEAD    # phải trống
```

---

## 2. Thêm khoá SSH vào tài khoản Vast.ai

Trên **laptop** của anh/chị, tạo khoá nếu chưa có:

```powershell
ssh-keygen -t ed25519 -C "aurea"
```

Bấm Enter cho mọi câu hỏi. Rồi copy khoá **công khai**:

```powershell
type $env:USERPROFILE\.ssh\id_ed25519.pub
```

Dán toàn bộ dòng đó vào Vast.ai → **Account** → **SSH Keys** → *Add SSH Key*.

> Đây là khoá công khai, dán đi không sao. Tệp `id_ed25519` (không có `.pub`)
> mới là khoá riêng — đừng gửi cho ai, đừng commit.

---

## 3. Thuê máy — bốn thứ phải chọn đúng

Vào **Vast.ai → Search**, rồi lọc:

| | Chọn gì | Vì sao |
|---|---|---|
| GPU | **RTX 4090** hoặc 3090 (24 GB) | `qwen3.5:4b` chỉ ~3 GB; chỗ thừa là để chạy nhiều lượt song song |
| Disk space | **≥ 40 GB** | node_modules 1 GB + model giọng 1,2 GB + model Ollama 3,7 GB + hệ thống |
| Instance type | **On-Demand**, KHÔNG phải Interruptible | Interruptible rẻ hơn nhưng bị cắt giữa chừng khi có người trả giá cao hơn |
| Image | `pytorch/pytorch` hoặc bất kỳ ảnh **Ubuntu 22.04 + CUDA** nào | Cần driver NVIDIA sẵn; script tự cài Node và Ollama |

Không cần mở cổng nào — Cloudflare Tunnel gọi ra ngoài, không cần cổng vào.

Giá tham khảo: **0,3–0,5 USD/giờ**. Chạy 24/7 là **220–360 USD/tháng**. Thuê
theo buổi demo thì chỉ vài đô — bấm **Destroy** khi xong là ngừng tính tiền.

---

## 4. SSH vào máy

Vast.ai → **Instances** → nút **Connect** → nó cho sẵn một dòng như:

```
ssh -p 41234 root@ssh5.vast.ai -L 8080:localhost:8080
```

Dán nguyên văn vào PowerShell trên laptop. Lần đầu nó hỏi `yes/no` — gõ `yes`.

Dấu nhắc thành `root@...:~#` là đã vào.

---

## 5. Dựng — hai lệnh

Trong phiên SSH:

```bash
git clone https://github.com/pham-ng/P228-G24.git aurea && cd aurea
```

```bash
bash scripts/bootstrap-linux.sh
```

Script cài Node, cài Ollama, kéo `qwen3.5:4b` + `bge-m3`, tải model giọng nói,
chỉnh `.env` cho máy thuê (`QUEUE_CHAT=8`, `OLLAMA_NUM_PARALLEL=8`,
`HOST=0.0.0.0`), rồi build. Mất khoảng **10–20 phút**, phần lớn là tải model.

Chạy lại được nhiều lần — mỗi bước tự bỏ qua nếu đã xong.

Rồi chạy hai lệnh nó in ra:

```bash
nohup npm start > /tmp/aurea.log 2>&1 &
sleep 25 && curl -s localhost:5000/api/health
```

```bash
nohup npm run tunnel > /tmp/tunnel.log 2>&1 &
sleep 15 && grep -o 'https://[a-z-]*\.trycloudflare\.com' /tmp/tunnel.log
```

`nohup ... &` là thứ cho phép anh/chị **đóng SSH và tắt laptop** mà hai tiến
trình vẫn chạy. Không có nó thì đóng SSH là cả hai chết theo.

Link in ra ở lệnh cuối là link gửi cho mọi người.

---

## 6. Sao lưu `data.db` — làm trước khi có người dùng thật

Container bị huỷ là mất hết hội thoại, đặt phòng, task. Kéo về laptop:

```powershell
scp -P 41234 root@ssh5.vast.ai:/root/aurea/data.db .\data.db.backup
```

(Thay `-P 41234` và host bằng đúng thông số máy anh/chị, lấy từ nút Connect.)

Làm định kỳ khi đang có người dùng. Server cũng tự sao lưu vào `backups/` mỗi
24 giờ, nhưng thư mục đó **cũng nằm trong container** nên nó không cứu được
trường hợp container biến mất.

---

## 7. Kiểm tra máy thuê có thật sự nhanh hơn không

Đừng tin ước lượng của tôi — đo:

```bash
curl -s localhost:5000/api/health
curl -s localhost:5000/api/queue
```

Và đo một lượt thật bằng đồng hồ. Nếu vẫn ~13 giây thì Ollama chưa dùng GPU:

```bash
nvidia-smi                    # có tiến trình ollama không, chiếm bao nhiêu VRAM
grep -i "gpu\|cuda" /tmp/ollama.log | head
```

Nếu `nvidia-smi` không thấy ollama thì ảnh máy thiếu driver — huỷ máy, thuê ảnh khác.

---

## 8. Khi xong

```bash
pkill -f cloudflared      # link chết ngay
pkill -f "node dist"      # server dừng
```

Rồi trên web Vast.ai bấm **Destroy** để ngừng tính tiền. **Stop** không đủ —
máy dừng nhưng vẫn tính tiền đĩa.

Nhớ `scp` `data.db` về trước khi Destroy.

---

## 9. Khi có sự cố

| Hiện tượng | Kiểm tra |
|---|---|
| `npm ci` hỏng ở better-sqlite3 | `apt-get install -y build-essential python3` rồi chạy lại |
| Ollama không lên | `cat /tmp/ollama.log`; cổng 11434 có thể đã bị chiếm |
| `/api/health` trả `degraded` | Ollama chưa chạy hoặc chưa `ollama pull qwen3.5:4b` |
| Vẫn chậm như laptop | mục 7 — nhiều khả năng đang chạy CPU chứ không phải GPU |
| Đóng SSH là chết hết | thiếu `nohup ... &` ở mục 5 |
| Không có nút mic / nút loa | `npm run setup:verify` |
| Link chết sau vài giờ | chủ máy lấy lại máy. Vast.ai không cam kết uptime — dựng lại trên máy khác |
