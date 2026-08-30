# Aurea AI Concierge — Architecture Diagram
*Cập nhật theo trạng thái mã nguồn 08/2026*

---

## Sơ đồ 1 — Tổng quan Hệ thống

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          AUREA AI CONCIERGE                                 │
│                     Vinpearl Resort Nha Trang                               │
└─────────────────────────────────────────────────────────────────────────────┘

  CLIENTS                                           BACKEND (port 5000)
  ───────                                           ──────────────────
  Khách (mọi ngôn ngữ)         HTTPS               ┌──────────────────────┐
  ┌─────────────────────┐  ──────────────────────►  │   Express 5 Server   │
  │  #/ (Guest Kiosk)   │                           │   server/index.ts    │
  │  - Mã đặt phòng     │  ◄──────────────────────  │   server/routes.ts   │
  │  - Flag switcher    │       JSON / Media        └──────────┬───────────┘
  │  - Media gallery    │                                      │
  │  - Intent chips     │                           ┌──────────▼───────────┐
  └─────────────────────┘                           │     Staff API Guard   │
                                                    │  RBAC + Rate Limit   │
  Nhân viên (6 vai trò)                             │  server/rbac.ts      │
  ┌─────────────────────┐                           │  server/ratelimit.ts │
  │  #/staff/* (9 trang)│                           └──────────┬───────────┘
  │  Inbox · Tasks      │                                      │
  │  Rooms · Reserv.    │         ┌────────────────────────────┼──────────────────────────┐
  │  Insights · KB      │         │                            │                          │
  │  Policies · Camps   │  ┌──────▼──────┐          ┌─────────▼──────────┐  ┌────────────▼───────┐
  │  Settings           │  │   SQLite    │          │   Agent Engine     │  │  Static / Vite     │
  └─────────────────────┘  │  data.db   │          │   server/agent.ts  │  │  client/dist/      │
                           │  21 bảng   │          │   21 tools         │  │  React 18 + Vite   │
                           │  Drizzle   │          │   10 vòng tối đa   │  └────────────────────┘
                           │  ORM       │          └─────────┬──────────┘
                           └──────┬──────┘                    │
                                  │                  ┌────────▼──────────────┐
                                  │                  │   Tool Router          │
                                  │                  │   server/toolrouter.ts │
                                  │                  │   54 tools → 4-5/turn  │
                                  │                  │   ~5K tokens budget    │
                                  │                  └────────┬──────────────┘
                                  │                           │
                              ┌───┘           ┌──────────────┼──────────────┐
                              │               │              │              │
                        ┌─────▼─────┐  ┌──────▼──────┐ ┌───▼────┐  ┌──────▼──────┐
                        │  Policies  │  │  Retrieval  │ │  LLM   │  │  Booking    │
                        │  Engine   │  │  Hybrid RAG │ │  Layer │  │  Engine     │
                        │  (policy  │  │  (retrieval │ │  (llm  │  │  (booking   │
                        │   .ts)    │  │   .ts)      │ │  .ts)  │  │   .ts)      │
                        └─────┬─────┘  └──────┬──────┘ └───┬────┘  └──────┬──────┘
                              │               │             │              │
                              └───────────────┴─────────────┴──────────────┘
                                                      │
                              ┌───────────────────────┼───────────────────────┐
                              │                       │                       │
                     ┌────────▼──────┐      ┌─────────▼──────┐      ┌────────▼──────┐
                     │   OpenAI API  │      │  Ollama Local  │      │  bge-m3 Local │
                     │   (online)    │      │  qwen2.5:3b    │      │  Embedding    │
                     │   GPT-5.4-mini│      │  (offline)     │      │  ~1.2GB       │
                     └───────────────┘      └────────────────┘      └───────────────┘
