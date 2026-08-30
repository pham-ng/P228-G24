# TÀI LIỆU YÊU CẦU SẢN PHẨM (PRD)
## Aurea AI Concierge — Vinpearl Resort Nha Trang
**Phiên bản**: 2.0 — cập nhật theo trạng thái mã nguồn tháng 08/2026

---

## 1. TỔNG QUAN SẢN PHẨM

**Aurea AI Concierge** là hệ thống trợ lý ảo AI hoạt động 24/7 dành cho khách sạn nghỉ dưỡng cao cấp. Đây là phiên bản clone có kiểm chứng của mô hình [Ameniti](https://ameniti.com/), được xây dựng trên dữ liệu thực của **Vinpearl Resort Nha Trang (Hòn Tre)**.

Hệ thống bao gồm ba bề mặt tích hợp chặt chẽ:
- **Kiosk khách hàng** (`#/`) — giao diện chat đa ngôn ngữ, truy cập bằng mã xác nhận đặt phòng hoặc QR code trong phòng
- **Dashboard vận hành nhân viên** (`#/staff/*`) — 9 trang quản lý: Inbox, Tasks, Rooms, Reservations, Insights, Knowledge, Policies, Campaigns, Settings
- **AI Engine** — vòng lặp agent 10 vòng tối đa, 21 tool thực thi thật trên database

**Ngôn ngữ hỗ trợ**: Tiếng Việt · English · 한국어 · 中文 · 日本語 · Русский (+ phát hiện tự động)

---

## 2. CHÂN DUNG NGƯỜI DÙNG

### 2.1 Khách lưu trú (Hotel Guests)
- **Nhu cầu cốt lõi**: Hỏi thông tin (giờ, giá, chính sách), đặt dịch vụ (bàn ăn, spa, room service), xin trả phòng muộn/nhận phòng sớm, theo dõi yêu cầu đã gửi
- **Đặc điểm quan trọng**: Đa quốc tịch, gõ không dấu hoặc sai chính tả, dùng điện thoại cá nhân hoặc tablet kiosk tại phòng
- **Kỳ vọng**: Phản hồi trong 3 giây, không bịa thông tin, giữ ngôn ngữ của mình xuyên suốt

### 2.2 Lễ tân & Nhân viên vận hành (Front Desk & Operations)
- **Nhu cầu cốt lõi**: Xem và phản hồi tất cả hội thoại, giao task cho bộ phận tương ứng, theo dõi SLA, can thiệp khi AI gặp giới hạn
- **Vai trò phân quyền**: Manager, Front Desk, F&B, Spa, Housekeeping, Engineering (RBAC theo `server/rbac.ts`)
- **Nền tảng**: Web Dashboard trên máy tính hoặc tablet tại quầy

---

## 3. CÁC TÍNH NĂNG ĐÃ TRIỂN KHAI

### 3.1 AI Agent — Vòng lặp Có Kiểm Soát

Agent chạy trong `server/agent.ts` với **doctrine 12 luật**, cấm model tự tính tiền, tự chọn ngày, tự hứa hoàn tiền. Luồng mỗi lượt:

```
Guest message
  → Guard screening (server/guard.ts) — lọc injection, số thẻ, cấp cứu, tranh chấp tiền
  → Tool selection (server/toolrouter.ts) — chọn tối đa ~4-5 tool phù hợp trong ngân sách token
  → Agent loop (tối đa 10 vòng):
      system prompt động → LLM gọi tool → server thực thi thật → kết quả trở về LLM
  → Numeric guard (server/numguard.ts) — kiểm tra số tiền, ngày, tỉ lệ trong reply
  → Lưu reply + tool_trace + latency vào database
  → Sentiment classifier (server/sentiment-net.ts) — phát hiện khách không hài lòng
```

**21 tool thực thi thật** chia 8 nhóm: tra cứu lưu trú, tra kiến thức (RAG), tra chính sách, tính phí, đặt phòng, đặt dịch vụ, vận hành task, leo thang người thật.

### 3.2 Hybrid RAG — Truy Xuất Đa Phương Thức

`server/retrieval.ts` chạy song song hai nhánh, hợp nhất bằng Reciprocal Rank Fusion:

| Nhánh | Cơ chế | Điểm mạnh |
|---|---|---|
| **BM25** (k1=1.5, b=0.75) | Khớp từ khoá sau khi bỏ dấu và bỏ stopword | Số tiền, tên riêng, mã phòng |
| **Vector similarity** | Cosine trên embedding bge-m3 (local) hoặc text-embedding-3-small | Câu hỏi ngữ nghĩa, đa ngôn ngữ |

Chỉ số: 42+ chunk từ 24 bài KB + 11 chính sách + 18 hạng phòng + 7 outlet ẩm thực. Khi embedding lỗi, hệ thống tự hạ xuống BM25 và ghi `strategy: bm25-only`.

Đo trên golden set 52 câu resort: bge-m3 đạt **hit@1 96.2%, MRR 0.972** — tốt hơn text-embedding-3-small và chạy hoàn toàn offline.

### 3.3 Tầng Chính Sách — Tính Toán Bằng Code, Không Bằng Model

`server/policy.ts` đọc JSON từ bảng `policies` (11 bản ghi, nguồn từ [vinpearl.com](https://booking.vinpearl.com/vi-VND/dieu-khoan/)) và trả kết quả chính xác với diễn giải phép tính:

- `quoteLateCheckout`: chọn khung giờ → lấy % → nhân giá gói → áp ưu đãi tier VIP
- `quoteEarlyCheckin`: trước 06:00 = 100%, từ 06:00–12:00 = 50%
- `checkOccupancy`: quy đổi tuổi trẻ em, so hạn mức villa/phòng, gợi số phòng cần thêm

Model **bị cấm** làm phép tính tiền. Mọi con số đều truy về URL nguồn.

### 3.4 Nghiệp Vụ Đặt Phòng — Luật Chạy Bằng Code

`server/booking.ts` xử lý hoàn toàn ngoài model:

- **`resolveDate`**: Đọc ngày tiếng Việt/Anh, khoảng ngày viết liền ("22/09 đến 24/09"), phát hiện mơ hồ (buộc hỏi lại)
- **`validateStayRequest`**: 14+ mã lỗi rõ ràng: `REVERSED_DATES`, `OVER_OCCUPANCY`, `BEYOND_BOOKING_HORIZON`, `GROUP_BOOKING`...
- **`checkRestrictions`**: Đọc rate calendar (`STOP_SELL`, `CTA`, `CTD`, `MIN/MAX_LOS`) — đã seed cho Tết 2027, Quốc khánh 2026
- **`searchAvailability`**: Tính phòng trống thực từ sổ đặt phòng, gắn cờ `over_budget`, luôn có `alternatives_to_offer`

### 3.5 Real-time Sentiment Classification — 0ms Latency

`server/sentiment-net.ts` dùng logistic regression trên embedding bge-m3 đã tính sẵn cho RAG. **Không gọi thêm model, không thêm latency**.

Đo trên bộ 600 câu đa ngôn ngữ (`sentiment_benchmark_600.jsonl`):
- **Linear head**: F1 = 91.8%, Accuracy = 92.1%, Recall = 89.2%
- **Centroid fallback** (khi chưa có weights): F1 ~15 — vẫn bắt được phàn nàn thẳng

Khi phát hiện khách không hài lòng: chuyển hội thoại sang `human` mode, mở urgent task SLA 10 phút, thông báo Lễ tân ngay.

### 3.6 Bộ Lọc An Toàn & Human-in-the-Loop

`server/guard.ts` sàng lọc mọi tin nhắn đầu vào (đa ngôn ngữ):

| Loại | Hành động |
|---|---|
| Prompt injection / mạo danh nhân viên | Chặn, không truyền cho model |
| Số thẻ tín dụng (kiểm tra Luhn) | Xoá khỏi text trước khi xử lý |
| Cấp cứu y tế / sự cố an ninh | **Buộc chuyển người thật ngay lập tức** |
| Tranh chấp tiền / đòi hoàn tiền | **Buộc chuyển người thật ngay lập tức** |
| Đòi gặp người thật | Kích hoạt escalation |

`server/local-hitl.ts`: Giao dịch lớn (đặt phòng, room service, trả phòng muộn) có thể yêu cầu xác nhận từ nhân viên trước khi ghi vào database.

### 3.7 Tính Năng Upsell & Cross-sell Thông Minh

`server/crosssell.ts` + `server/upsell.ts`:
- Đề xuất dịch vụ theo giai đoạn lưu trú (pre-arrival, in-stay, pre-departure)
- Phân tích thời tiết thực (fetchWeather) để gợi ý spa khi trời mưa, hoạt động ngoài trời khi nắng
- Cooldown UPSELL_COOLDOWN_TURNS để tránh spam khách

### 3.8 Giao Diện Khách Hàng (Kiosk)

- **Chọn ngôn ngữ nhanh**: Dải quốc kỳ (🇻🇳 VN · 🇬🇧 EN · 🇰🇷 KO · 🇨🇳 ZH · 🇯🇵 JA · 🇷🇺 RU) trên Header
- **Intent chips**: Câu hỏi gợi ý tự đổi theo ngôn ngữ và context (shopping phòng → chip phòng)
- **Media gallery**: Hiển thị ảnh phòng, nhà hàng, spa, cáp treo từ database theo câu hỏi
- **Poll 5 giây**: Staff takeover reply hiện ngay trên màn hình khách không cần refresh
- **Không localStorage**: Chạy được trong iframe sandbox, an toàn kiosk công cộng

### 3.9 Dashboard Nhân Viên — 9 Trang Đầy Đủ

| Trang | Tính năng chính |
|---|---|
| **Inbox** | Tất cả hội thoại, lọc AI/human/unread; xem tool trace; Take over / Hand back; Draft AI |
| **Tasks** | Kanban 3 cột, chip SLA (`5d 3h` thay vì số phút thô), gán người, RBAC theo bộ phận |
| **Rooms** | 40 phòng + 4 villa nhóm theo tầng, đổi trạng thái housekeeping |
| **Reservations** | Bảng PMS + tồn kho dịch vụ theo suất |
| **Insights** | 8 KPI (AI deflection, first response, resolution rate, occupancy, ancillary revenue, dept load, sentiment, topics) + Recharts |
| **Knowledge** | CRUD bài KB — sửa là AI trả lời khác ngay lượt sau, RAG tự reindex |
| **Policies** | 11 bản ghi chính sách dạng bảng + link nguồn Vinpearl, trạng thái embedding, hộp thử retrieval |
| **Campaigns** | Segment guests, gửi → model viết lại theo tên và ngôn ngữ từng khách |
| **Settings** | Brand voice, SLA, bật/tắt AI, test kết nối model, VietQR config, Guardrails config |

---

## 4. YÊU CẦU PHI CHỨC NĂNG

### 4.1 Hiệu Suất & Độ Trễ

| Metric | Mục tiêu | Thực đo |
|---|---|---|
| First token (OpenAI GPT) | < 3s | p50 ~2.1s, p95 ~6s |
| Local SLM (qwen2.5:3b 100% GPU) | < 3s | p50 ~1.5s ấm |
| Sentiment classifier | 0ms thêm | 0.04ms (dot product) |
| Tool selection (router) | < 5ms | Deterministic, < 1ms |

Tool narrowing (`server/toolrouter.ts`): 54 tool → 4-5 tool per turn, giảm 87K token/session xuống ~5K.

### 4.2 Độ Chính Xác & Grounding

- **Số tiền**: Tất cả giá đến từ database hoặc policy engine. Model bị cấm tính toán.
- **Ngày giờ**: `resolveDate` đọc từ text khách. Model bị cấm tự chọn ngày.
- **Benchmark 40 case**: 40/40 deterministic, 39/40 judge (lần chạy 2026-08-21)
- **RAG golden set 52 câu**: hit@1 96.2% với bge-m3

### 4.3 Bảo Mật

- **RBAC**: 6 vai trò, mọi endpoint staff đều kiểm tra capability
- **PIN không lộ qua API**: `safeStaff()` chặn trường `pin` trong mọi response
- **Card number redaction**: Kiểm tra Luhn, xoá khỏi input và output
- **Rate limiting**: `server/ratelimit.ts` — giới hạn yêu cầu guest, không block guest đúng code
- **Staff API token**: `STAFF_API_TOKEN` + `API_AUTH_ENFORCE=1` để tắt unauthenticated access

### 4.4 Quan Sát Hệ Thống (Observability)

- **Langfuse integration**: Mỗi lượt agent = 1 trace, mỗi tool call = 1 observation (bật khi có key)
- **Prometheus metrics** (`/api/metrics`): conversation volume, AI deflection rate, latency p50/p95
- **SQLite WAL mode**: An toàn ghi đồng thời, backup tự động (`server/backup.ts`)
- **Audit log**: Bảng `auditEvents` — mọi hành động, ai làm, lúc nào

---

## 5. DỮ LIỆU THỰC TẾ — VINPEARL NHA TRANG

| Nhóm | Nội dung | Nguồn |
|---|---|---|
| 9 hạng phòng | Deluxe Queen 2,200,000₫ → Tropicana Villa 10,130,000₫ | vinpearl.com |
| 7 outlet ẩm thực | Lotus (buffet), Jasmine, Bách Giai, VietFlavors Halal, 3 bar | vinpearl.com |
| Akoya Spa | 7 liệu trình 1,200,000₫–2,700,000₫ | statics.vinwonders.com |
| Cáp treo | Khứ hồi 200,000₫/người, 08:00–22:00 | vinpearl.com |
| 11 chính sách | Xác nhận đặt phòng, điều khoản chung, quy định, thanh toán, tranh chấp, quyền riêng tư | booking.vinpearl.com |
| Pearl Club | Giảm phòng 5–10%, golf 33%, spa 30%, F&B 20% | vinpearl.com |

---

## 6. MÔ HÌNH KINH TẾ & TRIỂN KHAI

**Stack kỹ thuật**:
- Frontend: React 18 + TypeScript + Vite + TailwindCSS v3 + shadcn/ui + wouter (hash routing)
- Backend: Express 5 + Drizzle ORM + better-sqlite3
- AI: OpenAI GPT (agent) hoặc Ollama qwen2.5:3b (local, offline)
- Embedding: bge-m3 (local, ~1.2GB) hoặc text-embedding-3-small (OpenAI)
- Observability: Langfuse + Prometheus

**Chi phí vận hành** (chế độ OpenAI): ~$0.002–0.005/lượt agent (GPT-5.4-mini), phần lớn là tool definitions. Tool narrowing giảm ~40% chi phí này.

**Chế độ Local (0 API cost)**: `LLM_MODE=local` + Ollama qwen2.5:3b + bge-m3 — chạy 100% offline trên GPU 4GB VRAM. Chất lượng đo được: 75.6% câu hỏi trả lời đúng (so với 90%+ khi dùng GPT).

*Chi tiết kiến trúc: xem `KIEN-TRUC.md` và `docs/Architecture_Diagram.md`*
