# Đo TTS và STT — cái gì đo được, và đo thế nào

Tài liệu này để trả lời một câu hỏi từ phía doanh nghiệp: *"giọng nói của các anh chính xác đến đâu, và làm sao tôi kiểm chứng được?"*

Mọi con số dưới đây đều tái lập được bằng lệnh có sẵn trong repo. Không có con số nào lấy từ tài liệu quảng cáo của model.

---

## 1. Bảng chỉ số

### STT (nhận dạng giọng nói)

| chỉ số | định nghĩa | trả lời câu hỏi gì | chuẩn thị trường |
|---|---|---|---|
| **WER** | (thay + thiếu + thừa) / số từ trong câu gốc | "sai bao nhiêu phần trăm?" | Chỉ số phổ quát. Mọi hệ thống ASR đều công bố WER, nên đây là thứ so sánh trực tiếp được với Google/Azure/vendor PMS. |
| **CER** | như trên nhưng tính trên ký tự | "sai gần đúng hay sai hẳn?" | Quan trọng với tiếng Việt hơn WER: mất một dấu thanh (`mát` → `mắt`) là một ký tự sai nhưng là một từ hoàn toàn khác, mà WER chấm giống hệt như đọc ra chữ vô nghĩa. |
| **Entity / number accuracy** | % câu mà **mọi con số** đều đúng | "có gửi buồng phòng lên đúng phòng không?" | Không phải chuẩn học thuật, nhưng là thứ khách sạn mua. Một bản ghi đúng 92% vẫn có thể cử người lên phòng 350 thay vì 305. |
| **Polarity accuracy** | % câu mà **phủ định còn nguyên** | "lời phàn nàn có bị lật thành lời khen không?" | Cùng lý do. Đã đo được cả hai model biến `không mát` thành `khủng mát`. |
| **RTF p50 / p95** | giây tính toán trên mỗi giây tiếng nói | "khách phải chờ bao lâu?" | p95 chứ không phải trung bình — lượt chậm nhất là lượt khách bỏ đi. |

### TTS (tổng hợp giọng nói)

| chỉ số | định nghĩa | ghi chú |
|---|---|---|
| **MOS** | 1–5 do người nghe chấm | Chuẩn vàng, và **cần người**. Script không tạo ra được. Nếu cần con số này thì phải tổ chức panel nghe. |
| **Intelligibility (round-trip WER)** | đọc câu ra → cho một ASR **cố định** nghe lại → WER so với văn bản gốc | Đây là chỉ số khách quan mà ngành dùng thay MOS. Trả lời "có nghe hiểu được không", **không** trả lời "có dễ nghe không". |
| **RTF** | giây tính toán trên mỗi giây audio | |
| **Time-to-first-audio** | tới lúc khách nghe được âm đầu tiên | Với engine không streaming thì TTFA = toàn bộ thời gian tổng hợp. Khách nghe âm tiết đầu, không nghe con số trung bình. |

**Đọc con số intelligibility cho đúng:** bản thân ASR cũng có tỉ lệ lỗi, nên đây là **cận dưới** của chất lượng tổng hợp, không phải phép đo sạch. Chạy `asr-eval.ts` trên bản thu người thật của cùng câu đó trước, rồi trừ đi — phần vượt trên baseline mới là đóng góp của TTS.

---

## 2. Bộ câu thử

`bench/data/speech-testset.json` — 22 câu, 6 ngôn ngữ. Mỗi câu có trường `why` nói nó được đưa vào để bắt lỗi gì. Bộ này chọn theo **kiểu hỏng gây thiệt hại**, không phải theo cái đẹp khi demo:

- số phòng đọc rời từng chữ (`ba không năm`)
- phủ định (`không mát`, `không đặt món này`)
- giờ + số người trong cùng một câu
- tên riêng nước ngoài (`Lotus`, `Cam Ranh`)
- câu rất ngắn (chỗ Whisper hay bịa khi đệm im lặng)
- va chạm âm đã biết của chính sản phẩm này (`gối` / `gọi`)

