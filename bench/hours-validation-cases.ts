/**
 * Phase 9 §9: focused hours/schedule validation set. Every fact copied
 * verbatim from the live corpus (KB articles, policy FACILITY_HOURS, dining
 * venue records) before writing the case — no invented schedules. Covers
 * single-interval, multi-interval, meal-specific, facility, entity
 * disambiguation, multilingual and paraphrase cases per the spec.
 */
export type HoursCase = { id: string; lang: string; q: string; expect: string[][] };

export const HOURS_CASES: HoursCase[] = [
  // single interval
  { id: "h-spa-vi", lang: "vi", q: "Akoya Spa mở cửa mấy giờ?", expect: [["09:00", "9:00"], ["22:00"]] },
  { id: "h-gym-vi", lang: "vi", q: "Phòng gym mở cửa từ mấy giờ?", expect: [["05:30", "5:30"], ["22:00"]] },
  { id: "h-aquafield-vi", lang: "vi", q: "Aquafield mở cửa mấy giờ?", expect: [["09:00", "9:00"], ["22:00"]] },
  { id: "h-poolbar-vi", lang: "vi", q: "Pool Bar mở cửa mấy giờ?", expect: [["09:00", "9:00"], ["23:00"]] },
  { id: "h-seaviewbar-vi", lang: "vi", q: "Seaview Bar hoạt động từ mấy giờ đến mấy giờ?", expect: [["07:00", "7:00"], ["23:00"]] },
  { id: "h-jasmine-en", lang: "en", q: "What time does Jasmine Restaurant open and close?", expect: [["11:00"], ["22:00"]] },
  { id: "h-beachcomber-vi", lang: "vi", q: "Beach Comber Bar mở cửa mấy giờ?", expect: [["09:00", "9:00"], ["23:00"]] },

  // meal-specific
  { id: "h-breakfast-vi", lang: "vi", q: "Ăn sáng phục vụ từ mấy giờ đến mấy giờ?", expect: [["06:00", "6:00"], ["10:30"]] },
  { id: "h-breakfast-en", lang: "en", q: "What are the breakfast serving hours?", expect: [["06:00", "6:00"], ["10:30"]] },

  // multi-interval (the exact failure mode this phase targets)
  { id: "h-lotus-slots-vi", lang: "vi", q: "Nhà hàng Lotus phục vụ những khung giờ nào trong ngày?", expect: [["06:00", "6:00"], ["10:30"], ["12:00"], ["18:00"], ["22:00"]] },
  { id: "h-lotus-slots-en", lang: "en", q: "What are all of Lotus Restaurant's serving hours today?", expect: [["06:00", "6:00"], ["10:30"], ["12:00"], ["18:00"], ["22:00"]] },
  { id: "h-halal-slots-vi", lang: "vi", q: "Nhà hàng Halal VietFlavors phục vụ những khung giờ nào?", expect: [["10:30"], ["14:30"], ["17:30"], ["22:00"]] },

  // facility hours (policy FACILITY_HOURS, distinct source from KB prose)
  { id: "h-pool-facility-vi", lang: "vi", q: "Hồ bơi ngoài trời mở cửa mấy giờ?", expect: [["06:00", "6:00"], ["20:00"]] },
  { id: "h-beach-facility-vi", lang: "vi", q: "Bãi biển riêng mở cửa mấy giờ?", expect: [["06:00", "6:00"], ["18:30"]] },
  { id: "h-kidsclub-vi", lang: "vi", q: "Kids Club mở cửa mấy giờ?", expect: [["08:00", "8:00"], ["20:00"]] },
  { id: "h-frontdesk-vi", lang: "vi", q: "Lễ tân làm việc mấy giờ?", expect: [["24/7", "00:00", "23:59"]] },

  // insufficient evidence — must not invent
  { id: "h-bachgiai-unknown", lang: "vi", q: "Nhà hàng Bách Giai mở cửa mấy giờ?", expect: [["hỏi lễ tân", "xem danh sách dịch vụ", "không có thông tin", "chưa xác nhận", "liên hệ"]] },

  // entity disambiguation — must not answer about the wrong bar/venue
  { id: "h-entity-poolbar-not-seaview", lang: "vi", q: "Quầy bar cạnh hồ bơi mở cửa mấy giờ?", expect: [["09:00", "9:00"], ["23:00"]] },

  // multilingual (natural phrasing, not literal translation)
  { id: "h-spa-zh", lang: "zh", q: "Akoya水疗中心几点营业？", expect: [["09:00", "9:00", "9点"], ["22:00", "10点", "22点"]] },
  { id: "h-gym-ja", lang: "ja", q: "ジムは何時から何時までですか？", expect: [["05:30", "5時30分"], ["22:00", "22時"]] },
  { id: "h-checkout-ko", lang: "ko", q: "체크아웃은 몇 시까지인가요?", expect: [["12:00", "12시"]] },
  { id: "h-checkin-zh", lang: "zh", q: "几点可以办理入住？", expect: [["14:00", "14点", "2点"]] },

  // paraphrase / colloquial stress-test
  { id: "h-spa-natural", lang: "vi", q: "Spa mấy giờ đóng cửa vậy?", expect: [["22:00"]] },
  { id: "h-gym-natural-en", lang: "en", q: "Is the gym open this early, like 6am?", expect: [["05:30", "5:30"]] },
  { id: "h-breakfast-natural-en", lang: "en", q: "Do you guys have breakfast early?", expect: [["06:00", "6:00"]] },
];
