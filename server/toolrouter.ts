/**
 * Chooses which of the 54 tools to show the model on a given turn.
 *
 * Measured on the real `TOOLS` export with the o200k_base tokenizer, the full
 * set serialises to 8,659 tokens (39,221 chars of compact JSON — the pretty
 * printed 12,640 figure is not what goes on the wire). That is re-sent on every
 * round of the agent loop, and `MAX_TOOL_ROUNDS` is 10, so one guest turn can
 * spend ~87k prompt tokens on tool definitions alone before a single word of
 * conversation. Two consequences:
 *
 *   - A local model with an 8K context cannot run the agent at all: the tool
 *     block alone overflows the window before the system prompt is added.
 *   - On the hosted API it is the single largest line item on the bill, and it
 *     is spent describing capabilities that are irrelevant to the question.
 *
 * So narrowing is applied to BOTH providers, not just the local one. Beyond
 * cost, this keeps the two paths comparable: if only the local leg were
 * narrowed, the same question would reach a different capability set depending
 * on whether the network happened to be up.
 *
 * Narrowing is a coverage risk, not a correctness risk — a hidden tool cannot
 * give a wrong price, it can only fail to be used. The risk is handled two
 * ways: deterministic keyword routing picks the likely families up front, and
 * `find_capability` lets the model discover and unlock what it cannot see. The
 * second matters more than the first, because it means a routing miss costs one
 * extra round rather than a wrong refusal.
 */

import type { ToolSpec } from "./llm";

/* ------------------------------------------------------------------ budget */

/**
 * Tokens per character, measured at 4.53 on the real tool set. Rounded down to
 * 4.2 so the estimate errs high and the budget is never quietly overshot;
 * re-deriving it needs a tokenizer, which is not a runtime dependency here.
 */
const CHARS_PER_TOKEN = 4.2;

export function estimateTokens(tools: ToolSpec[]): number {
  return Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN);
}

/**
 * The context window the local model is served with. This is a property of the
 * llama.cpp/Ollama launch flags (`-c`), not of the model, so it must be kept in
 * step with them by hand — there is no way to read it back over the OpenAI
 * compatible API.
 */
export const LOCAL_CTX = Number(process.env.LOCAL_CTX ?? 8192);

/**
 * Share of the context the tool block may occupy. The rest has to hold the
 * system prompt (~900 tokens measured), the reply reservation (maxTokens 1100),
 * the trimmed history, and the tool results — which are frequently larger than
 * the definitions, since one `check_availability` result can list nine room
 * types with rates.
 *
 * At the 8K default this yields ~3,270 tokens, which must stay above the largest
 * family plus core (currently `stay_changes` at ~1,350, so ~2,220 together): the
 * commonest reasons a guest talks to a kiosk are booking a stay and changing one,
 * and a budget that could not fit those families would fail on the main use case.
 * `stay_changes` once held both jobs and sat at 99% of this ceiling — see
 * `room_shopping` for why it was split.
 */
const TOOL_CTX_SHARE = Number(process.env.LOCAL_TOOL_SHARE ?? 0.4);

/**
 * How many tokens of tool definitions each provider may carry.
 *
 * The hosted default is not a context limit — the API has room for all 54 — but
 * a cost limit. 5,000 tokens keeps roughly four families available while cutting
 * the per-round tool spend by about 40%.
 */
export const TOOL_BUDGET = {
  local: Number(process.env.LOCAL_TOOL_BUDGET ?? Math.floor(LOCAL_CTX * TOOL_CTX_SHARE)),
  openai: Number(process.env.OPENAI_TOOL_BUDGET ?? 5000),
};

/* ----------------------------------------------------------------- families */

/**
 * Tools grouped by what a guest is trying to do, because that is the unit a
 * message selects. Grouping by subsystem (booking/ops/billing) would cut across
 * intents: "tôi muốn ở thêm một đêm" needs an availability check, a rate quote
 * and a reservation change that live in three different files.
 *
 * `core` is on every turn: identity, policy lookup, knowledge search, date
 * parsing and the escalation hatch. Those are the tools whose absence turns a
 * good answer into a fabricated one, and together they cost ~680 tokens.
 */
