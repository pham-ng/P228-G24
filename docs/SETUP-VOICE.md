# Cài giọng nói (STT + TTS) — Hướng dẫn dành cho máy mới

> **Nếu bạn chỉ cần chạy chat văn bản**: bỏ qua file này. Mọi tính năng khác chạy bình thường.
> Nút mic và nút đọc chỉ ẩn, không gây lỗi, khi thiếu model.

---

## Tại sao model không nằm trong git?

| Model | Kích thước | Lý do không commit |
|---|---|---|
| `models/hf/` (Whisper STT) | **885 MB** | Vượt giới hạn GitHub 100MB/file |
| `models/piper/` (Piper TTS) | **412 MB** | Nhị phân + weights, không phải code |

Cả hai thư mục đã có trong `.gitignore`. Bạn cần tải thủ công một lần.

---

## Bước 1 — Tải STT (Speech-to-Text)

STT dùng **Whisper** qua `@huggingface/transformers` (đã có trong `node_modules` sau `npm install`).
Weights tải tự động lần đầu khi khách nhấn nút mic **nếu có kết nối internet**.

Để tải sẵn (offline/demo):

```bash
node -e "
const { pipeline, env } = require('@huggingface/transformers');
const { join } = require('path');
env.cacheDir = join(process.cwd(), 'models', 'hf');

// Tải PhoWhisper-small (Vietnamese chuyên biệt)
pipeline('automatic-speech-recognition', 'huuquyet/PhoWhisper-small', { dtype: 'q8' })
  .then(() => console.log('[done] PhoWhisper-small ready'));

// Tải Whisper-small (đa ngôn ngữ: EN/KO/ZH/JA/RU)
pipeline('automatic-speech-recognition', 'onnx-community/whisper-small', { dtype: 'q8' })
  .then(() => console.log('[done] whisper-small ready'));
"
```

Sau khi tải, weights nằm trong `models/hf/` (~430MB mỗi model, format q8).

**Biến môi trường tùy chọn** (thêm vào `.env`):
```
STT_MODEL=onnx-community/whisper-small     # model đa ngôn ngữ (mặc định)
STT_MODEL_VI=huuquyet/PhoWhisper-small     # model Việt (mặc định)
STT_DTYPE=q8                               # fp32 / fp16 / q8 (mặc định q8)
STT_DEVICE=cpu                             # cpu / cuda (mặc định cpu)
STT_MODEL_CACHE=1                          # số model giữ trong RAM cùng lúc
```

---

## Bước 2 — Tải TTS (Text-to-Speech)

TTS dùng **Piper** — nhị phân C++ nhẹ, RTF 0.09 trên CPU, không chiếm VRAM.

### 2a. Tải nhị phân Piper

**Windows (máy phát triển):**
```powershell
# Tạo thư mục
mkdir -p models\piper

# Tải Piper Windows
$url = "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip"
Invoke-WebRequest $url -OutFile "models\piper\piper.zip"
Expand-Archive "models\piper\piper.zip" -DestinationPath "models\piper\" -Force
Remove-Item "models\piper\piper.zip"
# Kết quả: models\piper\piper\piper.exe
```

**Linux/Mac (server/Docker):**
```bash
mkdir -p models/piper && cd models/piper

# Linux x86_64
curl -L -o piper.tar.gz \
  https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz
tar xzf piper.tar.gz && rm piper.tar.gz
# Kết quả: models/piper/piper/piper
```

### 2b. Tải 5 giọng đọc

```bash
mkdir -p models/piper/voices && cd models/piper/voices
B=https://huggingface.co/rhasspy/piper-voices/resolve/main

for P in \
  vi/vi_VN/vais1000/medium/vi_VN-vais1000-medium \
  en/en_US/lessac/medium/en_US-lessac-medium \
  ko/ko_KR/kss/medium/ko_KR-kss-medium \
  zh/zh_CN/huayan/medium/zh_CN-huayan-medium \
  ru/ru_RU/irina/medium/ru_RU-irina-medium; do
    N=$(basename $P)
    curl -sL --progress-bar -o "$N.onnx"      "$B/$P.onnx"
    curl -sL --progress-bar -o "$N.onnx.json" "$B/$P.onnx.json"
done
```

