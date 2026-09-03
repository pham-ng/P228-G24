/**
 * Ask back when the guest named an attribute but no subject.
 *
 * Measured on the Vietnamese golden set before this existed: **0 of 6**
 * ambiguous questions got a clarifying question. Every one was answered with a
 * guess, and the guesses were not harmless —
 *
 *   "Bao lâu thì tới ạ?"        → quoted the airport transfer lead time, when
 *                                 room service and laundry publish waits too.
 *   "Cho tôi đặt lúc 7 giờ nhé." → quoted a 50% early-check-in fee, inventing a
 *                                 transaction the guest had not asked for.
 *
 * The second is worse than a wrong answer: it puts a charge in front of someone
 * who said nothing about checking in. A concierge who cannot say "sorry, which
 * one?" will eventually book the wrong thing.
 *
 * DETERMINISTIC, AND DELIBERATELY SO. No model call, no latency, and the same
 * input always produces the same question — which matters because a clarifying
 * question that varies run to run is impossible to test. The rule is narrow:
 *
 *   the message names an ATTRIBUTE (hours, price, how long, cancel, discount,
 *   book) AND names no SUBJECT at all AND is short.
 *
 * All three conditions, because the cost of a false positive is real: asking
 * "which one did you mean?" of a guest who was perfectly clear is worse than
 * the occasional guess. When in doubt this stays silent and the normal pipeline
 * runs.
 */
import { fold } from "./retrieval";

export type ClarifyLang = "vi" | "en" | "ko" | "ja" | "zh" | "ru";
export type Attribute = "hours" | "price" | "duration" | "cancel" | "discount" | "book" | "capacity";

/**
 * What is being asked ABOUT. Folded, so an unaccented "may gio mo cua" matches
 * the same rule as "mấy giờ mở cửa".
 */
const ATTRIBUTES: Array<{ key: Attribute; re: RegExp }> = [
  { key: "hours", re: /\b(?:may gio|gio mo cua|mo cua luc nao|mo den may gio|dong cua luc nao|what time.*open|opening hours|when.*open)\b/i },
  /* "phu thu.{0,20}bao nhieu|the nao" và "tinh phi/tien.{0,20}the nao" thêm sau
     audit tay 461-case (2026-09-03): "Phụ thu bao nhiêu?", "Tính phí thế
     nào?", "Thêm người phụ thu thế nào?" đều hỏi giá mà không nêu chủ thể
     (phòng, dịch vụ, giường phụ...), nhưng cụm "phụ thu"/"tính phí" không
     khớp bốn mẫu giá cũ (chỉ có "giá/tiền/hết bao nhiêu"). */
  { key: "price", re: /\b(?:gia bao nhieu|bao nhieu tien|gia the nao|het bao nhieu|how much (?:is|does)?|what.*price|price\?|phu thu.{0,20}(?:bao nhieu|the nao)|tinh (?:phi|tien).{0,20}the nao)\b/i },
  { key: "duration", re: /\b(?:bao lau|mat bao lau|khi nao (?:thi )?(?:toi|den)|how long|when will it (?:arrive|come))\b/i },
  { key: "cancel", re: /\b(?:huy duoc khong|co huy duoc|toi muon huy|can i cancel|cancel it)\b/i },
  { key: "discount", re: /\b(?:duoc giam gia|co giam gia|giam gia khong|any discount|is there a discount)\b/i },
  { key: "book", re: /\b(?:cho (?:toi|em) dat|toi muon dat|dat luc|book (?:me|it)|i.d like to book)\b/i },
  /* Thêm cùng đợt: "Sức chứa thế nào?" không nêu phòng/nhà hàng/hội trường nào
     — sức chứa của mỗi nơi một khác (phòng 4 người, nhà hàng vài trăm). */
  { key: "capacity", re: /\b(?:suc chua the nao|suc chua bao nhieu|chua (?:duoc )?bao nhieu nguoi|toi da bao nhieu nguoi)\b/i },
];

/**
 * Anything a question could be ABOUT.
 *
 * Broad on purpose — a missed clarification is cheap, a wrongly-asked one is
 * not. Common nouns matter more than proper names here: a guest writes "hồ
 * bơi", not "the main freshwater pool". Words that are part of an attribute are
 * deliberately absent — "giá" is not a subject, or "giá bao nhiêu" would look
 * like it named one.
 */
