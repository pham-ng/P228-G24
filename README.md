# 🌟 Aurea: Vinpearl AI Concierge

![Aurea Banner](https://img.shields.io/badge/Aurea-AI%20Concierge-0052cc?style=for-the-badge&logo=openai)
![React](https://img.shields.io/badge/React-18.x-61dafb?style=for-the-badge&logo=react)
![Express](https://img.shields.io/badge/Express-5.x-000000?style=for-the-badge&logo=express)
![SQLite](https://img.shields.io/badge/SQLite-Drizzle-003B57?style=for-the-badge&logo=sqlite)

Aurea là một trợ lý ảo (AI Concierge) thông minh được thiết kế đặc biệt cho **Vinpearl Resort Nha Trang**. Hệ thống ứng dụng mô hình ngôn ngữ lớn (LLM) để giao tiếp tự nhiên với khách lưu trú, đồng thời kết nối trực tiếp với cơ sở dữ liệu thời gian thực của khách sạn để thực hiện các nghiệp vụ như tư vấn phòng, đặt bàn nhà hàng, mua vé VinWonders và gợi ý Spa.

---

## ✨ Tính Năng Nổi Bật

- 🤖 **Giao tiếp Tự nhiên (Conversational AI)**: Khả năng hiểu ngữ cảnh và phản hồi chính xác dựa trên cơ sở tri thức (Knowledge Base) của khu nghỉ dưỡng.
- 🖼️ **Giao diện Trực quan (Data-Driven Image Gallery)**: AI tự động phân tích và đính kèm bộ sưu tập ảnh chất lượng cao (phòng ngủ, nhà hàng, spa, khu vui chơi) tích hợp thẳng vào đoạn chat với thao tác vuốt trượt (Lightbox) mượt mà.
- 🛎️ **Nghiệp vụ Tự động (Tool-calling)**: Tích hợp công cụ để truy vấn giá vé, kiểm tra tình trạng phòng trống, và tạo yêu cầu đặt dịch vụ (Booking) trực tiếp.
- 👑 **Cá nhân hóa Khách hàng (Personalization)**: Nhận diện phân hạng VIP (Platinum, Gold,...) và tự động áp dụng các quyền lợi, mã giảm giá tương ứng trong các báo giá của AI.

## 🛠 Công Nghệ Sử Dụng

**Frontend (Client):**
- React 18 với Vite
- Tailwind CSS & Radix UI (shadcn/ui)
- Framer Motion (Animation & Transitions)
- React Markdown (Render tin nhắn AI)

**Backend (Server):**
- Node.js & Express 5
- OpenAI API (GPT-4o / GPT-4o-mini)
- Drizzle ORM
- SQLite (better-sqlite3)

---

## 🚀 Hướng Dẫn Cài Đặt & Khởi Chạy

### 1. Yêu cầu hệ thống
- Node.js (phiên bản >= 18.x)
- Tài khoản OpenAI API Key

### 2. Cài đặt Dependencies
```bash
git clone https://github.com/pham-ng/P228-G24.git
cd P228-G24
npm install
```

### 3. Cấu hình Môi trường
Tạo tệp `.env` ở thư mục gốc dựa trên mẫu `.env.example`:
```bash
cp .env.example .env
```
Mở tệp `.env` và điền khóa API của bạn vào biến `OPENAI_API_KEY`.

### 4. Khởi chạy Ứng dụng (Chế độ Development)
Để khởi chạy cả Server và Frontend cùng một lúc (nhờ Vite Middleware Mode), bạn chỉ cần chạy:
```bash
npm run dev
```
Truy cập vào ứng dụng tại: `http://localhost:5000`

---

## 📁 Cấu Trúc Dự Án

```
Aurea/
├── client/                 # Mã nguồn Frontend (React)
│   ├── public/             # Tài nguyên tĩnh (Hình ảnh phòng, nhà hàng, dịch vụ)
│   └── src/
│       ├── components/     # UI Components (shadcn/ui, markdown-body,...)
│       ├── lib/            # Tiện ích Frontend (Tailwind config, fetchers)
│       └── pages/          # Các trang giao diện chính (Inbox, Guest profile)
├── server/                 # Mã nguồn Backend (Express + AI Tools)
│   ├── agent.ts            # Quản lý logic AI & Tool-calling (Prompts)
│   ├── catalogue.ts        # Service lấy thông tin Phòng nghỉ
│   ├── dining.ts           # Service lấy thông tin Nhà hàng & Bar
│   ├── storage.ts          # Kết nối Database (Drizzle ORM)
│   └── index.ts            # Entry point Server
├── shared/                 # Định nghĩa Schema dùng chung
│   └── schema.ts           # Schema CSDL (SQLite Tables)
└── data.db                 # Database SQLite (Sẵn sàng sử dụng)
```

## 📝 Quản Lý Dữ Liệu Hình Ảnh (Data-Driven UI)

Hệ thống được thiết kế hoàn toàn tự động dựa trên cơ sở dữ liệu. Để thêm ảnh cho một dịch vụ mới:
1. Thêm hình ảnh của bạn vào các thư mục tương ứng trong `client/public/rooms`, `/dining`, hoặc `/services`.
2. Khai báo các đường dẫn hình ảnh này dưới dạng mảng JSON `["/duong-dan/1.jpg"]` vào cột `images` của bảng tương ứng trong CSDL SQLite.
3. Khi AI giới thiệu về dịch vụ đó, nó sẽ tự động chèn mã `[IMAGES: ...]` để giao diện hiển thị băng chuyền hình ảnh cho người dùng.

---
*Phát triển bởi nhóm P228-G24.*
