# Giọng đọc Piper

375 MB nhị phân và trọng số, **không nằm trong git**. Máy mới phải tải bằng tay
hoặc bằng bước dựng ảnh Docker.

```bash
# 1. Nhị phân (Linux cho Docker, Windows cho máy phát triển)
curl -L -o piper.tar.gz \
  https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz
tar xzf piper.tar.gz && rm piper.tar.gz     # ra thư mục ./piper

# 2. Năm giọng
mkdir -p voices && cd voices
B=https://huggingface.co/rhasspy/piper-voices/resolve/main
for P in vi/vi_VN/vais1000/medium/vi_VN-vais1000-medium \
         en/en_US/lessac/medium/en_US-lessac-medium \
         ko/ko_KR/kss/medium/ko_KR-kss-medium \
         zh/zh_CN/huayan/medium/zh_CN-huayan-medium \
         ru/ru_RU/irina/medium/ru_RU-irina-medium; do
  N=$(basename $P)
  curl -sL -o $N.onnx      $B/$P.onnx
  curl -sL -o $N.onnx.json $B/$P.onnx.json
done
```

## Hai chỗ đã cắn, đừng để cắn lại

### Giọng Hàn cần sửa cấu hình

`ko_KR-kss-medium.onnx.json` có **năm âm vị hai ký tự** trong `phoneme_id_map`
(`aɪ aʊ ɔɪ eɪ oʊ` — nguyên âm đôi tiếng Anh). Piper 1.2.0 từ chối bất kỳ khoá
nào không phải một điểm mã đơn, và nó chết ngay lúc **nạp cấu hình**, trước cả
khi tổng hợp, với thông điệp `"aɪ" is not a single codepoint`.

Giọng đó được huấn luyện bằng bản Piper mới hơn runtime này. Gỡ năm mục đi là
xong — espeak-ng cho tiếng Hàn không sinh ra nguyên âm đôi tiếng Anh, nên không
mất gì:

```bash
node -e '
const fs=require("fs"), p="voices/ko_KR-kss-medium.onnx.json";
const j=JSON.parse(fs.readFileSync(p,"utf8"));
for (const k of Object.keys(j.phoneme_id_map)) if ([...k].length > 1) delete j.phoneme_id_map[k];
fs.writeFileSync(p, JSON.stringify(j));
'
```

### Đường dẫn có ký tự ngoài ASCII làm Piper chết câm

Piper 1.2.0 trên Windows dùng API chuỗi hẹp. Đường dẫn tuyệt đối chứa dấu tiếng
Việt hoặc gạch dài — như tên thư mục dự án này — làm tiến trình chết với
`0xC0000409` và **stderr rỗng**.

`server/tts.ts` vì thế gọi bằng đường dẫn **tương đối** với `cwd` đặt ở đây.
Đừng "dọn dẹp" nó thành đường tuyệt đối.

## Vì sao không có giọng Nhật Ở ĐÂY

`rhasspy/piper-voices` chỉ có một giọng Nhật, và nó khai
`phoneme_type: "japanese"` — cần OpenJTalk để phiên âm. Piper 1.2.0 không có
OpenJTalk nên nó nhồi âm vị espeak vào, **không báo lỗi**, và sinh ra 13,5 giây
âm thanh cho câu lẽ ra 4 giây. Đó là phát âm sai, không phải chậm.

Một giọng đọc sai tệ hơn không có giọng, nên tiếng Nhật đi **một đường riêng,
không qua Piper**: âm vị sinh bằng Python (`misaki[ja]` + pyopenjtalk), giọng
bằng Kokoro ONNX. Xem `server/tts-ja.ts` và `docs/SETUP-VOICE.md` bước 3.

## Số đo trên máy phát triển (i7-10870H, CPU, không GPU)

```
Piper gọi thẳng, máy rảnh      RTF 0,09
qua HTTP, một yêu cầu          RTF 0,26
qua HTTP, 5 yêu cầu liên tiếp  RTF 0,78 – 1,33
F5-TTS tiếng Việt, cùng máy    RTF 25,26      ← vì sao không chọn nó
```

Kiểm lại bất cứ lúc nào: `npx tsx bench/tts-server-probe.ts`
