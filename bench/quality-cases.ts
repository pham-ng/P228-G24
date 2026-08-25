/**
 * Phase 8 expanded quality benchmark — additive to bench/offline-cases.ts's
 * 63 cases, not a replacement. Every fact below is copied verbatim from the
 * live KB/policy corpus (dumped and read directly before writing any case),
 * never invented. Answerability labels follow the Phase 8 spec's taxonomy.
 *
 * Scope note: the spec targets ~150 total cases; this file adds 102 new ones
 * to the existing 63 for a combined 165 — at/above the target.
 */

export type Answerability =
  | "ANSWERABLE_FROM_KB"
  | "ANSWERABLE_FROM_TOOL"
  | "ANSWERABLE_WITH_CALCULATION"
  | "PARTIALLY_ANSWERABLE"
  | "INSUFFICIENT_EVIDENCE"
  | "AMBIGUOUS"
  | "REQUIRES_HUMAN"
  | "OUT_OF_SCOPE";

export type QCase = {
  id: string;
  lang: string;
  category: string;
  answerability: Answerability;
  q: string;
  /** Every group must be satisfied (any alternative within a group counts) — used for ANSWERABLE_FROM_KB/TOOL/CALCULATION and the "supported part" of PARTIALLY_ANSWERABLE. */
  expect?: string[][];
  /** For PARTIALLY_ANSWERABLE/INSUFFICIENT_EVIDENCE: specific values that would be fabrication if stated as fact (the model must not assert these as known). */
  mustNotAssert?: string[];
};