const SUBJECTS = [
  /* facilities */
  "ho boi", "be boi", "pool", "gym", "phong tap", "fitness", "spa", "massage", "sauna", "xong hoi",
  "kids club", "tre em", "bai bien", "beach", "le tan", "front desk", "reception", "wifi", "internet",
  "business center", "doi tien", "ngoai te", "currency", "golf", "bowling", "karaoke", "imperial",
  /* dining */
  "nha hang", "restaurant", "bar", "buffet", "bua sang", "bua trua", "bua toi", "breakfast", "lunch",
  "dinner", "an sang", "an trua", "an toi", "lotus", "jasmine", "ozone", "bach giai", "halal",
  "mon", "thuc don", "menu", "do an", "food", "cocktail", "hai san", "seafood",
  /* rooms and stay */
  "phong", "room", "villa", "biet thu", "deluxe", "suite", "giuong", "bed", "view", "huong bien",
  "nhan phong", "tra phong", "check in", "checkin", "check out", "checkout", "dat phong", "booking",
  "coc", "deposit", "hoa don", "bill", "invoice", "thue", "vat",
  /* services */
  "giat", "laundry", "ui", "xe", "car", "buggy", "dua don", "transfer", "san bay", "airport",
  "cap treo", "cable car", "vinwonders", "tour", "taxi", "room service", "phuc vu tai phong",
  "khan", "towel", "goi", "pillow", "don phong", "housekeeping",
  /* membership */
  /* KHÔNG có "the" trần trụi ở đây — xem lý do ngay dưới. */
  "pearl club", "hoi vien", "member", "the thanh vien", "diamond", "platinum", "gold", "silver",
  /* Added after the golden set caught two false positives — both cases where a
     subject WAS named and the lexicon simply did not know the word:
       "Nếu tôi muốn khiếu nại thì bao lâu có trả lời?"  -> asked back at a guest
         making a COMPLAINT, which is the worst possible moment for it.
       "Vé máy bay từ Hà Nội vào Cam Ranh giá bao nhiêu?" -> out of scope, but
         plainly about a named thing; the right answer is "we don't have that",
         not "which service did you mean?".
     A missing subject word does not merely lose a clarification, it manufactures
     one, so this list errs long. */
  "khieu nai", "phan anh", "complaint", "complain", "tranh chap", "dispute",
  "ve may bay", "may bay", "flight", "chuyen bay", "ve tau", "ve xe",
  "hop dong", "hoa don do", "bao hiem", "insurance", "visa", "ho chieu", "passport",
  "khai bao", "luu tru", "thu cung", "pet", "hut thuoc", "smoking",
  /* Caught by the 461-case eval (2026-09-03): "Đổi tên khách sau hạn chót bị
     phạt bao nhiêu tiền?" named a clear subject (guest name change) whose fee is
     in the GUEST_LIST doc, but the lexicon did not know "đổi tên", so the price
     attribute fired and the guest was asked "which service?" instead of being
     told 350.000đ. A whole class of "phí <specific thing> bao nhiêu" was blocked
     before retrieval even ran. */
  "doi ten", "name change", "danh sach khach", "guest list", "chuyen phong", "transfer khach",
  /* Same class, same eval run: named subjects the lexicon missed, so a clear
     question got "which service?" instead of an answer (or a correct "not
     published, ask reception"): water sports, the Harbour shows. */
  "mo to nuoc", "jet ski", "the thao duoi nuoc", "water sport", "lan bien", "kayak", "du luon",
  "show", "harbour", "vinpearl harbour", "nhac nuoc", "tata",
];
/**
 * VÌ SAO KHÔNG CÒN "the" (thẻ hội viên) TRẦN TRỤI TRONG DANH SÁCH TRÊN.
 *
 * `fold()` xoá dấu bằng cách chuẩn hoá NFD rồi bỏ mọi dấu thanh — và phép đó
 * làm mất phân biệt: "thẻ" (card) VÀ "thế" (từ để hỏi trong "thế nào" — cực kỳ
 * phổ biến) đều gập về đúng một chuỗi "the". `SUBJECTS.some(s => f.includes(s))`
 * so bằng substring, nên MỌI câu chứa "thế nào" — dù không hề nhắc tới thẻ hội
 * viên — bị hiểu nhầm là "đã nêu chủ thể" và không bao giờ được hỏi lại.
 *
 * Bắt được qua audit 461 ca (2026-09-03): "Sức chứa thế nào?", "Tính phí thế
 * nào?", "Thêm người phụ thu thế nào?" đều im lặng đoán bừa vì lý do này —
 * không phải vì thiếu regex thuộc tính (dù thiếu regex ĐÓ cũng là một phần).
 *
 * Đây không phải lỗi có thể sửa bằng ranh giới từ (word-boundary): "thẻ" và
 * "thế" gập về CÙNG một chuỗi, nên không có cách nào phân biệt chúng sau khi
 * đã fold. Bỏ hẳn "the" trần trụi; "the thanh vien" (cả cụm) và bốn hạng thẻ
 * (diamond/platinum/gold/silver) đủ để nhận ra câu hỏi thật về thẻ hội viên,
 * không đụng tới bất kỳ câu "thế nào" nào khác.
 *
 * Đo bằng dry-run trên toàn bộ 461 câu trước khi áp dụng: 3/4 ca mục tiêu
 * được kích hoạt đúng, KHÔNG câu nào khác trong 461 câu bị kích hoạt sai.
 */