export type FamilyName =
  | "core"
  | "room_shopping"
  | "stay_changes"
  | "dining_services"
  | "billing"
  | "housekeeping"
  | "rooms_info"
  | "guest_profile"
  | "transport_tours"
  | "urgent";

export const FAMILIES: Record<FamilyName, string[]> = {
  core: ["get_stay_details", "search_knowledge", "get_policy", "resolve_date", "escalate_to_human"],

  /* Shopping for a stay that does not exist yet: what is available, what it
   * costs, and booking it. Split out of `stay_changes` when that family reached
   * 99% of the local context budget and adding one tool pushed the property's
   * commonest intent out of the tool block entirely. The two jobs also have
   * disjoint vocabularies — nobody asking for a late checkout needs the rate
   * card — so separating them improves routing precision as well as headroom. */
  room_shopping: [
    "recommend_room_packages",
    "compare_room_types",
    "check_availability",
    "create_reservation",
    "check_occupancy",
    "get_restrictions",
  ],

  /* Changing a booking the guest already holds. */
  stay_changes: [
    "change_reservation_dates",
    "cancel_reservation",
    "quote_cancellation",
    "extend_stay",
    "quote_late_checkout",
    "request_late_checkout",
    "quote_early_checkin",
    "request_early_checkin",
    "add_guest_to_reservation",
  ],

  dining_services: [
    "suggest_experiences",
    "get_dining_facts",
    "list_services",
    "book_service",
    "modify_service_booking",
    "cancel_service_booking",
    "order_room_service",
    "get_facility_hours",
    "book_meeting_room",
    "request_babysitting",
  ],

  billing: [
    "get_folio",
    "settle_folio",
    "create_payment_link",
    "request_invoice",
    "express_checkout",
    "declare_lodging",
    "quote_tax_gross_up",
  ],

  housekeeping: [
    "request_housekeeping",
    "report_maintenance_issue",
    "request_laundry",
    "request_luggage",
    "request_room_move",
    "request_wake_up_call",
    "report_lost_item",
    "get_request_status",
    "create_task",
  ],

  rooms_info: ["get_room_type_facts", "get_offers", "get_weather", "get_live_weather"],

  guest_profile: [
    "get_guest_profile",
    "get_loyalty_status",
    "enroll_loyalty",
    "update_guest_preferences",
    "submit_feedback",
  ],

  transport_tours: ["book_transport", "book_local_tour"],

  urgent: ["request_medical_assistance"],
};

/* ----------------------------------------------------------------- lexicons */

/**
 * Keyword cues per family in the four languages the kiosk serves: Vietnamese,
 * English, Korean and Chinese. Matching is on a lowercased, accent-preserving
 * substring, which is correct for vi/ko/zh — Korean and Chinese do not put
 * spaces between words, so word-boundary matching would miss almost everything.
 *
 * These are cues for *routing only*. Nothing here decides an answer, so a bad
 * keyword costs one extra `find_capability` round, never a wrong reply. That is
 * the reason routing is allowed to be this crude.
 */
