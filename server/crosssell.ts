/**
 * In-stay cross-sell and pre-arrival outreach.
 *
 * A guest already on the island is the property's best revenue opportunity: the
 * room is sold, so every spa treatment, dinner and excursion is incremental.
 * But an in-house guest is also the easiest to annoy — they are on holiday, not
 * shopping — so a suggestion only earns its place when it fits THIS guest, at
 * THIS hour, in THIS weather, on THIS day of their stay.
 *
 * That is what this module encodes. Each candidate service is scored against the
 * signals the system genuinely has, and every surviving suggestion carries the
 * reason it was chosen, so the concierge can say *why* rather than reciting a
 * menu. A suggestion that cannot explain itself is an advert.
 *
 * WHAT IS DELIBERATELY NOT DONE HERE
 * No price is computed. Scoring decides WHAT to offer; `priceService` in
 * pricing.ts remains the only thing that decides what it COSTS, so a member
 * discount quoted in a suggestion is the same figure the booking will charge.
 */

import type { Service, Offer, Guest, Reservation } from "@shared/schema";

export type DayPart = "morning" | "afternoon" | "evening" | "night";
export type StayPhase = "arrival_day" | "mid_stay" | "departure_day";

export type Weather = {
  /** Free text from the forecast, e.g. "Có mây, gió biển nhẹ". */
  condition?: string;
  /** Percentage chance of rain, when the forecast gives one. */
  rainChance?: number;
};

export type Suggestion = {
  service_id: number;
  name: string;
  category: string;
  price: number;
  unit: string | null;
  /** Why this guest, now. Narrated by the agent; never shown as a raw list. */
  why: string;
  /** Slot times the guest could still take today, when the service has slots. */
  slots: string[];
  score: number;
};

export type CrossSellResult = {
  phase: StayPhase;
  day_part: DayPart;
  nights_left: number;
  suggestions: Suggestion[];
  /** Offers the guest is eligible for, from the offers table. */
  offers: Array<{ title: string; detail: string; price: number | null }>;
  note: string;
};

/* ------------------------------------------------------------------时 time */

export function dayPartOf(clockHHMM: string): DayPart {
  const h = Number(clockHHMM.split(":")[0] ?? 0);
  if (h < 11) return "morning";
  if (h < 17) return "afternoon";
  if (h < 22) return "evening";
  return "night";
}

/** Nights between two ISO dates, floored at 0. */
export function nightsBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

export function phaseOf(res: Pick<Reservation, "checkIn" | "checkOut">, today: string): StayPhase {
  if (today === res.checkIn) return "arrival_day";
  if (today === res.checkOut) return "departure_day";
  return "mid_stay";
}

/** Is it raining, or likely to? Drives indoor-vs-outdoor suggestions. */
export function isWet(w?: Weather): boolean {
  if (!w) return false;
  if (typeof w.rainChance === "number" && w.rainChance >= 60) return true;
  return /mưa|rain|storm|bão|dông/i.test(w.condition ?? "");
}

/* --------------------------------------------------------------- scoring */

/** Services that only make sense outdoors, and those that shine when it rains. */
const OUTDOOR = /beach|water sports|bãi biển|thể thao dưới nước|harbour|cable car|cáp treo|vinwonders/i;
const INDOOR = /spa|massage|sauna|aquafield|facial|therapy|xông hơi/i;

const DINING = /dinner|lunch|buffet|restaurant|bữa|nhà hàng/i;
const LUNCH = /lunch|trưa/i;
const DINNER = /dinner|tối/i;

export type CrossSellInput = {
  services: Service[];
  offers: Offer[];
  guest: Pick<Guest, "vipTier" | "preferences" | "staysCount">;
  reservation: Pick<Reservation, "checkIn" | "checkOut" | "status">;
  /** Hotel-local date, YYYY-MM-DD. */
  today: string;
  /** Hotel-local time, HH:MM. */
  clock: string;
  weather?: Weather;
  /** Service ids the guest has already booked — never suggested again. */
  alreadyBooked?: number[];
  /** The guest's own words, when they asked for something specific. */
  interest?: string;
  lang?: "vi" | "en";
  limit?: number;
};

/* A preference is guest-typed text, so it becomes part of a RegExp only after
   escaping — an entry like "spa (2h)" would otherwise throw and take the whole
   ranking down. */
const escapeRe = (s: string) => s.replace(/[\.*+?^${}()|\[\]\\]/g, "\\$&");

