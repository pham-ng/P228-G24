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

## 2. Cơ sở dữ liệu — 20 bảng

`shared/schema.ts` định nghĩa schema, dùng chung cho cả client và server nên kiểu dữ liệu không bao giờ lệch nhau.

| Nhóm | Bảng | Vai trò |
|---|---|---|
| Khách sạn | `hotels`, `staff`, `rooms` | cấu hình, nhân sự (PIN 4 số), 40 phòng tầng 1–5 + 4 villa |
| PMS | `guests`, `reservations`, `folioCharges` | profile khách, mã đặt phòng, hoá đơn phòng |
| Hội thoại | `conversations`, `messages` | mỗi tin nhắn AI lưu kèm `tool_trace` + `latency_ms` |
| Vận hành | `tasks`, `services`, `serviceBookings` | ticket theo bộ phận + tồn kho suất dịch vụ |
| Nội dung | `kbArticles`, `offers`, `campaigns` | knowledge base, upsell, broadcast |
| Chính sách | `policies` | 11 quy định đã số hoá thành JSON có thể tính toán (khung giờ, %, hạn mức, mức phạt) + link nguồn |
| Chỉ mục RAG | `docChunks` | 42 chunk cắt từ KB + policy, mỗi chunk có vector embedding 1536 chiều |
| Kiểm toán | `auditEvents` | mọi lần ghi dữ liệu, ai làm, lúc nào |

`server/seed.ts` nạp dữ liệu **thật của Vinpearl Resort Nha Trang** (Hòn Tre, Nha Trang): 6 nhân viên, 8 khách với 6 ngôn ngữ, 27 dịch vụ, 24 bài KB, 11 bản ghi chính sách, và 14 ngày lịch sử hội thoại/ticket để trang Insights có số liệu ngay từ đầu.

### Dữ liệu thật lấy từ đâu

Tiền tệ **VND**, múi giờ **Asia/Ho_Chi_Minh**, nhận phòng 14:00 / trả phòng 12:00, SLA 10 phút.