```

---

## Sơ đồ 2 — Luồng Xử lý Một Tin Nhắn Khách

```
  Khách gửi tin nhắn
         │
         ▼
  ┌─────────────────────────────┐
  │     Guard Screening         │  server/guard.ts
  │  - Kiểm tra Luhn (thẻ)     │  ← Tất cả input phải qua đây
  │  - Phát hiện injection      │
  │  - Y tế / an ninh?          │──── YES ──► Chuyển Lễ tân NGAY + Task urgent
  │  - Tranh chấp tiền?         │──── YES ──► Chuyển Lễ tân NGAY + Task urgent
  └─────────────┬───────────────┘
                │ PASS
                ▼
  ┌─────────────────────────────┐
  │     Tool Router             │  server/toolrouter.ts
  │  Phân tích intent           │  Token budget: 5000 (OpenAI) / 3270 (Local)
  │  Chọn 4-5 tool phù hợp     │  54 tool → subset per-turn
  │  trong ngân sách token      │
  └─────────────┬───────────────┘
                │
                ▼
  ┌─────────────────────────────┐
  │     RAG — Hybrid Search     │  server/retrieval.ts
  │  Song song:                 │  Chạy trước agent loop để có context
  │  ├─ BM25 (từ khoá)          │
  │  └─ Vector cosine (bge-m3) │  Cache vector → dùng lại cho sentiment
  │  Hợp nhất bằng RRF          │
  └─────────────┬───────────────┘
                │ Top-k passages
                ▼
  ┌─────────────────────────────┐
  │     Agent Loop              │  server/agent.ts
  │  (tối đa 10 vòng)           │  ← System prompt động: brand voice + lưu trú thật + tier VIP
  │                             │
  │  System prompt              │
  │       ↓                     │
  │  LLM (GPT hoặc qwen2.5)    │
  │       ↓ gọi tool            │
  │  Execute tool thật (DB)     │──► policy.ts / booking.ts / ops.ts / dining.ts ...
  │       ↓ kết quả              │
  │  LLM nhận kết quả           │
  │       ↓ ...lặp...           │
  │  LLM trả lời text           │
  └─────────────┬───────────────┘
                │ Raw reply
                ▼
  ┌─────────────────────────────┐
  │     Numeric Guard           │  server/numguard.ts
  │  Kiểm tra số tiền, ngày     │  Phát hiện hallucination số
  │  trong reply                │
  └─────────────┬───────────────┘
                │ Verified reply
                ▼
  ┌─────────────────────────────┐
  │     Sentiment Classifier    │  server/sentiment-net.ts
  │  Logistic regression trên   │  Dùng vector đã tính ở bước RAG → 0ms thêm
  │  embedding đã có sẵn        │  F1 = 91.8% trên 600 mẫu đa ngôn ngữ
  │  Chạy song song với save    │
  └─────────────┬───────────────┘
                │ negative detected?
                │──── YES ──► mode=human, Task urgent SLA 10 phút
                │
                ▼
  Lưu reply + tool_trace + latency_ms vào database
  Trả JSON về client
```

---

## Sơ đồ 3 — Database Schema (21 bảng)

```
  ┌─────────────┐   ┌─────────────┐   ┌─────────────────┐
  │   hotels    │   │    staff    │   │     rooms       │
  │  id, name   │   │  id, name   │   │  id, number     │
  │  brand_voice│   │  role, dept │   │  type, floor    │
  │  sla_minutes│   │  pin (hash) │   │  base_rate      │
  │  ai_enabled │   │             │   │  status         │
  └──────┬──────┘   └──────┬──────┘   └────────┬────────┘
         │                 │                    │
  ┌──────▼──────┐                      ┌────────▼────────┐
  │   guests    │                      │   room_types    │
  │  id, name   │                      │  (9 hạng thật)  │
  │  lang, vip  │                      │  area, beds     │
  │  tier       │                      │  amenities[]    │
  └──────┬──────┘                      └─────────────────┘
         │
  ┌──────▼──────────────┐    ┌─────────────────┐
  │    reservations     │    │   restrictions  │
  │  confirmationCode   │    │  rate calendar  │
  │  checkIn/Out        │    │  STOP_SELL, CTA │
  │  roomId             │    │  MIN/MAX_LOS    │
  └──────┬──────────────┘    └─────────────────┘
         │
  ┌──────▼──────┐   ┌─────────────┐   ┌──────────────────┐
  │conversations│   │  messages   │   │   folioCharges   │
  │  mode       │   │  role       │   │  amount, desc    │
  │  sentiment  │   │  body       │   │  service/fee     │
  │  channel    │   │  tool_trace │   └──────────────────┘
  │  unread     │   │  latency_ms │
  └──────┬──────┘   └─────────────┘
         │
  ┌──────▼──────┐   ┌─────────────┐   ┌──────────────────┐
  │    tasks    │   │  services   │   │ serviceBookings  │
  │  dept, prio │   │  name, cap  │   │  date, slots     │
  │  sla, due   │   │  images[]   │   │  status          │
  └─────────────┘   └─────────────┘   └──────────────────┘

  ┌─────────────┐   ┌─────────────┐   ┌──────────────────┐
  │ kbArticles  │   │   offers    │   │   campaigns      │
  │  title      │   │  upsell     │   │  segment         │
  │  content    │   │  conditions │   │  personalised    │
  │  sourceUrl  │   └─────────────┘   └──────────────────┘
  └──────┬──────┘
         │
  ┌──────▼──────┐   ┌─────────────┐   ┌──────────────────┐
  │  docChunks  │   │  policies   │   │ dining_venues    │
  │  42+ chunk  │   │  11 bản ghi │   │  7 outlet        │
  │  vector 1024│   │  JSON rules │   │  hours, menu     │
  │  -d (bge-m3)│   │  sourceUrl  │   │  prices          │
  └─────────────┘   └─────────────┘   └──────────────────┘

  ┌─────────────┐   ┌─────────────────────────┐
  │ auditEvents │   │       feedback          │
  │  type, actor│   │  rating, comment        │
  │  summary    │   │  messageId (per-message) │
  └─────────────┘   └─────────────────────────┘
