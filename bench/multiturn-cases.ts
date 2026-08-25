/**
 * Phase 7 multi-turn subset — 10 conversations, 3 turns each (spec asked for
 * 10-15 convos of 3-6 turns; this is the smaller end, explicitly a
 * model-selection signal, not the full multi-turn acceptance suite).
 * Each turn's `expect` is checked against the reply at that turn if present;
 * omitting `expect` means the turn is context-setting only and not scored.
 */

export type Turn = { q: string; expect?: string[][]; mustEscalate?: boolean };
export type Conversation = { id: string; lang: string; kind: string; turns: Turn[] };

export const MULTITURN_CASES: Conversation[] = [
  {
    id: "mt-followup-checkout",
    lang: "vi",
    kind: "follow-up question",
    turns: [
      { q: "Mấy giờ tôi phải trả phòng?", expect: [["12:00"]] },
      { q: "Vậy nếu tôi ra muộn hơn thì sao?", mustEscalate: true },
      { q: "Được rồi, cảm ơn." },
    ],
  },
  {
    id: "mt-omitted-subject",
    lang: "vi",
    kind: "omitted subject",
    turns: [
      { q: "Spa mở cửa mấy giờ?", expect: [["09:00", "9:00"], ["22:00"]] },
      { q: "Còn bể bơi thì sao?", expect: [["hồ bơi", "nước ngọt"]] },
      { q: "Cảm ơn bạn." },
    ],
  },
  {
    id: "mt-pronoun-reference",
    lang: "en",
    kind: "pronoun/reference",
    turns: [
      { q: "Tell me about the Grand Deluxe room.", },
      { q: "Does it have an ocean view?", },
      { q: "And what time can I check in to it?", expect: [["14:00", "2 pm", "2:00"]] },
    ],
  },
  {
    id: "mt-correction",
    lang: "vi",
    kind: "correction",
    turns: [
      { q: "Ăn sáng phục vụ từ mấy giờ?", expect: [["06:00", "6:00"]] },
      { q: "Ý tôi là hỏi giờ đóng cửa cơ, không phải giờ mở cửa.", expect: [["10:30"]] },
      { q: "Vậy ăn sáng ở nhà hàng nào?", expect: [["lotus"]] },
    ],
  },
  {
    id: "mt-package-followup",
    lang: "vi",
    kind: "package -> follow-up",
    turns: [
      { q: "Mã BB trong bảng giá nghĩa là gì?", expect: [["bed and breakfast", "bữa sáng", "ăn sáng"]] },
      { q: "Vậy có gói nào bao gồm cả bữa tối không?", mustEscalate: true },
      { q: "OK vậy để tôi hỏi lễ tân." },
    ],
  },
  {
    id: "mt-breakfast-children",
    lang: "vi",
    kind: "breakfast -> children",
    turns: [
      { q: "Ăn sáng ở nhà hàng nào?", expect: [["lotus"]] },
      { q: "Trẻ em đi cùng có cần mang giấy tờ gì không?", expect: [["khai sinh", "birth certificate"]] },
      { q: "Cảm ơn." },
    ],
  },
  {
    id: "mt-room-price-breakfast",
    lang: "en",
    kind: "room -> price -> breakfast",
    turns: [
      { q: "What room types do you have?", },
      { q: "What's the price for the Deluxe Twin room?", mustEscalate: true },
      { q: "Does that room's package include breakfast?", mustEscalate: true },
    ],
  },
  {
    id: "mt-language-continuity-ko",
    lang: "ko",
    kind: "language continuity",
    turns: [
      { q: "체크아웃은 몇 시인가요?", expect: [["12:00", "12시"]] },
      { q: "그럼 체크인은요?", expect: [["14:00", "2시", "14시"]] },
      { q: "감사합니다." },
    ],
  },
  {
    id: "mt-language-continuity-zh",
    lang: "zh",
    kind: "language continuity",
    turns: [
      { q: "水疗中心几点开门？", expect: [["09:00", "9:00", "9点", "9 点"]] },
      { q: "那游泳池呢？", expect: [["泳池", "游泳"]] },
      { q: "谢谢。" },
    ],
  },
  {
    id: "mt-pets-followup",
    lang: "vi",
    kind: "follow-up on a policy answer",
    turns: [
      { q: "Tôi mang theo chó nhỏ được không?", },
      { q: "Nếu mang theo thì bị phạt bao nhiêu tiền?", mustEscalate: true },
      { q: "Vậy tôi để nó ở nhà vậy." },
    ],
  },

  /* --- Phase 8 additions (10 more, bringing the subset to 20 conversations —
     an honest expansion from the spec's 30-conversation target, not a full
     match; disclosed in the report rather than padded silently). --- */
  {
    id: "mt-date-change",
    lang: "vi",
    kind: "user changes date/time",
    turns: [
      { q: "Tôi muốn nhận phòng sớm lúc 8 giờ sáng, phí thế nào?", expect: [["50%"]] },
      { q: "Thôi để tôi đổi giờ đến, 5 giờ sáng thì sao?", expect: [["100%"]] },
      { q: "Vậy tôi đến đúng giờ tiêu chuẩn vậy, cảm ơn." },
    ],
  },
  {
    id: "mt-tool-followup",
    lang: "vi",
    kind: "tool call -> follow-up",
    turns: [
      { q: "Đón sân bay Cam Ranh giá bao nhiêu?", expect: [["750,000", "750.000"]] },
      { q: "Cần báo trước bao lâu?", expect: [["6"]] },
      { q: "Xe chở được tối đa mấy người?", expect: [["4", "bốn"]] },
    ],
  },
  {
    id: "mt-language-switch",
    lang: "vi",
    kind: "language switching mid-conversation",
    turns: [
      { q: "Spa mở cửa mấy giờ?", expect: [["09:00", "9:00"], ["22:00"]] },
      { q: "What about the swimming pool?", expect: [["pool", "hồ bơi"]] },
      { q: "Cảm ơn." },
    ],
  },
  {
    id: "mt-ambiguous-reference",
    lang: "vi",
    kind: "ambiguous pronoun/reference",
    turns: [
      { q: "Cho tôi hỏi về Deluxe và Grand Deluxe.", },
      { q: "Cái đó giá bao nhiêu?", },
      { q: "Ý tôi là Grand Deluxe.", expect: [["2,410,000", "2.410.000", "2410000"]] },
    ],
  },
  {
    id: "mt-elliptical",
    lang: "en",
    kind: "short elliptical messages",
    turns: [
      { q: "Breakfast hours?", expect: [["06:00", "6:00"]] },
      { q: "Price?", expect: [["650,000", "375,000"]] },
      { q: "Kids?", expect: [["375,000", "child"]] },
    ],
  },
  {
    id: "mt-policy-scenario",
    lang: "vi",
    kind: "policy -> specific scenario",
    turns: [
      { q: "Chính sách hút thuốc trong resort thế nào?", expect: [["khu vực", "phạt"]] },
      { q: "Nếu tôi hút trong phòng thì bị phạt bao nhiêu?", expect: [["3,000,000", "3.000.000"]] },
    ],
  },
  {
    id: "mt-package-inclusion-price",
    lang: "vi",
    kind: "package -> inclusion -> price",
    turns: [
      { q: "Gói HB là gói gì?", expect: [["half board"]] },
      { q: "Vậy có bao gồm ăn trưa không?", mustEscalate: true },
    ],
  },
  {
    id: "mt-question-clarification",
    lang: "en",
    kind: "question -> clarification",
    turns: [
      { q: "How much extra?", mustEscalate: false },
      { q: "I mean for an extra bed in a Deluxe room.", expect: [["1", "một"]] },
    ],
  },
  {
    id: "mt-long-chain-checkin",
    lang: "vi",
    kind: "4-turn chain",
    turns: [
      { q: "Mấy giờ tôi được nhận phòng?", expect: [["14:00"]] },
      { q: "Cần mang giấy tờ gì?", expect: [["căn cước", "cccd", "hộ chiếu", "passport"]] },
      { q: "Trẻ em thì sao?", expect: [["khai sinh", "birth certificate"]] },
      { q: "Cảm ơn nhiều." },
    ],
  },
  {
    id: "mt-cjk-conversation-ja",
    lang: "ja",
    kind: "conversation in CJK",
    turns: [
      { q: "チェックインは何時からですか？", expect: [["14:00", "2時", "14時"]] },
      { q: "ペットは連れて行けますか？", expect: [["禁止", "できません", "不可"]] },
    ],
  },
];