const CUES: Record<Exclude<FamilyName, "core">, string[]> = {
  room_shopping: [
    // vi — availability, rates, and the rate-package ladder
    "đặt phòng", "còn phòng", "trống phòng", "phòng trống", "giá phòng", "bao nhiêu người",
    "mấy đêm", "gói", "gói phòng", "bảng giá", "combo phòng", "trọn gói", "bao gồm gì",
    "ngân sách", "khoảng giá", "tầm giá", "rẻ nhất", "gói nào", "nên đặt phòng nào",
    "bao nhiêu tiền", "giá bao nhiêu", "ưu đãi phòng", "đặt villa", "thuê phòng",
    // comparison, celebrations, and price pushback
    "khác gì", "so sánh", "khác nhau", "nên chọn", "loại nào tốt hơn",
    "trăng mật", "kỷ niệm", "sinh nhật", "đắt quá", "mắc quá", "rẻ hơn", "có gói nào rẻ",
    // en
    "book a room", "availability", "available room", "vacancy", "occupancy", "room rate",
    "package", "cheapest", "budget", "how much is a room", "what can i get for",
    // ko
    "예약", "빈방", "인원", "객실 요금", "패키지",
    // zh
    "预订", "预定", "订房", "空房", "房价", "套餐", "预算",
  ],

  stay_changes: [
    // vi — changing a booking the guest already holds
    "ở thêm", "gia hạn", "thêm đêm", "đổi ngày", "chuyển ngày", "huỷ phòng", "hủy phòng",
    "huỷ đặt", "hủy đặt", "trả phòng muộn", "check-out muộn", "checkout muộn",
    "nhận phòng sớm", "check-in sớm", "checkin sớm", "thêm người", "thêm khách",
    // en
    "extend", "extra night", "change date", "reschedule", "cancel", "late checkout",
    "late check-out", "early check-in", "early checkin", "add guest",
    // ko
    "연장", "날짜 변경", "취소", "레이트 체크아웃", "늦은 체크아웃", "얼리 체크인", "이른 체크인",
    // zh
    "续住", "延长", "改日期", "改期", "取消", "延迟退房", "提前入住", "加人",
  ],

  dining_services: [
    // vi
    "nhà hàng", "ăn", "món", "thực đơn", "menu", "bữa sáng", "bữa trưa", "bữa tối", "buffet",
    "quán bar", "cà phê", "đồ uống", "spa", "massage", "xông hơi", "hồ bơi", "bể bơi", "gym",
    "phòng gym", "sân golf", "golf", "dịch vụ", "đặt bàn", "đặt chỗ", "phục vụ tại phòng",
    "room service", "giờ mở", "mở cửa", "đóng cửa", "phòng họp", "hội nghị", "trông trẻ", "giữ trẻ",
    // in-stay cross-sell: a guest already here, wondering how to spend their time
    "làm gì", "chơi gì", "đi đâu", "tối nay", "chiều nay", "sáng mai", "có gì vui",
    "gợi ý", "nên làm gì", "hoạt động", "trải nghiệm", "rảnh",
    // en
    "restaurant", "dining", "breakfast", "lunch", "dinner", "bar", "coffee", "drink",
    "swimming pool", "pool", "fitness", "treatment", "book a table", "reservation for dinner",
    "opening hours", "meeting room", "conference", "babysitting", "kids club",
    // ko
    "식당", "레스토랑", "아침", "조식", "점심", "저녁", "뷔페", "칵테일", "커피", "스파", "마사지", "수영장", "헬스", "골프",
    "예약 테이블", "영업시간", "회의실", "베이비시터",
    // zh
    "餐厅", "餐廳", "早餐", "午餐", "晚餐", "自助餐", "酒吧", "咖啡", "水疗", "水療", "按摩", "泳池", "游泳池", "健身",
    "高尔夫", "订餐", "订桌", "营业时间", "会议室", "托儿",
  ],

  billing: [
    // vi
    "hoá đơn", "hóa đơn", "thanh toán", "trả tiền", "chi phí", "tổng tiền", "số tiền", "dư nợ",
    "công nợ", "phí", "thuế", "vat", "xuất hoá đơn", "xuất hóa đơn", "biên lai", "thẻ tín dụng",
    "chuyển khoản", "khai báo lưu trú", "tạm trú", "trả phòng nhanh",
    // en
    "bill", "invoice", "folio", "payment", "pay", "charge", "balance", "total cost", "receipt",
    "credit card", "settle", "tax", "express checkout",
    // ko
    "청구", "계산서", "결제", "지불", "요금", "잔액", "영수증", "세금", "카드",
    // zh
    "账单", "帳單", "发票", "發票", "付款", "支付", "费用", "費用", "余额", "餘額", "收据", "税金", "含税", "增值税", "结账", "結帳",
  ],

  housekeeping: [
    // vi
    "dọn phòng", "dọn dẹp", "buồng phòng", "khăn", "ga giường", "thay ga", "giấy vệ sinh",
    "xà phòng", "hỏng", "không hoạt động", "bị lỗi", "rò rỉ", "chảy nước", "tắc", "mất điện",
    "điều hoà", "điều hòa", "máy lạnh", "nóng quá", "lạnh quá", "ồn", "tiếng ồn", "wifi",
    "giặt", "giặt ủi", "là quần áo", "ủi", "hành lý", "gửi hành lý", "đổi phòng", "báo thức",
    "gọi dậy", "mất đồ", "để quên", "bỏ quên", "tình trạng yêu cầu", "đã xử lý chưa",
    // en
    "housekeeping", "clean", "towel", "bed sheet", "linen", "toiletries", "broken", "not working",
    "leak", "clogged", "air conditioning", "aircon", "too hot", "too cold", "noisy", "noise",
    "laundry", "ironing", "luggage", "baggage", "room move", "change room", "wake-up", "wake up call",
    "lost", "left behind", "request status", "maintenance",
    // ko
    "청소", "수건", "침구", "고장", "작동하지", "누수", "막혔", "에어컨", "너무 더", "너무 추",
    "시끄", "세탁", "다림질", "수하물", "짐 보관", "방 변경", "모닝콜", "분실", "잃어",
    // zh
    "打扫", "打掃", "清洁", "清潔", "毛巾", "床单", "床單", "坏了", "壞了", "不能用", "漏水", "堵塞", "堵住",
    "空调", "空調", "太热", "太熱", "太冷", "太吵", "吵闹", "洗衣", "熨烫", "熨衣", "行李", "换房", "換房", "叫醒", "丢了", "丢失", "丟了", "丟失",
  ],

  rooms_info: [
    // vi
    "loại phòng", "hạng phòng", "diện tích", "view", "hướng biển", "ban công", "bao gồm gì",
    "tiện nghi", "trong phòng có", "ưu đãi", "khuyến mãi", "combo", "thời tiết", "trời",
    "mưa", "nắng", "nhiệt độ", "giá phòng", "giá phòng deluxe", "bao nhiêu 1 đêm", "bảng giá phòng", "giá bao nhiêu",
    // en
    "room type", "suite", "villa", "square meter", "ocean view", "balcony", "amenities",
    "what is included", "offer", "promotion", "deal", "package", "weather", "rain", "temperature",
    // ko
    "객실 종류", "룸 타입", "스위트", "빌라", "오션뷰", "발코니", "어메니티", "포함", "프로모션", "할인", "날씨", "기온", "바다",
    // zh
    "房型", "套房", "别墅", "別墅", "海景", "阳台", "陽台", "设施", "設施", "包含", "优惠", "優惠", "促销", "天气", "天氣", "下雨", "气温",
  ],

  guest_profile: [
    // vi
    "thành viên", "hội viên", "điểm thưởng", "tích điểm", "hạng", "platinum", "diamond", "gold",
    "silver", "đăng ký thành viên", "sở thích", "ưu tiên của tôi", "góp ý", "phản hồi", "khiếu nại",
    "đánh giá",
    // en
    "membership", "loyalty", "points", "tier", "enrol", "enroll", "sign up", "preference",
    "feedback", "complaint", "review",
    // ko
    "회원", "멤버십", "포인트", "등급", "가입", "선호", "피드백", "불만", "후기",
    // zh
    "会员", "會員", "积分", "積分", "等级", "等級", "注册", "註冊", "偏好", "反馈", "反饋", "投诉", "投訴", "评价", "評價",
  ],

  transport_tours: [
    // vi
    "xe", "đưa đón", "sân bay", "taxi", "thuê xe", "tài xế", "di chuyển", "tour", "tham quan",
    "du lịch", "vé", "điểm đến", "đi chơi",
    // en
    "transfer", "airport", "taxi", "car", "driver", "shuttle", "pick up", "tour", "excursion",
    "sightseeing", "ticket",
    // ko
    "차량", "공항", "택시", "픽업", "기사", "투어", "관광", "티켓",
    // zh
    "接送", "机场", "機場", "出租车", "包车", "司机", "司機", "接机", "接機", "旅游", "旅遊", "观光", "觀光", "门票", "門票",
  ],

  urgent: [
    // vi
    "cấp cứu", "khẩn cấp", "bác sĩ", "y tế", "bệnh viện", "đau", "chảy máu", "ngất", "dị ứng",
    "thuốc", "gãy", "bị sốt", "sốt cao", "ngộ độc",
    /* "sốt" alone also means sauce ("nước sốt"), which would route a question
       about dinner into the medical family, so it only matches in context. */
    // en
    "emergency", "ambulance", "doctor", "medical", "hospital", "hurt", "injur", "bleeding",
    "faint", "allergic", "medicine", "fever", "poisoning",
    // ko
    "응급", "구급", "의사", "병원", "아파", "출혈", "알레르기", "약국", "구급약", "고열",
    // zh
    "急救", "紧急", "緊急", "医生", "醫生", "医院", "醫院", "疼痛", "很疼", "出血", "过敏", "過敏", "药品", "吃药", "藥品", "吃藥", "发烧", "發燒", "中毒",
  ],
};

