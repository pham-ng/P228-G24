# Ảnh chụp cấu hình trước khi thử Qwen3-TTS

Khôi phục: `cp .env <thư mục này>/.env` rồi khởi động lại server.

- `.env`            — biến môi trường đang chạy (LLM_MODE, model, STT, guardrail…)
- `ollama-ps.txt`   — model nào đang nạp, nạp bằng GPU hay CPU
- `ollama-list.txt` — các model có sẵn trên máy
- `gpu.txt`         — VRAM tại thời điểm chụp

Trạng thái đã đo tại thời điểm này:
- qwen3.5:4b · 3.1 GB · 100% GPU · context 4096
- VRAM 3805/4096 MiB dùng, 291 MiB trống
- GPU 86-100% util, 1920 MHz, 35-50 W khi suy luận → GPU đã bão hoà, không có dư địa ẩn
- prompt eval ~5 ms/token; sinh chữ 26-41 tok/s
- TTS đang dùng giọng của thiết bị khách (0 byte máy chủ, 0 VRAM)
- STT: PhoWhisper-small (vi) / whisper-small (khác), CPU, q8