Cùng một nội dung được lặp qua các ngôn ngữ (`vi-02` / `en-02` / `ko-01` / `ja-01` / `zh-01` / `ru-01` đều là "điều hòa phòng 305 không mát") để đọc ngang hàng được.

---

## 3. Chạy như thế nào

### Bước 1 — có audio

Một file WAV **16 kHz mono 16-bit** cho mỗi `id`, đặt tên `vi-01.wav`, … Thiếu câu nào thì câu đó bị bỏ qua và được đếm, nên bộ thu dở dang vẫn cho ra số trung thực trên phần đã có.

Kèm một file `SOURCE.txt` một dòng nói ai/cái gì tạo ra bản thu. **Script in dòng này lên đầu báo cáo và cảnh báo nếu thiếu** — một con số không có nguồn thì không đem đi báo cáo được.

```bash
ffmpeg -i thu-am.wav -ar 16000 -ac 1 -sample_fmt s16 vi-01.wav
```

> **Bẫy đã mắc phải một lần:** đưa audio 22050 Hz vào model 16 kHz **không báo lỗi** — nó nhận dạng audio bị kéo giãn và cho ra một bảng số hoàn toàn sai. Cả `asr-eval.ts` lẫn `stt-probe.ts` giờ **throw** nếu sample rate khác 16000.

### Bước 2 — chấm STT

```bash
npx tsx bench/asr-eval.ts <thư-mục-audio>
```

Mặc định dùng đúng định tuyến của sản phẩm (vi → PhoWhisper-small, còn lại → whisper-small). Ép một model cụ thể để so sánh:

```bash
npx tsx bench/asr-eval.ts <thư-mục-audio> onnx-community/whisper-small
```

Kết quả ghi ra `bench/asr-eval-<tên-thư-mục>.json` — đặt tên theo thư mục audio để chấm engine thứ hai không đè lên kết quả engine thứ nhất.

### Bước 3 — chấm TTS

```bash
npx tsx bench/tts-eval.ts <thư-mục-ra>                       # tổng hợp + đo RTF/TTFA
# resample về 16 kHz rồi:
npx tsx bench/asr-eval.ts <thư-mục-ra> onnx-community/whisper-small
```

Chấm bằng **cùng một scorer, cùng một normalisation, cùng một bộ câu** như STT — cố ý, để hai con số so sánh trực tiếp được thay vì là hai cách đo khác nhau.

---

## 4. Chuẩn hoá văn bản: cái gì được tha, cái gì không

Không chuẩn hoá thì phép so sánh vô nghĩa: whisper-small viết `16h`, PhoWhisper viết `mười sáu giờ`, **cả hai đều đúng**. Mọi benchmark ASR nghiêm túc đều chuẩn hoá trước khi chấm. `bench/lib/speech-metrics.ts` ghi rõ nó tha những gì, và `test/speech-metrics.test.ts` khoá lại từng điều một.

**Được tha:** chữ hoa/thường · dấu câu · `16h` = `16:00` = `mười sáu giờ` · `ba không năm` = `305` · `2.640.000` = `2640000` · `đồng` = `đ`

**Không được tha:** dấu thanh (`mát` ≠ `mắt`) · số bị đảo (`305` ≠ `350`) · phủ định bị mất

Bốn lỗi trong chính bộ chấm này đã bị test bắt trước khi có con số nào được công bố — trong đó `\b` của JavaScript không nhận ký tự tiếng Việt nên luật tiền `đồng` chưa bao giờ chạy, và `ba không năm không mát` bị gộp thành `3050` rồi nuốt mất chữ `không` phủ định. Một benchmark rộng lượng theo cách chưa ai soát còn tệ hơn không có benchmark.

---

## 5. Số đo hiện có