/* ------------------------------------------------------------------ scoring */

/** Lowercase and collapse whitespace. Accents are kept: "hoá đơn" must not become "hoa don". */
function normalise(s: string): string {
  return String(s || "").toLowerCase().replace(/\s+/g, " ");
}

/** Does this cue contain Han, Hangul, Hiragana or Katakana? */
function isCjk(cue: string): boolean {
  return /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(cue);
}

const BOUNDARY_CACHE = new Map<string, RegExp>();

/**
 * Where a cue first occurs, or -1.
 *
 * Match mode depends on script, and getting this wrong is not a subtle problem.
 * Korean and Chinese are written without spaces, so a cue like 退房 only ever
 * matches as a substring. Vietnamese and English are space-delimited, and
 * substring matching there produces false intents: the cue "xe" (vehicle) is
 * inside "xem" (to view), so "xem hoá đơn" — show me the bill — scored as a
 * request for airport transport and crowded the billing tools out of the budget.
 * Latin cues therefore match on word boundaries.
 *
 * The boundary is built from Unicode letter classes rather than \b, because \b
 * treats the accented letters in "hoá đơn" as non-word characters and would
 * split Vietnamese words in the middle.
 *
 * The trailing boundary is only enforced for cues shorter than four letters,
 * which is what lets English inflection through: "leak" has to reach "leaking"
 * and "towel" has to reach "towels", or a guest reporting the two most ordinary
 * housekeeping problems in the language routes nowhere. Short cues keep the
 * strict boundary because that is exactly where the damage was — "xe" must not
 * open as a prefix of "xem".
 */
