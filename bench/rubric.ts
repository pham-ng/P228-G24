/**
 * Bộ luật chấm — MỘT nguồn duy nhất cho cả người lẫn máy.
 *
 * Vì sao file này tồn tại: bản chấm đầu (2026-08-29) cho κ = 0,36 / 0,15, và
 * lý do không phải giám khảo dở. Rubric của giám khảo máy có nguyên một dòng
 * "từ chối đúng là câu trả lời đúng → correctness 3". Nút mà người chấm nhìn
 * thấy thì ghi "3 · đúng & đủ". Hai bên chấm hai bộ luật khác nhau rồi tôi đi
 * đo mức đồng thuận giữa họ.
 *
 * Đo được, không phải phỏng đoán:
 *
 *   ca PHẢI TỪ CHỐI (29):  lệch ≥2 bậc ở 6 ca — 21%
 *   ca PHẢI TRẢ LỜI (71):  lệch ≥2 bậc ở 5 ca —  7%
 *
 * Gấp ba lần. Trên một ca từ chối, "đúng & đủ" không có nghĩa gì: một lời từ
 * chối đúng thì KHÔNG CÓ nội dung nào để mà đủ. Người chấm đọc là "hệ thống xử
 * lý hợp lý" nên bấm 3; máy đọc là "so với đáp án chuẩn thì trống" nên bấm 0.
 *
 * Lỗi thứ hai, ít ai để ý mà chiếm số lượng lớn hơn: trên 71 ca phải trả lời,
 * 25 trong 28 ca lệch là người chấm cao hơn máy ĐÚNG MỘT BẬC, gần như luôn là
 * 3-vs-2. Ranh giới giữa "đúng & đủ" và "thiếu ý phụ" chưa từng được định
 * nghĩa ở đâu. Mà kappa tính theo danh mục, không có điểm bán phần — nên lệch
 * một bậc bị phạt y hệt lệch ba bậc.
 *
 * Cách chữa của hai thang dưới đây: **gọi tên việc đã xảy ra, thay vì chấm mức
 * độ.** "Đúng và đủ" so với "Thiếu thông tin" là một câu hỏi sự kiện — có bỏ
 * sót ý nào không — chứ không phải một phán đoán mức độ. Và "Hợp lý" áp dụng
 * được cho mọi loại ca, nên ca từ chối cuối cùng cũng có ô để bấm.
 *
 * Thang là DANH MỤC, không phải thứ bậc. Không có cái nào "cao hơn" cái nào;
 * mỗi cái mô tả một chuyện khác nhau đã xảy ra. Đó là lý do `judge-kappa.ts`
 * dùng kappa không trọng số — ở đây nó là phép đo đúng, không phải phép đo khắt
 * khe.
 */

export type Choice = { value: string; label: string; hint: string };