const say = (lang: "vi" | "en", vi: string, en: string) => (lang === "vi" ? vi : en);

/**
 * Rank what to offer an in-house guest right now.
 *
 * Pure: same inputs, same suggestions — so the reasoning is testable without a
 * model, a clock or a network call.
 */
export function suggestInStay(input: CrossSellInput): CrossSellResult {
  const lang = input.lang ?? "vi";
  const limit = input.limit ?? 3;
  const dayPart = dayPartOf(input.clock);
  const phase = phaseOf(input.reservation, input.today);
  const nightsLeft = nightsBetween(input.today, input.reservation.checkOut);
  const wet = isWet(input.weather);
  const booked = new Set(input.alreadyBooked ?? []);
  const interest = (input.interest ?? "").toLowerCase();
  /* Stored as a JSON array of short phrases; a malformed value must not take
     the whole ranking down with it. */
  const prefs: string[] = (() => {
    const raw = input.guest.preferences as unknown;
    if (Array.isArray(raw)) return raw.filter((p): p is string => typeof p === "string");
    if (typeof raw === "string") {
      try {
        const p = JSON.parse(raw);
        return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
      } catch {
        return [];
      }
    }
    return [];
  })();

  const scored: Array<Suggestion & { explicit: boolean }> = [];

  for (const s of input.services) {
    if (!s.active || booked.has(s.id)) continue;
    /* In-room dining is a fulfilment channel, not an experience to be pitched;
       a guest who wants it asks for it. Transport is logistics, offered when
       relevant (departure) rather than sold. */
    if (s.category === "roomservice") continue;

    const slotsAll: string[] = safeSlots(s.slots);
    /**
     * When is this service actually available?
     *
     * The rules below read the service NAME to guess a good time, and a name is
     * not a schedule. "Private beachfront dinner" matched the outdoor rule, drew
     * the morning bonus, and was offered to a guest at nine in the morning with
     * the reason "mornings are the best time for this" — for a dinner whose only
     * slots are 18:00 and later. The published slots settle it; a service with
     * none is treated as available all day, which is what a beach desk is.
     */
    const slotParts = new Set<DayPart>(slotsAll.map(dayPartOf));
    const timely = (part: DayPart) => slotParts.size === 0 || slotParts.has(part);

    let score = 0;
    const reasons: string[] = [];
    /* Did the guest themselves point at this service — by asking now, or by
       writing it on the preferences form? Contextual signals are inferences;
       these two are statements, and they are treated differently below. */
    let explicit = false;
    const text = `${s.name} ${s.description ?? ""}`;

    /* --- what the guest actually asked about outranks everything else --- */
    if (interest) {
      const words = interest.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);
      if (words.some((w) => text.toLowerCase().includes(w))) {
        score += 6;
        explicit = true;
        reasons.push(say(lang, "đúng điều anh/chị đang hỏi", "matches what you asked about"));
      }
    }

    /* --- time of day --- */
    if (DINING.test(text)) {
      if (dayPart === "evening" && DINNER.test(text)) {
        score += 4;
        reasons.push(say(lang, "hợp cho bữa tối nay", "good for dinner tonight"));
      } else if (dayPart === "afternoon" && LUNCH.test(text)) {
        score += 3;
        reasons.push(say(lang, "kịp cho bữa trưa", "in time for lunch"));
      } else if (dayPart === "night") {
        score -= 3; // kitchens are closing
      } else if (LUNCH.test(text) && dayPart === "evening") {
        score -= 4; // lunch buffet in the evening is simply wrong
      }
    }
    if (/spa|massage|therapy|facial/i.test(text) && (dayPart === "afternoon" || dayPart === "evening") && timely(dayPart)) {
      score += 2;
      reasons.push(say(lang, "khung giờ chiều/tối thường dễ đặt", "afternoon and evening slots are easiest to get"));
    }
    if (OUTDOOR.test(text) && dayPart === "morning" && timely("morning")) {
      score += 3;
      reasons.push(say(lang, "buổi sáng là lúc đẹp nhất để đi", "mornings are the best time for this"));
    }
    /* Only penalise the evening for things that cannot BE an evening: a sunset
       dinner on the sand is outdoors and is exactly right at 19:00. */
    if (OUTDOOR.test(text) && (dayPart === "evening" || dayPart === "night") && !timely(dayPart)) score -= 4;

    /**
     * What the guest told us they like, at check-in or on a previous stay.
     *
     * `preferences` was declared on `CrossSellInput` and never read — 21 of 23
     * guests in this database have entries and the ranking could not see any of
     * them. Kim Ji-woo has written down "Aquafield sauna" and was being offered
     * whatever the weather suggested instead.
     *
     * Scored just under an explicit in-conversation request (+6) and above every
     * contextual signal: a stated preference is weaker evidence than "I want
     * this now", and stronger than an inference from the clock. Matched on
     * whole words so "spa" does not match inside "space".
     */
    for (const pref of prefs) {
      const words = pref.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);
      if (!words.length) continue;
      if (!words.some((w) => new RegExp(`\\b${escapeRe(w)}\\b`, "iu").test(text))) continue;
      score += 5;
      explicit = true;
      reasons.push(
        say(lang, `anh/chị có ghi chú thích "${pref}"`, `you told us you like "${pref}"`),
      );
      break; // one preference reason is enough; two reads like a dossier
    }

    /* --- weather --- */
    if (wet && INDOOR.test(text)) {
      score += 4;
      reasons.push(say(lang, "trời có mưa nên hoạt động trong nhà sẽ thoải mái hơn", "rain is forecast, so an indoor option is more comfortable"));
    }
    if (wet && OUTDOOR.test(text)) score -= 5;
    if (!wet && OUTDOOR.test(text)) {
      score += 1;
      reasons.push(say(lang, "thời tiết đang thuận", "the weather suits it"));
    }

    /* --- how much of the stay is left --- */
    if (/2-day|2 ngày|2-ngày/i.test(text)) {
      /* A two-day pass a guest cannot finish is money taken for nothing. */
      if (nightsLeft < 2) {
        continue;
      }
      score += 2;
      reasons.push(say(lang, "anh/chị còn đủ ngày để dùng hết vé", "you have enough nights left to use it fully"));
    }
    if (phase === "departure_day" && !/cable car|cáp treo|transfer|buggy/i.test(text)) {
      /* On the way out, only quick or logistical things are realistic. */
      score -= 3;
    }
    if (phase === "arrival_day" && /spa|massage/i.test(text)) {
      score += 1;
      reasons.push(say(lang, "thư giãn sau chặng đường dài", "a good way to unwind after the journey"));
    }

    /* --- who the guest is --- */
    if (s.category === "spa" && ["gold", "platinum", "diamond"].includes(input.guest.vipTier)) {
      score += 2;
      reasons.push(say(lang, "hạng thẻ của anh/chị có ưu đãi spa", "your membership tier includes a spa benefit"));
    }
    if ((input.guest.staysCount ?? 0) > 1 && /private|riêng|beachfront/i.test(text)) {
      score += 1;
      reasons.push(say(lang, "trải nghiệm riêng tư, khác với lần trước", "something more private than the usual"));
    }

    if (score <= 0) continue;

    /* Only slots still ahead of us today are worth naming. */
    const upcoming = slotsAll.filter((t) => t > input.clock);

    scored.push({
      explicit,
      service_id: s.id,
      name: s.name,
      category: s.category,
      price: s.price,
      unit: s.unit,
      why: reasons.slice(0, 2).join("; "),
      slots: upcoming.length ? upcoming : slotsAll,
      score,
    });
  }

  /**
   * Explicit first, then score.
   *
   * Score alone was not enough once preferences were wired in. Kim Ji-woo has
   * "Aquafield sauna" on file; on a clear morning the VinWonders pass collects
   * +3 for the hour and +1 for the weather and +2 for the length of the stay,
   * out-scoring the +5 the sauna gets for being the thing she actually asked
   * for — and because both are category "experience", the one-per-category rule
   * below then dropped the sauna from the list entirely rather than ranking it
   * second. Stacked inferences were quietly outvoting a statement.
   *
   * Sorting explicit matches first fixes it at the source: the guest's own
   * words take the category slot, and the inferred option is the one that
   * yields.
   */
  scored.sort((a, b) => Number(b.explicit) - Number(a.explicit) || b.score - a.score || a.price - b.price);

  /* One suggestion per category: three spa treatments is a menu, not advice. */
  const perCategory = new Set<string>();
  const suggestions: Suggestion[] = [];
  for (const s of scored) {
    if (perCategory.has(s.category)) continue;
    perCategory.add(s.category);
    const { explicit: _explicit, ...rest } = s;
    suggestions.push(rest);
    if (suggestions.length >= limit) break;
  }

  const offers = eligibleOffers(input.offers, input.guest, phase);

  return {
    phase,
    day_part: dayPart,
    nights_left: nightsLeft,
    suggestions,
    offers,
    note: say(
      lang,
      `Khách ĐANG lưu trú (${phase === "departure_day" ? "hôm nay trả phòng" : phase === "arrival_day" ? "hôm nay nhận phòng" : `còn ${nightsLeft} đêm`}), hiện là buổi ${viDayPart(dayPart)}${wet ? ", trời có thể mưa" : ""}. Gợi ý TỐI ĐA 2-3 lựa chọn bằng giọng tự nhiên và LUÔN nói lý do trong 'why' — đừng đọc như thực đơn. Giá phải lấy từ list_services hoặc book_service, KHÔNG tự tính. Nếu khách không quan tâm thì dừng, không nài.`,
      `The guest is IN-HOUSE (${phase === "departure_day" ? "departing today" : phase === "arrival_day" ? "arriving today" : `${nightsLeft} nights left`}), it is ${dayPart}${wet ? ", and rain is likely" : ""}. Offer AT MOST 2-3 options in natural language and always give the reason in 'why' — do not read a menu. Prices must come from list_services or book_service, never computed. If they are not interested, drop it.`,
    ),
  };
}

