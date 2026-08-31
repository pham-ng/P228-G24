# Aurea AI Concierge — Architecture & Decision Records
*Cập nhật 08/2026 — mã nguồn thực tế*

---

## 1. SYSTEM DIAGRAM — Toàn cảnh hệ thống

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    AUREA AI CONCIERGE SYSTEM                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  KHÁCH (6 ngôn ngữ)            NHÂN VIÊN (6 vai trò)                  │
│  ┌──────────────────┐          ┌──────────────────────┐                │
│  │  Kiosk / Phone   │          │  Staff Dashboard     │                │
│  │  #/ (React SPA)  │          │  #/staff/* (9 trang) │                │
│  │                  │          │                      │                │
│  │  • Chat text     │          │  • Inbox + Takeover  │                │
│  │  • 🎤 Mic (STT)  │          │  • Tasks (Kanban)    │                │
│  │  • 🔊 TTS        │          │  • Insights (8 KPI)  │                │
│  │  • 🌐 Flag switch│          │  • Knowledge (CRUD)  │                │
│  │  • Media gallery │          │  • Policies          │                │
│  └────────┬─────────┘          └──────────┬───────────┘                │
│           │ HTTPS/WS                      │                            │
│           └──────────────┬────────────────┘                            │
│                          ▼                                              │
│          ┌───────────────────────────────┐                             │
│          │    Express 5  (port 5000)     │                             │
│          │    server/routes.ts           │                             │
│          │    server/index.ts            │                             │
│          └──────────────┬────────────────┘                             │
│                         │                                               │
│   ┌─────────────────────┼──────────────────────────┐                  │
│   │                     │                          │                   │
│   ▼                     ▼                          ▼                   │
│  ┌─────────┐    ┌───────────────┐    ┌──────────────────────┐         │
│  │SQLite   │    │  AI Engine    │    │  Voice Pipeline      │         │
│  │data.db  │    │  agent.ts     │    │  ┌──────────────────┐│         │
│  │21 bảng  │    │  21 tools     │    │  │STT: Whisper q8   ││         │
│  │Drizzle  │    │  10 vòng max  │    │  │  PhoWhisper (vi) ││         │
│  │WAL mode │    │               │    │  │  whisper-small   ││         │
│  └────┬────┘    └───────┬───────┘    │  │  (en/ko/zh/ru/ja)││         │
│       │                 │            │  ├──────────────────┤│         │
│       │         ┌───────┴───────┐    │  │TTS: Piper VITS   ││         │
│       │         │   LLM Layer   │    │  │  RTF 0.09 CPU    ││         │
│       │         │   llm.ts      │    │  │  vi/en/ko/zh/ru  ││         │
│       │         │               │    │  │  ja → browser    ││         │
│       │         │  OpenAI API   │    │  └──────────────────┘│         │
│       │         │  (online)     │    └──────────────────────┘         │
│       │         │  Ollama local │                                      │
│       │         │  qwen2.5:3b   │                                      │
│       │         └───────┬───────┘                                      │
│       │                 │                                               │
│       └─────────────────┘                                              │
└─────────────────────────────────────────────────────────────────────────┘

EXTERNAL:
  api.openai.com    (GPT-5.4-mini agent, text-embedding-3-small)
  Ollama localhost  (qwen2.5:3b, bge-m3 offline)
  Langfuse cloud    (optional trace — tắt nếu không có key)
  Prometheus        (metrics endpoint /api/metrics)
