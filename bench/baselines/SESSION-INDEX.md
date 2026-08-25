# Aurea — chỉ mục phiên làm việc (2026-08-24)

File này là bản đồ, không phải nội dung — mọi số liệu chi tiết nằm trong các
file được trỏ tới bên dưới. Đọc file này trước khi mở bất kỳ file con nào.

## Trạng thái hệ thống NGAY BÂY GIỜ (xác nhận trực tiếp, không suy đoán)

```
LLM_MODE=openai              ← luồng hosted là mặc định (đúng, thương mại)
EMBED_PROVIDER=local
LOCAL_EMBED_MODEL=bge-m3     ← đã đổi từ e5-small, đã đo tốt hơn
RRF_VEC_WEIGHT=0.5           ← đã quét lại, xác nhận tối ưu trên data.db thật
LOCAL_AGENT_MODEL=qwen3.5:4b
LOCAL_API=ollama
HF_API_KEY=<đã điền>         ← dùng để test cross-encoder thật qua Hugging Face

index_meta trong data.db: bge-m3, 1024 chiều, 138/138 chunk — nhất quán
```

`server/local-agent.ts`: `LOCAL_MIN_SCORE` = **0.005** (đổi từ 0.012, có đo
xác nhận, xem mục 3 bên dưới).

## Việc đã làm, theo thứ tự thời gian

### 1. Sửa 4 lỗi P0/P1 đã biết
File: không có báo cáo tổng hợp riêng, nằm rải trong hội thoại. Tóm tắt:
- Lỗi ngôn ngữ tiếng Anh (`detectMessageLang` không nhận ASCII → sửa)
- Model bịa "ưu đãi Platinum miễn phí đến 14:00" → thêm tool bắt buộc
  (`tool_choice` ép gọi `quote_late_checkout`/`quote_early_checkin`/
  `quote_tax_gross_up` khi tin nhắn có đủ ý định + giá trị cụ thể)
- Tính sai thuế gộp → thêm `quoteTaxGrossUp()` trong `server/pricing.ts`
- numguard chặn nhầm giờ khách tự nói lại → thêm parser giờ tự nhiên
  (`VN_HOUR_WORD_RE`, `AMPM_HOUR_RE` trong `server/numguard.ts`) + mask số
  năm trần trụi

**Kết quả đo** (`bench/baselines/remediation/`):
- `01-hosted-before.json` → `05-hosted-after.json`: task success 77.1%→89.5%,
  an toàn 87.5%→100%, bịa số 6.7%→1.0%
- `03-offline-before-bgem3.json` → `06-offline-after.json`: usefulness
  62.2%→64.4% (chỉ tính hiệu ứng numguard, chưa tính ngưỡng lọc)

### 2. Đổi embedding sang bge-m3 (P0)
- `00-audit.json`: xác nhận lệch cấu hình ban đầu
- `02-retrieval-before.json` / `02-retrieval-after-FINAL.json`: hit@1
  88.5%→92.3% (VI/EN), 5 ngôn ngữ 36.7%→96.7%, zh/ja/ko từ 0/6 lên 6/6
- Backup gốc `data.db.pre-bgem3-backup` **đã bị xoá nhầm lúc dọn dẹp** —
  đường lùi duy nhất là đổi `.env` về `qllama/multilingual-e5-small:q8_0`
  rồi chạy lại `reindex.ts`. Có checkpoint SAU khi sửa:
  `data.db.post-remediation-checkpoint`.

### 3. Xác nhận lại RRF hybrid + rerank (theo yêu cầu "cần trả lời tech lead")
- `07-ablation-bgem3.json`: Hybrid đơn thuần thắng tuyệt đối — HyDE/LLM-rerank
  không cải thiện gì (giống hệt số), cross-encoder thật (`bge-reranker-v2-m3`,
  đo qua Hugging Face Inference API, xem `server/rerank-hf.ts`) còn làm
  **giảm** độ chính xác (hit@1 92.3%→90.4%) và chậm hơn 20 lần (1914ms)
  → `08-crossencoder-hf.txt`