function viDayPart(d: DayPart): string {
  return d === "morning" ? "sáng" : d === "afternoon" ? "chiều" : d === "evening" ? "tối" : "khuya";
}

function safeSlots(json: string | null): string[] {
  try {
    const v = JSON.parse(json || "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** Offers whose segment matches this guest and this point in their stay. */
export function eligibleOffers(
  offers: Offer[],
  guest: Pick<Guest, "vipTier" | "staysCount">,
  phase: StayPhase,
): Array<{ title: string; detail: string; price: number | null }> {
  return offers
    .filter((o) => {
      if (!o.active) return false;
      if (o.segment === "all") return true;
      if (o.segment === "in_house") return phase !== "departure_day";
      if (o.segment === "departing") return phase === "departure_day";
      if (o.segment === "vip") return ["gold", "platinum", "diamond"].includes(guest.vipTier);
      if (o.segment === "repeat") return (guest.staysCount ?? 0) > 1;
      return false;
    })
    .map((o) => ({ title: o.title, detail: o.body, price: o.price ?? null }));
}

/* ------------------------------------------------- pre-arrival outreach */

export type PreArrivalTarget = {
  reservationId: number;
  confirmationCode: string;
  guestName: string;
  guestLang: string;
  checkIn: string;
  /** Whole days from today until arrival. */
  daysUntilArrival: number;
  nights: number;
  vipTier: string;
  /** Why this reservation is worth contacting now. */
  angle: string;
};

/**
 * Reservations sitting in the pre-arrival conversion window.
 *
 * Industry practice puts the sweet spot at 48–72 hours before arrival: the guest
 * is still planning, has not committed their days, and an offer lands as help
 * rather than as an interruption. Earlier is forgotten; later is intrusive.
 *
 * This only SELECTS and explains. It sends nothing — reaching out to a guest is
 * an outbound message, and that stays a decision a human makes.
 */
export function preArrivalTargets(
  reservations: Array<Reservation & { guestName?: string; guestLang?: string; vipTier?: string }>,
  today: string,
  opts: { minDays?: number; maxDays?: number; lang?: "vi" | "en" } = {},
): PreArrivalTarget[] {
  const minDays = opts.minDays ?? 2;
  const maxDays = opts.maxDays ?? 3;
  const lang = opts.lang ?? "vi";

  const out: PreArrivalTarget[] = [];
  for (const r of reservations) {
    if (r.status !== "confirmed") continue;
    const days = nightsBetween(today, r.checkIn);
    if (days < minDays || days > maxDays) continue;
    const nights = nightsBetween(r.checkIn, r.checkOut);

    /* The angle is what makes the message worth sending. Ordered by how much it
       is worth to the property and how welcome it tends to be. */
    let angle: string;
    if (nights >= 3) {
      angle = say(lang, "lưu trú dài — hợp gợi ý vé VinWonders không giới hạn hoặc gói trọn bữa", "long stay — a good fit for an unlimited VinWonders pass or full board");
    } else if (["gold", "platinum", "diamond"].includes(r.vipTier ?? "")) {
      angle = say(lang, "hội viên hạng cao — nhắc ưu đãi spa và nâng hạng phòng", "high tier member — remind them of the spa benefit and a room upgrade");
    } else if ((r.adults ?? 0) + (r.children ?? 0) >= 3) {
      angle = say(lang, "đi đông người — hợp gói ăn và vé công viên cho cả nhà", "larger party — suits a meal package and family park tickets");
    } else {
      angle = say(lang, "sắp đến — xác nhận giờ đến và mời đặt trước spa/nhà hàng", "arriving soon — confirm arrival time and invite them to pre-book spa or dining");
    }

    out.push({
      reservationId: r.id,
      confirmationCode: r.confirmationCode,
      guestName: r.guestName ?? "",
      guestLang: r.guestLang ?? "en",
      checkIn: r.checkIn,
      daysUntilArrival: days,
      nights,
      vipTier: r.vipTier ?? "none",
      angle,
    });
  }
  return out.sort((a, b) => a.daysUntilArrival - b.daysUntilArrival || b.nights - a.nights);
}

/* ------------------------------------------------------------ when to stay quiet */

/**
 * Should the concierge offer anything at all on this turn?
 *
 * The ranking above answers "what is worth suggesting". This answers the
 * question that comes first and was enforced NOWHERE until now: whether this is
 * a moment to be selling. `suggest_experiences` is a tool, so the model decided
 * entirely on its own when to call it — which means a guest who had just
 * complained, or whose message tripped a guard flag, could be answered with a
 * spa offer. Nothing in the codebase prevented it.
 *
 * Kept pure and separate from the tool body so it can be tested without a
 * database, a model, or a conversation.
 *
 * NOT ported from the earlier offline design: a language check. That design
 * templated the offer sentence, so a language with no template had to mean no
 * offer. Here the hosted model writes the sentence in whatever language the
 * guest is using, and the `why` strings are hints for it to rewrite rather than
 * text shown to anyone. Gating on language would refuse to sell to a Korean
 * guest for a reason that no longer exists.
 */
export type UpsellGate = {
  /** This turn handed off to a person, or a person has already taken over. */
  escalated: boolean;
  /** Any guard flag at all was raised on the guest's message. */
  flagged: boolean;
  /** The conversation's sentiment label, or null if nobody has judged it. */
  sentiment: string | null;
  /** Guest turns since the last suggestion was shown; null if never shown. */
  turnsSinceLast: number | null;
  stayPhase: StayPhase;
  dayPart: DayPart;
};

/**
 * Turns a guest must speak after being offered something before being offered
 * again. Asking twice in a row is the single most common way an assistant
 * reads as a salesman rather than a concierge.
 */
export const UPSELL_COOLDOWN_TURNS = 4;

export function upsellAllowed(g: UpsellGate): { ok: boolean; reason: string } {
  /* Order matters only for which reason gets reported; all are disqualifying.
     The people-first ones come first so the logged reason names the real cause
     rather than a coincidental second condition. */

  /* A turn that went to a human is a turn where the guest needed something the
     assistant could not give. Selling on top of that is the worst possible
     read of the room. */
  if (g.escalated) return { ok: false, reason: "escalated" };

  /* Any flag — medical, safety, prohibited, injection, billing dispute, or a
     plain request for a human. Deliberately ANY rather than a chosen subset:
     the cost of staying quiet is one missed suggestion, and the cost of a
     wrong call here is a guest being sold a massage mid-emergency. If a
     specific flag ever needs to be exempted, exempt it explicitly. */
  if (g.flagged) return { ok: false, reason: "guard_flag" };

  /* Honoured whatever its source, including `seed`. A seeded label is dice
     rather than a verdict, but silence is the cheap failure here and a
     mistaken offer to an angry guest is the expensive one. */
  if (g.sentiment === "negative") return { ok: false, reason: "guest_unhappy" };

  /* Someone packing to leave does not want to hear about a two-hour spa. */
  if (g.stayPhase === "departure_day") return { ok: false, reason: "departure_day" };

  /* Nothing on this list can actually be delivered at 02:00, and the message
     arrives on a phone that may be on a bedside table. */
  if (g.dayPart === "night") return { ok: false, reason: "night" };

  if (g.turnsSinceLast !== null && g.turnsSinceLast < UPSELL_COOLDOWN_TURNS)
    return { ok: false, reason: "cooldown" };

  return { ok: true, reason: "ok" };
}