```

---

## Sơ đồ 4 — Luồng Truy Xuất Hybrid RAG

```
  Câu hỏi của khách
         │
         ├──────────────────────────────────────────┐
         │                                          │
         ▼                                          ▼
  ┌─────────────────┐                    ┌──────────────────┐
  │   BM25 Search   │                    │  Vector Search   │
  │                 │                    │                  │
  │  Bỏ dấu tiếng  │                    │  Embed bằng      │
  │  Việt, stopword │                    │  bge-m3 (local)  │
  │  k1=1.5, b=0.75 │                    │  hoặc t-e-3-small│
  │                 │                    │                  │
  │  Hits: số tiền  │                    │  Hits: ngữ nghĩa │
  │  tên riêng      │                    │  đa ngôn ngữ     │
  │  mã phòng       │                    │  câu hỏi gián tiếp│
  └────────┬────────┘                    └────────┬─────────┘
           │                                      │
           └──────────────┬───────────────────────┘
                          │
                          ▼
                ┌─────────────────┐
                │   RRF Fusion    │
                │  (1/(60+rank))  │
                │                 │
                │  Giới hạn 2     │
                │  chunk/tài liệu │
                │                 │
                │  Nếu embedding  │
                │  lỗi → BM25-only│
                └────────┬────────┘
                         │
                         ▼
                Top-k chunks (3-5)
                gửi vào context agent
```

---

## Sơ đồ 5 — Tool Router & Narrowing

```
  54 tools tổng cộng (8,659 tokens nếu gửi hết)
  
  Tool Router phân tích intent từ câu hỏi:
  
  INTENT DETECTED         TOOLS SELECTED           TOKENS
  ─────────────────       ──────────────────────   ──────
  "đặt phòng"       →    room_shopping (4 tools)   ~900
  "giá/rate"        →    room_shopping + price      ~1100
  "check in/out"    →    stay_changes (4 tools)     ~1350
  "ăn uống/nhà hàng"→    dining (3 tools)           ~800
  "spa/dịch vụ"     →    services (4 tools)         ~900
  "hóa đơn/tiền"    →    financial (4 tools)        ~750
  "khiếu nại"       →    escalation (2 tools)       ~300
  "không rõ"        →    core (3 tools) + find_cap  ~600
  
  + always included:
    get_stay_details       (context tool)
    find_capability        (escape hatch — model tự unlock tool)
    search_knowledge       (RAG fallback)
  
  Budget: 5000 tokens (OpenAI) / ~3270 tokens (Local 8K ctx)
  
  find_capability: Model có thể gọi tool này để xem danh sách đầy đủ
  và tự unlock bất kỳ family nào nó cần — routing miss = 1 vòng thêm,
  không phải wrong refusal.