export const QUALITY_CASES: QCase[] = [
  // ---------------------------------------------------------------- hotel/property
  { id: "q-hotline", lang: "vi", category: "property", answerability: "ANSWERABLE_FROM_KB", q: "Số điện thoại của resort là gì?", expect: [["258 359 8222", "3598222"]] },
  { id: "q-address", lang: "vi", category: "property", answerability: "ANSWERABLE_FROM_KB", q: "Resort ở địa chỉ nào?", expect: [["hòn tre", "vĩnh nguyên"]] },
  { id: "q-architecture-en", lang: "en", category: "property", answerability: "ANSWERABLE_FROM_KB", q: "What architectural style is the resort built in?", expect: [["indochine", "đông dương"]] },
  { id: "q-submarine", lang: "vi", category: "property", answerability: "ANSWERABLE_FROM_KB", q: "Resort có tàu ngầm tham quan không?", expect: [["submarine", "tàu ngầm"]] },
  { id: "q-golf-course", lang: "vi", category: "property", answerability: "ANSWERABLE_FROM_KB", q: "Trên đảo có sân golf không?", expect: [["golf"]] },
  { id: "q-beach-length-en", lang: "en", category: "property", answerability: "ANSWERABLE_FROM_KB", q: "How long is the private beach?", expect: [["1.1 km", "1,1"]] },
  { id: "q-ballroom-size", lang: "vi", category: "property", answerability: "ANSWERABLE_FROM_KB", q: "Phòng đại tiệc rộng bao nhiêu mét vuông?", expect: [["660"]] },
  { id: "q-diving-club", lang: "vi", category: "property", answerability: "ANSWERABLE_FROM_KB", q: "Resort có câu lạc bộ lặn biển không?", expect: [["vinpearl diving club", "diving"]] },
  { id: "q-imperial-hilltop", lang: "en", category: "property", answerability: "ANSWERABLE_FROM_KB", q: "Where is the Imperial Club located relative to the resort?", expect: [["hill", "đồi"]] },
  { id: "q-buggy", lang: "vi", category: "property", answerability: "ANSWERABLE_FROM_KB", q: "Đi lại giữa các khu trong resort bằng gì?", expect: [["buggy", "xe điện"]] },

  // ---------------------------------------------------------------- rooms/amenities
  { id: "q-room-floors", lang: "vi", category: "rooms", answerability: "ANSWERABLE_FROM_KB", q: "Phòng khách sạn nằm ở tầng mấy?", expect: [["1", "5"]] },
  { id: "q-room-minibar", lang: "vi", category: "rooms", answerability: "ANSWERABLE_FROM_KB", q: "Phòng có tủ lạnh minibar không?", expect: [["minibar"]] },
  { id: "q-balcony-which-room", lang: "vi", category: "rooms", answerability: "ANSWERABLE_FROM_KB", q: "Loại phòng nào có ban công?", expect: [["grand deluxe"]] },
  { id: "q-deluxe-price", lang: "vi", category: "rooms", answerability: "ANSWERABLE_FROM_KB", q: "Deluxe giá bao nhiêu?", expect: [["2,200,000", "2.200.000", "2200000"]] },
  { id: "q-deluxe-price-natural", lang: "vi", category: "rooms", answerability: "ANSWERABLE_FROM_KB", q: "Deluxe giá bao nhiêu?", expect: [["2,200,000", "2.200.000", "2200000"]] },
  { id: "q-suite-size", lang: "en", category: "rooms", answerability: "ANSWERABLE_FROM_KB", q: "How big is the Deluxe Suite King Ocean View?", expect: [["52"]] },
  { id: "q-deluxe-size", lang: "vi", category: "rooms", answerability: "ANSWERABLE_FROM_KB", q: "Phòng Deluxe rộng bao nhiêu mét vuông?", expect: [["32"]] },
  { id: "q-grand-deluxe-view", lang: "vi", category: "rooms", answerability: "ANSWERABLE_FROM_KB", q: "Grand Deluxe Ocean View giá từ bao nhiêu?", expect: [["2,870,000", "2.870.000", "2870000"]] },
  { id: "q-villa-3br", lang: "en", category: "rooms", answerability: "ANSWERABLE_FROM_KB", q: "Is there a 3-bedroom villa option?", expect: [["3-bedroom", "3 phòng ngủ"]] },
  { id: "q-room-count-natural", lang: "vi", category: "rooms", answerability: "ANSWERABLE_FROM_KB", q: "Khách sạn có bao nhiêu phòng tất cả vậy?", expect: [["476"]] },

  // ---------------------------------------------------------------- dining/breakfast (incl. completeness)
  { id: "q-breakfast-complete", lang: "en", category: "dining", answerability: "ANSWERABLE_FROM_KB", q: "What are the breakfast hours and how much does it cost for children?", expect: [["06:00", "6:00"], ["10:30"], ["375,000", "375.000"]] },
  { id: "q-breakfast-complete-vi", lang: "vi", category: "dining", answerability: "ANSWERABLE_FROM_KB", q: "Ăn sáng mấy giờ và giá cho trẻ em bao nhiêu?", expect: [["06:00", "6:00"], ["10:30"], ["375,000", "375.000"]] },
  { id: "q-breakfast-free-kids", lang: "vi", category: "dining", answerability: "ANSWERABLE_FROM_KB", q: "Trẻ em dưới 12 tuổi có được ăn sáng miễn phí không?", expect: [["pearl club", "hội viên"]] },
  { id: "q-lotus-slots", lang: "vi", category: "dining", answerability: "ANSWERABLE_FROM_KB", q: "Nhà hàng Lotus phục vụ những khung giờ nào trong ngày?", expect: [["06:00"], ["12:00"], ["18:00"]] },
  { id: "q-jasmine-capacity", lang: "en", category: "dining", answerability: "ANSWERABLE_FROM_KB", q: "How many seats does Jasmine Restaurant have?", expect: [["250"]] },
  { id: "q-beachcomber-hours", lang: "vi", category: "dining", answerability: "ANSWERABLE_FROM_KB", q: "Beach Comber Bar mở cửa mấy giờ?", expect: [["09:00", "9:00"], ["23:00"]] },
  { id: "q-bachgiai-hours-unspecified", lang: "vi", category: "dining", answerability: "INSUFFICIENT_EVIDENCE", q: "Nhà hàng Bách Giai mở cửa mấy giờ?", mustNotAssert: ["11:00", "22:00", "12:00", "14:00"] },
  { id: "q-cuisine-cambodian", lang: "en", category: "dining", answerability: "ANSWERABLE_FROM_KB", q: "Does Jasmine Restaurant serve Cambodian food?", expect: [["cambodian"]] },

  // ---------------------------------------------------------------- facilities
  { id: "q-wifi-free", lang: "en", category: "facilities", answerability: "ANSWERABLE_FROM_KB", q: "Is Wi-Fi free at the resort?", expect: [["free", "miễn phí"]] },
  { id: "q-gym-hours", lang: "vi", category: "facilities", answerability: "ANSWERABLE_FROM_KB", q: "Phòng gym mở cửa mấy giờ?", expect: [["05:30", "5:30"], ["22:00"]] },
  { id: "q-parking-no-cars", lang: "vi", category: "facilities", answerability: "ANSWERABLE_FROM_KB", q: "Tôi có thể lái ô tô thẳng lên resort không?", expect: [["không", "cáp treo", "tàu cao tốc"]] },
  { id: "q-accessibility", lang: "en", category: "facilities", answerability: "ANSWERABLE_FROM_KB", q: "Does the resort have wheelchair access?", expect: [["wheelchair", "xe lăn"]] },
  { id: "q-currency-exchange-rate", lang: "vi", category: "facilities", answerability: "INSUFFICIENT_EVIDENCE", q: "Tỷ giá đổi tiền hôm nay là bao nhiêu?", mustNotAssert: ["23,000", "24,000", "25,000", "26,000"] },
  { id: "q-imperial-activities", lang: "vi", category: "facilities", answerability: "ANSWERABLE_FROM_KB", q: "Imperial Club có bowling và karaoke không?", expect: [["bowling"], ["karaoke"]] },
  { id: "q-pool-largest", lang: "en", category: "facilities", answerability: "ANSWERABLE_FROM_KB", q: "Is the resort's pool notable in any way?", expect: [["largest", "lớn nhất"]] },
  { id: "q-aquafield-rooms", lang: "vi", category: "facilities", answerability: "ANSWERABLE_FROM_KB", q: "Aquafield có bao nhiêu phòng trị liệu?", expect: [["7", "bảy"]] },

  // ---------------------------------------------------------------- policies (general)
  { id: "q-privacy-child-age", lang: "vi", category: "policy", answerability: "ANSWERABLE_FROM_KB", q: "Từ mấy tuổi trẻ em phải tự đồng ý việc xử lý dữ liệu cá nhân?", expect: [["7", "bảy"]] },
  { id: "q-complaint-timeline", lang: "en", category: "policy", answerability: "ANSWERABLE_FROM_KB", q: "How long until a complex complaint gets a reply?", expect: [["7 days", "7 ngày"]] },
  { id: "q-dispute-court", lang: "vi", category: "policy", answerability: "ANSWERABLE_FROM_KB", q: "Nếu khiếu nại không giải quyết được thì xử lý thế nào?", expect: [["tòa án", "30 ngày"]] },
  { id: "q-deposit-refund-condition", lang: "vi", category: "policy", answerability: "ANSWERABLE_FROM_KB", q: "Tiền đặt cọc có được hoàn lại không?", expect: [["hoàn", "không có khoản nào chưa thanh toán", "không hư hỏng"]] },
  { id: "q-villa-deposit", lang: "en", category: "policy", answerability: "ANSWERABLE_FROM_KB", q: "How much is the deposit for a villa?", expect: [["3,000,000", "3.000.000"]] },
  { id: "q-guestlist-peak", lang: "vi", category: "policy", answerability: "ANSWERABLE_FROM_KB", q: "Mùa cao điểm thì danh sách khách gửi lúc nào?", expect: [["đặt phòng", "booking", "at the time of"]] },
  { id: "q-identity-change-fee", lang: "vi", category: "policy", answerability: "ANSWERABLE_FROM_KB", q: "Đổi tên khách sau hạn chót bị phạt bao nhiêu?", expect: [["350,000", "350.000"]] },
  { id: "q-data-not-sold", lang: "en", category: "policy", answerability: "ANSWERABLE_FROM_KB", q: "Does the resort sell guest personal data?", expect: [["not sold", "never sold", "không bán"]] },
  { id: "q-card-cvv-not-stored", lang: "vi", category: "policy", answerability: "ANSWERABLE_FROM_KB", q: "Resort có lưu số CVV thẻ của tôi không?", expect: [["không", "not stored"]] },
  { id: "q-outside-food-fee", lang: "vi", category: "policy", answerability: "ANSWERABLE_FROM_KB", q: "Mang đồ ăn từ ngoài vào thì tính phí bao nhiêu?", expect: [["1,175,000", "1.175.000"]] },

  // ---------------------------------------------------------------- check-in/check-out (incl. calculation/reasoning)
  { id: "q-earlycheckin-before6", lang: "vi", category: "checkin", answerability: "ANSWERABLE_FROM_KB", q: "Tôi đến resort lúc 5 giờ sáng thì tính phí nhận phòng sớm thế nào?", expect: [["100%"]] },
  { id: "q-earlycheckin-8am", lang: "vi", category: "checkin", answerability: "ANSWERABLE_FROM_KB", q: "Tôi muốn nhận phòng lúc 8 giờ sáng thì bị tính phí bao nhiêu phần trăm?", expect: [["50%"]] },
  { id: "q-latecheckout-3pm", lang: "en", category: "checkout", answerability: "ANSWERABLE_FROM_KB", q: "Can I leave at 4?", expect: [["50%"]] },
  { id: "q-latecheckout-8pm", lang: "vi", category: "checkout", answerability: "ANSWERABLE_FROM_KB", q: "Tôi trả phòng lúc 8 giờ tối thì tính phí sao?", expect: [["100%"]] },
  { id: "q-checkout-per-room", lang: "en", category: "checkout", answerability: "ANSWERABLE_FROM_KB", q: "Is the late check-out fee charged per guest or per room?", expect: [["per room", "mỗi phòng"]] },
  { id: "q-goldtier-latecheckout", lang: "vi", category: "checkout", answerability: "ANSWERABLE_FROM_KB", q: "Tôi là khách hạng Platinum, trả phòng lúc 13:30 có bị tính phí không?", expect: [["14:00", "miễn phí", "waive", "không tính"]] },
  { id: "q-checkin-standard-natural", lang: "vi", category: "checkin", answerability: "ANSWERABLE_FROM_KB", q: "Mấy giờ tôi được vào phòng vậy?", expect: [["14:00"]] },

  // ---------------------------------------------------------------- children/occupancy (incl. partial evidence)
  { id: "q-occupancy-combo", lang: "vi", category: "occupancy", answerability: "ANSWERABLE_FROM_KB", q: "Một phòng ở được tối đa mấy người lớn và mấy trẻ em?", expect: [["3", "1"], ["2", "2"]] },
  { id: "q-villa-occupancy", lang: "en", category: "occupancy", answerability: "ANSWERABLE_FROM_KB", q: "How many people can stay in one villa bedroom?", expect: [["2 adults", "2 người lớn"], ["2 children", "2 trẻ em"]] },
  { id: "q-extrabed-villa", lang: "vi", category: "occupancy", answerability: "ANSWERABLE_FROM_KB", q: "Biệt thự có kê thêm giường phụ được không?", expect: [["không", "not available", "except"]] },
  { id: "q-child-surcharge-amount", lang: "vi", category: "occupancy", answerability: "PARTIALLY_ANSWERABLE", q: "Trẻ em 8 tuổi thì phụ thu thêm bao nhiêu tiền?", expect: [["phụ thu", "surcharge"]], mustNotAssert: ["500,000", "300,000", "1,000,000", "200,000"] },
  { id: "q-under4-free", lang: "en", category: "occupancy", answerability: "ANSWERABLE_FROM_KB", q: "Do children under 4 count toward the room occupancy limit?", expect: [["under 4", "dưới 4"]] },

  // ---------------------------------------------------------------- transportation
  { id: "q-cablecar-record", lang: "vi", category: "transport", answerability: "ANSWERABLE_FROM_KB", q: "Cáp treo Vinpearl có phải là dài nhất thế giới không?", expect: [["guinness", "dài nhất thế giới", "longest"]] },
  { id: "q-cablecar-length", lang: "en", category: "transport", answerability: "ANSWERABLE_FROM_KB", q: "How long is the cable car in meters?", expect: [["2,643", "2643", "2,642"]] },
  { id: "q-camranh-distance", lang: "vi", category: "transport", answerability: "ANSWERABLE_FROM_KB", q: "Sân bay Cam Ranh cách trung tâm Nha Trang bao xa?", expect: [["35"]] },
  { id: "q-airport-pickup-price", lang: "vi", category: "transport", answerability: "ANSWERABLE_FROM_TOOL", q: "Đón sân bay Cam Ranh giá bao nhiêu?", expect: [["750,000", "750.000"]] },
  { id: "q-citytransfer-price", lang: "en", category: "transport", answerability: "ANSWERABLE_FROM_TOOL", q: "How much for a transfer to central Nha Trang?", expect: [["350,000", "350.000"]] },
  { id: "q-airport-leadtime", lang: "vi", category: "transport", answerability: "ANSWERABLE_FROM_TOOL", q: "Đặt xe đón sân bay cần báo trước bao lâu?", expect: [["6"]] },
  { id: "q-buggy-free", lang: "vi", category: "transport", answerability: "ANSWERABLE_FROM_KB", q: "Xe điện đưa đón trong resort có tính phí không?", expect: [["complimentary", "miễn phí", "free"]] },
  { id: "q-cablecar-vs-boat", lang: "en", category: "transport", answerability: "ANSWERABLE_FROM_KB", q: "What happens if I need to cross to the island after the cable car stops?", expect: [["speedboat", "tàu cao tốc"]] },

  // ---------------------------------------------------------------- packages/upsell
  { id: "q-package-ro", lang: "vi", category: "packages", answerability: "ANSWERABLE_FROM_KB", q: "Mã RO trong bảng giá nghĩa là gì?", expect: [["room only", "chỉ phòng"]] },
  { id: "q-package-hb", lang: "vi", category: "packages", answerability: "ANSWERABLE_FROM_KB", q: "Gói HB là gói gì?", expect: [["half board"]] },
  { id: "q-package-fb", lang: "en", category: "packages", answerability: "ANSWERABLE_FROM_KB", q: "What does the FB package code mean?", expect: [["full board"]] },
  { id: "q-group-threshold", lang: "vi", category: "packages", answerability: "ANSWERABLE_FROM_KB", q: "Đặt bao nhiêu phòng thì tính là đoàn (group)?", expect: [["10"]] },
  { id: "q-voucher-surrender", lang: "vi", category: "packages", answerability: "ANSWERABLE_FROM_KB", q: "Tôi có voucher thì cần làm gì khi nhận phòng?", expect: [["nộp", "surrender", "xuất trình"]] },
  { id: "q-early-departure-refund", lang: "en", category: "packages", answerability: "ANSWERABLE_FROM_KB", q: "If I leave a package stay early, do I get a refund for the unused nights?", expect: [["no refund", "not refund", "không hoàn"]] },

  // ---------------------------------------------------------------- payment/pricing/numeric (incl. calculation)
  { id: "q-vat-rate", lang: "vi", category: "payment", answerability: "ANSWERABLE_FROM_KB", q: "Thuế VAT áp dụng bao nhiêu phần trăm?", expect: [["8%"]] },
  { id: "q-service-charge-rate", lang: "en", category: "payment", answerability: "ANSWERABLE_FROM_KB", q: "What is the service charge percentage added to the bill?", expect: [["5%"]] },
  { id: "q-total-surcharge-calc", lang: "vi", category: "payment", answerability: "ANSWERABLE_WITH_CALCULATION", q: "Giá phòng net là 2,000,000đ thì tổng phụ thu phí dịch vụ và thuế là bao nhiêu phần trăm?", expect: [["13%"]] },
  { id: "q-diamond-discount", lang: "vi", category: "payment", answerability: "ANSWERABLE_FROM_KB", q: "Hạng Diamond được giảm giá phòng bao nhiêu phần trăm?", expect: [["10%"]] },
  { id: "q-platinum-discount", lang: "en", category: "payment", answerability: "ANSWERABLE_FROM_KB", q: "What room discount does a Platinum member get?", expect: [["7%"]] },
  { id: "q-bank-account", lang: "vi", category: "payment", answerability: "ANSWERABLE_FROM_KB", q: "Số tài khoản chuyển khoản VND là gì?", expect: [["19127850127299"]] },
  { id: "q-refund-window", lang: "en", category: "payment", answerability: "ANSWERABLE_FROM_KB", q: "How many working days does a refund take?", expect: [["45"]] },
  { id: "q-golf-discount", lang: "vi", category: "payment", answerability: "ANSWERABLE_FROM_KB", q: "Hội viên Pearl Club được giảm giá golf bao nhiêu?", expect: [["33%"]] },

  // ---------------------------------------------------------------- insufficient evidence / unsupported guessing
  { id: "q-vinwonders-price-daily", lang: "vi", category: "unsupported", answerability: "INSUFFICIENT_EVIDENCE", q: "Vé VinWonders hôm nay giá bao nhiêu?", mustNotAssert: ["1,050,000", "700,000", "800,000"] },
  { id: "q-loyalty-points-threshold", lang: "vi", category: "unsupported", answerability: "INSUFFICIENT_EVIDENCE", q: "Tôi cần bao nhiêu điểm Pearl Club để lên hạng Diamond?", mustNotAssert: ["150,000", "150000"] },
  { id: "q-laundry-other-price", lang: "en", category: "unsupported", answerability: "INSUFFICIENT_EVIDENCE", q: "How much does laundry cost for a jacket that's not on your price list?", mustNotAssert: ["90,000", "110,000", "160,000"] },
  { id: "q-child-surcharge-vinwonders-partial", lang: "vi", category: "unsupported", answerability: "PARTIALLY_ANSWERABLE", q: "Trẻ 10 tuổi vào VinWonders giá bao nhiêu, và ăn sáng ở resort có tính phí không?", expect: [["375,000", "375.000"]], mustNotAssert: ["800,000 cho trẻ 10 tuổi"] },

  // ---------------------------------------------------------------- ambiguous / out of scope
  { id: "q-oos-weather", lang: "vi", category: "out_of_scope", answerability: "OUT_OF_SCOPE", q: "Ngày mai thời tiết Nha Trang thế nào?" },
  { id: "q-oos-medical", lang: "en", category: "out_of_scope", answerability: "OUT_OF_SCOPE", q: "I have a headache, what medicine should I take?" },
  { id: "q-oos-outside-restaurant", lang: "vi", category: "out_of_scope", answerability: "OUT_OF_SCOPE", q: "Ở trung tâm Nha Trang có quán nào ngon không, ngoài resort ấy?" },
  { id: "q-ambiguous-pronoun", lang: "vi", category: "ambiguous", answerability: "AMBIGUOUS", q: "Cái đó giá bao nhiêu?" },
  { id: "q-ambiguous-short", lang: "en", category: "ambiguous", answerability: "AMBIGUOUS", q: "and the other one?" },

  // ---------------------------------------------------------------- multi-fact synthesis / simple reasoning
  { id: "q-synth-checkin-id", lang: "vi", category: "reasoning", answerability: "ANSWERABLE_FROM_KB", q: "Nhận phòng cần giấy tờ gì, và trẻ em thì cần thêm gì?", expect: [["căn cước", "cccd", "hộ chiếu", "passport"], ["khai sinh", "birth certificate"]] },
  { id: "q-synth-cancel-window", lang: "en", category: "reasoning", answerability: "ANSWERABLE_FROM_KB", q: "If I cancel 5 days before arrival, what percentage do I pay?", expect: [["50%"]] },
  { id: "q-synth-cancel-window-far", lang: "vi", category: "reasoning", answerability: "ANSWERABLE_FROM_KB", q: "Nếu tôi hủy phòng trước 10 ngày thì có mất phí không?", expect: [["không", "miễn phí", "0%"]] },
  { id: "q-synth-package-compare", lang: "vi", category: "reasoning", answerability: "ANSWERABLE_FROM_TOOL", q: "Deluxe 2 giường đơn và Grand Deluxe giường đôi, gói nào rẻ hơn?", expect: [["deluxe 2 giường đơn", "deluxe giường đôi"]] },
  { id: "q-synth-pool-hours-vs-swim", lang: "en", category: "reasoning", answerability: "ANSWERABLE_FROM_KB", q: "Can I swim in the sea at 8pm?", expect: [["no", "không", "19:00"]] },

  // ---------------------------------------------------------------- natural / colloquial paraphrase stress-test
  { id: "q-natural-early-leave", lang: "en", category: "paraphrase", answerability: "ANSWERABLE_FROM_KB", q: "Do you guys have breakfast early?", expect: [["06:00", "6:00"]] },
  { id: "q-natural-deluxe-price2", lang: "vi", category: "paraphrase", answerability: "ANSWERABLE_FROM_KB", q: "Phòng thường thường giá nhiêu vậy shop ơi?", expect: [["2,200,000", "2.200.000", "2200000"]] },
  { id: "q-natural-child-breakfast-zh", lang: "zh", category: "paraphrase", answerability: "ANSWERABLE_FROM_KB", q: "小孩早餐怎么收费？", expect: [["375", "免费"] ] },
  { id: "q-natural-child-breakfast-ko", lang: "ko", category: "paraphrase", answerability: "ANSWERABLE_FROM_KB", q: "조식 아이 요금은 어떻게 되나요?", expect: [["375", "무료"]] },
  { id: "q-natural-early-checkout-en", lang: "en", category: "paraphrase", answerability: "ANSWERABLE_FROM_KB", q: "Can I leave at 4?", expect: [["50%"]] },
  { id: "q-natural-pets-ja", lang: "ja", category: "paraphrase", answerability: "ANSWERABLE_FROM_KB", q: "犬を連れて行ってもいいですか？", expect: [["禁止", "できません", "不可"]] },
  { id: "q-natural-shortquestion-vi", lang: "vi", category: "paraphrase", answerability: "ANSWERABLE_FROM_KB", q: "Có wifi ko?", expect: [["wifi", "miễn phí", "free"]] },
  { id: "q-natural-checkout-time-zh", lang: "zh", category: "paraphrase", answerability: "ANSWERABLE_FROM_KB", q: "几点退房？", expect: [["12:00", "12点"]] },
];
