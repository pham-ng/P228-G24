# 🌟 Aurea: Enterprise Multilingual AI Concierge (Vinpearl Resort)

![Aurea Banner](https://img.shields.io/badge/Aurea-AI%20Concierge-0052cc?style=for-the-badge&logo=openai)
![Qwen](https://img.shields.io/badge/Model-Qwen%202.5--3B%20%2F%204B-purple?style=for-the-badge)
![Ollama](https://img.shields.io/badge/Ollama-Offline%20Mode-blue?style=for-the-badge)
![React](https://img.shields.io/badge/React-18.x-61dafb?style=for-the-badge&logo=react)
![Express](https://img.shields.io/badge/Express-5.x-000000?style=for-the-badge&logo=express)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?style=for-the-badge&logo=typescript)

Aurea là hệ thống Trợ lý ảo (AI Concierge) doanh nghiệp cao cấp dành cho **Vinpearl Resort Nha Trang**, hoạt động theo kiến trúc **Local-First & Fail-Closed**, tích hợp bộ kiểm soát an toàn quyết định (Deterministic Safety & NumGuard Interceptor), bộ kiểm soát 5 trạng thái tri thức (5-State Knowledge Architecture) và hỗ trợ đa ngôn ngữ (Tiếng Việt, Anh, Hàn, Nhật, Trung, Nga).

---

## 🚀 Hướng Dẫn Cài Đặt & Khởi Chạy Nhanh (Quick Start)

### 1. Yêu cầu Tiền đề (Prerequisites)
- **Node.js**: Phiên bản `>= 18.x` (Khuyến nghị Node.js 20.x).
- **Git**: Đã cài đặt trên máy.
- **Ollama** (Bắt buộc nếu chạy chế độ Local Offline): Tải và cài đặt tại [ollama.com](https://ollama.com).

---

### 2. Tải Mã Nguồn (Clone Repository)
Mở Terminal/PowerShell và thực hiện các lệnh sau:
```bash
git clone https://github.com/pham-ng/P228-G24.git
cd P228-G24
npm install
```

---

### 3. Khởi Tạo Model AI Local (Chạy 100% Offline)
Mở Terminal/PowerShell và chạy lệnh sau để Ollama tải model Qwen local về máy (chỉ cần chạy 1 lần duy nhất):
```bash
ollama pull qwen2.5:3b
```
*(Tùy chọn: Nếu muốn dùng thêm Vector Search local với BGE-M3, chạy: `ollama pull bge-m3`)*

---

### 4. Cấu Hình Môi Trường (`.env`)
Tạo tệp `.env` tại thư mục gốc từ tệp mẫu `.env.example`:

**Trên Windows (PowerShell):**
```powershell
cp .env.example .env
```
**Trên Mac / Linux:**
```bash
cp .env.example .env
```

**Nội dung file `.env` chuẩn để chạy Local Offline:**
```env
# Mode chạy AI Local Offline 100%
LLM_MODE=local
LOCAL_API=ollama
EMBED_PROVIDER=local

# Địa chỉ Server Ollama & Tên Model Qwen
LOCAL_BASE=http://127.0.0.1:11434
LOCAL_LLM_BASE=http://127.0.0.1:11434
LOCAL_AGENT_MODEL=qwen2.5:3b

# Cấu hình RAG & Cổng ứng dụng
LOCAL_MIN_SCORE=0.28
LOCAL_PASSAGE_CHAR_CAP=700
PORT=5000
```

---

### 5. Khởi Chạy Ứng Dụng (Dev Server)
Khởi chạy cả Express Server Backend và Vite React Frontend với 1 lệnh duy nhất:
```bash
npm run dev
```

Mở trình duyệt truy cập ngay tại: **[http://localhost:5000](http://localhost:5000)**

---

## 🔑 Hướng Dẫn Trải Nghiệm Khách Hàng (Guest Login)

Khi truy cập [http://localhost:5000](http://localhost:5000):
1. Tại danh sách **"IN HOUSE NOW"**, chỉ cần **click trực tiếp vào tên khách hàng** để vào thẳng giao diện chat.
2. Hoặc sử dụng các **Mã đặt phòng (Confirmation Codes)** mẫu dưới đây:

| Khách hàng | Quốc tịch / Ngôn ngữ | Mã đặt phòng (Code) | Hạng phòng | Hạng thẻ Pearl Club |
| :--- | :--- | :--- | :--- | :--- |
| **Nguyễn Thanh Hà** | 🇻🇳 Việt Nam (vi) | `VPNT-2M77VD` | 202 (Grand Deluxe Ocean) | **Platinum** (-20% F&B, -30% Spa) |
| **Trần Minh Quân** | 🇻🇳 Việt Nam (vi) | `VPNT-7H23PC` | 101 (Deluxe Twin) | None |
| **Lê Hoàng Phúc** | 🇻🇳 Việt Nam (vi) | `VPNT-1D40TG` | V03 (Villa 3 phòng ngủ) | **Diamond** |
| **Kim Ji-woo** | 🇰🇷 Hàn Quốc (ko) | `VPNT-5K18QA` | 102 (Deluxe Queen) | **Gold** |
| **Yuki Tanaka** | 🇯🇵 Nhật Bản (ja) | `VPNT-9K52JH` | 104 (Deluxe Ocean) | **Silver** |
| **Zhang Wei** | 🇨🇳 Trung Quốc (zh) | `VPNT-6B44LN` | 301 (Grand Deluxe) | **Gold** |

---

## 🛡️ Kiến Trúc An Toàn & Tin Cậy (Hardened Architecture)

Hệ thống Aurea đạt tiêu chuẩn an toàn doanh nghiệp (Release-Grade) qua 3 giai đoạn gia cố:

- 🔒 **Phase 1 (Safety & Transaction Hardening):**
  - Đảm bảo 0% hành vi tự bịa giá, tự hủy phòng hay tự hứa đền bù tài chính.
  - Tự động chặn và chuyển hướng cho lễ tân (`escalate_to_human`) khi phát hiện truy vấn nhạy cảm.

- 🧮 **Phase 2 (Numeric Grounding Reliability):**
  - Tích hợp bộ kiểm chứng số liệu **NumGuard Interceptor** & bộ chuẩn hóa đa ngôn ngữ **Multilingual Canonical Normalizer**.
  - Mọi con số (giá tiền, thời gian check-in, sức chứa) bắt buộc phải kiểm chứng trùng khớp 100% với dữ liệu tri thức gốc mới được trả về cho khách.

- 🧩 **Phase 3 (Knowledge-State & Ambiguity Reliability):**
  - Phân loại truy vấn theo **5 trạng thái tri thức** (`ANSWERABLE`, `UNKNOWN`, `AMBIGUOUS`, `CONFLICTING`, `DYNAMIC`).
  - Khi gặp câu hỏi thiếu thông tin (ví dụ: *"Giá bao nhiêu?"*, *"Mấy giờ?"*), AI không tự đoán mà tự động phát câu hỏi làm rõ (Clarification Prompt).

---

## 🧪 Đánh Giá Chất Lượng (Evaluation Suite)

Hệ thống đi kèm bộ công cụ đánh giá độc lập (Evaluator Suite với Gemini LLM-as-a-Judge) trên 591 kịch bản frozen test cases:

```bash
# Đánh giá tổng thể hệ thống local với Gemini Judge
npx tsx bench/run-full-gemini-eval.ts

# Chạy đánh giá Phase 1 (Safety)
npx tsx bench/run-phase1-eval.ts

# Chạy đánh giá Phase 2 (Numeric Grounding)
npx tsx bench/run-phase2-eval.ts

# Chạy đánh giá Phase 3 (Knowledge-State & Ambiguity)
npx tsx bench/run-phase3-eval.ts
```
Báo cáo nghiệm thu chi tiết được lưu tự động tại thư mục: `bench/baselines/kiosk-validation/`.

---

## 📁 Cấu Trúc Dự Án

```
aurea/
├── client/                 # Mã nguồn Frontend (React 18 + Vite + Tailwind + Radix UI)
│   ├── public/             # 119 tệp hình ảnh thực tế (Phòng, Nhà hàng, Spa, VinWonders)
│   └── src/                # Components UI & Pages (Guest Kiosk Chat, Staff Portal)
├── server/                 # Mã nguồn Backend (Express + AI Core)
│   ├── data/               # Tri thức chuẩn: canonical-facts.json, room-types.json, venues.json
│   ├── local-agent.ts      # Agent Local (Qwen 2.5:3b), 5-State Routing & Prompt Engine
│   ├── numguard.ts         # Bộ kiểm chứng số liệu NumGuard Interceptor
│   ├── retrieval.ts        # RAG lai (BM25 + BGE-M3 Vector Search + RRF Fusion)
│   ├── pricing.ts          # Bảng tính ưu đãi thẻ Pearl Club & Phí nhận/trả phòng
│   ├── seed.ts             # Khởi tạo dữ liệu SQLite gốc
│   └── routes.ts           # REST API Endpoints & Gateway Security Guards
├── bench/                  # Bộ đánh giá chất lượng (Gemini Judge & Benchmark Cases)
└── package.json            # Danh sách dependencies & scripts
```

---
*Dự án phát triển bởi nhóm P228-G24.*
