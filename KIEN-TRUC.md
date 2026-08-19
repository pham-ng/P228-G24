# Aurea — Kiến trúc & cách hoạt động

Bản clone hoạt động thật của mô hình sản phẩm [Ameniti](https://ameniti.com/): một AI concierge nói chuyện với khách và **thực sự hành động**, cộng với dashboard vận hành cho nhân sự khách sạn.

Không có dữ liệu giả trong luồng chạy: mọi câu trả lời của AI đều đến từ OpenAI qua API key của bạn, mọi hành động (đặt bàn, gọi món, xin trả phòng muộn, mở ticket) đều **ghi vào SQLite** và hiện ngay trên dashboard.

---

## 1. Tổng quan

```
Khách (mọi ngôn ngữ)                     Nhân viên khách sạn
        │                                        │
   #/  (concierge chat)                   #/staff/* (9 trang)
        │                                        │
        └──────────► Express API (port 5000) ◄───┘
                            │
              ┌─────────────┼──────────────┐
              │             │              │
        SQLite (data.db) Agent loop   OpenAI API
        15 bảng          10 tool      (key của bạn qua
        Drizzle ORM      thật         proxy an toàn)
```

**Stack**: React 18 + TypeScript + Vite + Tailwind v3 + shadcn/ui + wouter (hash routing) + TanStack Query ở frontend; Express + Drizzle ORM + better-sqlite3 ở backend.

---

## 2. Cơ sở dữ liệu — 15 bảng

`shared/schema.ts` định nghĩa schema, dùng chung cho cả client và server nên kiểu dữ liệu không bao giờ lệch nhau.

| Nhóm | Bảng | Vai trò |
|---|---|---|
| Khách sạn | `hotels`, `staff`, `rooms` | cấu hình, nhân sự (PIN 4 số), 24 phòng tầng 3–8 |
| PMS | `guests`, `reservations`, `folioCharges` | profile khách, mã đặt phòng, hoá đơn phòng |
| Hội thoại | `conversations`, `messages` | mỗi tin nhắn AI lưu kèm `tool_trace` + `latency_ms` |
| Vận hành | `tasks`, `services`, `serviceBookings` | ticket theo bộ phận + tồn kho suất dịch vụ |
| Nội dung | `kbArticles`, `offers`, `campaigns` | knowledge base, upsell, broadcast |
| Kiểm toán | `auditEvents` | mọi lần ghi dữ liệu, ai làm, lúc nào |

`server/seed.ts` tạo dữ liệu khởi tạo thực tế: khách sạn *Aurea Riverside Hanoi*, 6 nhân viên, 8 khách với 6 ngôn ngữ khác nhau, 10 dịch vụ, 14 bài KB, và 14 ngày lịch sử hội thoại/ticket để trang Insights có số liệu thật ngay từ đầu.

---

## 3. Trái tim hệ thống — vòng lặp agent

`server/agent.ts`. Đây là phần khác biệt giữa "chatbot" và "AI concierge".

Khi khách gửi tin nhắn:

1. Server dựng **system prompt** động: brand voice của khách sạn, thông tin lưu trú thật của khách, tier VIP, giờ khách sạn, ngôn ngữ ưu tiên.
2. Gửi tới OpenAI cùng **10 định nghĩa tool**.
3. Model gọi tool → server **thực thi thật trên DB** → trả kết quả về model.
4. Lặp tối đa 6 vòng cho tới khi model trả lời bằng văn bản.
5. Lưu câu trả lời + toàn bộ `tool_trace` để nhân viên xem lại được model đã làm gì.

**10 tool thật:**

| Tool | Ghi gì vào DB |
|---|---|
| `get_stay_details` | đọc reservation + profile + tier |
| `search_knowledge` | tìm KB bằng thuật toán chấm điểm theo từ khoá |
| `list_services` | tồn kho suất theo ngày, trừ số đã đặt |
| `book_service` | tạo `serviceBooking` + `folioCharge` + `task` cho bộ phận |
| `order_room_service` | tính tiền theo menu, tạo `folioCharge` + `task` F&B |
| `request_late_checkout` | sửa `checkOutTime`, miễn phí theo tier, tạo task housekeeping |
| `get_folio` | tổng hoá đơn hiện tại |
| `create_task` | mở ticket kèm SLA và deadline |
| `get_offers` | upsell theo ngữ cảnh lưu trú |
| `escalate_to_human` | chuyển hội thoại sang chế độ `human` |

### Bằng chứng đã kiểm thử thật

Khách phòng 802 (Nguyễn Thanh Hà, Platinum) gõ tiếng Việt: *"phòng tôi hơi nóng, điều hoà không mát… đặt bàn ăn tối cho 2 người… xin trả phòng muộn"*. Trong 3.4 giây model gọi 3 tool: `create_task` (engineering, priority high), `list_services` (dining), `request_late_checkout` → duyệt 14:00 **miễn phí vì tier Platinum**. Trả lời bằng tiếng Việt. Ba bản ghi mới xuất hiện trong DB.

Lượt sau: gọi 2 phở bò + 1 cà phê sữa và spa massage. Model gọi `order_room_service` → tính 32 USD, tạo task F&B ETA 35 phút; cà phê sữa không có trong menu in-room dining nên model tự tạo task riêng cho F&B; `book_service` giữ suất spa 16:30 và tính 85 USD lên folio. Tổng 5 ticket mở, hoá đơn phòng 802 tăng từ 1.150 lên 1.267 USD — tất cả hiện trên dashboard.

---

## 4. Giao diện khách — `#/`

- Vào bằng mã xác nhận (`AUR-2M77VD`) hoặc deep link `#/?code=AUR-2M77VD` để đặt QR trong phòng.
- Chip gợi ý câu hỏi tự đổi theo ngôn ngữ của khách.
- Poll 5 giây: khi nhân viên nhận hội thoại, header đổi sang tên người thật ngay trên máy khách.
- Không dùng localStorage/cookie — chạy được trong iframe sandbox.

## 5. Dashboard nhân viên — `#/staff/*`

Đăng nhập bằng tên + PIN (demo: `1234` cho cả 6 nhân viên).

| Trang | Nội dung |
|---|---|
| **Inbox** | mọi hội thoại, lọc theo AI/nhân viên; mở được **trace tool-call** của từng câu trả lời AI; nút *Take over* / *Hand back to AI*; nút *Draft* để AI soạn nháp cho nhân viên; panel phải hiển thị profile, lưu trú, folio, ticket của khách |
| **Tasks** | kanban 3 cột, chip SLA, gán người, start/done/reopen, tạo task tay |
| **Rooms** | 24 phòng nhóm theo tầng, đổi trạng thái housekeeping |
| **Reservations** | bảng PMS + tồn kho dịch vụ theo suất |
| **Insights** | 8 KPI + biểu đồ Recharts: AI deflection, first response (tách AI vs người), resolution rate, occupancy, doanh thu ancillary, tải theo bộ phận, sentiment, chủ đề |
| **Knowledge** | CRUD bài KB — sửa ở đây là AI trả lời khác ngay lượt sau |
| **Campaigns** | chọn segment (in-house/arriving/departing/VIP/repeat), xem trước danh sách nhận, gửi → **model viết lại từng bản theo tên và ngôn ngữ của từng khách** |
| **Activity** | timeline audit mọi lần ghi dữ liệu |
| **Settings** | brand voice, SLA, bật/tắt AI, kiểm tra kết nối model thật |

### Campaign đã gửi thật

Một broadcast tiếng Anh về nhạc jazz sân thượng gửi tới 5 khách in-house. DB lưu 5 bản khác nhau: tiếng Việt cho Trần Minh Quân và Nguyễn Thanh Hà, tiếng Anh cho Daniel Okafor, tiếng Pháp cho Sophie Lauren (*"jazz live sur la terrasse du neuvième étage…"*), tiếng Nhật kính ngữ cho Yuki Tanaka (*"田中ユキ様、今夜20:00より9階テラスで…"*). Giờ và dữ kiện giữ nguyên tuyệt đối.

---

## 6. Bảo mật & xử lý API key

Key OpenAI của bạn **không nằm trong code**. Nó được lưu trong vault credential của phiên làm việc; server nhận hai biến môi trường trỏ tới một proxy an toàn và gọi `${URL}/v1/chat/completions` với header `x-api-key`. `server/openai.ts` tự nhận diện theo thứ tự: gateway → `OPENAI_API_KEY` → `HTTPS_PROXY`, nên deploy ở đâu cũng chạy.

Model: `gpt-5.4-mini` cho agent, `gpt-5.4-nano` cho phân loại sentiment/topic.

## 7. Lỗi tìm được trong QA và đã sửa

QA bằng Playwright ở 1440px và 390px, chạy đúng luồng người dùng thật:

1. **PIN nhân viên lộ qua API** — `GET /api/conversations/:id` trả cả `pin`. Đã thêm hàm chặn `safeStaff()`, xác nhận không còn field `pin` trong bất kỳ response nào.
2. **Deep link `#/?code=…` ra 404** — wouter trả cả query string trong path. Đã bọc hook location để cắt query trước khi khớp route.
3. **Trang 404 mặc định của template** — thay bằng trang có logo và hai lối ra.
4. **Chip SLA hiển thị "7425m over"** — thêm hàm `duration()` đổi sang `5d 3h`.
5. **Tool `order_room_service` báo lỗi không dạy được model** — nay trả kèm cả menu để model tự sửa ngay trong một vòng thay vì phải gọi thêm `list_services`.

---

## 8. Chạy lại và mở rộng

```bash
cd /home/user/workspace/aurea
npm install
npm run dev      # dev, port 5000
npm run build && NODE_ENV=production node dist/index.cjs
```

Cần key OpenAI trong env (`OPENAI_API_KEY`) nếu chạy ngoài môi trường này. Xoá `data.db` để seed lại từ đầu.

**Hướng mở rộng gần nhất**: đổi polling sang WebSocket cho realtime; nối PMS thật (Opera/Stayntouch) thay lớp `reservations`; thêm kênh WhatsApp/SMS qua webhook (schema đã có cột `channel`); thêm voice bằng Whisper + TTS; đổi SQLite sang Postgres — Drizzle giữ nguyên gần hết code.

---

Nguồn tham khảo mô hình sản phẩm: [Ameniti](https://ameniti.com/), [Ameniti — About](https://ameniti.com/about), [tích hợp Stayntouch](https://www.stayntouch.com/snt-integrations-new/ameniti/), [Ameniti Voice trên ExploreTECH](https://www.exploretech.io/en/product/ameniti-inc-ameniti-voice).