**Windows PowerShell:**
```powershell
$B = "https://huggingface.co/rhasspy/piper-voices/resolve/main"
$voices = @(
  "vi/vi_VN/vais1000/medium/vi_VN-vais1000-medium",
  "en/en_US/lessac/medium/en_US-lessac-medium",
  "ko/ko_KR/kss/medium/ko_KR-kss-medium",
  "zh/zh_CN/huayan/medium/zh_CN-huayan-medium",
  "ru/ru_RU/irina/medium/ru_RU-irina-medium"
)
New-Item -ItemType Directory -Force -Path "models\piper\voices" | Out-Null
foreach ($v in $voices) {
  $N = $v.Split('/')[-1]
  Invoke-WebRequest "$B/$v.onnx"      -OutFile "models\piper\voices\$N.onnx"
  Invoke-WebRequest "$B/$v.onnx.json" -OutFile "models\piper\voices\$N.onnx.json"
}
```

### 2c. Sửa lỗi giọng Hàn (bắt buộc)

File cấu hình giọng Hàn có 5 âm vị tiếng Anh không tương thích với Piper 1.2.0.
Phải xóa trước khi dùng:

```bash
node -e '
const fs=require("fs"), p="models/piper/voices/ko_KR-kss-medium.onnx.json";
const j=JSON.parse(fs.readFileSync(p,"utf8"));
for (const k of Object.keys(j.phoneme_id_map)) if ([...k].length > 1) delete j.phoneme_id_map[k];
fs.writeFileSync(p, JSON.stringify(j));
console.log("Fixed Korean voice config");
'
```

---

## Kiểm tra sau khi cài

```bash
# Khởi động server
npm run dev

# Trong tab khác — kiểm tra API
curl http://localhost:5000/api/guest/voice
# Kết quả mong đợi:
# {"stt":true,"maxSeconds":30,"sampleRate":16000,"tts":true,"ttsLangs":["vi","en","ko","zh","ru"],...}

# Test TTS tiếng Việt
curl -X POST http://localhost:5000/api/tts \
  -H "Content-Type: application/json" \
  -d '{"text":"Xin chào quý khách","lang":"vi"}' \
  --output test.wav && echo "TTS OK"
```

---

## Tiếng Nhật — tại sao không có TTS?

Piper chỉ có 1 giọng Nhật, và nó cần OpenJTalk để phiên âm. Piper 1.2.0 không có OpenJTalk, 
nên nó tổng hợp sai hoàn toàn (13.5 giây âm thanh cho câu 4 giây, phát âm sai).
**Giọng sai tệ hơn không có giọng** → tiếng Nhật dùng `speechSynthesis` của trình duyệt khách 
(iPhone/Android Nhật luôn có giọng Nhật sẵn).

---

## Cấu trúc thư mục sau khi cài đầy đủ

```
models/
├── hf/                              # STT weights (885 MB, .gitignored)
│   ├── huuquyet/PhoWhisper-small/   # Vietnamese Whisper
│   └── onnx-community/whisper-small/ # Multilingual Whisper
└── piper/                           # TTS (412 MB, .gitignored)
    ├── piper/piper.exe (hoặc piper) # Binary
    └── voices/                      # 5 voice files
        ├── vi_VN-vais1000-medium.onnx + .json
        ├── en_US-lessac-medium.onnx + .json
        ├── ko_KR-kss-medium.onnx + .json   ← cần patch JSON
        ├── zh_CN-huayan-medium.onnx + .json
        └── ru_RU-irina-medium.onnx + .json
```
