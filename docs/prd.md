# TÀI LIỆU YÊU CẦU SẢN PHẨM (PRD) - AUREA AI CONCIERGE

## 1. TỔNG QUAN SẢN PHẨM (Product Overview)
**Aurea AI Concierge** là hệ thống trợ lý ảo AI thông minh hoạt động 24/7, được thiết kế chuyên biệt cho ngành Khách sạn – Khu nghỉ dưỡng (Hospitality) cao cấp. Sản phẩm là một hệ thống full-stack kết hợp giữa Giao diện trò chuyện của khách hàng, Bảng điều khiển quản lý của nhân viên (Dashboard) và Động cơ AI (AI Engine) tự động hóa.
Mục tiêu của Aurea là nâng cao trải nghiệm lưu trú của khách thông qua việc hỗ trợ đa ngôn ngữ, tự động cá nhân hóa ưu đãi, xử lý các yêu cầu tức thì (như đặt bàn, yêu cầu dọn phòng, thông tin dịch vụ) trong khi vẫn duy trì sự giám sát và can thiệp kịp thời của con người (Human-in-the-Loop - HITL) đối với những tình huống nhạy cảm.

---

## 2. CHÂN DUNG NGƯỜI DÙNG (Target Audience)
Sản phẩm phục vụ hai nhóm đối tượng chính với các nhu cầu khác biệt:

### 2.1. Khách lưu trú (Hotel Guests)
- **Nhu cầu**: Cần giải đáp thắc mắc, đặt dịch vụ (ăn uống, spa, đánh golf), yêu cầu hỗ trợ phòng, cập nhật tình trạng trả phòng muộn (late check-out) nhanh chóng, mọi lúc mọi nơi.
- **Đặc điểm**: Đa quốc gia, sử dụng nhiều ngôn ngữ khác nhau (Anh, Việt, Hàn, Trung, Nhật, Nga,...). Yêu cầu phản hồi tức thì và chính xác tuyệt đối về giá cả/chính sách.
- **Nền tảng sử dụng**: Web App trên thiết bị di động (quét mã QR trong phòng) hoặc màn hình máy tính bảng.

### 2.2. Nhân viên & Quản lý khách sạn (Hotel Staff & Operations)
- **Nhu cầu**: Quản lý tập trung hàng trăm luồng tin nhắn đồng thời. Bám sát trạng thái các yêu cầu (Booking, Task, Ticketing). Cần công cụ cảnh báo (Alert) để can thiệp kịp thời nếu AI gặp khó khăn hoặc khách có yêu cầu y tế, an ninh.
- **Nền tảng sử dụng**: Web Dashboard trên máy tính hoặc tablet tại quầy lễ tân (Front Desk).

---

## 3. CÁC TÍNH NĂNG CỐT LÕI (Core Features)

### 3.1. Proactive AI Agent (Trợ lý AI Chủ động)
- **Cơ chế suy luận có kiểm soát**: Agent không tự do bịaa thông tin (Zero Hallucination). Nó hoạt động theo quy trình 5 bước nghiêm ngặt: Phân tích (Decompose) -> Tìm kiếm công cụ (Ground) -> Tính toán & Cá nhân hóa (Compute) -> Xác minh (Verify) -> Trả lời (Resolve).
- **Hỗ trợ đa ngôn ngữ (Multi-lingual)**: Tự động phát hiện và trả lời trôi chảy bằng ngôn ngữ mà khách vừa sử dụng, giữ nguyên văn phong lịch sự, trang trọng.

### 3.2. Hybrid RAG (Hệ thống Truy xuất Thông tin Đa phướng thức)
- Tích hợp tính năng RAG (Retrieval-Augmented Generation) kết hợp giữa tìm kiếm từ khóa truyền thống (BM25) và tìm kiếm ngữ nghĩa Vector (Vector Embedding) từ OpenAI.
- Quản lý hàng trăm bài báo, quy định nội quy, thực đơn, cẩm nang từ `kb_articles` và các file cào dữ liệu ngoài (ví dụ: dữ liệu VinWonders).
- Có cơ chế tag version (VD: `v1`) giúp đội ngũ admin dễ dàng quản lý dữ liệu bị trùng lặp hoặc mâu thuẫn.