```

---

## Sơ đồ 6 — Sentiment Classification Pipeline

```
  Tin nhắn khách
        │
        │ (vector đã được tính cho RAG ở bước trước)
        ▼
  ┌───────────────────────────────────────────────────────┐
  │          server/sentiment-net.ts                      │
  │                                                       │
  │  Backend: "linear" (default) | "centroid" | "onnx"   │
  │                                                       │
  │  LINEAR (default, F1=91.8%):                          │
  │    vector (1024-d bge-m3, L2-norm)                    │
  │    → dot product với weights (20KB JSON)              │
  │    → logistic sigmoid → probability p                 │
  │    → p >= threshold ? negative : neutral              │
  │    Thời gian: ~0.04ms                                 │
  │                                                       │
  │  CENTROID fallback (F1~15, không cần training):       │
  │    cosine(query_vec, prototype_neg[])                 │
  │    cosine(query_vec, prototype_neu[])                 │
  │    max_neg > max_neu + MARGIN ? negative : neutral    │
  │                                                       │
  │  SHADOW MODE (default): ghi log, không open task      │
  │  ACTIVE MODE (LOCAL_SENTIMENT_ACT=1):                 │
  └───────────────────┬───────────────────────────────────┘
                      │ negative detected
                      ▼
        ┌─────────────────────────────┐
        │  escalateUnhappyGuest()     │
        │  server/routes.ts           │
        │                             │
        │  1. conversations.mode      │
        │     = "human"               │
        │  2. conversations.sentiment │
        │     = "negative"            │
        │  3. Task tạo: URGENT        │
        │     SLA 10 phút             │
        │     dept: front_desk        │
        │  4. auditEvent ghi log      │
        └─────────────────────────────┘

  Training dataset: sentiment_benchmark_600.jsonl
    600 câu × 6 ngôn ngữ (vi/en/ko/zh/ja/ru)
    0% lặp câu, 10 hiện tượng ngữ pháp
    (direct_complaint, sarcasm, implied, negation, fault_report_calm...)
  
  Retrain: npx tsx bench/sentiment-probe-eval.ts <set>.jsonl --augment --emit