Chạy 2026-08-29, `q8`, CPU (i7-10870H), **audio tổng hợp bằng giọng Windows** — sạch, không giọng vùng miền, không tiếng ồn. Đây là **sàn để so hai model trên cùng file**, không phải độ chính xác thực địa.

### STT — định tuyến của sản phẩm

| ngôn ngữ | câu | WER | CER | số đúng | phủ định đúng | RTF p50 | RTF p95 |
|---|---|---|---|---|---|---|---|
| vi (PhoWhisper-small) | 10 | 10.8% | 6.4% | 80.0% | 90.0% | 0.94 | 1.66 |
| en (whisper-small) | 4 | 4.9% | 0.0% | 100% | 100% | 0.81 | 1.14 |
| **tổng** | **14** | **9.4%** | **4.6%** | **85.7%** | **92.9%** | **0.94** | **1.66** |

ko/ja/zh/ru chưa có số: máy này không cài giọng cho các ngôn ngữ đó, nên tám câu kia bị bỏ qua thay vì bị đọc bằng giọng sai.

Hai ca hỏng đáng xem, vì chúng cho thấy WER một mình không đủ:

| câu | gốc | nhận được | WER |
|---|---|---|---|
| vi-09 | Hủy giúp tôi lịch **spa chiều nay** | vì giúp tôi lịch sử **ba triệu** nay | 40% |
| vi-02 | phòng 305 **không mát** | phòng 305 **khủng mát** | 13% |

vi-09 bịa ra một con số (`ba triệu`) — WER 40% không nói cho ai biết rằng nó vừa bịa ra tiền. Cột **số đúng** nói. vi-02 chỉ sai 13% WER nhưng đã **lật ngược lời phàn nàn** — cột **phủ định đúng** nói.

### TTS — cùng 4 câu tiếng Anh, cùng một ASR chấm

| engine | intelligibility WER | CER | RTF p50 | TTFA p50 | ngôn ngữ | chi phí máy chủ |
|---|---|---|---|---|---|---|
| Giọng sẵn của thiết bị (Microsoft David) | 4.9% | 0.0% | — | tức thì | tuỳ thiết bị; vi ✅ | **0** |
| Kokoro-82M q8 CPU (`af_heart`) | 4.9% | 0.0% | 0.99 | 4.29s | **chỉ en-us / en-gb** | 1 giây CPU cho mỗi giây audio |

**Hai engine không phân biệt được về độ nghe rõ.** Kokoro tính thêm ~1 giây CPU cho mỗi giây audio và mất tiếng Việt. Đó là lập luận để giữ TTS trên thiết bị khách, và nó là một con số chứ không phải một ý kiến.

---

## 6. Muốn có số đem đi báo cáo được thì làm gì

Số ở trên so sánh model được, **không** quảng cáo được. Muốn quảng cáo được cần audio người thật:

1. **Nhờ 5–10 nhân viên đọc 22 câu trong bộ thử**, bằng điện thoại, ở đúng sảnh khách sạn. 10 người × 22 câu = 220 mẫu, đủ để một con số WER có nghĩa. Giọng Bắc/Trung/Nam nên có đủ — PhoWhisper huấn luyện trên 844 giờ đa vùng miền, đó là điểm mạnh nên đo.
2. Đặt vào một thư mục, ghi `SOURCE.txt`, chạy `asr-eval.ts`.
3. Muốn so với chuẩn công bố thì chạy thêm trên bộ dữ liệu công khai (**VIVOS**, **Common Voice vi**, **FLEURS vi**) — đây là các bộ mà bài báo PhoWhisper báo cáo, nên con số của bạn đặt cạnh con số của họ được.

Điều cần nói với doanh nghiệp cùng lúc với WER: **STT tốn khoảng 0.8× độ dài câu nói, cộng với p95 ~11s của LLM.** Một câu hỏi 6 giây là **~16 giây** mới có tiếng trả lời. Người dùng chat chịu được 10 giây; người dùng voice chịu được 1–2 giây. Đó là con số quyết định voice có bán được hay không, chứ không phải WER.
