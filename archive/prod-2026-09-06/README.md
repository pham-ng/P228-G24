# Ảnh chụp máy chủ prod — 2026-09-06

Instance GPU thuê (Vast.ai, RTX 3060 12GB) đã **bị xoá** ngày 2026-09-06. Đây là
toàn bộ những gì đáng giữ, chụp lại ngay trước khi xoá.

## ⚠️ Đây KHÔNG phải `data.db` ở gốc repo

Hai cơ sở dữ liệu **đã tách nhánh, không cái nào chứa cái nào** — đừng chép đè
theo bất kỳ chiều nào:

| | `/data.db` (gốc repo) | `archive/prod-2026-09-06/data.db` |
|---|---|---|
| Vai trò | Bộ demo, commit cố ý để clone về là chạy được | Ảnh chụp máy chủ thật |
| Bài KB | 52 | **43** — có bài "Quy Định Chung" mà bản demo không có |
| Hội thoại | 23 | **125** |
| Tin nhắn | 405 | 378 |
| Khách / đặt phòng | 23 | 31 / 31 |
| Audit event | — | 70 |

Chụp bằng `sqlite3 .backup` (nhất quán, không phải copy file đang mở).
`PRAGMA integrity_check` = `ok`.

## Quyền riêng tư — đã kiểm trước khi đưa lên repo public

Repo này công khai, nên đã quét kỹ:

- `id_number`, `dob`, `nationality`: **0 dòng có dữ liệu**
- Email: 23 ở `@vinaurea.test`, 8 ở `@example.*` — đều là TLD dành riêng cho
  kiểm thử (RFC 2606/6761), không thể thuộc về người thật
- **177 tin nhắn do người dùng gõ**: 0 số điện thoại, 0 CCCD/CMND, 0 email thật,
  0 số thẻ

Không có thông tin định danh cá nhân.

## Cấu hình prod (khác máy dev)

Không kèm `.env` vì nó chứa `STAFF_API_TOKEN` thật. Các thiết lập đáng nhớ:

| | máy dev | prod |
|---|---|---|
| `LOCAL_NUM_GPU` | 36 | **99** (toàn bộ layer lên GPU) |
| `LOCAL_EMBED_NUM_GPU` | 0 (ép bge-m3 xuống CPU để nhường VRAM) | **99** |
| `LOCAL_PASSAGE_CHAR_CAP` | 400 | **1200** |
| `RERANK_ENABLED` | không đặt | **1** (`RERANK_BACKEND=local`, `RERANK_DEPTH=30`) |
| `QUEUE_CHAT` | 1 | 1 |

Prod chạy `qwen3.5:4b` + `bge-m3`, cả hai 100% trên GPU, keep-alive vĩnh viễn.
Tốc độ sinh đo thật: **~75 token/giây** (máy dev GTX 1650 Ti chỉ ~39).

## Hai tệp báo cáo kèm theo

`bao-cao-325-truoc-hieu-chinh.json` và `bao-cao-cu.json` — nằm ở `/root` trên
máy prod, ngoài repo, có tiền tố `GIU-` do phiên làm việc trước đánh dấu giữ lại.

## Dùng lại ảnh chụp này

```bash
cp archive/prod-2026-09-06/data.db data.db   # GHI ĐÈ bộ demo — cân nhắc kỹ
npm ci && npm run build
ollama pull qwen3.5:4b && ollama pull bge-m3
```

Muốn xem mà không đụng bộ demo thì mở trực tiếp:
`sqlite3 archive/prod-2026-09-06/data.db`

## Lưu ý khi dựng máy prod mới

`.env` của prod cũ **thiếu cả `STAFF_API_TOKEN` lẫn `API_AUTH_ENFORCE`**, nên
toàn bộ `/api/*` chạy không xác thực và mở ra Internet. Đừng lặp lại. Nhưng cũng
**đừng bật `API_AUTH_ENFORCE=1` một mình** — allowlist `isGuestRoute()` chưa phủ
hết các lời gọi mà kiosk cần, bật lên là kiosk gãy cùng dashboard. Rà `client/`
trước.
