#!/usr/bin/env bash
# Dựng Aurea từ đầu trên một máy Linux trống (Vast.ai, RunPod, VPS).
#
# CHẠY:  bash scripts/bootstrap-linux.sh
#
# Nó cài Node, cài Ollama, kéo hai model, tải model giọng nói, build, và in ra
# việc cuối cùng cần làm. Chạy lại được nhiều lần — mỗi bước tự bỏ qua nếu đã
# xong.
#
# ĐIỀU PHẢI BIẾT TRƯỚC:
#
#   · Máy thuê là **container của người khác**. Vast.ai không cam kết thời gian
#     hoạt động, và chủ máy có thể lấy lại máy. Thuê GPU mua được TỐC ĐỘ và số
#     người phục vụ cùng lúc — nó KHÔNG mua được "không bao giờ sập".
#   · **Dữ liệu không tự tồn tại.** Container bị huỷ là `data.db` đi theo. Xem
#     mục sao lưu ở cuối docs/DEPLOY-VASTAI.md.
#   · Cần khoảng **20 GB đĩa trống**: node_modules ~1 GB, model giọng nói
#     1,2 GB, model Ollama ~3,7 GB, còn lại là hệ thống.
set -euo pipefail

xanh() { printf '\033[32m✓\033[0m %s\n' "$1"; }
vang() { printf '\033[33m!\033[0m %s\n' "$1"; }
buoc() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
chet() { printf '\033[31m✗ %s\033[0m\n' "$1"; exit 1; }

[ -f package.json ] || chet "Chạy lệnh này TRONG thư mục dự án (chỗ có package.json)."

# ---------------------------------------------------------------- 1. Node

buoc "Node.js 20+"
if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; then
  xanh "đã có $(node -v)"
else
  vang "cài Node 20 từ NodeSource…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
  xanh "đã cài $(node -v)"
fi

# `better-sqlite3` là native. Ảnh Vast.ai thường có sẵn build-essential, nhưng
# thiếu nó thì `npm ci` hỏng ở giữa với một lỗi khó đọc — cài trước cho chắc.
buoc "Công cụ biên dịch (better-sqlite3 cần)"
if command -v cc >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then
  xanh "đã có"
else
  apt-get update -qq && apt-get install -y build-essential python3
  xanh "đã cài build-essential"
fi

# -------------------------------------------------------------- 2. Ollama

buoc "Ollama"
if command -v ollama >/dev/null 2>&1; then
  xanh "đã có $(ollama --version 2>&1 | head -1)"
else
  curl -fsSL https://ollama.com/install.sh | sh
  xanh "đã cài"
fi

# Trong container thường không có systemd, nên `systemctl start ollama` không
# chạy. Khởi động thẳng và ghi log ra tệp.
buoc "Khởi động Ollama"
if curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  xanh "đã chạy sẵn"
else
  # OLLAMA_NUM_PARALLEL là nửa quan trọng của việc thuê GPU: không đặt thì
  # Ollama vẫn phục vụ tuần tự và card 24 GB chạy đúng bằng card 4 GB.
  export OLLAMA_NUM_PARALLEL="${OLLAMA_NUM_PARALLEL:-8}"
  export OLLAMA_HOST=127.0.0.1:11434
  nohup ollama serve > /tmp/ollama.log 2>&1 &
  for i in $(seq 1 30); do
    curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && break
    sleep 1
  done
  curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1 \
    || chet "Ollama không lên sau 30 giây — xem /tmp/ollama.log"
  xanh "đang chạy (OLLAMA_NUM_PARALLEL=$OLLAMA_NUM_PARALLEL)"
fi

buoc "Kéo model (~3,7 GB, lâu nhất trong toàn bộ script)"
for m in qwen3.5:4b bge-m3; do
  if ollama list 2>/dev/null | grep -q "^${m%%:*}"; then
    xanh "$m đã có"
  else
    ollama pull "$m"
  fi
done

# ------------------------------------------------- 3. Phụ thuộc + model giọng

buoc "npm ci"
npm ci
xanh "node_modules khớp package-lock.json"

buoc "Model giọng nói (~1,2 GB) + venv tiếng Nhật"
# KHÔNG còn --skip-ja. Trước đây bỏ qua vì Kokoro chạy trong luồng chính và
# khoá cả server 15–28 giây mỗi câu; nay nó nằm trong tiến trình con riêng
# (server/tts-ja-worker.mjs) nên tiếng Nhật bật được an toàn.
# Thiếu Python thì setup.mjs tự bỏ qua bước venv và cảnh báo, không hỏng.
node scripts/setup.mjs

# ------------------------------------------- 3b. STT trên GPU (nếu có GPU)

