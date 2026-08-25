/**
 * Case data for the offline answer-quality benchmark — pure data, no side
 * effects on import. Split out of offline-answers.ts because that file calls
 * main() unconditionally at module scope; a second script importing its
 * case arrays would otherwise trigger a full benchmark run (with real LLM
 * calls) as an import side effect — exactly what happened once already.
 */

export type Lane = "answer" | "escalate";
export type Case = {
  id: string;
  lang: string;
  lane: Lane;
  q: string;
  /** Accepted forms of the correct fact. Every group must be satisfied; within a
      group any alternative counts. */
  expect?: string[][];
  /** Why this belongs in the escalate lane, for the report. */
  why?: string;
};

/* ------------------------------------------------------------ the ANSWER lane */
/* Facts a guest asks at a front desk twenty times a day. All are in the corpus,
   none require arithmetic, and a concierge that cannot answer these offline has
   no reason to exist. */
export const ANSWER: Case[] = [
  // --- hours ---------------------------------------------------------------
  { id: "spa-hours-vi", lang: "vi", lane: "answer", q: "Spa mở cửa mấy giờ?", expect: [["09:00", "9:00"], ["22:00"]] },
  { id: "spa-hours-en", lang: "en", lane: "answer", q: "What are the spa opening hours?", expect: [["09:00", "9:00"], ["22:00"]] },
  { id: "aquafield-hours", lang: "vi", lane: "answer", q: "Aquafield mở cửa lúc nào?", expect: [["09:00", "9:00"], ["22:00"]] },
  { id: "breakfast-hours-vi", lang: "vi", lane: "answer", q: "Ăn sáng phục vụ từ mấy giờ đến mấy giờ?", expect: [["06:00", "6:00"], ["10:30"]] },
  { id: "breakfast-hours-en", lang: "en", lane: "answer", q: "When is breakfast served?", expect: [["06:00", "6:00"], ["10:30"]] },
  { id: "breakfast-where", lang: "vi", lane: "answer", q: "Ăn sáng ở nhà hàng nào?", expect: [["lotus"]] },
  /* 08:30–23:00 comes from the canonical Phase B page ("Cáp treo Vinpearl ra đảo
     Hòn Tre", checked against the official Vinpearl source). This case first
     asserted 08:00–22:00, taken from the older "Cable car and Vinpearl Harbour
     ticket prices" chunk, which says "runs from about 08:00 to 22:00" — the two
     documents contradict each other and the vaguer one is not the verified one.
     The model was answering correctly and the label was wrong. The stale chunk
     is still in the corpus; see the hygiene report. */
  { id: "cablecar-hours", lang: "vi", lane: "answer", q: "Cáp treo chạy từ mấy giờ tới mấy giờ?", expect: [["08:30"], ["23:00"]] },
  /* The canonical page says "khoảng 8 phút"; the older chunk says "8–12 minutes".
     Requiring both numbers failed a reply that quoted the verified one. */
  { id: "cablecar-duration", lang: "vi", lane: "answer", q: "Đi cáp treo mất bao lâu?", expect: [["8"]] },
  { id: "checkout-time-vi", lang: "vi", lane: "answer", q: "Mấy giờ phải trả phòng?", expect: [["12:00"]] },
  { id: "checkin-time-vi", lang: "vi", lane: "answer", q: "Mấy giờ tôi được nhận phòng?", expect: [["14:00"]] },
  { id: "checkin-time-en", lang: "en", lane: "answer", q: "What time can I check in?", expect: [["14:00", "2 pm", "2:00"]] },
  { id: "visitor-curfew", lang: "vi", lane: "answer", q: "Khách đến thăm được ở lại phòng tới mấy giờ?", expect: [["20:00"]] },

  // --- yes / no rules ------------------------------------------------------
  { id: "pets-vi", lang: "vi", lane: "answer", q: "Tôi mang theo chó nhỏ được không?", expect: [["không"]] },
  { id: "pets-en", lang: "en", lane: "answer", q: "Can I bring my dog to the resort?", expect: [["not allowed", "no pets", "cannot", "aren't allowed", "are not"]] },
  { id: "smoking-where", lang: "vi", lane: "answer", q: "Tôi hút thuốc trong phòng được không?", expect: [["không", "khu vực", "phạt"]] },
  /* The corpus is unambiguous — "banned in rooms: durian". The model answered
     about the villa-kitchen reheating rule instead, which is a different line of
     the same key:value dump. Requiring the ban word keeps that a failure. */
  { id: "durian", lang: "vi", lane: "answer", q: "Tôi mang sầu riêng vào phòng được không?", expect: [["không được", "cấm", "không cho phép", "không được phép"]] },
  { id: "id-required", lang: "vi", lane: "answer", q: "Nhận phòng cần giấy tờ gì?", expect: [["căn cước", "cccd", "hộ chiếu", "passport", "giấy tờ"]] },
  { id: "child-doc", lang: "vi", lane: "answer", q: "Trẻ em đi cùng cần mang giấy tờ gì?", expect: [["khai sinh", "birth certificate"]] },

  // --- what is there -------------------------------------------------------
  { id: "spa-treatments", lang: "vi", lane: "answer", q: "Spa có những loại massage nào?", expect: [["bamboo", "hot stone", "balinese", "shiatsu", "lomi"]] },
  { id: "watersports", lang: "vi", lane: "answer", q: "Ở resort có hoạt động dưới nước gì?", expect: [["kayak", "lặn", "mô tô nước", "dù lượn"]] },
  { id: "chinese-restaurant", lang: "vi", lane: "answer", q: "Resort có nhà hàng Trung Hoa không?", expect: [["bách giai", "bach giai"]] },
  { id: "imperial-club", lang: "vi", lane: "answer", q: "Imperial Club có gì chơi?", expect: [["bowling", "karaoke", "disco"]] },
  { id: "vinwonders-zones", lang: "vi", lane: "answer", q: "VinWonders Nha Trang gồm những phân khu nào?", expect: [["adventure", "sea world", "fairy land", "king"]] },
  { id: "vinwonders-access", lang: "vi", lane: "answer", q: "Đi VinWonders bằng cách nào?", expect: [["cáp treo", "cable car", "tàu"]] },
  { id: "zipline", lang: "vi", lane: "answer", q: "Trên đảo có zipline không, dài bao xa?", expect: [["880"]] },
  { id: "beach-length", lang: "vi", lane: "answer", q: "Bãi biển riêng của resort dài bao nhiêu km?", expect: [["1,1", "1.1"]] },
  { id: "sauna-rooms", lang: "vi", lane: "answer", q: "Aquafield có mấy phòng trị liệu?", expect: [["7", "bảy"]] },
  { id: "ballroom", lang: "en", lane: "answer", q: "How many people fit in the grand ballroom?", expect: [["600"]] },
  { id: "meeting-rooms", lang: "vi", lane: "answer", q: "Resort có mấy phòng hội nghị?", expect: [["7", "bảy"]] },
  { id: "room-count", lang: "vi", lane: "answer", q: "Resort có tất cả mấy phòng?", expect: [["476"]] },
  { id: "pool", lang: "vi", lane: "answer", q: "Resort có hồ bơi không?", expect: [["hồ bơi", "nước ngọt"]] },

  // --- policy shape (no arithmetic) ----------------------------------------
  { id: "occupancy-room", lang: "vi", lane: "answer", q: "Một phòng khách sạn ở tối đa mấy người?", expect: [["4", "bốn"]] },
  { id: "extra-bed-count", lang: "vi", lane: "answer", q: "Một phòng kê thêm được mấy giường phụ?", expect: [["1", "một"]] },
  { id: "package-codes", lang: "vi", lane: "answer", q: "Mã BB trong bảng giá nghĩa là gì?", expect: [["bed and breakfast", "bữa sáng", "ăn sáng"]] },
  { id: "guestlist-lowseason", lang: "vi", lane: "answer", q: "Danh sách khách phải gửi trước bao nhiêu ngày mùa thấp điểm?", expect: [["7"]] },
  { id: "complaint-steps", lang: "vi", lane: "answer", q: "Tôi muốn khiếu nại thì quy trình thế nào?", expect: [["3", "ba", "bước"]] },
  { id: "payment-methods", lang: "vi", lane: "answer", q: "Resort nhận thanh toán bằng hình thức nào?", expect: [["thẻ", "chuyển khoản", "qr"]] },

  // --- other languages (the handoff-language bug lived here) ---------------
  /* Times are written the local way once the reply is in the guest's language:
     "오후 10시", "晚上10点", "午後10時" all mean 22:00. Asserting only the
     ISO form failed replies that were correct and idiomatic. */
  { id: "spa-hours-ko", lang: "ko", lane: "answer", q: "스파는 몇 시에 문을 여나요?", expect: [["09:00", "9:00", "9시", "9 시"], ["22:00", "10시", "10 시", "22시"]] },
  { id: "breakfast-ko", lang: "ko", lane: "answer", q: "조식은 몇 시부터인가요?", expect: [["06:00", "6:00", "6시", "6 시"]] },
  { id: "pets-ko", lang: "ko", lane: "answer", q: "반려견을 데려가도 되나요?", expect: [["불가", "없습니다", "않습니다", "안 됩니다"]] },
  { id: "spa-hours-zh", lang: "zh", lane: "answer", q: "水疗中心几点开门？", expect: [["09:00", "9:00", "9点", "9 点"], ["22:00", "10点", "22点"]] },
  { id: "breakfast-zh", lang: "zh", lane: "answer", q: "早餐几点开始供应？", expect: [["06:00", "6:00", "6点", "6 点"]] },
  { id: "pool-zh", lang: "zh", lane: "answer", q: "酒店有游泳池吗？", expect: [["泳池", "游泳"]] },
  { id: "spa-hours-ja", lang: "ja", lane: "answer", q: "スパは何時から開いていますか？", expect: [["09:00", "9:00", "9時"], ["22:00", "10時", "22時"]] },
  { id: "checkout-ja", lang: "ja", lane: "answer", q: "チェックアウトは何時ですか？", expect: [["12:00", "12時"]] },
];

