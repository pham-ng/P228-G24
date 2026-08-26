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

  /* --- focused completeness set (context-compression experiment, §6) ------
     Each case requires 2+ independent facts that must BOTH survive whatever
     passage-length cap is applied, sourced directly from the live DB (queried
     the same day this set was written, not from memory) so no fact here is
     invented. Two facts per case, deliberately spanning different parts of
     the same passage — hours+capacity, size+occupancy, price+duration — so a
     truncation that keeps only the first sentence of a passage shows up as a
     real completeness regression, not a pass. */
  { id: "cf-bachgiai-hours-capacity", lang: "vi", lane: "answer", q: "Nhà hàng Bách Giai mở cửa mấy giờ và sức chứa bao nhiêu khách?", expect: [["10:30"], ["250"]] },
  { id: "cf-ozone-hours-capacity", lang: "vi", lane: "answer", q: "Nhà hàng hải sản Ozone mở cửa mấy giờ và sức chứa bao nhiêu khách?", expect: [["10:30"], ["360"]] },
  { id: "cf-jasmine-hours-capacity", lang: "vi", lane: "answer", q: "Nhà hàng Jasmine mở cửa mấy giờ và sức chứa bao nhiêu khách?", expect: [["11:00"], ["250"]] },
  { id: "cf-lotus-hours-capacity", lang: "vi", lane: "answer", q: "Nhà hàng Lotus mở cửa mấy giờ và sức chứa bao nhiêu khách?", expect: [["07:00"], ["800"]] },
  { id: "cf-deluxe-twin-size-guests", lang: "vi", lane: "answer", q: "Phòng Deluxe 2 Giường Đơn diện tích bao nhiêu m2 và tối đa mấy khách?", expect: [["32"], ["4"]] },
  { id: "cf-grand-deluxe-size-guests", lang: "vi", lane: "answer", q: "Phòng Grand Deluxe Giường Đôi diện tích bao nhiêu m2 và tối đa mấy khách?", expect: [["42"], ["4"]] },
  { id: "cf-oceanview-deluxe-size-guests", lang: "vi", lane: "answer", q: "Phòng Deluxe Hướng Biển Giường Đôi diện tích bao nhiêu m2 và tối đa mấy khách?", expect: [["32"], ["4"]] },
  /* Was reported as "qwen2.5:3b compresses multi-slot schedules wrong" —
     re-traced and that diagnosis was wrong. Two seed.ts KB docs said
     "08:00-22:00, 8-12 minutes" while the dedicated, higher-confidence
     canonical fact for this exact topic said "08:30-23:00, ~8 minutes" —
     the model was reporting one real passage correctly; the passages
     themselves disagreed. Same failure class as migrations 008/010/011
     (facility/pool/Bach Giai hours conflicts). Reconciled the two seed.ts
     docs to the canonical fact's numbers instead of patching the prompt. */
  { id: "cf-cablecar-hours-duration", lang: "vi", lane: "answer", q: "Cáp treo Vinpearl chạy trong khung giờ nào và mất bao lâu để qua đảo?", expect: [["08:30"], ["8 phút", "8 minutes"]] },
  { id: "cf-spa-bamboo-price-duration", lang: "vi", lane: "answer", q: "Akoya Spa liệu trình Warm Bamboo Massage giá bao nhiêu và kéo dài bao lâu?", expect: [["2.700.000", "2700000"], ["85"]] },
  { id: "cf-spa-balinese-price-duration", lang: "vi", lane: "answer", q: "Akoya Spa liệu trình Balinese Massage giá bao nhiêu và kéo dài bao lâu?", expect: [["2.300.000", "2300000"], ["90"]] },

  /* Live-test cases (2026-08-26), each locking in a real bug fix so it
     cannot silently regress:
      - cf-villa-price: the "Rooms and room types" KB chunk is 773 chars —
        past the frozen 400-char PASSAGE_CHAR_CAP — and the villa sentence
        sits at char 492, so head-truncation cut it before the model ever
        saw it; the model answered with the villa DEPOSIT (3,000,000) from
        an unrelated chunk instead. Fixed by selectRelevantWindow (see
        local-agent.ts) scoring sentences against the question instead of
        always keeping the head.
      - cf-airport-transfer-price: originally diagnosed as "the price only
        lives in a tool-reachable table, never in KB text" and fixed by
        adding it to the KB article directly — WRONG. The property's own
        canonical-facts entry for this exact topic (transport.cam_ranh_
        airport, VERIFIED) deliberately omits a price: "Resort transfer
        price/time is operational — use the booking tool or ask the front
        desk." The services-table figure carries an explicit "system
        default, not yet confirmed by management" disclaimer, so publishing
        it as a settled fact would overclaim certainty the property itself
        doesn't have. Reverted; the correct answer here is to point the
        guest to reception/the booking tool, matching what the passage
        actually (and deliberately) says. The real, separate routing bug
        this case caught and keeps fixed: "transport_tours" was blanket-
        escalating any price question containing "đưa đón"/"sân bay" before
        retrieval ever ran, the same shape of bug wifi had.
      - cf-wifi-direct: known-reproduced circular-non-answer bug — the
        passage states "MIỄN PHÍ" in its first clause but the model
        restated the question instead of answering; mitigated with an
        explicit directness instruction.
      - cf-explosives: one of three live "abstains despite clear evidence"
        instances — the rule exists only in the English house-rules chunk,
        phrased differently from the guest's Vietnamese wording; mitigated
        with an explicit instruction that a general rule counts even when
        the guest's wording differs from the passage's. */
  /* Re-tracing this live with hybridSearch() found the retrieval landscape
     is richer than the original diagnosis assumed: a "giá bao nhiêu" query
     for this villa returns five PACKAGE-rate passages (room+breakfast,
     room+breakfast+cáp treo, ...), each with its own "Giá Công Bố Tốt Nhất"
     for a different bundle — never the plain per-night seed rate
     (8,610,000) used in the original report. So the correct acceptance bar
     here is "grounded in a real published number for THIS villa, not the
     unrelated 3,000,000 deposit and not an invented figure" — 13,850,000 is
     the real lowest package rate the current retrieval surfaces. Naming
     WHICH package that price belongs to is still unreliable on a 3B model
     even with an explicit instruction (see buildAnswerPrompt) — a known,
     documented limitation, not something this fix claims to fully solve. */
  { id: "cf-villa-price", lang: "vi", lane: "answer", q: "Villa 3 phòng ngủ hướng biển giá bao nhiêu một đêm?", expect: [["13.850.000", "13850000", "21.890.000", "21890000", "8.610.000", "8610000"]] },
  { id: "cf-airport-transfer-price", lang: "vi", lane: "answer", q: "Giá đưa đón sân bay Cam Ranh bao nhiêu?", expect: [["lễ tân", "công cụ đặt", "bộ phận vận chuyển", "báo giá", "front desk", "reception"]] },
  { id: "cf-wifi-direct", lang: "vi", lane: "answer", q: "Wifi ở resort có miễn phí không?", expect: [["miễn phí"]] },
  { id: "cf-explosives", lang: "vi", lane: "answer", q: "Tôi mang theo chất nổ có được không?", expect: [["không", "cấm", "prohibited", "nghiêm cấm"]] },
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
  { id: "esc-budget-choose", lang: "vi", lane: "escalate", q: "Tôi có 5 triệu thì nên chọn phòng nào?", why: "budget reasoning — 'chọn' verb-swap bypass regression, live bug 2026-08-26" },
  { id: "esc-cheapest", lang: "vi", lane: "escalate", q: "Gói nào rẻ nhất cho 4 người?", why: "multi-constraint" },
  { id: "esc-cancel", lang: "vi", lane: "escalate", q: "Tôi muốn huỷ phòng", why: "irreversible write" },
  { id: "esc-change-date", lang: "vi", lane: "escalate", q: "Đổi ngày trả phòng giúp tôi", why: "booking change" },
  { id: "esc-book-table", lang: "vi", lane: "escalate", q: "Cho tôi đặt bàn tối nay", why: "service booking" },
  { id: "esc-extend", lang: "vi", lane: "escalate", q: "Tôi muốn gia hạn thêm 1 đêm", why: "extend stay" },
  { id: "esc-towels", lang: "ko", lane: "escalate", q: "수건이 부족하고 에어컨이 작동하지 않아요", why: "housekeeping write" },
  { id: "esc-pay", lang: "vi", lane: "escalate", q: "Cho tôi thanh toán bằng thẻ", why: "payment" },
];