function cueIndex(haystack: string, cue: string): number {
  if (isCjk(cue)) return haystack.indexOf(cue);
  let re = BOUNDARY_CACHE.get(cue);
  if (!re) {
    const esc = cue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const letters = cue.replace(/[^\p{L}]/gu, "").length;
    const tail = letters < 4 ? "(?![\\p{L}\\p{N}])" : "";
    re = new RegExp(`(?<![\\p{L}\\p{N}])${esc}${tail}`, "u");
    BOUNDARY_CACHE.set(cue, re);
  }
  const m = re.exec(haystack);
  return m ? m.index : -1;
}

/**
 * Score each family against the message.
 *
 * Cues are weighted by specificity: a multi-word or long cue ("trả phòng muộn",
 * "sân bay") is strong evidence of intent, while a short single word ("bàn",
 * "xe") is weak and often incidental. Without the weighting, a message that
 * mentions five things in passing outranks one that states a single clear need.
 *
 * `first` records where the family's earliest cue appears. It breaks ties by the
 * order the guest raised things, which is more meaningful than alphabetical
 * order: in "tôi muốn ở thêm 1 đêm, và xem hoá đơn", extending the stay is the
 * request and the bill is the aside.
 */
export function scoreFamilies(
  text: string,
): Array<{ family: FamilyName; score: number; first: number; hits: string[] }> {
  const t = normalise(text);
  const out: Array<{ family: FamilyName; score: number; first: number; hits: string[] }> = [];
  for (const [family, cues] of Object.entries(CUES) as Array<[FamilyName, string[]]>) {
    let score = 0;
    let first = Number.MAX_SAFE_INTEGER;
    const hits: string[] = [];
    for (const cue of cues) {
      const at = cueIndex(t, cue);
      if (at === -1) continue;
      hits.push(cue);
      /* A space means a phrase; CJK is dense, so 2+ characters already is one. */
      const specific = cue.includes(" ") || (isCjk(cue) ? cue.length >= 2 : cue.length >= 6);
      score += specific ? 2 : 1;
      if (at < first) first = at;
    }
    if (hits.length) out.push({ family, score, first, hits });
  }
  return out.sort((a, b) => b.score - a.score || a.first - b.first);
}