### 4. Hiệu chỉnh LOCAL_MIN_SCORE (Part 2 — kiosk validation)
Thư mục: `bench/baselines/kiosk-validation/`
- `00-FROZEN-RETRIEVAL-BASELINE.md`: điểm neo cấu hình
- `01-local-min-score-audit.txt`: điểm số thật của 8 case CJK bị chặn oan —
  phát hiện ngưỡng 0.012 CAO HƠN trần toán học của điểm thuần-vector
  (0.5/61 ≈ 0.0082), nên **mọi** câu hỏi CJK thuần-vector đều bị chặn bất kể
  đúng sai
- `02-threshold-sweep.txt` + `02-LOCAL_MIN_SCORE-DECISION.md`: quyết định
  0.012→0.005, xác nhận không đánh đổi (coverage +15.6pp, precision cũng
  tăng nhẹ, an toàn/bịa số không đổi)

### 5. Phân rã nguyên nhân gốc (Part 5 — kiosk validation)
File chính: **`03-ROOT-CAUSE-DECOMPOSITION.md`** ← quan trọng nhất, đã gửi
trực tiếp cho bạn qua file đính kèm.

**Kết luận trung tâm**: SLM KHÔNG phải điểm nghẽn chính. Trong 10 case sai:
5 là lỗi truy hồi (xếp sai hạng, không phải lỗi ngưỡng), 2 là định tuyến quá
tay, 1 là lỗ hổng bộ dò từ chối, chỉ 1 là lỗi khả năng model thật
(`breakfast-ko`). Trần lý thuyết nếu đổi model mạnh hơn: chỉ cứu được 1/10.

**Phát hiện quan trọng nhất, tìm bằng đọc code**: `server/agent.ts:708`,
hàm `replyLang()` **không bao giờ trả về `ko/ja/zh`** — chỉ có `vi`/`en`.
Nghĩa là mọi số liệu CJK tốt trong toàn bộ dự án này (kể cả mục 2, 4 ở trên)
đo đúng khả năng pipeline khi được cấp đúng ngôn ngữ, **không phản ánh việc
khách Hàn/Nhật/Trung dùng luồng offline thật hôm nay sẽ nhận tiếng Anh**.
Đây là lỗi P1 có thật, **CHƯA SỬA** (đúng luật "chỉ chẩn đoán" của Part 5).

## Việc CHƯA làm — nói thẳng, không giả vờ

Từ bản đặc tả 25 phần "Final Reliability & Local Kiosk Validation" mà bạn
đưa, mới làm xong phần đóng băng baseline + hiệu chỉnh ngưỡng + phân rã lỗi.
**Chưa làm**: mở rộng benchmark lên 150-200 case, 50+ case tool, 30-40 hội
thoại nhiều lượt, 50+ case injection, so sánh đầy đủ 3-4 model local, đo tải
đồng thời 1-2-4-8 luồng, thí nghiệm độ dài context, ma trận quyết định cuối
cùng (GREEN/YELLOW/RED). Đây là khối lượng nhiều phiên làm việc thật.

## Việc nên làm ngay khi tiếp tục (đề xuất, rẻ nhất trước)

1. **Sửa `replyLang()`** — lợi ích lớn nhất, rủi ro thấp nhất, đã có sẵn
   `detectMessageLang()` trả đúng giá trị, chỉ cần ngừng bỏ nó đi.
2. Thêm alias từ khoá cho 5 case truy hồi sai đã tìm thấy (chó/dog↔pets,
   giấy tờ↔ID/passport, mấy phòng↔476).
3. Mở rộng `ABSTAIN_PROSE` cho thứ tự câu "không được nêu rõ trong X".
4. Sau đó mới quay lại phần so sánh model / tải đồng thời / injection.

## Ghi chú vận hành

- `bench/offline-cases.ts` mới tách ra từ `bench/offline-answers.ts` (data
  thuần, không có tác dụng phụ khi import) — nếu viết script mới cần dùng
  chung 63 case, import từ đây, không import từ `offline-answers.ts`.
- `server/rerank-hf.ts` + `bench/ablation-crossencoder.ts` +
  `bench/probe-hf-rerank.ts`: dùng HF Inference API thật, cần `HF_API_KEY`
  trong `.env`, gọi qua `router.huggingface.co` (không phải
  `api-inference.huggingface.co`, domain đó bị chặn ở proxy môi trường này).
- `.claude/launch.json` (ở thư mục cha, không phải trong `aurea/`) đã có sẵn
  để bật server test qua `preview_start` với tên `aurea-dev`.