const PHRASES: Record<ClarifyLang, Record<Attribute, string>> = {
  vi: {
    hours: "Dạ anh/chị muốn hỏi giờ mở cửa của nơi nào ạ — hồ bơi, phòng gym, spa hay nhà hàng? Mỗi nơi một khung giờ khác nhau ạ.",
    price: "Dạ anh/chị đang hỏi giá của dịch vụ nào ạ — tiền phòng, bữa ăn, spa hay xe đưa đón? Em xin phép hỏi rõ để báo đúng ạ.",
    duration: "Dạ anh/chị đang hỏi về việc gì ạ — đồ ăn gọi lên phòng, xe đưa đón hay đồ giặt ủi? Mỗi loại một thời gian khác nhau ạ.",
    cancel: "Dạ anh/chị muốn huỷ đặt phòng hay huỷ một dịch vụ đã đặt ạ? Hai trường hợp này chính sách phí khác nhau ạ.",
    discount: "Dạ anh/chị đang là hội viên hạng nào của Pearl Club, và muốn hỏi ưu đãi cho hạng mục nào ạ — phòng, spa, golf hay ăn uống?",
    book: "Dạ anh/chị muốn đặt dịch vụ nào ạ, và là 7 giờ sáng hay 7 giờ tối, cho mấy người ạ?",
    capacity: "Dạ anh/chị đang hỏi sức chứa của đâu ạ — phòng, nhà hàng hay phòng hội nghị? Mỗi nơi một con số khác nhau ạ.",
  },
  en: {
    hours: "Which one did you mean — the pool, the gym, the spa or a restaurant? Each has its own opening hours.",
    price: "Which one would you like the price for — a room, a meal, the spa, or the airport transfer?",
    duration: "Which one did you mean — in-room dining, the airport transfer, or the laundry? Each has a different turnaround.",
    cancel: "Would you like to cancel a room booking or a service booking? The two carry different fees.",
    discount: "Which Pearl Club tier are you on, and which would you like the discount for — the room, the spa, golf or dining?",
    book: "What would you like to book, at 7 in the morning or 7 in the evening, and for how many people?",
    capacity: "Which one's capacity did you mean — a room, a restaurant, or a meeting room? Each holds a different number.",
  },
  ko: {
    hours: "어느 곳의 운영 시간을 말씀하시는 걸까요 — 수영장, 피트니스, 스파, 레스토랑 중에서요? 각각 시간이 다릅니다.",
    price: "어떤 항목의 가격을 알려드릴까요 — 객실, 식사, 스파, 공항 픽업 중에서요?",
    duration: "어떤 것을 말씀하시는 걸까요 — 룸서비스, 공항 픽업, 세탁 중에서요? 소요 시간이 각각 다릅니다.",
    cancel: "객실 예약을 취소하시겠습니까, 아니면 예약하신 서비스를 취소하시겠습니까? 수수료 규정이 다릅니다.",
    discount: "펄클럽 등급이 어떻게 되시고, 어떤 항목의 할인을 원하시나요 — 객실, 스파, 골프, 식음료 중에서요?",
    book: "어떤 서비스를 예약해 드릴까요? 오전 7시인가요 오후 7시인가요, 그리고 몇 분이신가요?",
    capacity: "어디의 수용 인원을 말씀하시는 걸까요 — 객실, 레스토랑, 회의실 중에서요? 장소마다 다릅니다.",
  },
  ja: {
    hours: "どちらの営業時間でしょうか — プール、ジム、スパ、レストランのいずれでしょうか。それぞれ時間が異なります。",
    price: "どちらの料金をお調べいたしましょうか — 客室、お食事、スパ、空港送迎のいずれでしょうか。",
    duration: "どちらのことでしょうか — ルームサービス、空港送迎、ランドリーのいずれでしょうか。所要時間が異なります。",
    cancel: "ご予約のお部屋のキャンセルでしょうか、それともご予約サービスのキャンセルでしょうか。規定が異なります。",
    discount: "パールクラブの会員ランクと、どちらの割引をご希望かお教えいただけますか — 客室、スパ、ゴルフ、レストランのいずれでしょうか。",
    book: "どのサービスをご予約いたしましょうか。朝の7時と夜の7時のどちらで、何名様でしょうか。",
    capacity: "どちらの収容人数でしょうか — 客室、レストラン、会議室のいずれでしょうか。場所により異なります。",
  },
  zh: {
    hours: "请问您指的是哪一处的开放时间 — 泳池、健身房、水疗还是餐厅？每处时间不同。",
    price: "请问您想了解哪一项的价格 — 客房、餐饮、水疗还是机场接送？",
    duration: "请问您指的是哪一项 — 送餐服务、机场接送还是洗衣？各自所需时间不同。",
    cancel: "请问您是要取消客房预订，还是取消已预订的服务？两者的费用规定不同。",
    discount: "请问您的 Pearl Club 会员等级是？想了解哪一项的优惠 — 客房、水疗、高尔夫还是餐饮？",
    book: "请问您想预订哪项服务？是早上7点还是晚上7点，几位用？",
    capacity: "请问您想了解哪里的容纳人数 — 客房、餐厅还是会议室？每处不同。",
  },
  ru: {
    hours: "Что именно вас интересует — бассейн, спортзал, спа или ресторан? У каждого свой график.",
    price: "Стоимость чего вас интересует — номера, питания, спа или трансфера из аэропорта?",
    duration: "О чём именно речь — доставка еды в номер, трансфер или прачечная? Сроки у всех разные.",
    cancel: "Вы хотите отменить бронирование номера или заказанную услугу? Условия отмены разные.",
    discount: "Какой у вас уровень Pearl Club и на что нужна скидка — номер, спа, гольф или рестораны?",
    book: "Что именно забронировать, на 7 утра или на 7 вечера, и на сколько человек?",
    capacity: "Вместимость чего вас интересует — номера, ресторана или конференц-зала? У каждого своя.",
  },
};

/** Long messages carry their own context even without a subject noun. */
const MAX_WORDS = 12;

/**
 * The clarifying question this message needs, or null to let the pipeline run.
 *
 * Returns null on anything uncertain. That asymmetry is the design: silence
 * here costs one guess, a wrong clarification costs the guest's patience on a
 * question they had already asked properly.
 */
export function needsClarification(text: string, lang: ClarifyLang = "vi"): { attribute: Attribute; reply: string } | null {
  const raw = text.trim();
  if (!raw) return null;
  if (raw.split(/\s+/).length > MAX_WORDS) return null;

  const f = fold(raw);
  /* A subject anywhere means the guest told us what they are asking about. */
  if (SUBJECTS.some((s) => f.includes(s))) return null;

  const hit = ATTRIBUTES.find((a) => a.re.test(f));
  if (!hit) return null;

  return { attribute: hit.key, reply: PHRASES[lang][hit.key] };
}