/** Hệ thống có làm ĐÚNG VIỆC CẦN LÀM không? Áp dụng cho mọi ca. */
export const HANDLING: Choice[] = [
  {
    value: "hop_ly",
    label: "Hợp lý — KHÔNG trả lời thẳng",
    /* Tên ô ghi rõ "KHÔNG trả lời thẳng" sau khi đo: 26 ca người chấm bấm
       "Hợp lý" trong khi hệ thống ĐÃ trả lời thẳng có nội dung, còn máy bấm
       "Đúng và đủ". Hai bên cùng kết luận ĐẠT, chỉ gọi tên khác — mà kappa
       theo danh mục phạt nặng chuyện đó: 26 trong 54 chỗ lệch. Nguyên nhân là
       "Hợp lý" đọc như một ô "chấp nhận được" chung chung. Tên mới đóng cửa
       cách đọc đó. */
    hint: "hệ thống KHÔNG trả lời thẳng mà chuyển nhân viên (thiếu căn cứ) hoặc hỏi lại (câu mơ hồ) — và làm vậy là đúng. Nếu nó CÓ trả lời nội dung thì chọn ô khác",
  },
  { value: "dung_du", label: "Đúng và đủ — CÓ trả lời", hint: "trả lời thẳng bằng nội dung, không bỏ sót ý chính nào" },
  { value: "thieu", label: "Thiếu thông tin", hint: "đúng hướng nhưng bỏ sót một ý mà khách cần" },
  { value: "sai", label: "Sai thông tin", hint: "có con số, giờ giấc hoặc sự kiện sai" },
  {
    value: "khong_hop_ly",
    label: "Trả lời không hợp lý",
    hint: "lẽ ra phải hỏi lại hoặc chuyển người, nhưng lại trả lời chắc nịch — hoặc trả lời lạc đề",
  },
  /**
   * Ô này thiếu ở vòng chấm đầu, và chủ dự án phát hiện ra khi đang bấm.
   *
   * Không có nó thì một ca "tài liệu CÓ mà mô hình vẫn đẩy sang lễ tân" trông
   * y hệt một ca từ chối đúng — cùng một câu chuyển tiếp, cùng một giao diện.
   * Đo được: 13 ca lấy đúng tài liệu nhưng câu trả lời không chứa con số cần
   * có, và chúng bị chấm thành BỐN nhãn khác nhau (6 khong_hop_ly, 3 sai,
   * 3 hop_ly, 1 dung_du). Ba ca rơi vào `hop_ly` là thất bại đang được đếm
   * thành công.
   *
   * Đây cũng là chỗ yếu đắt nhất của sản phẩm: im lặng khi đã có sẵn câu trả
   * lời thì vừa mất niềm tin của khách vừa đẩy việc sang người thật — tốn tiền
   * đúng ở chỗ hệ thống lẽ ra phải tiết kiệm.
   */
  {
    value: "im_lang",
    label: "Có tài liệu mà không trả lời",
    /**
     * Điều kiện "NHÌN THẤY trong đoạn tài liệu" là bắt buộc, và nó được thêm
     * vào sau khi đo.
     *
     * Bản đầu chỉ ghi "tài liệu có sẵn câu trả lời, nhưng mô hình vẫn im".
     * Giám khảo máy đọc thế và gán `im_lang` cho **13 ca UNANSWERABLE** — những
     * câu mà tài liệu KHÔNG hề có (giá vé máy bay, chỗ gửi thú cưng) và hệ
     * thống từ chối hoàn toàn đúng. Không ca nào trong 13 có bằng chứng tất
     * định của im lặng thật (`contextRecall` đều null, `anchorsExpected` = 0).
     * Người chấm gọi chúng là `hop_ly`; người chấm đúng.
     *
     * Nguyên nhân: giám khảo thấy câu trả lời trống rồi suy ra "chắc là né",
     * mà không kiểm xem đoạn tài liệu trước mặt có chứa câu trả lời không.
     */
    hint: "CHỈ khi đoạn tài liệu trước mặt bạn NHÌN THẤY RÕ câu trả lời mà mô hình vẫn im hoặc đẩy sang nhân viên. Tài liệu không chứa câu trả lời thì đó là 'hop_ly', không phải ô này",
  },
];

/** Lời nói dựa trên cái gì? Độc lập với thang trên. */
export const SOURCE: Choice[] = [
  { value: "dung_tl", label: "Đúng tài liệu", hint: "mọi khẳng định đều có căn cứ trong đoạn hệ thống tìm được" },
  { value: "sai_tl", label: "Sai tài liệu", hint: "nói ngược lại điều tài liệu ghi" },
  { value: "bia_tl", label: "Bịa tài liệu", hint: "dựng ra con số hoặc sự kiện không có ở đâu cả" },
  {
    value: "khong_co_tl",
    label: "Tài liệu không sẵn có",
    hint: "kho không có gì để bám vào — thường đi cùng một lời từ chối đúng. KHÔNG phải lỗi",
  },
];

/**
 * Thế nào là đạt, khi quy ra một con số cho bảng điều khiển.
 *
 * `hop_ly` tính là ĐẠT có chủ đích: với sản phẩm này, chuyển đúng người khi
 * thiếu căn cứ là hành vi mong muốn, không phải thất bại. Một hệ thống trả lời
 * được mọi câu là hệ thống đang bịa.
 */
export const HANDLING_PASS = new Set(["hop_ly", "dung_du"]);

/** `khong_co_tl` không phải lỗi — không có gì để bám thì không thể bám sai. */
export const SOURCE_PASS = new Set(["dung_tl", "khong_co_tl"]);

export const HANDLING_VALUES = HANDLING.map((c) => c.value);
export const SOURCE_VALUES = SOURCE.map((c) => c.value);

/** Đoạn luật nhét thẳng vào prompt của giám khảo máy, sinh từ chính hai mảng
 *  trên — nên prompt không thể trôi khỏi cái người chấm đang nhìn. */
export function rubricText(): string {
  const list = (cs: Choice[]) => cs.map((c) => `  "${c.value}" = ${c.label}: ${c.hint}.`).join("\n");
  return (
    `handling — hệ thống có làm ĐÚNG VIỆC CẦN LÀM không?\n${list(HANDLING)}\n\n` +
    `source — lời nói dựa trên cái gì? Độc lập với handling.\n${list(SOURCE)}`
  );
}