/* ------------------------------------------------------- find_capability */

/**
 * The escape hatch. Narrowing hides tools, and a hidden tool the model needs is
 * invisible rather than merely unavailable — the model has no way to know it was
 * ever an option, so it would answer "we cannot do that", which is a
 * fabrication of a different kind.
 *
 * This tool costs ~70 tokens and converts that silent failure into one extra
 * round: the model describes what it is trying to do, gets back the matching
 * tool names, and those families are unlocked for the rest of the conversation.
 */
export const FIND_CAPABILITY: ToolSpec = {
  type: "function",
  function: {
    name: "find_capability",
    description:
      "Search for a hotel capability that is not in your current tool list. Use this before telling a guest that something is not possible. Returns the names of matching tools, which then become available to you.",
    parameters: {
      type: "object",
      properties: {
        need: {
          type: "string",
          description:
            "What you are trying to do, in a few words, e.g. 'issue a VAT invoice' or 'book an airport pickup'.",
        },
      },
      required: ["need"],
      additionalProperties: false,
    },
  },
};

/**
 * Resolve a `find_capability` call. Matches the request against family cues and
 * tool names, then reports which families to unlock.
 *
 * Falls back to naming every family when nothing matches, because "here is
 * everything the hotel can do" is a far better failure than "not found" — the
 * model can then pick for itself on the next round.
 */
export function resolveFindCapability(
  need: string,
  all: ToolSpec[],
): { families: FamilyName[]; tools: Array<{ name: string; description: string }>; matched: boolean } {
  const t = normalise(need);
  const scored = scoreFamilies(need).map((s) => s.family);

  /* Also match on tool names and descriptions: the model tends to paraphrase the
     tool it wants ("invoice") rather than the guest's words. */
  const byName = all.filter((tool) => {
    const nm = tool.function.name.toLowerCase();
    const desc = normalise(tool.function.description ?? "");
    const words = t.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3);
    return words.some((w) => nm.includes(w) || desc.includes(w));
  });

  const families = new Set<FamilyName>(scored);
  for (const tool of byName) {
    for (const [fam, names] of Object.entries(FAMILIES) as Array<[FamilyName, string[]]>) {
      if (names.includes(tool.function.name)) families.add(fam);
    }
  }
  families.delete("core");

  /* Nothing matched the request against any family cue or tool name. The model
     asked for a capability the router could not place, so it gets the whole
     catalogue to pick from — but the caller is told it was a miss, because a
     miss is a routing signal worth counting, not a normal lookup. */
  const matched = families.size > 0;
  const chosen = matched
    ? [...families]
    : (Object.keys(FAMILIES) as FamilyName[]).filter((f) => f !== "core");

  const names = new Set(chosen.flatMap((f) => FAMILIES[f]));
  const tools = all
    .filter((tool) => names.has(tool.function.name))
    .map((tool) => ({
      name: tool.function.name,
      description: (tool.function.description ?? "").slice(0, 120),
    }));

  return { families: chosen, tools, matched };
}