```

---

## 2. ARCHITECTURE DIAGRAM — Các tầng chi tiết

```
  TẦNG PRESENTATION
  ─────────────────
  React 18 + TypeScript + Vite + TailwindCSS v3 + shadcn/ui
  Routing: wouter hash-based (#/ và #/staff/*)
  State: TanStack Query (server state) + useState (UI state)
  Không có localStorage → an toàn cho kiosk công cộng

  TẦNG API
  ────────
  Express 5  ←→  Zod validation  ←→  RBAC (server/rbac.ts)
  Rate limiting (server/ratelimit.ts)
  Staff auth: per-session token + legacy shared token
  Guest auth: reservationCode lookup

  TẦNG BUSINESS LOGIC (thuần TypeScript, không gọi LLM)
  ──────────────────────────────────────────────────────
  server/booking.ts     → resolveDate, validateStay, checkRestrictions
  server/policy.ts      → quoteLateCheckout, quoteEarlyCheckin, checkOccupancy
  server/catalogue.ts   → findRoomType, matchAmenity (anti-hallucination)
  server/dining.ts      → findVenue, matchDish, windowFor (anti-hallucination)
  server/guard.ts       → injection, Luhn cards, medical/security/dispute
  server/numguard.ts    → số tiền/ngày trong reply (fact-check)
  server/sentiment-net.ts → logistic regression, 0ms, F1 91.8%

  TẦNG AI AGENT
  ─────────────
  server/toolrouter.ts  → 54 tool → 4-5 tool/turn (token budget)
  server/agent.ts       → system prompt động + ReAct loop (max 10 vòng)
  server/local-agent.ts → RAG-first path cho Ollama (1 LLM call)
  server/llm.ts         → OpenAI / Ollama abstraction

  TẦNG RETRIEVAL
  ──────────────
  server/retrieval.ts   → BM25 (k1=1.5, b=0.75) + Vector cosine
                           Hợp nhất RRF → top-k chunks
  docChunks             → 60+ chunk, vector 1024-d (bge-m3)
  Đo: hit@1 96.2%, MRR 0.972 (golden set 52 câu, bge-m3)

  TẦNG VOICE
  ──────────
  STT: server/stt.ts    → @huggingface/transformers (Whisper ONNX q8)
                           Vi: PhoWhisper-small (RTF 0.76 CPU)
                           Others: whisper-small (RTF 0.89 CPU)
  TTS: server/tts.ts    → Piper subprocess (RTF 0.09 CPU)
                           5 ngôn ngữ: vi/en/ko/zh/ru
                           Ja: browser speechSynthesis (không có giọng Piper đúng)
  Client: record.ts     → MediaRecorder → WAV 16kHz mono (browser resampling)
          speech.ts     → SpeechSynthesisUtterance (browser, backup cho ja)

  TẦNG DATABASE
  ─────────────
  better-sqlite3 + Drizzle ORM + WAL mode
  21 bảng + auto-migrate + seed từ JSON (không có migration CLI)
  Backup: server/backup.ts (WAL-safe checkpoint)
  Metrics: server/metrics.ts (Prometheus /api/metrics)
```

---

## 3. AGENT FLOW DIAGRAM — Luồng xử lý một tin nhắn

```
  Guest gửi tin nhắn (text hoặc transcript từ STT)
                │
                ▼
  ┌─────────────────────────────────────────────┐
  │         GUARD SCREENING (server/guard.ts)   │
  │                                             │
  │  Số thẻ tín dụng? → redact (Luhn check)    │
  │  Prompt injection? → block, không truyền    │
  │  Cấp cứu / an ninh? ─────────────────────► escalate NGAY
  │  Tranh chấp tiền? ────────────────────────► escalate NGAY
  │  Yêu cầu người thật? → flag                │
  └──────────────────────┬──────────────────────┘
                         │ PASS
                         ▼
  ┌─────────────────────────────────────────────┐
  │         TOOL ROUTER (server/toolrouter.ts)  │
  │                                             │
  │  54 tool definitions → phân tích intent    │
  │  → chọn 4-5 tool trong budget:             │
  │    OpenAI: 5000 tokens                     │
  │    Local:  3270 tokens (8K ctx model)      │
  │  + always: get_stay_details, find_cap,     │
  │            search_knowledge                │
  └──────────────────────┬──────────────────────┘
                         │
                         ▼
  ┌─────────────────────────────────────────────┐
  │         RAG RETRIEVAL (server/retrieval.ts) │
  │                                             │
  │  Parallel:                                  │
  │    BM25 (từ khoá, bỏ dấu+stopword)         │
  │    Vector cosine (bge-m3 1024-d)            │
  │  → RRF fusion → top 3-5 chunks             │
  │  → vector reuse cho sentiment              │
  └──────────────────────┬──────────────────────┘
                         │ context chunks
                         ▼
  ┌─────────────────────────────────────────────┐
  │         AGENT LOOP (server/agent.ts)        │
  │                                             │
  │  System prompt động:                       │
  │    brand voice + lưu trú thật + VIP tier   │
  │    + ngôn ngữ + giờ khách sạn              │
  │                                             │
  │  for i in range(10):           ← max 10 vòng
  │    LLM(system+history+tools)               │
  │    if tool_call:                           │
  │      result = execute_tool(tool)           │
  │      ← booking.ts / policy.ts / dining.ts │
  │      ← catalogue.ts / ops.ts / ...        │
  │      append result to history              │
  │    else:                                   │
  │      break → final reply                   │
  └──────────────────────┬──────────────────────┘
                         │ raw reply text
                         ▼
  ┌─────────────────────────────────────────────┐
  │         NUMERIC GUARD (server/numguard.ts)  │
  │  Kiểm tra số tiền/ngày trong reply          │
  │  → flag nếu model tự tính số không có tool │
  └──────────────────────┬──────────────────────┘
                         │ verified reply
                         ▼
  ┌─────────────────────────────────────────────┐
  │       SENTIMENT (server/sentiment-net.ts)   │
  │  Logistic regression trên RAG vector        │
  │  Thêm 0.04ms · F1 91.8% · 600 mẫu 6 ngôn  │
  └──────────────────────┬──────────────────────┘
                         │ negative?
                         ├──YES──► mode=human, task urgent 10 phút
                         │
                         ▼
  Lưu reply + tool_trace + latency_ms vào DB
  Push đến client (polling 5s hoặc WS)
  TTS: nếu có Piper → /api/tts → WAV → browser play
       Fallback: browser speechSynthesis (ja + khi Piper không có)
```

---

## 4. DEPLOYMENT DIAGRAM

```
  ┌──────────────────────────────────────────────────────────────────┐
  │                     DEPLOYMENT OPTIONS                           │
  ├──────────────────────────────────────────────────────────────────┤
  │                                                                  │
  │  OPTION A — Cloud (recommended production)                       │
  │  ────────────────────────────────────────                        │
  │                                                                  │
  │  Internet                                                        │
  │     │                                                            │
  │     ▼                                                            │
  │  [Nginx / Caddy]  ← TLS termination, rate limit                 │
  │     │                                                            │
  │     ▼                                                            │
  │  [Node.js process]  ← npm start / pm2                           │
  │  dist/index.cjs                                                  │
  │  PORT=5000                                                       │
  │     │                                                            │
  │     ├── /data/data.db       (SQLite, mount volume)              │
  │     ├── /app/models/hf/     (Whisper weights, 885MB)            │
  │     ├── /app/models/piper/  (Piper binary + voices, 412MB)      │
  │     └── .env                (OPENAI_API_KEY, etc.)              │
  │                                                                  │
  │  Requires: OPENAI_API_KEY để agent hoạt động                    │
  │  Optional: LOCAL_API=ollama (chạy Ollama trên cùng máy)          │
  │                                                                  │
  │  ─────────────────────────────────────────────────────          │
  │  OPTION B — Local Dev (laptop của bạn)                          │
  │  ─────────────────────────────────────                           │
  │                                                                  │
  │  npm run dev                                                     │
  │     ├── Vite HMR (client, hot reload)                           │
  │     └── tsx watch (server, auto-restart)                         │
  │     → cùng port 5000                                             │
  │                                                                  │
  │  ─────────────────────────────────────────────────────          │
  │  OPTION C — Full Offline (không cần internet)                   │
  │  ─────────────────────────────────────────────                   │
  │                                                                  │
  │  Cần cài sẵn:                                                   │
  │    Ollama + ollama pull qwen2.5:3b + ollama pull bge-m3         │
  │    models/hf/ (Whisper) + models/piper/ (Piper TTS)             │
  │                                                                  │
  │  .env:                                                           │
  │    LLM_MODE=local                                                │
  │    LOCAL_API=ollama                                              │
  │    LOCAL_AGENT_MODEL=qwen2.5:3b                                  │
  │    EMBED_PROVIDER=local                                          │
  │    LOCAL_EMBED_MODEL=bge-m3                                      │
  │                                                                  │
  │  Chat quality: ~75.6% vs ~90% online                            │
  │  Latency: p50 ~1.5s (GPU) vs p50 ~2.1s (OpenAI)               │
  │  Cost: $0                                                        │
  │                                                                  │
  │  ─────────────────────────────────────────────────────          │
  │  OPTION D — Docker (team deployment)                            │
  │  ─────────────────────────────────────                           │
  │                                                                  │
  │  docker-compose -f ops/docker-compose.obs.yml up                │
  │     ├── aurea (app)                                              │
  │     ├── prometheus (metrics)                                     │
  │     └── grafana (dashboard, vinaurea.json)                      │
  └──────────────────────────────────────────────────────────────────┘

  CHECKLIST trước khi deploy:
  □ OPENAI_API_KEY đặt trong .env
  □ data.db không commit (có trong .gitignore)
  □ .env không commit (có trong .gitignore)
  □ models/ không commit (885MB+412MB, .gitignored)
  □ npm run build không lỗi TypeScript
  □ NODE_ENV=production node dist/index.cjs (Windows: $env:NODE_ENV="production"; node dist/index.cjs)
```

---

## 5. ARCHITECTURE DECISION RECORDS (ADR)

### ADR-001 — SQLite thay vì PostgreSQL

**Quyết định**: Dùng SQLite + WAL mode  
**Lý do**:
- Hệ thống chạy trên 1 máy (kiosk khách sạn), không cần horizontal scale
- Không cần connection pool, không có network round-trip
- WAL mode đủ an toàn cho concurrent reads + 1 writer
- "Pull và chạy" — không cần cài database server riêng
- Drizzle ORM giữ hầu hết code nếu cần đổi sang Postgres sau

**Đánh đổi**: Không thể scale ngang, không hỗ trợ multiple server nodes.

---

### ADR-002 — Hash routing (#/) thay vì HTML5 history routing

**Quyết định**: `wouter` với hash-based routing  
**Lý do**:
- Vite dev server và Express server cùng chạy trên port 5000
- Express chỉ cần serve 1 file HTML, không cần cấu hình wildcard route
- Kiosk trong iframe sandbox: `history.pushState` thường bị chặn
- Không có `localStorage` → không có session persistence → hash routing không khác gì

**Đánh đổi**: URL kém đẹp (`#/staff/inbox`), không share-able trực tiếp.

---

### ADR-003 — Tool Router (54→4-5 tool/turn)

**Quyết định**: Lọc tool động theo intent thay vì gửi toàn bộ definitions  
**Lý do**:
- 54 tool definitions = 8,659 tokens nếu gửi hết → ~$0.009/lượt, 87K tokens/session
- Local model (8K context): toàn bộ tool definitions chiếm 40% context window → không còn chỗ cho lịch sử chat
- Đo được: tool narrowing giảm từ 87K → ~5K tokens/session (~94% giảm)
- `find_capability` tool: model tự unlock thêm tool nếu cần → routing miss = 1 vòng thêm, không phải từ chối sai

**Đánh đổi**: Routing sai = 1 vòng thêm latency. Giải quyết bằng `find_capability`.

---

### ADR-004 — Hybrid BM25 + Vector RAG thay vì Vector-only

**Quyết định**: Chạy song song BM25 và vector, hợp nhất RRF  
**Lý do**:
- BM25 bắt số chính xác: "2.200.000", "VPNT-2M77VD" — vector không làm được
- Vector (bge-m3) bắt ngữ nghĩa, đa ngôn ngữ — BM25 không tokenize được Korean/Chinese/Japanese
- Đo: BM25-only → 0 kết quả với câu Hàn/Trung/Nhật; vector-only → 34.6% hit@1 với e5-small
- bge-m3 hybrid: hit@1 96.2%, MRR 0.972 trên golden set 52 câu

**Đánh đổi**: 2 pipeline chạy song song, hơi tốn RAM hơn. Overhead < 10ms.

---

### ADR-005 — STT trên Server, TTS trên Client (browser speechSynthesis)

**Quyết định ban đầu**: STT server (Whisper), TTS browser (speechSynthesis)  
**Lý do STT phải ở server**:
- Browser `SpeechRecognition` API = upload audio đến Google → vi phạm privacy khách sạn
- Whisper ONNX q8 chạy offline 100%, audio không ra ngoài server khách sạn
- Resampling (48kHz → 16kHz) làm ở browser (AudioContext) → server không cần ffmpeg

**Lý do TTS ở browser ban đầu**: Miễn phí, tức thì, không cần model.

**Vấn đề thực tế đo được**: Máy demo chỉ có 4 giọng (3 EN + 1 VI). Hàn/Trung/Nhật/Nga không có → nút đọc biến mất ở 4/6 ngôn ngữ.

**Quyết định thực tế**: Thêm **Piper TTS** trên server cho vi/en/ko/zh/ru. Tiếng Nhật vẫn dùng browser (không có giọng Piper đúng — xem ADR-006).

---

### ADR-006 — Piper thay vì F5-TTS / Kokoro

**Quyết định**: Piper VITS subprocess  
**Đo trên i7-10870H CPU, không GPU**:

| Model | RTF | Ghi chú |
|---|---|---|
| F5-TTS (Vietnamese) | 25.26 | Câu 9s = 4 phút compute |
| Kokoro ONNX | ~3–5 | Không đo trực tiếp trên máy này |
| **Piper** | **0.09** | Câu 9s = 0.8s |

**Lý do**: 4GB VRAM đã bị qwen3.5:4b chiếm 3.1GB. Piper là VITS nhỏ, chạy CPU, không đụng VRAM.

**Tiếng Nhật**: Piper có 1 giọng Nhật nhưng cần OpenJTalk (phoneme_type: "japanese"). Piper 1.2.0 không có OpenJTalk → phát âm sai 100%. **Giọng sai tệ hơn không có giọng** → tiếng Nhật dùng browser.

**Gotcha**: Piper trên Windows không chạy đường dẫn Unicode. `tts.ts` dùng `cwd` + relative path thay vì absolute path.

---

### ADR-007 — Sentiment Classification: Logistic Regression thay vì LLM

**Quyết định**: Linear head (logistic regression) trên embedding đã tính cho RAG  
**Lý do**:
- Embedding đã được tính ở bước RAG → reuse, không tốn thêm gì
- Thêm 0.04ms latency (dot product) vs 2-3s nếu gọi LLM riêng
- F1 91.8% đủ cho production (shadow mode → tích lũy log → fine-tune ngưỡng)
- LLM-based sentiment = 1 call thêm mỗi lượt → $0.002 × 1000 lượt/ngày = $2/ngày chỉ cho sentiment

**Shadow mode mặc định**: Ghi log nhưng không mở ticket → tránh false positive làm phiền lễ tân trước khi có đủ data.

---

### ADR-008 — Policy Engine bằng Code thay vì RAG

**Quyết định**: Tính phí bằng TypeScript thuần (`server/policy.ts`), model bị cấm làm phép tính  
**Lý do**:
- Model sai 1 số → khách mất tiền → mất niềm tin hoàn toàn
- RAG trả về text → model vẫn phải tính → vẫn có thể sai
- Policy engine: input (giờ, tier, rate) → output (số tiền chính xác, diễn giải, URL nguồn)
- Mọi con số đều traceable về Vinpearl URL

**Doctrine trong agent**: "NEVER state a number not returned by a tool in this same turn."

---

### ADR-009 — Không dùng localStorage

**Quyết định**: Không lưu session vào localStorage  
**Lý do**:
- Kiosk công cộng: localStorage persistence = session của khách A còn khi khách B dùng
- Iframe sandbox: `localStorage` bị block theo origin
- Nhân viên đăng nhập lại khi tải trang = hành vi đúng cho thiết bị shared (không phải bug)

---

### ADR-010 — STT: Whisper thay vì Web Speech API

**Quyết định**: Whisper ONNX trên server  
**Lý do**:
- Web Speech API Chrome = upload audio đến `www.google.com/speech-api/v1/` (verified)
- Giọng khách, số phòng, khiếu nại → đây là dữ liệu nhạy cảm nhất hệ thống có
- Hotel wifi: guest nói tiếng Việt có dấu → Chrome route đến Google CDN server
- Whisper q8 chạy offline, audio chỉ đến server khách sạn

**Đánh đổi**: Cần tải 430MB weights/model, RTF ~0.8 (câu 5s = 4s compute).

---

### ADR-011 — Resampling Audio ở Browser, không phải Server

**Quyết định**: `AudioContext.OfflineAudioContext` resample 48kHz→16kHz ở browser trước khi POST WAV  
**Lý do**:
- Server không cần ffmpeg dependency (một binary nặng, nhiều CVE)
- Browser đã có decoder và resampler trong AudioContext — zero cost cho server
- WAV PCM 16-bit = format đơn giản nhất server có thể parse, không cần thư viện
- Firefox bug: `AudioContext({sampleRate: 16000})` bị ignore → phải resample explicit bằng OfflineAudioContext