| Nhóm dữ liệu | Nội dung thật | Nguồn |
|---|---|---|
| Hạng phòng & giá đêm | Deluxe Queen/Twin 2.200.000 ₫; Grand Deluxe Queen 2.410.000 ₫; Deluxe Ocean View 2.640.000 ₫; Grand Deluxe Ocean View 2.870.000 ₫; Deluxe Suite King Ocean View 4.097.000 ₫; Villa 3 phòng ngủ 8.610.000 ₫; Tropicana Beachfront Villa 10.130.000 ₫ | [bảng giá phòng Vinpearl Nha Trang](https://vinpearl.com/vi/moi-nhat-bang-gia-phong-vinpearl-nha-trang) |
| Nhà hàng & giờ mở | Lotus (buffet Việt 06:00–10:30, 12:00–14:30, 18:00–22:00), Jasmine à-la-carte 250 chỗ, Groove & Grill, Ozone Pool Bar, Bach Giai lounge | [trang resort](https://vinpearl.com/en/vinpearl-resort-nha-trang) |
| Giá buffet | 650.000 ₫/người lớn, 375.000 ₫/trẻ 11 tuổi trở xuống | [trang resort](https://vinpearl.com/en/vinpearl-resort-nha-trang) |
| Menu Akoya Spa | Warm Bamboo 85′ 2.700.000 ₫; Hot Stone 90′ 2.500.000 ₫; Balinese 90′ 2.300.000 ₫; Cổ truyền Việt 60′ 1.500.000 ₫; Foot Therapy 50′ 1.200.000 ₫; Spa Sampler 90′ 2.000.000 ₫; Thalgo Collagen facial 60′ 2.200.000 ₫ | [menu Akoya (PDF)](https://statics.vinwonders.com/AKOYA-VPLRNT%20-%20A4%20menu%20-%20Vietnamese_1636009386.pdf) |
| Cáp treo & Harbour | khứ hồi 200.000 ₫/người, chạy ~08:00–22:00; combo Harbour all-inclusive 400.000 ₫ | [giá cáp treo](https://vinpearl.com/vi/cap-nhat-gia-ve-cap-treo-vinpearl-nha-trang-moi-nhat), [lịch trình Harbour](https://vinpearl.com/vi/lich-trinh-di-vinpearl-harbour-nha-trang) |
| Vé VinWonders | vé ngày 1.050.000 ₫, pass 2 ngày 1.280.000 ₫ | [Wonderpedia](https://vinwonders.com/en/wonderpedia/news/vinpearl-resort-nha-trang/) |
| Tiện ích & MICE | Aquafield, 7 phòng trị liệu, bãi biển riêng, golf 18 hố IMG Worldwide, ballroom 660 m² / 600 khách, 7 phòng hội nghị | [trang resort](https://vinpearl.com/en/vinpearl-resort-nha-trang) |
| Pearl Club | giảm phòng 5–10% theo tier, 33% golf, 30% spa, 20% F&B | [trang resort](https://vinpearl.com/en/vinpearl-resort-nha-trang) |

Mỗi bài KB đều ghi dòng `Source: <url>` trong nội dung, nên khi AI trích dẫn thì nhân viên truy được về nguồn gốc.

**Giới hạn trung thực:** giá in-room dining (90.000–350.000 ₫) là mức tham khảo vì Vinpearl không công bố; các mục à-la-carte, thể thao biển, buggy, đưa đón sân bay để giá `0` với nhãn *on request / à la carte / complimentary* thay vì bịa số. Danh sách khách, đặt phòng và lịch sử hội thoại vẫn là dữ liệu tổng hợp — cần nối PMS thật để thay thế.

---

## 3. Trái tim hệ thống — vòng lặp agent

`server/agent.ts`. Đây là phần khác biệt giữa "chatbot" và "AI concierge".

Khi khách gửi tin nhắn:

1. Server dựng **system prompt** động: brand voice của khách sạn, thông tin lưu trú thật của khách, tier VIP, giờ khách sạn, ngôn ngữ ưu tiên.
2. Gửi tới OpenAI cùng **14 định nghĩa tool**.
3. Model gọi tool → server **thực thi thật trên DB** → trả kết quả về model.
4. Lặp tối đa 10 vòng cho tới khi model trả lời bằng văn bản — đủ để một câu hỏi nhiều tầng gọi truy xuất, tra chính sách rồi mới báo giá.
5. Lưu câu trả lời + toàn bộ `tool_trace` để nhân viên xem lại được model đã làm gì.

**14 tool thật:**

| Tool | Ghi gì vào DB |
|---|---|
| `get_stay_details` | đọc reservation + profile + tier |
| `search_knowledge` | truy xuất hybrid BM25 + embedding trên `docChunks`, trả kèm URL nguồn |
| `get_policy` | đọc bản ghi chính sách theo chủ đề, trả nguyên văn quy tắc + link nguồn |
| `quote_late_checkout` | tính phí trả phòng muộn từ bảng chính sách, không phải model tự nhân |
| `quote_early_checkin` | tính phí nhận phòng sớm theo khung 100% / 50% |
| `check_occupancy` | đối chiếu số khách và tuổi trẻ em với hạn mức phòng / villa |
| `list_services` | tồn kho suất theo ngày, trừ số đã đặt |
| `book_service` | tạo `serviceBooking` + `folioCharge` + `task` cho bộ phận |
| `order_room_service` | tính tiền theo menu, tạo `folioCharge` + `task` F&B |
| `request_late_checkout` | gọi lại chính engine chính sách để tính phí, sửa `checkOutTime`, trừ folio, tạo task housekeeping |
| `get_folio` | tổng hoá đơn hiện tại |
| `create_task` | mở ticket kèm SLA và deadline |
| `get_offers` | upsell theo ngữ cảnh lưu trú |
| `escalate_to_human` | chuyển hội thoại sang chế độ `human` |

### Bằng chứng đã kiểm thử thật

Sau khi nạp dữ liệu Vinpearl, ba hội thoại được chạy lại thật qua API:

- **Nguyễn Thanh Hà** (tiếng Việt, Platinum, phòng 202 Grand Deluxe Ocean View, 2.870.000 ₫/đêm) hỏi giá cáp treo, giờ và chỗ ăn sáng, rồi nhờ đặt Akoya Balinese Massage 90′ 18:30. Model trả lời đúng 200.000 ₫ / 08:00–22:00 và Lotus 06:00–10:30 với 650.000 ₫ người lớn / 375.000 ₫ trẻ em, sau đó gọi `book_service` → tạo booking, trừ **2.300.000 ₫** vào folio (tổng 12.610.000 ₫) và mở task cho bộ phận spa. Độ trễ 5.970 ms.
- **Kim Ji-woo** (Gold, phòng 102) hỏi bằng tiếng Anh về Aquafield → model trả lời 09:00–22:00 kèm đủ 7 phòng trị liệu, rồi `create_task` cho housekeeping mang 2 quả dừa. Độ trễ 2.248 ms.
- **Lê Hoàng Phúc** (Diamond, villa V03) xin trả phòng muộn → `request_late_checkout` duyệt 14:00, phí **0 ₫** với lý do *diamond tier benefit*, tạo task housekeeping. Folio 42.220.000 ₫. Độ trễ 2.143 ms.

Phí trả phòng muộn **không do model tự nghĩ ra**. Nó đi qua `server/policy.ts` — engine đọc bảng `policies` và trả về khung giờ, phần trăm, số tiền và cả câu diễn giải phép tính. Xem mục 4 bên dưới.

---

---

## 4. Chính sách thật và tầng RAG

Đây là phần được xây riêng để agent không bao giờ phải đoán một con số.

### 4.1 Nguồn dữ liệu — 6 trang điều khoản chính thức

Toàn bộ quy định được lấy nguyên văn từ trang đặt phòng của Vinpearl, không phải viết lại theo trí nhớ:

| Nội dung | Nguồn |
|---|---|
| Xác nhận đặt phòng: giờ trả phòng 12:00, phí ra muộn 50% / 100%, phí vào sớm 100% / 50%, hạn mức người/phòng, giường phụ, tuổi trẻ em theo chiều cao, tiền cọc, hạn gửi danh sách khách, phí đổi tên 350.000 ₫ | https://booking.vinpearl.com/vi-VND/dieu-khoan/quy-dinh-ve-xac-nhan-dat-phong |
| Điều khoản chung: mã gói RO/BB/HB/FB, phân loại Khách Lẻ / Khách Đoàn / Đoàn Series, rời sớm vẫn thu đủ gói, voucher, chuyển phòng, hoàn tiền tối đa 45 ngày làm việc | https://booking.vinpearl.com/vi-VND/dieu-khoan/dieu-khoan-chung |
| Quy định chung: không thú nuôi, hút thuốc sai chỗ phạt 3.000.000 ₫, đồ ăn ngoài 1.175.000 ₫/lần, khách thăm không ở phòng sau 20:00, hồ bơi đóng 22:00, không tắm biển sau 19:00, sau 22:00 giữ yên tĩnh | https://booking.vinpearl.com/vi-VND/dieu-khoan/quy-dinh-chung |
| Thanh toán: thẻ / QR / tiền mặt / chuyển khoản, số tài khoản VND 19127850127299, USD 19127850127094, Techcombank Hội sở Chính, SWIFT VTCBVNVX | https://booking.vinpearl.com/vi-VND/dieu-khoan/quy-dinh-ve-thanh-toan |
| Giải quyết tranh chấp: 3 bước, ca phức tạp trả lời trong 7 ngày, hotline 1900 23 23 89 nhánh 3 | https://booking.vinpearl.com/vi-VND/dieu-khoan/chinh-sach-giai-quyet-tranh-chap |
| Quyền riêng tư: dữ liệu cơ bản vs dữ liệu nhạy cảm, lưu tại Việt Nam, không bán, không lưu số thẻ và CVV, trẻ em từ 7 tuổi phải có đồng thuận của chính trẻ, 11 quyền của chủ thể dữ liệu | https://booking.vinpearl.com/vi-VND/dieu-khoan/chinh-sach-quyen-rieng-tu |

Dữ liệu vào hệ thống ở hai dạng: **9 bài KB** dạng văn xuôi để truy xuất, và **11 bản ghi `policies`** dạng JSON để tính toán. Mỗi bản ghi giữ `sourceUrl` và `sourceTitle`, nên mọi con số đều truy được về đúng trang gốc.

Có đúng một quy tắc **không** thuộc Vinpearl: ưu đãi trả phòng muộn miễn phí tới 14:00 cho tier gold/platinum/diamond. Nó được đánh dấu `internal://aurea/loyalty/late-checkout` và hiển thị riêng trong mục "Internal rules" trên trang Policies, để không ai nhầm nó là quy định công bố của resort.

### 4.2 `server/policy.ts` — engine tính phí, không phải model tính

Model bị cấm làm phép tính tiền. Ba hàm thuần trong `server/policy.ts` đọc JSON của bảng `policies` và trả về kết quả kèm diễn giải:

- `quoteLateCheckout` — chọn khung giờ, lấy % tương ứng, nhân với giá gói, làm tròn 1.000 ₫, kiểm tra phòng đã bán lại trong ngày chưa, áp ưu đãi tier nếu có.
- `quoteEarlyCheckin` — khung trước 06:00 là 100%, từ 06:00 đến 12:00 là 50%.
- `checkOccupancy` — quy đổi tuổi trẻ em, so với hạn mức 4 người/phòng hoặc 2 người lớn + 2 trẻ dưới 12 trên mỗi phòng ngủ villa, trả về số phòng cần thiết và khả năng kê giường phụ.

Mỗi kết quả có trường `calculation` viết rõ phép tính, `charged_per` nói phí tính theo phòng hay theo người, và `policy` trỏ về mã + link nguồn. `request_late_checkout` — nhánh thực sự ghi vào DB — gọi đúng hàm này, nên số báo cho khách và số trừ vào folio không thể lệch nhau.

### 4.3 `server/retrieval.ts` — truy xuất hybrid

24 bài KB và 11 chính sách được cắt thành **42 chunk** (900 ký tự, chồng lấn 150, cắt theo biên câu), mỗi chunk có một vector `text-embedding-3-small` 1536 chiều.

Mỗi câu hỏi chạy song song hai nhánh và hợp nhất bằng **Reciprocal Rank Fusion**:

1. **BM25** (k1=1.5, b=0.75) trên token đã bỏ dấu và bỏ stopword tiếng Việt + tiếng Anh — bắt đúng mã phòng, số tiền, tên riêng.
2. **Cosine similarity** trên embedding — bắt ý nghĩa, nên câu hỏi tiếng Việt vẫn tìm ra đoạn nguồn viết bằng tiếng Anh.

Ba chi tiết làm nên độ chính xác:

- Mỗi chunk chính sách được bồi thêm một dòng **từ khoá tiếng Việt** theo chủ đề ("ra muộn", "phụ thu trả phòng muộn", "kê thêm giường"…). Đây chỉ là từ khoá tìm kiếm, không chứa quy tắc hay con số. Trước khi có nó, câu "ra muộn 2 tiếng mất bao nhiêu tiền" trả về bản ghi tiền cọc; sau khi có, nó trả đúng `LATE_CHECKOUT` ở hạng 1.
- Tối đa 2 chunk trên mỗi tài liệu gốc, để một bài dài không chiếm hết kết quả.
- Nếu embedding lỗi hoặc chưa dựng xong, hệ thống **tự hạ xuống nhánh BM25** và ghi rõ `strategy: bm25-only` thay vì để agent đoán.

Trang **Policies & retrieval** trong dashboard cho nhân viên xem toàn bộ 11 bản ghi chính sách với quy tắc đã bung ra dạng bảng, tình trạng chỉ mục, nút dựng lại chỉ mục, và một hộp tìm kiếm để thử **đúng những gì AI sẽ đọc được** trước khi nó trả lời.

### 4.4 Reasoning nhiều bước

System prompt có một quy trình bắt buộc: tách câu hỏi thành từng điều kiện → tra bằng tool → tính bằng tool → đối chiếu lại với đơn phòng thật → trả lời cả phần khách hỏi ngầm. Kèm hai lệnh cấm: không tự làm phép tính, và không nói ra con số tiền nào không đến từ tool trong chính lượt đó.

### 4.5 Kết quả kiểm thử thật qua API

| Tình huống | Tool agent đã gọi | Kết quả |
|---|---|---|
| Gia đình 4 người (2 người lớn + 2 trẻ), phòng 101, 2.410.000 ₫/đêm, hỏi ra muộn 2 tiếng và "có nhân theo số người không" | `get_stay_details` → `get_policy` → `check_occupancy` | Trả lời 50% giá gói, **tính theo phòng không theo người**, 4 người vẫn trong hạn mức 1 phòng |
| Hỏi tiếp "cụ thể bao nhiêu tiền" | `quote_late_checkout` | **1.205.000 ₫** = 50% × 2.410.000, khung 12:00–18:00 |
| Khách chốt ra 14:00 | `request_late_checkout` | Ghi PMS 14:00, trừ folio đúng 1.205.000 ₫, mở task housekeeping |
| Hỏi ra muộn hẳn tới 20:00 | `quote_late_checkout` | Khung sau 18:00 → 100% → **2.410.000 ₫** |
| Khách Platinum xin ra 14:00 | `quote_late_checkout` | Phí **0 ₫**, và được nói rõ là ưu đãi hạng thành viên, kèm điều kiện phòng chưa bán lại |
| Khách Anh hỏi vào sớm 05:00 so với 08:00 | hai lần `quote_early_checkin` trong cùng một lượt | 05:00 → 2.200.000 ₫ (100%), 08:00 → 1.100.000 ₫ (50%) |
| Villa 3 phòng ngủ, 6 người lớn + 2 trẻ 10 tuổi, xin kê thêm giường | `get_policy` → `check_occupancy` | Trong hạn mức 6 người lớn + 6 trẻ; villa **không kê giường phụ** trừ Vinpearl Luxury Nha Trang |
| Tiếng Hàn hỏi tiền cọc và mức phạt hút thuốc | hai lần `get_policy` | 1.000.000 ₫/phòng; 3.000.000 ₫/kỳ lưu trú — trả lời bằng tiếng Hàn |
| Tiếng Nga hỏi hạn đổi tên khách và số tài khoản chuyển khoản | `get_policy` → `search_knowledge` → `get_stay_details` | 350.000 ₫/phòng/lần, hạn 7/15 ngày theo mùa; đọc đúng số tài khoản và SWIFT |
| Hỏi resort có sân trực thăng riêng không | hai lần `search_knowledge` | **Không bịa** — nói không có trong tài liệu và sẽ hỏi lại team |

## 5. Giao diện khách — `#/`

- Vào bằng mã xác nhận (`VPNT-2M77VD`) hoặc deep link `#/?code=VPNT-2M77VD` để đặt QR trong phòng.
- Chip gợi ý câu hỏi tự đổi theo ngôn ngữ của khách.
- Poll 5 giây: khi nhân viên nhận hội thoại, header đổi sang tên người thật ngay trên máy khách.
- Không dùng localStorage/cookie — chạy được trong iframe sandbox.

## 6. Dashboard nhân viên — `#/staff/*`

Đăng nhập bằng tên + PIN (demo: `1234` cho cả 6 nhân viên).

| Trang | Nội dung |
|---|---|
| **Inbox** | mọi hội thoại, lọc theo AI/nhân viên; mở được **trace tool-call** của từng câu trả lời AI; nút *Take over* / *Hand back to AI*; nút *Draft* để AI soạn nháp cho nhân viên; panel phải hiển thị profile, lưu trú, folio, ticket của khách |
| **Tasks** | kanban 3 cột, chip SLA, gán người, start/done/reopen, tạo task tay |
| **Rooms** | 40 phòng + 4 villa nhóm theo tầng, đổi trạng thái housekeeping |
| **Reservations** | bảng PMS + tồn kho dịch vụ theo suất |
| **Insights** | 8 KPI + biểu đồ Recharts: AI deflection, first response (tách AI vs người), resolution rate, occupancy, doanh thu ancillary, tải theo bộ phận, sentiment, chủ đề |
| **Knowledge** | CRUD bài KB — sửa ở đây là AI trả lời khác ngay lượt sau, chỉ mục RAG tự dựng lại |
| **Policies** | 11 bản ghi chính sách với quy tắc bung ra dạng bảng + link nguồn Vinpearl, tình trạng chỉ mục embedding, nút dựng lại chỉ mục, và hộp thử truy xuất để xem chính xác AI sẽ đọc gì |
| **Campaigns** | chọn segment (in-house/arriving/departing/VIP/repeat), xem trước danh sách nhận, gửi → **model viết lại từng bản theo tên và ngôn ngữ của từng khách** |
| **Activity** | timeline audit mọi lần ghi dữ liệu |
| **Settings** | brand voice, SLA, bật/tắt AI, kiểm tra kết nối model thật |

### Campaign đã gửi thật

Một broadcast tiếng Anh về nhạc jazz sân thượng gửi tới 5 khách in-house. DB lưu 5 bản khác nhau: tiếng Việt cho Trần Minh Quân và Nguyễn Thanh Hà, tiếng Anh cho Daniel Okafor, tiếng Pháp cho Sophie Lauren (*"jazz live sur la terrasse du neuvième étage…"*), tiếng Nhật kính ngữ cho Yuki Tanaka (*"田中ユキ様、今夜20:00より9階テラスで…"*). Giờ và dữ kiện giữ nguyên tuyệt đối.

---

## 7. Bảo mật & xử lý API key

Key OpenAI của bạn **không nằm trong code**. Nó được lưu trong vault credential của phiên làm việc; server nhận hai biến môi trường trỏ tới một proxy an toàn và gọi `${URL}/v1/chat/completions` với header `x-api-key`. `server/openai.ts` tự nhận diện theo thứ tự: gateway → `OPENAI_API_KEY` → `HTTPS_PROXY`, nên deploy ở đâu cũng chạy.

Model: `gpt-5.4-mini` cho agent, `gpt-5.4-nano` cho phân loại sentiment/topic.

## 8. Lỗi tìm được trong QA và đã sửa

QA bằng Playwright ở 1440px và 390px, chạy đúng luồng người dùng thật:

1. **PIN nhân viên lộ qua API** — `GET /api/conversations/:id` trả cả `pin`. Đã thêm hàm chặn `safeStaff()`, xác nhận không còn field `pin` trong bất kỳ response nào.
2. **Deep link `#/?code=…` ra 404** — wouter trả cả query string trong path. Đã bọc hook location để cắt query trước khi khớp route.
3. **Trang 404 mặc định của template** — thay bằng trang có logo và hai lối ra.
4. **Chip SLA hiển thị "7425m over"** — thêm hàm `duration()` đổi sang `5d 3h`.
5. **Tool `order_room_service` báo lỗi không dạy được model** — nay trả kèm cả menu để model tự sửa ngay trong một vòng thay vì phải gọi thêm `list_services`.

---

## 9. Tầng nghiệp vụ đặt phòng, tầng chắn an toàn và benchmark

Phần này trả lời trực tiếp câu hỏi "agent có đủ thông minh để xử lý nghiệp vụ khách sạn thật không". Cách làm không phải nhồi thêm prompt, mà đưa mọi phán quyết có thể tính được ra khỏi model.

### 9.1 Nghiên cứu nghiệp vụ trước khi viết code

`research/hotel-edge-cases.md` tổng hợp 9 nhóm tình huống thật ở front desk/PMS thành 45 luật kiểm tra và 84 kịch bản, dựa trên các nguồn:

- Vụ [Air Canada bị buộc trả tiền vì chatbot tự bịa chính sách](https://guardion.ai/ai-incidents/air-canada-chatbot-bereavement-refund) (Moffatt v. Air Canada, 2024 BCCRT 149) — lý do agent không bao giờ được tự phát minh chính sách hay hứa hoàn tiền.
- [Night audit trong vận hành khách sạn](https://thehotelblueprint.com/hotel-operations/management/hotel-night-audit/) và [bộ mã trạng thái phòng](https://rapideyeinspections.com/blog/hotel-room-status-codes/) — vì sao "hôm nay" của khách và của khách sạn có thể lệch nhau.
- [Rủi ro prompt injection với chatbot phục vụ khách](https://www.apexhorizondigital.com/blog/prompt-injection-risks-in-customer-facing-chatbots).
- Cách chấm agent của [τ-bench](https://openreview.net/pdf/57cd0f8d1f7b7790714c1bedf5d781ba10e56590.pdf) (so trạng thái database cuối cùng), [BFCL](https://gorilla.cs.berkeley.edu/leaderboard.html), [ToolBench](https://leaderboard.steel.dev/registry/benchmarks/toolbench) và [faithfulness của RAGAS](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/faithfulness/).

### 9.2 `server/booking.ts` — luật đặt phòng chạy bằng code, không bằng model

- `resolveDate` đọc ngày tương đối tiếng Việt/tiếng Anh theo giờ khách sạn, hiểu cả khoảng ngày viết liền ("22/09 đến 24/09"), tự đánh dấu khi câu chữ **mập mờ** (ví dụ "mai" lúc 3 giờ sáng) để agent buộc phải hỏi lại. Model bị cấm tự tính ngày.
- `validateStayRequest` trả về mã lỗi rõ ràng cho từng tình huống: `REVERSED_DATES` (trả phòng trước nhận phòng), `SAME_DAY_STAY`, `ARRIVAL_IN_PAST`, `MAX_STAY_EXCEEDED` (>30 đêm), `BEYOND_BOOKING_HORIZON` (>365 ngày), `MISSING_CHECK_IN/OUT`, `MISSING_ADULTS`, `MISSING_CHILD_AGES`, `CHILD_COUNT_MISMATCH`, `UNACCOMPANIED_MINOR`, `OVER_OCCUPANCY`, `GROUP_BOOKING` (≥10 phòng / ≥5 villa thuộc bộ phận Khách Đoàn), `UNKNOWN_ROOM_TYPE`… Mỗi mã đi kèm một câu gợi ý cách nói lại với khách.
- `checkRestrictions` đọc bảng `restrictions` (rate calendar thật của property): `STOP_SELL`, `CLOSED_TO_ARRIVAL`, `CLOSED_TO_DEPARTURE`, `MIN_LOS`, `MAX_LOS` — có seed cho Tết 2027, Quốc khánh 2026 và một đợt dừng bán hạng suite.
- `searchAvailability` tính phòng trống từ danh sách phòng và sổ đặt phòng thật, lấy giá công bố từ cột `rooms.base_rate`; hạng nào không có giá thì không bán được qua chat. Nếu khách đã nêu ngân sách, tool tự nhớ lại từ chính lời khách (`extractBudget`) và gắn cờ `over_budget`; nếu hạng khách hỏi không bán được, tool trả luôn `alternatives_to_offer` để agent không thể chỉ hỏi suông "anh có muốn xem hạng khác không".
- `createReservation` / `changeReservationDates` là hai đường ghi duy nhất: kiểm tra phòng còn trống thật, sinh mã `VPNT-xxxxxx`, ghi charge vào folio, và từ chối khi khách đã in-house hoặc phòng đã có người.

### 9.3 `server/guard.ts` — sàng lọc từng tin nhắn trước khi model đọc

Nhận diện đa ngôn ngữ: cấp cứu y tế, sự cố an ninh, prompt injection, mạo danh nhân viên, hỏi thông tin khách khác, số thẻ dán vào chat (xoá bằng kiểm tra Luhn), đòi gặp người thật, và **tranh chấp tiền** (đòi hoàn tiền, bồi thường, tính sai). Ba nhóm cuối cùng — y tế, an ninh, tranh chấp tiền — bị **buộc** chuyển người thật ngay trong lượt đó, bất kể model viết gì.

### 9.4 Benchmark 28 case — `bench/`

- `bench/cases.json`: 28 case chia 6 nhóm — Dates (7), Incomplete requests (5), Restrictions (4), Booking execution (3), Safety (6), Money & grounding (3).
- Mỗi case chấm hai lớp: **deterministic** (gọi đúng tool nào, cấm tool nào, có mã validation nào, câu trả lời có kết thúc bằng câu hỏi không, và **trạng thái database sau cùng** kiểu τ-bench — số đặt phòng mới, ngày của một mã đặt phòng cụ thể) và **LLM judge** cho 5 chiều: grounded, correct_handling, asked_for_missing, no_overpromise, tone.
- `bench/run.mjs` nói chuyện với server thật qua HTTP đúng như khách, có retry khi gateway giới hạn token, reset hội thoại về chế độ AI trước mỗi case, và ghi ra `bench/report.json` + `bench/report.md`.
- Kỳ vọng viết theo **token tương đối** chứ không phải ngày cứng: `{{+5}}` là 5 ngày sau ngày khách sạn, `{{depart+1}}` là một ngày sau ngày trả phòng hiện tại của chính đặt phòng đó. Seed đặt các lượt lưu trú tương đối theo "hôm nay", nên ngày cứng trong assertion sẽ mục theo thời gian — token thì không.
- Judge chấm **3 phiếu độc lập, lấy đa số**, vì một phiếu LLM đơn lẻ có thể cho hai kết luận khác nhau trên cùng một câu trả lời. Số phiếu hiện trên báo cáo và trên trang Benchmark (`2/3 pass`).
- Một số case nhận **nhiều đường tool hợp lệ** (`expect_tools_any`): ví dụ chặn 5 người một phòng Deluxe bằng `check_availability` hay `check_occupancy` đều là code kiểm tra, không phải model đoán.
- Trang **Benchmark** trong dashboard đọc `GET /api/bench/report`, mở từng case ra xem hội thoại, tool đã gọi, từng phép kiểm tra và điểm của judge.

Cách chạy:

```bash
rm -f data.db data.db-wal data.db-shm     # chạy trên seed sạch cho đúng phép so trạng thái
npm run build && NODE_ENV=production node dist/index.cjs
node bench/run.mjs                        # hoặc --only D1,I5,M3 · --no-judge
```

### 9.5 Những lỗi thật benchmark tìm ra và đã sửa

1. `validateStayRequest` không bao giờ báo `OVER_OCCUPANCY` — điều kiện guard dùng `occ.ok`, mà `occ.ok` chỉ false đúng khi vượt số người.
2. Khớp tên hạng phòng kiểu "chứa chuỗi" trả về "Grand Deluxe Queen Bed" khi khách nói "Deluxe Queen" — nay khớp chính xác trước, rồi mới lấy chuỗi khớp ngắn nhất.
3. Giá phòng suy ra từ lịch sử đặt phòng nên villa hiện **0 VND** và agent đem "villa giá 0" ra mời khách — nay giá công bố nằm ở `rooms.base_rate`, hạng không có giá thì không bán.
4. `check_availability` lọc danh sách theo đúng hạng khách hỏi, nên khi hạng đó dừng bán agent không có gì để gợi ý — nay luôn tính đủ mọi hạng và trả `alternatives_to_offer`.
5. Agent lấy tên khách từ profile chat để tạo đặt phòng — nay `create_reservation` chỉ chạy khi chính khách đã nhập tên và số điện thoại trong hội thoại.
6. Ngân sách khách nêu ở lượt trước bị bỏ quên ở lượt sau — nay đọc lại từ lời khách và gắn cờ `over_budget`, kèm cấm dùng chữ "phù hợp" cạnh hạng vượt ngân sách.
7. Đòi hoàn tiền không được chuyển người thật, và agent tự hứa "gọi lại trong 10 phút" — nay guard buộc chuyển, và prompt cấm hứa thời gian phản hồi.
8. `resolve_date` không đọc được khoảng ngày viết liền "22/09 đến 24/09" nên agent hỏi lại vô ích — nay trả cả hai đầu.

### 9.6 Kết quả lần chạy mới nhất

**27/28 case đạt — deterministic 28/28, judge 27/28** (20/08/2026, seed sạch, ngày khách sạn 2026-08-20):

| Nhóm | Đạt |
| --- | --- |
| Dates & temporal logic | 6/7 |
| Incomplete requests | 5/5 |
| Rate-calendar restrictions | 4/4 |
| Booking execution | 3/3 |
| Safety & escalation | 6/6 |
| Money & grounding | 3/3 |

Case còn trượt là **D7**: agent trả lời đúng ngày, đúng giá, hỏi lại đúng thông tin thiếu, nhưng viết "có thể giữ tiếp để đặt ngay" — một lời hứa giữ phòng mà chưa có tool nào xác nhận. Đây là lỗi cách nói, không phải lỗi dữ liệu.

Cần nói thẳng một điều về con số này: **lớp deterministic ổn định 28/28**, còn **lớp judge dao động 25–28/28 giữa các lần chạy** dù code không đổi, vì nó là một model chấm model. Đã giảm nhiễu bằng cách lấy đa số 3 phiếu, nhưng chưa triệt tiêu được. Vì vậy khi đọc báo cáo, hãy tin lớp deterministic trước — đó mới là phần kiểm tra tool, mã lỗi nghiệp vụ và trạng thái database.

Toàn bộ transcript của lần chạy mới nhất nằm trong `bench/report.md` và trên trang Benchmark của dashboard.

---

## 10. Danh mục hạng phòng lấy từ 9 trang phòng thật

Phần này trả lời đúng yêu cầu "bổ sung data nhưng agent không được lấy sai, không được bịa".

**Nguồn**: 9 tệp mô tả phòng do bạn cung cấp (Deluxe Giường Đôi, Deluxe 2 Giường Đơn, Deluxe Hướng Biển Giường Đôi, Deluxe Hướng Biển 2 Giường Đơn, Grand Deluxe Giường Đôi, Grand Deluxe 2 Giường Đơn, Grand Deluxe Hướng Biển 2 Giường Đơn, Biệt Thự 3 Phòng Ngủ Hướng Biển, Biệt thự Tropicana 3 phòng ngủ hướng biển).

**Đường đi của dữ liệu**

1. `scripts/parse-room-types.py` đọc 9 tệp, gỡ nhãn tiện nghi bị lặp đôi ("Ban côngBan công" → "Ban công"), tách diện tích, số phòng ngủ, loại giường (twin/double), hướng biển, bể riêng, sức chứa công bố dạng `Tối đa 4 người … (3 người lớn 1 trẻ em hoặc 2 người lớn 2 trẻ em)`, danh sách tiện nghi, tệp nguồn và URL nguồn → `server/data/room-types.json`.
2. **Nguyên tắc cốt lõi: trường nào trang không công bố thì để `null`, không suy đoán.** Chỉ 4/9 hạng có công bố sức chứa; 5 hạng còn lại `max_guests = null` và agent phải nói là chưa công bố.
3. Bảng mới `room_types` trong `shared/schema.ts` + `server/storage.ts`; seed từ JSON trong `server/seed.ts`.
4. `server/retrieval.ts` đánh index thêm mỗi hạng phòng thành chunk `kind:"room"` → index hiện có 25 chunk KB + 17 chunk policy + 18 chunk phòng.
5. `GET /api/room-types` và bảng **Room catalogue** ở trang Rooms của dashboard hiển thị đúng những gì được công bố; ô trống hiện dấu gạch để nhân viên thấy rõ chỗ nào trang phòng im lặng.

**Tầng chống trả lời sai** — `server/catalogue.ts`

- `findRoomType()` khớp tên tiếng Việt lẫn tiếng Anh sau khi bỏ dấu, **trừ điểm nặng khi lệch loại giường hoặc lệch hướng biển**, và nếu một hạng chỉ có trong inventory mà không có trang công bố (Deluxe Suite King Ocean View) khớp tốt hơn thì trả về `null` thay vì đưa ra hạng gần giống. Trước khi có luật này, câu hỏi về Deluxe Suite King Ocean View bị trả lời bằng tiện nghi của Deluxe Hướng Biển Giường Đôi — đúng dạng bịa đặt mà module này sinh ra để chặn.
- `matchAmenity()` khớp theo **cả từ**, không khớp chuỗi con. Bản đầu tiên trả lời câu hỏi "có bàn là không?" bằng "có bàn làm việc" vì `bàn là` là chuỗi con của `bàn làm việc`. Đây là lỗi thật, đã sửa.
- `roomTypeFacts()` trả về `unpublished_fields` và một chuỗi `instruction` bắt buộc agent: tiện nghi `not_listed` thì nói là không nằm trong mô tả công bố (không được biến thành "có", cũng không được khẳng định resort không có), và khi hạng phòng không công bố sức chứa thì phải nói ra điều đó trong cùng câu trả lời.
- `server/booking.ts` nhận thêm tên hạng phòng tiếng Việt qua `findRoomType`; trước đó khách nói "Deluxe Giường Đôi" bị trả về `UNKNOWN_ROOM_TYPE` và agent nói sai rằng hạng phòng đó không tồn tại.
- Mã lỗi nghiệp vụ mới **`OVER_PUBLISHED_OCCUPANCY`**: tổ hợp công bố chặt hơn tổng số khách, nên 4 người lớn bị từ chối trong hạng ghi "3 người lớn + 1 trẻ em hoặc 2 người lớn + 2 trẻ em" dù trần chung vẫn là 4 người.
- Tool mới của agent: `get_room_type_facts(room_type, amenity_questions[])`; doctrine thêm **luật 6** về diện tích, tiện nghi và tổ hợp khách.

**Nói thẳng ba điều chưa hoàn hảo**

- Hai hạng `Deluxe Ocean View Twin Bed` và `Grand Deluxe Twin Bed` được thêm vào inventory để danh mục khớp với các trang phòng bạn gửi — đây là dữ liệu vận hành do tôi tạo, không phải trích từ trang.
- `Deluxe Suite King Ocean View` bán được nhưng **không có trang công bố**, nên agent chỉ báo giá và nói rõ là chi tiết chưa công bố.
- Giá theo hạng phòng lấy từ bảng giá đã seed trước đó, không nằm trong 9 tệp mô tả.

**Benchmark thêm nhóm F (Room facts & amenities)** — F1 tiện nghi có công bố, F2 tiện nghi không công bố, F3 bốn người lớn so với tổ hợp công bố, F4 biệt thự 370 m² và bể riêng, F5 hạng phòng không có trang công bố, F6 không được đổi 2 giường đơn thành giường đôi. Bộ case tăng từ 28 lên 34.

Trong lần chạy này, chính benchmark đã phát hiện 2 lỗi thật của agent (khớp chuỗi con `bàn là` / `bàn làm việc`, và ghép sai hạng phòng cho suite) cùng 2 lỗi của chính bộ kiểm (chuỗi cấm khớp giữa từ, và `expect_tools_any` bị lồng mảng). Cả 4 đều đã sửa.

---

## 11. Chạy lại và mở rộng

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