# Whisper chạy CPU thì mất 2,4–6,6 giây một câu; trên GPU còn 0,8. Cái chặn
# KHÔNG phải CUDA mà là cuDNN: onnxruntime-node 1.21 cần **cuDNN 9**, còn các
# ảnh pytorch phổ biến chỉ có cuDNN 8. Triệu chứng là một dòng khó đoán:
#
#     libcudnn.so.9: cannot open shared object file
#
# Hai bản sống chung được vì soname khác nhau (.so.8 với .so.9), nên PyTorch
# của ảnh gốc không bị đụng tới.
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L 2>/dev/null | grep -q GPU; then
  buoc "cuDNN 9 cho nhận dạng giọng nói trên GPU"
  if ldconfig -p 2>/dev/null | grep -q libcudnn.so.9; then
    xanh "đã có"
  else
    pip install --quiet nvidia-cudnn-cu12 2>/dev/null || vang "pip install nvidia-cudnn-cu12 hỏng"
    # Tìm bằng `find` chứ không đoán đường dẫn: nó nằm trong site-packages của
    # Python nào đang hoạt động, và chỗ đó khác nhau giữa các ảnh (đã gặp cả
    # /opt/conda lẫn /usr/local/lib).
    CUDNN_DIR=$(dirname "$(find / -name 'libcudnn.so.9' 2>/dev/null | head -1)")
    if [ -n "$CUDNN_DIR" ] && [ "$CUDNN_DIR" != "." ]; then
      echo "$CUDNN_DIR" > /etc/ld.so.conf.d/cudnn9.conf && ldconfig
      xanh "cuDNN 9 tại $CUDNN_DIR"
    else
      vang "không tìm thấy libcudnn.so.9 — nhận dạng giọng nói sẽ chạy CPU"
    fi
  fi
fi

# ------------------------------------------------------------- 4. Cấu hình

buoc "Cấu hình cho máy thuê"
sua_env() {
  local khoa="$1" gia="$2"
  if grep -qE "^#?[[:space:]]*${khoa}=" .env; then
    sed -i -E "s|^#?[[:space:]]*${khoa}=.*|${khoa}=${gia}|" .env
  else
    printf '\n%s=%s\n' "$khoa" "$gia" >> .env
  fi
  echo "    $khoa=$gia"
}
sua_env HOST 0.0.0.0
sua_env TRUST_PROXY 1
# Kokoro đã ra khỏi luồng chính nên không còn lý do tắt. Đo trên máy thuê:
# ping trung vị 2 ms trong suốt lúc tổng hợp, thay vì 15.068 ms như trước.
sua_env TTS_JA 1
# GPU lớn thì Ollama chạy song song được, nên hàng đợi phải mở theo — để 1 thì
# vẫn xếp hàng một người một lúc và tiền thuê GPU thành vô nghĩa.
sua_env QUEUE_CHAT "${QUEUE_CHAT:-8}"
sua_env QUEUE_SPEECH "${QUEUE_SPEECH:-4}"
# Không còn là laptop chia CPU với mọi thứ khác.
sua_env RL_GUEST_REQUESTS 40
# fp32 trên GPU vừa nhanh vừa chính xác hơn q8; fp16 thì transformers.js chưa
# hỗ trợ whisper. Không có cuDNN 9 thì ONNX Runtime tự rơi về CPU, không hỏng.
if ldconfig -p 2>/dev/null | grep -q libcudnn.so.9; then
  sua_env STT_DEVICE cuda
  sua_env STT_DTYPE fp32
fi
xanh ".env đã chỉnh"

# --------------------------------------------------------------- 5. Build

buoc "Build"
npm run build
[ -f dist/index.cjs ] || chet "Build xong mà không có dist/index.cjs"
xanh "dist/index.cjs"

# ---------------------------------------------------------------- xong

cat <<'HD'

────────────────────────────────────────────────────────────────
Xong phần dựng. Hai việc cuối, mỗi việc một phiên terminal.

  1) Chạy server — dùng nohup để nó sống tiếp khi đóng SSH:

       nohup npm start > /tmp/aurea.log 2>&1 &
       sleep 25 && curl -s localhost:5000/api/health

     Phải thấy "status":"ok" và "engine":"up".

  2) Mở link công khai:

       nohup npm run tunnel > /tmp/tunnel.log 2>&1 &
       sleep 15 && grep -o 'https://[a-z-]*\.trycloudflare\.com' /tmp/tunnel.log

Đọc docs/DEPLOY-VASTAI.md để biết cách SAO LƯU data.db — container bị huỷ
là mất sạch, và Vast.ai không cam kết máy luôn sống.
────────────────────────────────────────────────────────────────
HD
