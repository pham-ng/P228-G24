# Hướng dẫn Langfuse — giám sát & đọc trace cho Aurea

Langfuse là nền tảng observability mã nguồn mở dành riêng cho ứng dụng LLM. Với Aurea,
mỗi **lượt agent trả lời khách** được gửi sang Langfuse thành một **trace**, và mỗi bước
bên trong (gọi mô hình, gọi công cụ, kiểm số…) thành một **observation**. Bạn — hoặc
khách hàng đang xem demo — nhìn thấy toàn bộ quá trình agent suy nghĩ trên một dashboard
chuyên nghiệp, đúng thứ tạo cảm giác uy tín.

> **Quan trọng:** Langfuse là *tuỳ chọn*. Trang **Staff → Traces** trong app đã cho bạn
> xem đầy đủ trace mà không cần Langfuse. Langfuse chỉ là lớp thứ hai để trình diễn và
> phân tích sâu hơn. Nếu Langfuse lỗi/mất mạng, câu trả lời cho khách **không** bị ảnh hưởng.

---

## 1. Chọn cách chạy Langfuse

| | Langfuse Cloud | Tự dựng (self-host) |
|---|---|---|
| Độ dễ | Rất dễ, 5 phút | Cần Docker, ~20 phút |
| Dữ liệu nằm ở | Máy chủ Langfuse | Máy chủ của bạn |
| Khuyến nghị cho | Demo, thử nghiệm, đa số khách | Khách yêu cầu dữ liệu không ra ngoài |

Bắt đầu bằng **Cloud** cho nhanh; chuyển self-host sau nếu cần.

---

## 2. Lấy API key (Langfuse Cloud)

1. Vào **https://cloud.langfuse.com** → đăng ký (email hoặc Google).
   - Có 2 vùng: **EU** (`https://cloud.langfuse.com`) và **US** (`https://us.cloud.langfuse.com`).
     Nhớ vùng bạn chọn — nó chính là **Base URL** ở bước sau.
2. Tạo một **Organization** rồi một **Project** (đặt tên, ví dụ `aurea-demo`).
3. Vào **Settings → API Keys → Create new API keys**.
4. Bạn nhận được 2 khoá:
   - **Public Key** — bắt đầu bằng `pk-lf-...`
   - **Secret Key** — bắt đầu bằng `sk-lf-...` (chỉ hiện 1 lần, hãy copy ngay)

---

## 3. Nhập key vào Aurea

### Cách A — Qua giao diện (khuyến nghị, không cần sửa file)

1. Đăng nhập trang **Staff** → mở **Settings**.
2. Tới mục **“Langfuse — giám sát & nhật ký”**.
3. Dán **Public key** và **Secret key**. Để trống **Base URL** nếu dùng vùng EU;
   điền `https://us.cloud.langfuse.com` nếu bạn chọn vùng US; điền URL riêng nếu self-host.
4. Bấm **Lưu & kết nối**. Badge chuyển sang **“Đang kết nối”**.
   - Lượt chat *kế tiếp* sẽ tự động được gửi sang Langfuse (không cần khởi động lại).
   - Muốn tắt: bấm **Ngắt kết nối**.

> Secret key được lưu trên máy chủ và **không bao giờ** được trả ngược về giao diện —
> form chỉ hiển thị public key đã che bớt (ví dụ `pk-lf-…1234`).

### Cách B — Qua biến môi trường (khoá cứng cho production)

Thêm vào file `.env` rồi khởi động lại server:

```
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASEURL=https://cloud.langfuse.com
```

Khi có biến môi trường, nó **được ưu tiên** hơn key nhập qua giao diện, và ô nhập trong
Settings sẽ bị khoá (hiện dòng “đang cấu hình bằng biến môi trường”). Dùng cách này khi
bạn muốn ops kiểm soát, không cho ai đổi từ UI.

---

## 4. Kiểm tra đã chạy

1. Gửi thử vài tin nhắn cho agent ở trang khách (Guest).
2. Mở **cloud.langfuse.com → project của bạn → Tracing → Traces**.
   Bạn sẽ thấy các trace tên `agent.turn` xuất hiện trong vài giây.
3. Trong Aurea, trang **Traces** hiển thị badge xanh **“Đang gửi sang Langfuse”** có link
   bấm thẳng sang dashboard.

Nếu chưa thấy: kiểm tra lại đúng cặp key, đúng **Base URL/vùng**, và server có kết nối
internet ra ngoài.

---

## 5. Cách đọc trên Langfuse

- **Traces** (danh sách): mỗi dòng là một lượt agent. Cột **Latency** = thời gian lượt,
  **Timestamp**, và **Tags**.
- **Tags** = chính các *mã tín hiệu* của hệ thống (`numeric_fabrication`, `tool_needs_input`,
  `retrieval_empty`…). Bấm lọc theo tag để chỉ xem những lượt có vấn đề đó.
- Mở một trace → thấy **cây observation** thụt lề theo cha/con:
  - **GENERATION** (màu khác) = một lần gọi mô hình LLM. Bấm vào xem input/output, model.
  - **SPAN** = một bước công cụ / kiểm số / định tuyến. Mức **level** cho biết trạng thái:
    - `DEFAULT` = bình thường, `WARNING` = cảnh báo, `ERROR` = lỗi.
    - **Status Message** ghi lý do ngắn gọn (ví dụ `tool_error: No reservation linked`).
- **Sessions**: các lượt của cùng một cuộc trò chuyện được gộp theo
  `conversation:<id>` (chúng tôi đặt sẵn `sessionId`), nên bạn theo dõi được cả hội thoại.
- **Metadata** của mỗi observation chứa toàn bộ tín hiệu và ngữ cảnh (tham số công cụ,
  nhóm công cụ được chọn, số token…).

### Bản đồ khái niệm Aurea ↔ Langfuse

| Aurea (trang Traces) | Langfuse |
|---|---|
| 1 lượt agent (`agent.turn`) | 1 **Trace** |
| Bước gọi LLM (`llm.chat`) | **Generation** |
| Bước gọi công cụ / guard / router | **Span** |
| Chấm màu 🟢🟠🔴 | **Level** DEFAULT / WARNING / ERROR |
| Chip mã tín hiệu | **Tags** + Status Message |
| Hội thoại #id | **Session** `conversation:id` |

---

## 6. Tự dựng Langfuse (tuỳ chọn)

Nếu khách yêu cầu dữ liệu không ra khỏi hạ tầng của họ:

```bash
git clone https://github.com/langfuse/langfuse
cd langfuse
docker compose up -d        # mặc định chạy ở http://localhost:3000
```

Sau đó tạo project + API key như mục 2, và điền **Base URL** = `http://localhost:3000`
(hoặc tên miền nội bộ) vào ô Base URL trong Settings.

---

## 7. Lưu ý bảo mật

- **Secret key** cấp quyền ghi dữ liệu vào project — giữ như mật khẩu, không commit vào git.
- Trong Aurea, secret được lưu ở bảng cấu hình runtime và không bao giờ trả về client.
- Trước khi mở API ra mạng thật, hãy bật xác thực staff (`STAFF_API_TOKEN` +
  `API_AUTH_ENFORCE=1`) để ô nhập key không bị người lạ truy cập.
- Tránh gửi dữ liệu nhạy cảm của khách vào tên/trace nếu chính sách của bạn không cho phép;
  hiện hệ thống đã che số thẻ trong tin nhắn trước khi xử lý.
