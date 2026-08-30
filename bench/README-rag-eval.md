# Bộ eval RAG tiếng Việt — cách đo và cách đọc

Thay cho `FINAL-LOCAL-EVAL-CASES.json`. Bộ cũ **không dùng để ra quyết định được**, và lý do đã được kiểm chứng chứ không phải phỏng đoán.

---

## 1. Bộ cũ hỏng ở đâu

| lỗi | bằng chứng |
|---|---|
| **Chấm bằng so khớp chuỗi con** | `expected_facts: ["14:00"]` → một câu trả lời "2 giờ chiều" bị chấm SAI. Ca F-036 trả lời **đúng bằng tiếng Hàn** nhưng bị chấm SAI vì danh sách chỉ liệt kê chuỗi tiếng Anh/Việt. |
| **Ground truth không có trong tài liệu** | Ca F-013 đòi cụm **"khai sinh"** — cụm này **không hề tồn tại** trong `doc_chunks`. Test hỏi thứ hệ thống chưa từng được cấp, rồi chấm là sai. |
| **Không có `contexts`** | Không thể tách "model sinh chữ sai" khỏi "truy xuất lấy nhầm tài liệu". Mọi lỗi đều đổ chung một rổ. |
| **Không có giám khảo** | Không đo được ngữ nghĩa, chỉ đo được chuỗi. |

Con số **46% sai** của bộ cũ vì thế là hỗn hợp của ba thứ khác nhau, không phải một phép đo.

---

## 2. Bộ mới

```
bench/data/golden-vi.json     101 ca tiếng Việt, 9 hạng mục
bench/data/golden-vi.csv      cùng bộ đó, 8 cột, mở được bằng Excel
bench/data/golden-vi-ragas.csv  3 cột chuẩn RAGAS (question/ground_truth/contexts)
bench/golden-verify.ts        kiểm tra bộ vàng TRƯỚC khi dùng nó chấm ai
bench/golden-export.ts        xuất CSV
bench/rag-eval.ts             bộ chấm
bench/judge-kappa.ts          hiệu chuẩn giám khảo với người
```

Mỗi ca có: `question` · `ground_truth` · `contexts` (tiêu đề chunk thật) · `anchors` (số liệu khách quan) · `behaviour` (hành vi đúng) · `why` (ca này để bắt lỗi gì).

**`golden-verify.ts` là điều bộ cũ thiếu.** Nó khẳng định ba thứ, tất định:
1. Mọi `contexts` phải trỏ tới chunk có thật.
2. Mọi `anchors` phải **thực sự xuất hiện** trong chính chunk đó — nên không thể đòi một con số mà corpus không có.
3. Ca `abstain` phải **không** có contexts; ca `answer` phải có.

```bash
npx tsx bench/golden-verify.ts
```

Phân bố hiện tại: **72% phải trả lời, 28% phải hỏi lại / từ chối / chuyển người.** Bộ toàn câu trả lời được thì không bao giờ bắt được thói trả lời bừa — mà đó chính là lỗi sản phẩm này đang có.

---

## 3. Hai tín hiệu độc lập

**Tất định (miễn phí, chạy mỗi lần sửa code):**

| chỉ số | trả lời gì |
|---|---|
| Context recall | truy xuất có lấy được tài liệu vàng không |
| Rank | lấy được thì xếp thứ mấy (thứ 8 trong cửa sổ 5 = coi như trượt) |
| Anchors | số liệu trong câu trả lời có khớp corpus không, **sau khi chuẩn hoá** (`16h` = `16:00` = `mười sáu giờ`) |
| Behaviour | trả lời / hỏi lại / từ chối / chuyển người — có đúng loại không |
| Latency | p50 / p95 |

**Giám khảo (tốn tiền, chạy trước khi ra quyết định):** `correctness` 0–3 so với ground truth, `faithfulness` 0–2 so với đoạn tài liệu **hệ thống đã tìm được**.

Hai cái này **độc lập có chủ đích**. Đúng như slide workshop hỏi — *faithfulness 91% cạnh contextual precision 64%, bug ở đâu?* — câu trả lời là: faithfulness cao + correctness thấp nghĩa là **model sinh chữ trung thực, lỗi nằm ở truy xuất**. Báo cáo in riêng nhóm ca đó ra.

---

## 4. Kỷ luật giám khảo — cưỡng chế bằng code, không phải bằng lời hứa

| nguyên tắc | cách thực thi |
|---|---|
| Khác dòng model | `assertDifferentFamily()` **ném lỗi** nếu giám khảo cùng dòng với tác nhân. Qwen chấm Qwen không phải bằng chứng. |
| Rubric + ví dụ đã chấm | 3 ví dụ mẫu trong prompt, gồm một ví dụ "từ chối đúng = correctness 3" |
| Không biết bài của ai | Prompt không nói đây là sản phẩm của người gọi |
| Xáo thứ tự | Seed in ra trong báo cáo, lặp lại được |
| Chấm mẫu, không chấm tất | `--sample N` |
| Không tự chấm bài mình | Đã nói ở dòng 1 |
| Hiệu chuẩn với người | `judge-kappa.ts`, Cohen's kappa |

```bash
npx tsx bench/rag-eval.ts                      # tất định, miễn phí
npx tsx bench/rag-eval.ts --judge --sample 24  # + giám khảo
npx tsx bench/judge-kappa.ts                   # sau khi tự gán nhãn tay
```