/* ---------------------------------------------------------- the ESCALATE lane */
/* Answering any of these offline costs the guest money or a booking. */
export const ESCALATE: Case[] = [
  { id: "esc-folio", lang: "vi", lane: "escalate", q: "Tổng hoá đơn của tôi bao nhiêu tiền?", why: "folio arithmetic" },
  { id: "esc-folio-en", lang: "en", lane: "escalate", q: "What is my current bill total?", why: "folio arithmetic" },
  { id: "esc-breakfast-price", lang: "vi", lane: "escalate", q: "Buffet sáng giá bao nhiêu một người?", why: "price" },
  { id: "esc-breakfast-price-en", lang: "en", lane: "escalate", q: "How much is the breakfast buffet?", why: "price" },
  { id: "esc-deposit", lang: "vi", lane: "escalate", q: "Đặt cọc khi nhận phòng là bao nhiêu tiền?", why: "money" },
  { id: "esc-late-fee", lang: "vi", lane: "escalate", q: "Trả phòng muộn tính phí thế nào?", why: "fee" },
  { id: "esc-cancel-fee", lang: "en", lane: "escalate", q: "What is the cancellation fee?", why: "fee" },
  { id: "esc-cancel-fee-ko", lang: "ko", lane: "escalate", q: "취소 수수료는 얼마인가요?", why: "fee, ko" },
  { id: "esc-price-zh", lang: "zh", lane: "escalate", q: "延迟退房要收多少钱？", why: "fee, zh" },
  { id: "esc-price-ja", lang: "ja", lane: "escalate", q: "朝食は一人いくらですか？", why: "price, ja" },
  { id: "esc-budget", lang: "vi", lane: "escalate", q: "Tôi có 5 triệu thì nên đặt phòng nào?", why: "budget reasoning" },
  { id: "esc-cheapest", lang: "vi", lane: "escalate", q: "Gói nào rẻ nhất cho 4 người?", why: "multi-constraint" },
  { id: "esc-cancel", lang: "vi", lane: "escalate", q: "Tôi muốn huỷ phòng", why: "irreversible write" },
  { id: "esc-change-date", lang: "vi", lane: "escalate", q: "Đổi ngày trả phòng giúp tôi", why: "booking change" },
  { id: "esc-book-table", lang: "vi", lane: "escalate", q: "Cho tôi đặt bàn tối nay", why: "service booking" },
  { id: "esc-extend", lang: "vi", lane: "escalate", q: "Tôi muốn gia hạn thêm 1 đêm", why: "extend stay" },
  { id: "esc-towels", lang: "ko", lane: "escalate", q: "수건이 부족하고 에어컨이 작동하지 않아요", why: "housekeeping write" },
  { id: "esc-pay", lang: "vi", lane: "escalate", q: "Cho tôi thanh toán bằng thẻ", why: "payment" },
];
