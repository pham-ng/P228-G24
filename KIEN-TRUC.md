# Aurea — Kiến trúc & Cách Hoạt Động
*Cập nhật theo mã nguồn thực tế — tháng 08/2026*

Clone có kiểm chứng của [Ameniti](https://ameniti.com/): AI concierge nói chuyện với khách và **thực sự hành động**, cộng với dashboard vận hành cho nhân sự khách sạn. Mọi câu trả lời đến từ LLM thật, mọi hành động ghi vào SQLite thật và hiện ngay trên dashboard.

---

## 1. Tổng Quan Hệ Thống

```
Khách (6 ngôn ngữ)                     Nhân viên (6 vai trò)
       │                                        │
  #/ kiosk chat                         #/staff/* (9 trang)
       │                                        │
       └──────────► Express (port 5000) ◄───────┘
                         │
          ┌──────────────┼────────────────────────┐
          │              │                        │
     SQLite (data.db)  Agent loop           LLM providers
       21 bảng          21 tool              OpenAI API
       Drizzle ORM      10 vòng max          Ollama local
```

**Stack**: React 18 + TypeScript + Vite + TailwindCSS v3 + shadcn/ui + wouter + TanStack Query (frontend); Express 5 + Drizzle ORM + better-sqlite3 (backend).

---

## 2. Cơ Sở Dữ Liệu — 21 Bảng

`shared/schema.ts` định nghĩa schema dùng chung client lẫn server.

| Nhóm | Bảng | Vai trò |
|---|---|---|
| Khách sạn | `hotels`, `staff`, `rooms`, `room_types` | cấu hình, nhân sự (PIN), 40 phòng + 4 villa, 9 hạng phòng thật |
| PMS | `guests`, `reservations`, `folioCharges` | profile khách, mã đặt phòng, hoá đơn |
| Hội thoại | `conversations`, `messages` | mỗi tin nhắn AI lưu `tool_trace` + `latency_ms` |
| Vận hành | `tasks`, `services`, `serviceBookings`, `restrictions` | ticket theo bộ phận, tồn kho suất dịch vụ, rate calendar |
| Nội dung | `kbArticles`, `offers`, `campaigns`, `dining_venues` | KB, upsell, broadcast, 7 outlet ẩm thực thật |
| Chính sách | `policies` | 11 bản ghi JSON có thể tính toán, có `sourceUrl` trỏ Vinpearl |
| RAG | `docChunks` | 60+ chunk cắt từ KB + policy + phòng + ẩm thực, vector 1024-d (bge-m3) |
| Kiểm toán | `auditEvents`, `feedback` | mọi hành động ghi DB; rating neo vào từng message |

`server/seed.ts` nạp dữ liệu **thật của Vinpearl Resort Nha Trang**: 6 nhân viên, 8 khách với 6 ngôn ngữ, 9 hạng phòng, 7 outlet ẩm thực, 27 dịch vụ, 24 bài KB, 11 chính sách.

---

## 3. Trái Tim — Vòng Lặp Agent

`server/agent.ts` — đây là phần khác biệt giữa "chatbot" và "AI concierge".

### 3.1 Luồng mỗi lượt

1. **Guard screening** (`server/guard.ts`) — lọc injection, số thẻ (Luhn), cấp cứu, tranh chấp tiền. Ba loại cuối **buộc chuyển Lễ tân ngay**, bất kể model viết gì.
2. **Tool routing** (`server/toolrouter.ts`) — 54 tool → 4-5 tool phù hợp trong ngân sách token (5K OpenAI / 3.2K Local). `find_capability` cho phép model tự unlock tool không thấy — routing miss = 1 vòng thêm, không phải wrong refusal.
3. **System prompt động** — brand voice + lưu trú thật + tier VIP + giờ khách sạn + ngôn ngữ ưu tiên.
4. **Agent loop** (tối đa 10 vòng) — LLM gọi tool → server thực thi thật trên DB → kết quả về LLM → lặp.
5. **Numeric guard** (`server/numguard.ts`) — kiểm tra số tiền, ngày, tỉ lệ trong reply trước khi gửi.
6. **Sentiment classifier** (`server/sentiment-net.ts`) — logistic regression trên embedding đã tính, 0ms thêm, F1 91.8%.

### 3.2 Doctrine 12 Luật (system prompt)

Model bị cấm: tự làm phép tính tiền, tự chọn ngày, hứa giữ phòng, nói số không đến từ tool trong chính lượt đó, dùng chữ "phù hợp" cạnh hạng vượt ngân sách khách.

### 3.3 21 Tool Thực Thi Thật

| Nhóm | Tool | Ghi DB |
|---|---|---|
| Tra cứu | `get_stay_details`, `get_folio`, `get_offers` | đọc reservation + profile + tier |
| RAG | `search_knowledge`, `get_policy`, `get_room_type_facts`, `get_dining_facts` | truy xuất hybrid + URL nguồn |
| Tính phí | `quote_late_checkout`, `quote_early_checkin`, `check_occupancy` | policy engine, không model tính |
| Đặt phòng | `check_availability`, `create_reservation`, `change_reservation_dates`, `check_restrictions` | tồn phòng thật, rate calendar |
| Dịch vụ | `list_services`, `book_service`, `order_room_service`, `book_catalogue_service` | serviceBooking + folioCharge + task |
| Vận hành | `request_late_checkout`, `create_task` | PMS + task housekeeping |
| Leo thang | `escalate_to_human`, `find_capability` | mode=human; unlock tool |

---

## 4. Chính Sách & Tầng RAG

### 4.1 Nguồn Dữ Liệu — 6 Trang Điều Khoản Vinpearl

| Nội dung | Nguồn |
|---|---|
| Xác nhận đặt phòng: giờ, phí ra muộn/vào sớm, hạn mức người, tiền cọc | booking.vinpearl.com/vi-VND/dieu-khoan/quy-dinh-ve-xac-nhan-dat-phong |
| Điều khoản chung: mã gói RO/BB/HB/FB, rời sớm, hoàn tiền | booking.vinpearl.com/vi-VND/dieu-khoan/dieu-khoan-chung |
| Quy định chung: không thú nuôi, hút thuốc 3tr₫, đồ ăn ngoài 1.175tr₫ | booking.vinpearl.com/vi-VND/dieu-khoan/quy-dinh-chung |
| Thanh toán: thẻ/QR/chuyển khoản, số TK Techcombank, SWIFT | booking.vinpearl.com/vi-VND/dieu-khoan/quy-dinh-ve-thanh-toan |
| Giải quyết tranh chấp: 3 bước, hotline 1900 23 23 89 nhánh 3 | booking.vinpearl.com/vi-VND/dieu-khoan/chinh-sach-giai-quyet-tranh-chap |
| Quyền riêng tư: dữ liệu nhạy cảm, lưu VN, 11 quyền chủ thể | booking.vinpearl.com/vi-VND/dieu-khoan/chinh-sach-quyen-rieng-tu |

Một quy tắc **không** thuộc Vinpearl: ưu đãi trả phòng muộn miễn phí tới 14:00 cho Gold/Platinum/Diamond, đánh dấu `internal://aurea/loyalty/late-checkout`.

### 4.2 Policy Engine — Tính Bằng Code, Không Bằng Model

`server/policy.ts`:
- `quoteLateCheckout`: khung giờ → % → nhân giá gói → làm tròn 1.000₫ → kiểm tra phòng bán lại → áp tier
- `quoteEarlyCheckin`: trước 06:00 = 100%, từ 06:00–12:00 = 50%
- `checkOccupancy`: quy đổi tuổi trẻ em, hạn mức phòng/villa, gợi số phòng thêm

Mỗi kết quả có `calculation` (diễn giải phép tính), `policy` (link nguồn).

### 4.3 Hybrid Retrieval — `server/retrieval.ts`

60+ chunk (900 ký tự, chồng lấn 150, cắt theo biên câu), mỗi chunk có vector bge-m3 1024-d.

Mỗi câu hỏi chạy song song hai nhánh, hợp nhất bằng **Reciprocal Rank Fusion**:
1. **BM25** (k1=1.5, b=0.75) — bỏ dấu, bỏ stopword Việt+Anh → bắt số tiền, tên riêng
2. **Cosine similarity** trên bge-m3 — bắt ngữ nghĩa, đa ngôn ngữ

Đo trên golden set 52 câu: **bge-m3 hit@1 96.2%, MRR 0.972**. Khi embedding lỗi → tự hạ BM25-only.

---

## 5. Giao Diện Khách — `#/`

- Vào bằng mã xác nhận (`VPNT-2M77VD`) hoặc deep link `#/?code=VPNT-2M77VD`
- **Flag switcher** 🇻🇳🇬🇧🇰🇷🇨🇳🇯🇵🇷🇺 trên Header — đổi ngôn ngữ context tức thì (React Query cache update)
- Intent chips tự đổi theo ngôn ngữ và context hiện tại
- Media gallery: ảnh phòng/nhà hàng/spa/cáp treo từ DB theo câu hỏi
- Poll 5 giây: staff reply hiện ngay trên màn hình khách
- Không dùng localStorage — chạy được trong iframe sandbox, an toàn kiosk công cộng

---

## 6. Dashboard Nhân Viên — `#/staff/*`

Đăng nhập bằng tên + PIN (demo: `1234` cho cả 6 nhân viên).

| Trang | Tính năng |
|---|---|
| **Inbox** | Tất cả hội thoại; xem tool trace từng reply AI; Take over / Hand back to AI; Draft AI nháp cho nhân viên; audio alert khi có escalation mới |
| **Tasks** | Kanban 3 cột, SLA chip (định dạng `5d 3h`), gán người, RBAC theo bộ phận |
| **Rooms** | 40 phòng + 4 villa theo tầng, đổi trạng thái housekeeping |
| **Reservations** | Bảng PMS + tồn kho dịch vụ theo suất, Room catalogue 9 hạng thật |
| **Insights** | 8 KPI + Recharts: AI deflection, first response (AI vs người), resolution rate, occupancy, ancillary revenue, dept load, sentiment, topics |
| **Knowledge** | CRUD bài KB — sửa là AI trả lời khác ngay, RAG tự reindex; xem dining venues + thực đơn mẫu |
| **Policies** | 11 bản ghi, quy tắc bung ra bảng + link nguồn Vinpearl, trạng thái embedding, hộp thử retrieval |
| **Campaigns** | Segment → model viết lại từng bản theo tên và ngôn ngữ từng khách |
| **Settings** | Brand voice, SLA, bật/tắt AI, VietQR config, Langfuse config, Guardrails config |

---

## 7. Bảo Mật & API Key

Key OpenAI **không nằm trong code**. `server/openai.ts` nhận theo thứ tự: `CUSTOM_CRED_API_OPENAI_COM_URL` (gateway) → `OPENAI_API_KEY` → `HTTPS_PROXY`.

- **RBAC**: 6 vai trò, mọi endpoint staff kiểm tra capability (`server/rbac.ts`)
- **PIN không lộ**: `safeStaff()` strip field `pin` khỏi mọi response
- **Card redaction**: `redactCards()` kiểm tra Luhn, xoá trước khi xử lý và trước khi lưu
- **Rate limiting**: `server/ratelimit.ts` — giới hạn guest, không block code đúng
- **Staff auth**: per-session token (`issueSession`), enforce với `API_AUTH_ENFORCE=1`

---

## 8. Benchmark — 40 Case Thực

`bench/` — chạy HTTP thật đến server như khách thật.

Mỗi case chấm 2 lớp:
- **Deterministic**: tool nào được gọi, mã validation nào xuất hiện, trạng thái DB sau cùng (kiểu τ-bench)
- **LLM judge** (3 phiếu độc lập, lấy đa số): grounded, correct_handling, asked_for_missing, no_overpromise, tone

**Kết quả 2026-08-21**: 40/40 deterministic, 39/40 judge.

6 nhóm case: Dates (7), Incomplete requests (5), Restrictions (4), Booking execution (3), Safety (6), Money & grounding (3), Room facts (6), Dining venues (6).

```bash
# Chạy benchmark (cần server đang chạy)
rm -f data.db data.db-wal data.db-shm
npm run build && NODE_ENV=production node dist/index.cjs &
node bench/run.mjs --no-judge   # nhanh, chỉ deterministic
node bench/run.mjs              # đầy đủ, ~25-30 phút
```

---

## 9. Nghiệp Vụ Đặt Phòng — `server/booking.ts`

Tất cả đều chạy bằng code thuần, không qua model:

- **`resolveDate`**: Đọc ngày tiếng Việt/Anh, khoảng ngày viết liền, phát hiện mơ hồ → buộc hỏi lại
- **`validateStayRequest`**: 14+ mã lỗi: `REVERSED_DATES`, `OVER_OCCUPANCY`, `GROUP_BOOKING`, `BEYOND_BOOKING_HORIZON`...
- **`checkRestrictions`**: Rate calendar (`STOP_SELL`, `CTA`, `CTD`, `MIN/MAX_LOS`) — seed Tết 2027, Quốc khánh 2026
- **`searchAvailability`**: Tồn phòng thật, gắn cờ `over_budget`, luôn có `alternatives_to_offer`
- **`createReservation`** / **`changeReservationDates`**: Ghi thật, sinh `VPNT-xxxxxx`, từ chối khi phòng đã có người

---

## 10. Danh Mục Phòng — 9 Hạng Thật

Nguồn: 9 trang mô tả phòng Vinpearl. Quy tắc: **trang không công bố thì `null`**, không suy đoán.

`server/catalogue.ts` — tầng chống bịa:
- `findRoomType()`: khớp tên Việt/Anh sau bỏ dấu, trừ điểm lệch loại giường/hướng biển, trả `null` khi không có trang công bố (không ghép hạng gần giống)
- `matchAmenity()`: khớp cả từ, không khớp chuỗi con (lỗi thật: "bàn là" ⊂ "bàn làm việc" đã sửa)
- `roomTypeFacts()`: trả `unpublished_fields` + instruction buộc agent nói rõ khi tiện nghi chưa công bố

---

## 11. Danh Mục Ẩm Thực — 7 Outlet Thật

Nguồn: 7 trang outlet Vinpearl. Cùng quy tắc: trang im lặng → `null`.

`server/dining.ts` — tầng chống bịa:
- `findVenue()`: bỏ dấu + từ chung ("nhà hàng", "bar"), trả `null` khi không nổi trội (tránh tự chọn trong 3 nhà hàng)
- `matchDish()`: 3 trạng thái: `on_menu` (có giá), `in_published_categories` (có nhóm, không có món cụ thể), `not_listed`
- `windowFor()`: đối chiếu giờ muốn với giờ công bố, từ chối ngoài giờ kèm thông tin thật

Lotus: trang in 2 mốc giờ khác nhau → `venueFacts()` gắn cờ `hours_conflict`, buộc agent đọc ra cả hai.

---

## 12. Chạy & Mở Rộng

```bash
# Cài đặt
npm install

# Chế độ phát triển (HMR client + tsx server, cùng port 5000)
npm run dev

# Production
npm run build && NODE_ENV=production node dist/index.cjs
# Windows PowerShell: $env:NODE_ENV="production"; node dist/index.cjs

# Reset database (seed lại từ đầu)
rm -f data.db data.db-wal data.db-shm

# Kiểm tra TypeScript
npx tsc --noEmit
```

Cần `OPENAI_API_KEY` trong `.env` (copy từ `.env.example`). Xóa `data.db` để seed lại.

**Hướng mở rộng**:
- Đổi polling → WebSocket để realtime push
- Nối PMS thật (Opera/Stayntouch) thay lớp `reservations` — schema đã sẵn sàng
- Kênh WhatsApp/SMS qua webhook — `channel` column đã có trong schema
- Voice: Whisper STT + Kokoro TTS (`server/stt.ts`, `kokoro-js` đã trong package.json)
- Scale: đổi SQLite → Postgres — Drizzle giữ gần hết code

---

*Nguồn tham khảo: [Ameniti](https://ameniti.com/), [Stayntouch integration](https://www.stayntouch.com/snt-integrations-new/ameniti/), [τ-bench paper](https://openreview.net/pdf/57cd0f8d1f7b7790714c1bedf5d781ba10e56590.pdf), [RAGAS faithfulness](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/faithfulness/).*