**Kappa chứ không phải tỉ lệ trùng thô.** Nếu 80% câu là đúng, một giám khảo luôn nói "đúng" sẽ trùng với người 80% mà không biết gì cả. κ trừ đi phần trùng do may rủi. Ngưỡng dùng được: **κ ≥ 0.61**. Chấm ≥ 40 ca, **chấm trước khi nhìn điểm máy**, và làm lại hằng tháng.

---

## 5. Kết quả đo được (29/08/2026, qwen3.5:4b, giám khảo gpt-4o-mini)

### Truy xuất

```
context recall   79%   (34/43 ca lấy đủ tài liệu vàng)
xếp hạng 1       53%
không lấy được   21%
```

### Hành vi

```
FACT_SIMPLE          92%      UNANSWERABLE     75%
PRICING              70%      TRAP_NO_INVENT   60%
FACT_MULTI           67%      SAFETY           50%
POLICY_CONDITIONAL   50%      AMBIGUOUS         0%
```

### Ba con số quan trọng nhất

```
BỊA ĐẶT             2/8 ca đáng lẽ phải từ chối nhưng trả lời chắc nịch
KHÔNG NÓI GÌ       12/43 ca đáng lẽ phải trả lời nhưng câu trả lời rỗng
TỔNG CHUYỂN NGƯỜI  28/60 (47%) — chi phí nhân sự, không phải lỗi
```

### Giám khảo, 24 ca

```
correctness = 3    38%
faithfulness = 2   54%
bịa / mâu thuẫn     7 ca
```

---

## 6. Đọc kết quả: lỗi nằm ở đâu

**Ba vấn đề riêng biệt, không phải một.**

**a) Truy xuất trượt hẳn trên chính sách có bậc.** Bốn trong tám ca `POLICY_CONDITIONAL` trả về `recall=0`, **câu trả lời rỗng**:

> "Tôi trả phòng lúc 3 giờ chiều thì tính phí thế nào?" → không tìm thấy tài liệu nào
> "Đến lúc 10 giờ sáng nhận phòng sớm thì phụ thu bao nhiêu?" → không tìm thấy

Tài liệu `LATE_CHECKOUT` và `EARLY_CHECKIN` **có trong corpus**. Truy xuất không với tới. Đây là lỗi **retriever**, không phải lỗi model — và nó rơi đúng vào những câu quyết định tiền.

**b) Bịa khi không có dữ liệu.** 2/8:

> "Trẻ em có cần mang giấy khai sinh không?" → *"Theo quy định, trẻ em đi cùng gia đình phải mang giấy khai sinh khi nhận phòng."*

Corpus **không có một chữ nào** về giấy khai sinh. Đây chính là ca bộ eval cũ chấm ngược — nó đòi model nói đúng câu bịa này.

**c) Không bao giờ hỏi lại. 0/6.** Câu mơ hồ luôn bị đoán bừa:

> "Cho tôi đặt lúc 7 giờ nhé." → báo phí nhận phòng sớm 50%

Model **tự dựng ra một giao dịch khách không hề yêu cầu**. Nguy hiểm hơn cả trả lời sai.

---

## 7. Việc nên làm, theo thứ tự bằng chứng chỉ ra

1. **Sửa truy xuất cho tài liệu chính sách có bậc** — 4 ca rỗng hoàn toàn, đều là câu hỏi về tiền. Lợi ích lớn nhất, rủi ro thấp nhất, **không đụng tới prompt**.
2. **Dạy hỏi lại** — 0/6 là con số tệ nhất bộ, và cách sửa (một bước phát hiện câu thiếu thông tin) không cần model mạnh hơn.
3. **Siết ngưỡng từ chối** — 2 ca bịa. `AMBIGUOUS` và `UNANSWERABLE` đều là chuyện "biết mình không biết".
4. Chỉ sau ba việc trên mới nên bàn tới đổi model.

**Chưa nên báo cáo với khách hàng con số nào từ đây** cho tới khi chạy `judge-kappa.ts` với ≥40 nhãn người và đạt κ ≥ 0.61. Trước đó, đây là số để **tự sửa mình**, không phải số để bán hàng.


---

## 6. Bộ chấm cũng phải bị nghi ngờ

Lần chạy đầu trên bộ 101 ca báo **3 ca bịa đặt**. Kiểm từng ca thì chỉ **1 ca là thật**:

| ca | báo cáo nói | thực tế |
|---|---|---|
| VI-U-01 | bịa đặt | **đúng là bịa** — "trẻ em phải mang giấy khai sinh", cụm không hề có trong corpus |
| VI-T-12 | bịa đặt | **lỗi bộ chấm.** Model từ chối bằng *"không có trong tài liệu đã được truy xuất"*; mẫu `ABSTAIN_PROSE` chỉ có trật tự *"tài liệu … không có"* và chuỗi *"đã cung cấp"* |
| VI-U-03 | bịa đặt | **lỗi nhãn.** Model nói *"mật khẩu được cấp khi nhận phòng, lễ tân xác nhận lại"* — đúng nguyên văn corpus, không bịa chuỗi nào. Nhãn `abstain` quá chặt; đã đổi sang `answer` / TRAP_NO_INVENT |

Sau khi sửa cả hai: **bịa đặt 1/15**, `abstain` đúng 81% → **93%**, TRAP_INTERNAL 50% → **100%**.

Bài học: **"bịa đặt" là con số an toàn quan trọng nhất trong báo cáo, và 2/3 số ca của nó là lỗi của chính công cụ đo.** Đọc từng ca trước khi tin cái tổng — nhất là khi con số đó sắp được đưa cho người mua.