/* ---------------------------------------------------------------- selection */

export type SelectOptions = {
  /** The guest's latest message. Drives keyword routing. */
  text: string;
  /** The complete tool set, normally the `TOOLS` export from agent.ts. */
  all: ToolSpec[];
  /** Families already unlocked earlier in this conversation. Never dropped. */
  active?: FamilyName[];
  /** Token ceiling for the tool block. Defaults to the provider's budget. */
  budget?: number;
  provider?: "local" | "openai";
};

export type Selection = {
  tools: ToolSpec[];
  families: FamilyName[];
  tokens: number;
  /** Families that scored but did not fit the budget. Useful for logging. */
  dropped: FamilyName[];
  /** True when no cue matched and a default set was used. */
  guessed: boolean;
};

/**
 * Pick the tool set for one round.
 *
 * Order of precedence: core, then anything urgent, then the strongest intent in
 * the current message, then families unlocked earlier in the conversation, then
 * whatever else the message hinted at and still fits.
 *
 * Keeping earlier families ahead of the weaker current hints is what makes
 * multi-turn work: a guest who has been discussing their bill for three turns
 * and now writes only "vâng, đúng rồi" has no keywords left in the message, and
 * must not lose the billing tools because of it.
 */
export function selectTools(opts: SelectOptions): Selection {
  const provider = opts.provider ?? "local";
  const budget = opts.budget ?? TOOL_BUDGET[provider];
  const byName = new Map(opts.all.map((t) => [t.function.name, t]));

  const pick = (names: string[]) => names.map((n) => byName.get(n)).filter(Boolean) as ToolSpec[];

  const scored = scoreFamilies(opts.text);
  const guessed = scored.length === 0 && !(opts.active ?? []).length;

  /* With no cue and no history, favour the families that answer the most common
     kiosk questions rather than refusing or loading everything. */
  const ordered: FamilyName[] = [
    ...(opts.active ?? []).filter((f) => f !== "core"),
    ...scored.map((s) => s.family),
    ...(guessed ? (["rooms_info", "dining_services", "room_shopping"] as FamilyName[]) : []),
  ];

  /**
   * Two families jump the queue.
   *
   * `urgent` is admitted regardless of budget: a guest asking for a doctor
   * outranks any token ceiling.
   *
   * The top-scoring family is admitted before the rest because the fill below is
   * greedy, and greedy packing lets cheap families crowd out the expensive one
   * the guest actually asked about — `transport_tours` costs ~410 tokens and
   * `stay_changes` ~1,350, so on a tight budget the aside would win and the
   * request would be dropped.
   */
  const top = scored[0]?.family;
  const priority: FamilyName[] = [
    ...(ordered.includes("urgent") ? (["urgent"] as FamilyName[]) : []),
    ...(top && top !== "urgent" ? [top] : []),
    ...ordered,
  ];

  const chosen: FamilyName[] = ["core"];
  const dropped: FamilyName[] = [];
  let tools = [...pick(FAMILIES.core), FIND_CAPABILITY];

  for (const fam of priority) {
    if (chosen.includes(fam)) continue;
    const candidate = [...tools, ...pick(FAMILIES[fam])];
    if (estimateTokens(candidate) > budget && fam !== "urgent") {
      if (!dropped.includes(fam)) dropped.push(fam);
      continue;
    }
    tools = candidate;
    chosen.push(fam);
  }
  /* A family admitted later must not stay on the dropped list. */
  const reallyDropped = dropped.filter((f) => !chosen.includes(f));

  return { tools, families: chosen, tokens: estimateTokens(tools), dropped: reallyDropped, guessed };
}

/**
 * Every cue across every family. Exposed so tests can enforce hygiene rules on
 * the lexicon itself — most importantly that no Korean or Chinese cue is a
 * single character, since those match inside unrelated words and produce
 * confident nonsense (예약, "booking", contains 약, "medicine").
 */
export function cueList(): string[] {
  return Object.values(CUES).flat();
}