### 3.3. Tự động cá nhân hóa Ưu đãi (Dynamic Loyalty Entitlements)
- Hệ thống nhận diện tự động Hạng thẻ hội viên (Vip Tier: Pearl, Platinum, Diamond...).
- Tự động áp dụng công thức giảm giá ngay trong tư duy của LLM khi báo giá cho khách (Ví dụ: Khách Platinum hỏi giá Spa 1.000.000đ -> AI chủ động tính giảm 30% và báo giá 700.000đ).

### 3.4. Giao diện trực quan & Intent Chips (Quick Actions)
- Giao diện chat của khách có các "Ô Intent" (Chips hành động nhanh) như: 🍽️ Xem menu nhà hàng, 💆 Dịch vụ Spa, 🚪 Phí trả phòng muộn.
- Tính năng này cố định vĩnh viễn trên UI, giúp khách một chạm gửi yêu cầu mà không cần gõ phím. Cải thiện trải nghiệm cho người dùng thao tác chậm hoặc gõ sai lỗi chính tả (Typo handling).

### 3.5. Quy trình Đặt dịch vụ (Booking Flow) bảo vệ nghiêm ngặt
- Khi khách có ý định đặt bàn (F&B) hoặc Spa, AI không chốt đơn lập tức. 
- Nó phải thực hiện thu thập đủ tham số bắt buộc: **Khung giờ** và **Số lượng người lớn/trẻ em**. Thiếu 1 trong 2, AI sẽ hỏi lại bằng 1 câu lịch sự ngắn gọn.

### 3.6. Cơ chế Cảnh vệ & Human-in-the-Loop (Safety Guard & HITL)
- **Message Guard**: Mọi tin nhắn đầu vào được đi qua 1 màng lọc (Screening) trước khi LLM xử lý. 
- **Escalation (Chuyển giao)**: Nếu khách chửi thề, khiếu nại gay gắt về hóa đơn, hoặc có dấu hiệu Cấp cứu Y tế (Medical Emergency), AI lập tức phong tỏa luồng tự động và ping cho Lễ tân xử lý.

---

## 4. YÊU CẦU PHI CHỨC NĂNG (Non-Functional Requirements - NFR)

### 4.1. Hiệu suất & Độ trễ (Performance & Latency)
- **Thời gian phản hồi của AI**: Hệ thống cần trả về token đầu tiên (Streaming) hoặc hoàn tất thông điệp dưới **3 giây**.
- **Tối ưu Tool Calling**: Cho phép gọi nhiều tools song song (Parallel Tool Calling) để giảm thời gian load.

### 4.2. Độ chính xác & Toàn vẹn dữ liệu (Accuracy & Integrity)
- **Grounding Rate 100%**: Mọi dữ liệu liên quan đến Giờ mở cửa, Giá tiền, Khuyến mãi phải được lấy trực tiếp từ `Database` hoặc `RAG`, nghiêm cấm LLM tự "sáng tác" thông tin ảo.

### 4.3. Bảo mật (Security)
- Khả năng chống các cuộc tấn công Prompt Injection (VD: Khách yêu cầu AI quên chỉ thị, tự nhận là Giám đốc để đòi miễn phí phòng). Guard prompt sẽ chặn đứng các hành vi này.

### 4.4. Mở rộng (Scalability)
- Kiến trúc API phi trạng thái (Stateless API), dễ dàng triển khai với Docker và scale ngang để phục vụ hằng ngàn phòng khách sạn trong mùa cao điểm.
- Database SQLite với cơ chế WAL (Write-Ahead Logging) đáp ứng cực nhanh các giao dịch Đọc/Ghi.

---

## 5. MÔ HÌNH KIẾN TRÚC & TRIỂN KHAI (Architecture Overview)
- **Frontend**: React, TypeScript, TailwindCSS, Vite (Cung cấp UI siêu mượt).
- **Backend**: Node.js, Express (Chạy event-loop hiệu suất cao).
- **Storage**: SQLite qua Drizzle ORM (Quản lý tập trung mọi trạng thái).
- **AI Core**: Tích hợp OpenAI GPT-4o (Agent Engine) và text-embedding-3-small (Vector Search).
*(Xin xem chi tiết tại file `Architecture_Diagram.md` để quan sát các sơ đồ cấu trúc hệ thống cụ thể).*