```

---

## Sơ đồ 7 — Bảo Mật & RBAC

```
  Request đến /api/*
        │
  ┌─────▼─────────────────────────────────────────────────────┐
  │                   staffApiGuard middleware                  │
  │                                                            │
  │  1. Là guest route? (POST message / GET conv với code)    │──► next() — không cần token
  │  2. Là public reference? (/api/hotel, /api/room-types...) │──► next() — không cần token
  │  3. Có per-session token?  (issueSession / actorForToken) │──► next() với actor object
  │  4. Có legacy shared token? (STAFF_API_TOKEN env)         │──► next() với actor "service"
  │  5. API_AUTH_ENFORCE=1?                                   │──► 401
  │  6. Fallback: warn, next() (chỉ phát triển)              │──► console.warn
  └─────────────────────────────────────────────────────────────┘
  
  RBAC Capabilities (server/rbac.ts):
  ┌─────────────────┬──────────────────────────────────────────┐
  │ Capability      │ Ai có                                    │
  ├─────────────────┼──────────────────────────────────────────┤
  │ all_conversations│ manager, front_desk                     │
  │ tasks           │ tất cả (filter theo dept)                │
  │ insights        │ manager                                  │
  │ configure       │ manager                                  │
  │ approvals       │ manager                                  │
  │ payment         │ manager, front_desk                      │
  └─────────────────┴──────────────────────────────────────────┘

  Guest surface guards:
  - Rate limit: guestRequests + codeFailures (server/ratelimit.ts)
  - Code validation: reservation phải tồn tại, conv phải thuộc reservation đó
  - Data scope: guestSafeDetail() — chỉ trả name, lang, messages (không folio, PII)
  - Card redaction: input và output đều qua redactCards() (Luhn check)
```

---

## Sơ đồ 8 — Cấu Trúc Thư Mục

```
aurea/
├── client/                     # React 18 frontend
│   └── src/
│       ├── pages/
│       │   ├── guest.tsx       # Kiosk khách — chat, media, flag switcher
│       │   ├── inbox.tsx       # Staff inbox
│       │   ├── insights.tsx    # KPI dashboard
│       │   ├── benchmark.tsx   # Benchmark viewer (manager only)
│       │   └── ...             # 9 trang staff tổng cộng
│       └── components/
│           ├── markdown-body.tsx   # Render AI reply + media gallery
│           ├── staff-shell.tsx     # Layout + nav + audio alerts
│           └── ...
│
├── server/                     # Express backend
│   ├── agent.ts                # AI agent loop (2964 dòng, 12 luật, 21 tool)
│   ├── toolrouter.ts           # Tool selection & token budgeting
│   ├── retrieval.ts            # Hybrid BM25 + vector search, RRF
│   ├── sentiment-net.ts        # Real-time sentiment classifier
│   ├── guard.ts                # Input guard: injection, cards, escalation
│   ├── numguard.ts             # Numeric fact-check trên reply
│   ├── booking.ts              # Booking business rules (pure functions)
│   ├── policy.ts               # Policy engine (fees, occupancy)
│   ├── catalogue.ts            # Room type anti-hallucination layer
│   ├── dining.ts               # Dining venue anti-hallucination layer
│   ├── crosssell.ts            # Contextual upsell logic
│   ├── rbac.ts                 # Role-based access control
│   ├── ratelimit.ts            # Rate limiting for guest endpoints
│   ├── routes.ts               # All API routes (~2349 dòng)
│   ├── storage.ts              # SQLite abstraction layer
│   ├── seed.ts                 # Vinpearl data seeding
│   ├── backup.ts               # WAL-safe auto backup
│   ├── metrics.ts              # Prometheus metrics export
│   ├── llm.ts                  # OpenAI / Ollama abstraction
│   ├── local-agent.ts          # RAG-first path for local SLM
│   ├── observability.ts        # Langfuse tracing + signal analysis
│   └── data/
│       ├── room-types.json     # 9 hạng phòng từ trang thật
│       ├── venues.json         # 7 outlet ẩm thực từ trang thật
│       └── sentiment-head.json # Logistic regression weights (20KB)
│
├── shared/
│   └── schema.ts               # 21 bảng Drizzle ORM (dùng chung client+server)
│
├── bench/                      # Benchmark & evaluation suite
│   ├── cases.json              # 40 test cases (deterministic + judge)
│   ├── run.mjs                 # Runner (HTTP thật đến server)
│   ├── sentiment-probe-eval.ts # Sentiment benchmark + model training
│   └── baselines/              # JSON snapshots các lần chạy
│
├── docs/
│   ├── prd.md                  # Product Requirements Document
│   ├── Architecture_Diagram.md # File này
│   └── PHASE-B-REPORT.md       # RAGAS RAG evaluation report
│
├── KIEN-TRUC.md                # Kiến trúc chi tiết 12 chương (tiếng Việt)
├── CHAY-TREN-MAY-CUA-BAN.md   # Hướng dẫn chạy local
├── .env.example                # Template env vars (130 dòng có giải thích)
├── sentiment_benchmark_600.jsonl # 600 câu training data đa ngôn ngữ
└── research/
    └── hotel-edge-cases.md     # 45 luật nghiệp vụ, 84 kịch bản, có nguồn
```

---

## Sơ đồ 9 — Chế Độ Online vs Offline

```
  ┌──────────────────────────────────────────────────────────┐
  │                    LLM_MODE=openai (default)             │
  │                                                          │
  │  Agent: GPT-5.4-mini (via api.openai.com)               │
  │  Embedding: text-embedding-3-small (OpenAI)              │
  │                 HOẶC bge-m3 (Ollama local)               │
  │                                                          │
  │  Chất lượng: ~90% câu hỏi trả lời đúng                  │
  │  Latency: p50 ~2.1s, p95 ~6s                            │
  │  Chi phí: ~$0.002–0.005/lượt                            │
  └──────────────────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────────────┐
  │                    LLM_MODE=local                        │
  │                                                          │
  │  Agent: qwen2.5:3b qua Ollama (/api/chat)               │
  │  Embedding: bge-m3 (Ollama, ~1.2GB)                      │
  │                                                          │
  │  Pipeline: RAG-first (LOCAL_RAG_FIRST=1)                │
  │    phân loại intent (0 LLM call)                        │
  │    → BM25+vector lấy 3-5 đoạn                           │
  │    → SLM đọc context + trả lời (1 LLM call)             │
  │    → numguard kiểm tra số                               │
  │    → escalate nếu không đủ căn cứ                       │
  │                                                          │
  │  Chất lượng: ~75.6% câu hỏi trả lời đúng               │
  │  Latency: p50 ~1.5s (GPU 100%), p95 ~3s                 │
  │  Chi phí: $0 (hoàn toàn offline)                        │
  │  Yêu cầu: GPU 4GB VRAM, ollama pull qwen2.5:3b bge-m3  │
  └──────────────────────────────────────────────────────────┘
```
