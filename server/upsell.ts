/**
 * Package recommendation and upselling.
 *
 * Three guest situations, one engine:
 *
 *   1. Specific  — "I want a Deluxe."      → quote the CHEAPEST package for that
 *                                            category, then offer the ladder above it.
 *   2. Budgeted  — "I have 5 million."     → every package at or under the ceiling,
 *                                            best value first.
 *   3. Vague     — "I want to book a room" → too little to answer; return the
 *                                            preference facets to ask about instead
 *                                            of guessing.
 *
 * WHY THIS IS CODE AND NOT A PROMPT
 * Quoting the cheapest option, ranking an upsell ladder and filtering on a budget
 * are arithmetic over a rate card. Left to the model they become plausible-looking
 * invented prices — the exact failure numguard exists to catch. Here every figure
 * returned is a value read from a row, and the model's job is only to narrate it.
 *
 * The returned shapes are deliberately UI-ready: `clarify` carries the facet
 * chips a kiosk renders as tappable options, and `upsells` carries the
 * "+900.000 ₫ adds unlimited VinWonders" deltas a "see better packages" button
 * needs. The same JSON serves a text-only channel, which just reads it aloud.
 */

import type { RoomPackageRow } from "@shared/schema";

/* ------------------------------------------------------------------ facets */

/** One thing a guest can ask for, as a tappable chip. */
export type FacetKey =
  | "breakfast"
  | "full_board"
  | "vinwonders"
  | "golf"
  | "hotel_credit"
  | "spa"
  | "sauna"
  | "cable_car"
  | "pool"
  | "ocean_view"
  | "family_4";

export type FacetDef = {
  key: FacetKey;
  vi: string;
  en: string;
  /** Does a package satisfy this preference? Room-level facets get the room row. */
  matches: (p: RoomPackageRow, room?: RoomContext) => boolean;
};

/** What the engine knows about the room a package belongs to. */
export type RoomContext = {
  code: string;
  nameVi: string;
  maxGuests: number | null;
  privatePool: boolean;
  oceanView: boolean;
  areaSqm: number | null;
};

/**
 * The chips offered when a guest has not said enough. Ordered by how often a real
 * guest cares — meals and the theme park drive most upgrades at this property.
 */
export const FACETS: FacetDef[] = [
  { key: "breakfast", vi: "Có bữa sáng", en: "Breakfast included", matches: (p) => p.mealPlan !== "none" },
  { key: "full_board", vi: "Ăn cả 3 bữa (buffet)", en: "Full board buffet", matches: (p) => p.mealPlan === "full_board" },
  { key: "vinwonders", vi: "Vé VinWonders không giới hạn", en: "Unlimited VinWonders", matches: (p) => p.vinwonders === 1 },
  { key: "golf", vi: "Chơi golf", en: "Golf included", matches: (p) => p.golfRounds > 0 },
  { key: "hotel_credit", vi: "Có hotel credit", en: "Hotel credit", matches: (p) => p.hotelCredit > 0 },
  { key: "spa", vi: "Ưu đãi spa", en: "Spa benefit", matches: (p) => p.spaDiscountPct > 0 || p.aquafield === 1 },
  { key: "sauna", vi: "Xông hơi / jacuzzi", en: "Sauna & jacuzzi", matches: (p) => p.saunaJacuzzi === 1 || p.aquafield === 1 },
  { key: "cable_car", vi: "Miễn phí cáp treo", en: "Free cable car", matches: (p) => p.cableCar === 1 },
  { key: "pool", vi: "Bể bơi riêng", en: "Private pool", matches: (_p, r) => !!r?.privatePool },
  { key: "ocean_view", vi: "Hướng biển", en: "Ocean view", matches: (_p, r) => !!r?.oceanView },
  { key: "family_4", vi: "Ở được 4 người trở lên", en: "Fits 4+ guests", matches: (_p, r) => (r?.maxGuests ?? 0) >= 4 },
];

const FACET_BY_KEY = new Map(FACETS.map((f) => [f.key, f]));

/* ------------------------------------------------------------- travellers */

/**
 * Who is travelling, and what that implies about which package suits them.
 *
 * This is the difference between a chatbot that reads a rate card and a
 * concierge who reads the guest. A golfer does not want the buffet upgrade; a
 * family with children wants meals and the theme park; a couple responds to
 * credit and the spa. Encoding it here — rather than hoping the model infers it
 * — makes the recommendation reproducible and testable, and keeps the reasoning
 * visible to whoever tunes it later.
 *
 * These are SOFT preferences: they rank, they do not filter. A traveller hint
 * must never hide a package the guest could otherwise have booked, because a
 * guess about who someone is should not cost them an option.
 */
export type TravellerType =
  | "golf"
  | "family"
  | "couple"
  | "wellness"
  | "business"
  /* Celebrations. Front-desk practice treats "we're on our honeymoon" as the
     single strongest upsell signal there is — but the value comes from the
     acknowledgement, not the sell. These types rank romantic inclusions AND tell
     the agent to congratulate the guest first; an upgrade pitched before a
     "chúc mừng" reads as opportunism. */
  | "honeymoon"
  | "anniversary"
  | "birthday";

export const TRAVELLER_PREFS: Record<TravellerType, { vi: string; en: string; prefer: FacetKey[]; celebration?: boolean }> = {
  golf: { vi: "khách chơi golf", en: "golfer", prefer: ["golf"] },
  family: { vi: "gia đình có trẻ nhỏ", en: "family with children", prefer: ["full_board", "vinwonders", "family_4", "cable_car"] },
  couple: { vi: "cặp đôi nghỉ dưỡng", en: "couple on a getaway", prefer: ["hotel_credit", "sauna", "spa", "ocean_view"] },
  wellness: { vi: "khách nghỉ dưỡng, chăm sóc sức khoẻ", en: "wellness guest", prefer: ["spa", "sauna", "hotel_credit"] },
  business: { vi: "khách công tác", en: "business traveller", prefer: ["breakfast"] },
  honeymoon: { vi: "cặp đôi hưởng tuần trăng mật", en: "honeymooners", prefer: ["ocean_view", "spa", "sauna", "hotel_credit"], celebration: true },
  anniversary: { vi: "kỷ niệm ngày cưới", en: "wedding anniversary", prefer: ["ocean_view", "spa", "hotel_credit", "sauna"], celebration: true },
  birthday: { vi: "sinh nhật", en: "birthday", prefer: ["hotel_credit", "full_board", "spa"], celebration: true },
};

/** How well a package suits a traveller type: the count of matched preferences. */
export function affinityScore(p: RoomPackageRow, traveller: TravellerType | undefined, room?: RoomContext): number {
  if (!traveller) return 0;
  const prefs = TRAVELLER_PREFS[traveller].prefer;
  let score = 0;
  for (const key of prefs) {
    const f = FACET_BY_KEY.get(key);
    if (f?.matches(p, room)) score++;
  }
  return score;
}

export function facetChips(lang: "vi" | "en" = "vi") {
  return FACETS.map((f) => ({ key: f.key, label: lang === "vi" ? f.vi : f.en }));
}

/* ---------------------------------------------------------------- matching */

/** Fold Vietnamese diacritics so "hướng biển" matches "huong bien". */
function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .trim();
}

/**
 * Which room categories did the guest mean?
 *
 * Deliberately loose: "deluxe" legitimately means all six Deluxe/Grand Deluxe
 * variants, and narrowing that to one row would quote a price for a bed type the
 * guest never chose. An empty query matches everything, which is what makes the
 * vague path fall through to clarification rather than to a guess.
 */
export function matchRooms(query: string, rooms: RoomContext[]): RoomContext[] {
  const q = fold(query);
  if (!q) return rooms;
  const terms = q.split(/\s+/).filter((t) => t.length > 1);
  if (!terms.length) return rooms;
  const scored = rooms
    .map((r) => {
      const hay = `${fold(r.nameVi)} ${fold(r.code)}`;
      const hits = terms.filter((t) => hay.includes(t)).length;
      return { r, hits };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits);
  if (!scored.length) return [];
  const best = scored[0].hits;
  return scored.filter((x) => x.hits === best).map((x) => x.r);
}

/* ------------------------------------------------------------ presentation */

/** A short, human list of what a package includes — for the reply and the chip UI. */
export function summarise(p: RoomPackageRow, lang: "vi" | "en" = "vi"): string[] {
  const out: string[] = [];
  if (p.mealPlan === "full_board") out.push(lang === "vi" ? "Buffet sáng + trưa + tối" : "Full board (breakfast, lunch, dinner)");
  else if (p.mealPlan === "breakfast") out.push(lang === "vi" ? "Bữa sáng buffet" : "Buffet breakfast");
  if (p.vinwonders) out.push(lang === "vi" ? "Vé VinWonders không giới hạn" : "Unlimited VinWonders tickets");
  if (p.golfRounds > 0)
    out.push(lang === "vi" ? `${p.golfRounds} vòng golf 18 hố` : `${p.golfRounds} rounds of 18-hole golf`);
  if (p.hotelCredit > 0)
    out.push(
      lang === "vi"
        ? `Hotel credit ${p.hotelCredit.toLocaleString("vi-VN")}đ/đêm`
        : `Hotel credit ${p.hotelCredit.toLocaleString("en-US")} VND/night`,
    );
  if (p.aquafield) out.push(lang === "vi" ? "Miễn phí Aquafield" : "Free Aquafield experience");
  if (p.saunaJacuzzi) out.push(lang === "vi" ? "Xông hơi & jacuzzi" : "Sauna & jacuzzi");
  if (p.cableCar) out.push(lang === "vi" ? "Miễn phí cáp treo" : "Free cable car");
  const d: string[] = [];
  if (p.spaDiscountPct) d.push(`spa ${p.spaDiscountPct}%`);
  if (p.fnbDiscountPct) d.push(lang === "vi" ? `ẩm thực ${p.fnbDiscountPct}%` : `dining ${p.fnbDiscountPct}%`);
  if (p.golfDiscountPct) d.push(`golf ${p.golfDiscountPct}%`);
  if (d.length) out.push(lang === "vi" ? `Giảm ${d.join(", ")}` : `Discounts: ${d.join(", ")}`);
  return out;
}

/**
 * What the extra money buys, comparing an upgrade against the package being
 * quoted. Only genuine additions are listed — an upsell that cannot say what it
 * adds is just a more expensive room, and guests notice.
 */
export function upgradeDelta(base: RoomPackageRow, up: RoomPackageRow, lang: "vi" | "en" = "vi"): string[] {
  const adds: string[] = [];
  const rank = { none: 0, breakfast: 1, full_board: 2 } as Record<string, number>;
  if (rank[up.mealPlan] > rank[base.mealPlan])
    adds.push(up.mealPlan === "full_board" ? (lang === "vi" ? "thêm bữa trưa & tối" : "adds lunch & dinner") : lang === "vi" ? "thêm bữa sáng" : "adds breakfast");
  if (up.vinwonders && !base.vinwonders) adds.push(lang === "vi" ? "thêm vé VinWonders không giới hạn" : "adds unlimited VinWonders");
  if (up.golfRounds > base.golfRounds) adds.push(lang === "vi" ? `thêm ${up.golfRounds} vòng golf` : `adds ${up.golfRounds} golf rounds`);
  if (up.hotelCredit > base.hotelCredit)
    adds.push(lang === "vi" ? `thêm hotel credit ${up.hotelCredit.toLocaleString("vi-VN")}đ/đêm` : `adds ${up.hotelCredit.toLocaleString("en-US")} VND credit/night`);
  if (up.saunaJacuzzi && !base.saunaJacuzzi) adds.push(lang === "vi" ? "thêm xông hơi & jacuzzi" : "adds sauna & jacuzzi");
  if (up.cableCar && !base.cableCar) adds.push(lang === "vi" ? "thêm miễn phí cáp treo" : "adds free cable car");
  if (up.aquafield && !base.aquafield) adds.push(lang === "vi" ? "thêm Aquafield" : "adds Aquafield");
  return adds;
}

/* ------------------------------------------------------------- comparison */

export type RoomComparison = {
  room_code: string;
  room_name: string;
  area_sqm: number | null;
  max_guests: number | null;
  ocean_view: boolean;
  private_pool: boolean;
  /** Cheapest package for this category — the fair basis for comparing prices. */
  from_price: number | null;
  from_member_price: number | null;
  package_count: number;
  /** What this category has that the others being compared do not. */
  unique: string[];
};

/**
 * Compare room categories side by side.
 *
 * "What's the difference between a Deluxe and a Grand Deluxe?" is one of the
 * commonest questions at any front desk, and the honest answer is a table, not a
 * paragraph. Prices are compared FROM the cheapest package of each category —
 * comparing a category's breakfast rate against another's full-board rate would
 * make one look expensive for a reason that has nothing to do with the room.
 */
export function compareRooms(
  packages: RoomPackageRow[],
  rooms: RoomContext[],
  query: string,
  lang: "vi" | "en" = "vi",
): { rooms: RoomComparison[]; note: string } {
  /* Each distinct term the guest used selects its own category, so "deluxe với
     grand deluxe" compares two things rather than collapsing to one match. */
  const parts = query
    .split(/\s+(?:và|vs|với|hay|or|and|so với)\s+|,/i)
    .map((s) => s.trim())
    .filter(Boolean);
  const picked: RoomContext[] = [];
  for (const part of parts.length > 1 ? parts : [query]) {
    for (const r of matchRooms(part, rooms)) {
      if (!picked.some((p) => p.code === r.code)) picked.push(r);
    }
  }
  const chosen = picked.length ? picked : rooms;

  const rows: RoomComparison[] = chosen.map((r) => {
    const own = packages.filter((p) => p.roomCode === r.code).sort((a, b) => a.publicPrice - b.publicPrice);
    return {
      room_code: r.code,
      room_name: r.nameVi,
      area_sqm: r.areaSqm,
      max_guests: r.maxGuests,
      ocean_view: r.oceanView,
      private_pool: r.privatePool,
      from_price: own[0]?.publicPrice ?? null,
      from_member_price: own[0]?.memberPrice ?? null,
      package_count: own.length,
      unique: [],
    };
  });

  /* A feature is worth naming only when it actually separates the options: if
     every category on the table has an ocean view, saying so distinguishes
     nothing and just makes the table longer. */
  const say = (vi: string, en: string) => (lang === "vi" ? vi : en);
  for (const row of rows) {
    const others = rows.filter((o) => o.room_code !== row.room_code);
    if (row.ocean_view && others.some((o) => !o.ocean_view)) row.unique.push(say("hướng biển", "ocean view"));
    if (row.private_pool && others.some((o) => !o.private_pool)) row.unique.push(say("bể bơi riêng", "private pool"));
    if (row.area_sqm != null && others.some((o) => o.area_sqm != null && o.area_sqm < row.area_sqm!))
      row.unique.push(say(`rộng hơn (${row.area_sqm} m²)`, `larger (${row.area_sqm} m²)`));
    if (row.max_guests != null && others.some((o) => o.max_guests != null && o.max_guests < row.max_guests!))
      row.unique.push(say(`ở được nhiều người hơn (${row.max_guests})`, `sleeps more (${row.max_guests})`));
  }

  rows.sort((a, b) => (a.from_price ?? Infinity) - (b.from_price ?? Infinity));

  return {
    rooms: rows,
    note:
      lang === "vi"
        ? "So sánh giúp khách bằng lời tự nhiên: nêu ĐIỂM KHÁC BIỆT thật sự (trong 'unique') và giá khởi điểm (from_price) của từng hạng, đọc đúng con số. Gợi ý hạng phù hợp với nhu cầu khách đã nói, KHÔNG mặc định đẩy hạng đắt nhất."
        : "Compare in natural language: name the real differences (in 'unique') and each category's starting price (from_price), verbatim. Recommend the one that fits what the guest said they need — do not default to the most expensive.",
  };
}

/* -------------------------------------------------------------- the engine */

export type PackageView = {
  room_code: string;
  room_name: string;
  package_name: string;
  public_price: number;
  member_price: number | null;
  includes: string[];
  /** Only present on upsell entries: the extra cost and what it buys. */
  extra_cost?: number;
  adds?: string[];
  /** True when this rung matches the traveller type the guest revealed. */
  suits_traveller?: boolean;
  /** Date-bound text the agent must quote verbatim, never recompute. */
  conditions: string[];
  has_blackout: boolean;
};

export type Recommendation = {
  /** "quote" = we have a concrete answer; "clarify" = not enough information. */
  mode: "quote" | "clarify" | "empty";
  /** The cheapest qualifying package — what to quote first. */
  base?: PackageView;
  /** The ladder above `base`, each with what the extra money adds. */
  upsells: PackageView[];
  /**
   * Cheaper options than `base`, with what they give up. Populated when the
   * guest pushed back on price: a concierge answering "that's too expensive"
   * with only the same figure repeated has stopped being useful, and the honest
   * move is to show what costs less and say plainly what it drops.
   */
  cheaper: PackageView[];
  /** Set when the guest is celebrating: the agent must acknowledge it first. */
  celebration?: string;
  /** Facet chips to offer when the request was too vague, or to refine further. */
  clarify: Array<{ key: string; label: string }>;
  /** Plain-language note for the agent about what was and was not applied. */
  note: string;
  matched_rooms: string[];
};

export type RecommendInput = {
  /** The guest's words for the room, e.g. "deluxe", "villa", "" when unspecified. */
  roomQuery?: string;
  /** Nightly ceiling in VND. */
  maxPrice?: number;
  /** Facet keys the guest asked for. */
  mustHave?: string[];
  /** Party size, when known. */
  guests?: number;
  /** Who is travelling — ranks the ladder, never filters it. */
  traveller?: TravellerType;
  /** The guest said the price is too high: return cheaper options too. */
  tooExpensive?: boolean;
  lang?: "vi" | "en";
  /** How many upsell rungs to return. */
  limit?: number;
};

const view = (p: RoomPackageRow, lang: "vi" | "en"): PackageView => ({
  room_code: p.roomCode,
  room_name: p.roomNameVi,
  package_name: p.name,
  public_price: p.publicPrice,
  member_price: p.memberPrice,
  includes: summarise(p, lang),
  conditions: safeArr(p.conditions),
  has_blackout: p.hasBlackout === 1,
});

function safeArr(json: string): string[] {
  try {
    const v = JSON.parse(json || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * Rank and filter the rate card for one guest request.
 *
 * Pure: it takes the packages and rooms it is given, so the same inputs always
 * produce the same recommendation, and the tests can pin the upsell ladder
 * without a database or a model.
 */
export function recommend(
  packages: RoomPackageRow[],
  rooms: RoomContext[],
  input: RecommendInput,
): Recommendation {
  const lang = input.lang ?? "vi";
  const limit = input.limit ?? 3;
  const roomByCode = new Map(rooms.map((r) => [r.code, r]));

  const matched = matchRooms(input.roomQuery ?? "", rooms);
  const matchedCodes = new Set(matched.map((r) => r.code));

  const wanted = (input.mustHave ?? []).map((k) => FACET_BY_KEY.get(k as FacetKey)).filter(Boolean) as FacetDef[];
  const unknownFacets = (input.mustHave ?? []).filter((k) => !FACET_BY_KEY.has(k as FacetKey));

  let pool = packages.filter((p) => matchedCodes.has(p.roomCode));
  if (input.guests != null) {
    pool = pool.filter((p) => (roomByCode.get(p.roomCode)?.maxGuests ?? 99) >= input.guests!);
  }
  for (const f of wanted) {
    pool = pool.filter((p) => f.matches(p, roomByCode.get(p.roomCode)));
  }
  const overBudget = input.maxPrice != null ? pool.filter((p) => p.publicPrice > input.maxPrice!) : [];
  if (input.maxPrice != null) pool = pool.filter((p) => p.publicPrice <= input.maxPrice!);

  pool = [...pool].sort((a, b) => a.publicPrice - b.publicPrice);

  /* Nothing survived the filters. Say so and offer the chips again rather than
     quietly relaxing a constraint the guest actually stated. */
  if (!pool.length) {
    const cheapestOver = [...overBudget].sort((a, b) => a.publicPrice - b.publicPrice)[0];
    const budgetPart = input.maxPrice ? ` trong ngân sách ${input.maxPrice.toLocaleString("vi-VN")}đ/đêm` : "";
    const overPart = cheapestOver
      ? ` Gói rẻ nhất vượt ngân sách là ${cheapestOver.roomNameVi} — ${cheapestOver.name}, ${cheapestOver.publicPrice.toLocaleString("vi-VN")}đ/đêm.`
      : "";

    /* Which single criterion is doing the blocking? Re-run the filter with each
       requested facet dropped in turn: telling the guest "no package has both
       full board and golf" is actionable, where "nothing matched" is not. */
    const blocking: string[] = [];
    for (const f of wanted) {
      const others = wanted.filter((x) => x !== f);
      let test = packages.filter((p) => matchedCodes.has(p.roomCode));
      if (input.guests != null) test = test.filter((p) => (roomByCode.get(p.roomCode)?.maxGuests ?? 99) >= input.guests!);
      if (input.maxPrice != null) test = test.filter((p) => p.publicPrice <= input.maxPrice!);
      for (const o of others) test = test.filter((p) => o.matches(p, roomByCode.get(p.roomCode)));
      if (test.length) blocking.push(lang === "vi" ? f.vi : f.en);
    }
    const blockPart = blocking.length
      ? ` Tiêu chí đang loại hết lựa chọn: ${blocking.join(" + ")} — không có gói nào đáp ứng đồng thời. Hỏi khách muốn bỏ tiêu chí nào.`
      : " Hỏi khách nới tiêu chí hoặc ngân sách.";
    const ignoredPart = unknownFacets.length ? ` (Bỏ qua tiêu chí không nhận dạng: ${unknownFacets.join(", ")}.)` : "";
    return {
      mode: "empty",
      upsells: [],
      cheaper: [],
      clarify: wanted.length ? wanted.map((f) => ({ key: f.key, label: lang === "vi" ? f.vi : f.en })) : facetChips(lang),
      note: `Không có gói nào khớp yêu cầu${budgetPart}.${overPart}${blockPart}${ignoredPart} KHÔNG được tự bỏ tiêu chí của khách.`,
      matched_rooms: matched.map((r) => r.nameVi),
    };
  }

  /* The guest gave nothing to go on. Quoting the cheapest room in the resort here
     would be a guess dressed as an answer, so ask — with tappable chips. */
  const vague = !input.roomQuery?.trim() && input.maxPrice == null && !wanted.length && input.guests == null;
  if (vague) {
    return {
      mode: "clarify",
      upsells: [],
      cheaper: [],
      clarify: facetChips(lang),
      note:
        lang === "vi"
          ? "Khách chưa nói rõ nhu cầu. Hỏi ngắn gọn (số khách, ngân sách, hoặc điều họ quan tâm) và mời khách chọn trong danh sách clarify. KHÔNG tự chọn phòng giúp khách."
          : "The guest has not said enough. Ask briefly (party size, budget, or what matters to them) and offer the clarify chips. Do NOT pick a room for them.",
      matched_rooms: [],
    };
  }

  const base = pool[0];
  const baseRoom = base.roomCode;

  /* The ladder: only rungs that genuinely add something.
     When the guest named a category, its own packages come first — "Deluxe"
     should be upsold within Deluxe, not jumped straight into a villa. When they
     named no category (a pure budget question), rank by price instead, because
     the cheapest genuine upgrade is the useful next suggestion whatever room it
     belongs to. */
  const namedRoom = Boolean(input.roomQuery?.trim());
  const rest = pool.filter((p) => p.id !== base.id);
  const ordered = namedRoom
    ? [...rest.filter((p) => p.roomCode === baseRoom), ...rest.filter((p) => p.roomCode !== baseRoom)]
    : rest;
  const candidates = ordered
    .map((p) => ({ p, adds: upgradeDelta(base, p, lang) }))
    .filter((x) => x.adds.length > 0 && x.p.publicPrice > base.publicPrice);

  /* When we know who is travelling, surface the rungs that actually suit them
     first — a golfer should see the golf package before the buffet upgrade.
     Affinity only re-orders; nothing is removed, and equal-affinity rungs keep
     their cheapest-first order so the ladder still reads as a ladder. */
  if (input.traveller) {
    const sameAsBase = (p: RoomPackageRow) => (p.roomCode === baseRoom ? 0 : 1);
    candidates.sort(
      (a, b) =>
        affinityScore(b.p, input.traveller, roomByCode.get(b.p.roomCode)) -
          affinityScore(a.p, input.traveller, roomByCode.get(a.p.roomCode)) ||
        /* Within equal affinity, stay in the room the guest is being quoted.
           Without this the traveller sort re-mixed categories and the ladder
           showed the same upgrade twice at two different room prices. */
        sameAsBase(a.p) - sameAsBase(b.p) ||
        a.p.publicPrice - b.p.publicPrice,
    );
  }

  /* Several room categories are sold at the same price with the same package
     (a twin and a queen of the same class), so an un-deduplicated ladder offers
     the guest the identical upgrade twice and reads like a glitch. Collapse by
     what the guest actually sees — price plus what it adds — keeping the first,
     which is the best-ranked one. */
  const ladderSeen = new Set<string>();
  const ladder: PackageView[] = [];
  for (const { p, adds } of candidates) {
    const sig = `${p.publicPrice}|${adds.join(",")}`;
    if (ladderSeen.has(sig)) continue;
    ladderSeen.add(sig);
    ladder.push({
      ...view(p, lang),
      extra_cost: Math.round(p.publicPrice - base.publicPrice),
      adds,
      suits_traveller: input.traveller ? affinityScore(p, input.traveller, roomByCode.get(p.roomCode)) > 0 : undefined,
    });
    if (ladder.length >= limit) break;
  }

  /* Price pushback. `base` is already the cheapest thing that met every stated
     criterion, so anything cheaper must drop one — the honest answer names what.
     Searched across all packages, not just the filtered pool, because the guest
     has implicitly reopened their own constraints by saying it costs too much. */
  const cheaper: PackageView[] = [];
  if (input.tooExpensive) {
    const cheaperSeen = new Set<string>();
    const baseCtx = roomByCode.get(baseRoom);
    /* Searched across the WHOLE rate card, not just the categories the guest
       named: someone told a villa is too expensive needs to hear about a Grand
       Deluxe, and staying inside their original category would return nothing at
       all — which is how "too expensive" ends a conversation instead of saving it. */
    const belowBase = packages
      .filter((p) => p.publicPrice < base.publicPrice)
      .sort((a, b) => b.publicPrice - a.publicPrice); // closest below first
    for (const p of belowBase) {
      const ctx = roomByCode.get(p.roomCode);
      /* Room-level losses matter more than package ones when the guest is being
         moved out of a villa — dropping the private pool is the headline.
         Only claimed when the alternative's room row is actually known: a
         category missing from room_types has unknown features, and telling a
         guest an ocean-view room has no ocean view (as happened with the
         unmapped Grand Deluxe Ocean View Queen) is worse than saying nothing. */
      const drops = upgradeDelta(p, base, lang); // package benefits base has that this lacks
      if (ctx) {
        if (baseCtx?.privatePool && !ctx.privatePool) drops.unshift(lang === "vi" ? "thêm bể bơi riêng" : "adds a private pool");
        if (baseCtx?.oceanView && !ctx.oceanView) drops.push(lang === "vi" ? "thêm hướng biển" : "adds an ocean view");
      }
      if (!drops.length) continue; // nothing meaningfully different: not worth listing
      const sig = `${p.publicPrice}|${drops.join(",")}`;
      if (cheaperSeen.has(sig)) continue;
      cheaperSeen.add(sig);
      cheaper.push({
        ...view(p, lang),
        extra_cost: Math.round(p.publicPrice - base.publicPrice), // negative = the saving
        adds: drops.map((d) => (lang === "vi" ? `không có ${d.replace(/^thêm /, "")}` : d.replace(/^adds /, "without "))),
      });
      if (cheaper.length >= 2) break;
    }
  }

  const celebrationType = input.traveller && TRAVELLER_PREFS[input.traveller].celebration ? input.traveller : undefined;
  const celebration = celebrationType
    ? lang === "vi"
      ? TRAVELLER_PREFS[celebrationType].vi
      : TRAVELLER_PREFS[celebrationType].en
    : undefined;

  const celebrationNote = celebration
    ? lang === "vi"
      ? ` Khách đang có dịp đặc biệt (${celebration}) — hãy CHÚC MỪNG khách trước, chân thành, RỒI mới nói tới phòng. Gợi ý nâng hạng như một cách làm dịp này đáng nhớ hơn, không phải để bán thêm.`
      : ` The guest is celebrating (${celebration}) — congratulate them warmly FIRST, then talk about the room. Frame any upgrade as making the occasion special, not as a sale.`
    : "";

  const cheaperNote = cheaper.length
    ? lang === "vi"
      ? " Khách thấy giá cao: nêu các lựa chọn trong 'cheaper' và nói THẲNG mỗi lựa chọn phải bỏ đi điều gì, để khách tự cân nhắc."
      : " The guest finds it expensive: offer the 'cheaper' options and say plainly what each one gives up."
    : "";

  return {
    mode: "quote",
    base: view(base, lang),
    upsells: ladder,
    cheaper,
    celebration,
    // Offer only the chips that would actually change the result from here.
    clarify: FACETS.filter((f) => !wanted.includes(f) && !f.matches(base, roomByCode.get(baseRoom)))
      .map((f) => ({ key: f.key, label: lang === "vi" ? f.vi : f.en })),
    note:
      (lang === "vi"
        ? "Báo giá gói RẺ NHẤT trước (base), đọc đúng con số trong kết quả. Sau đó nêu ngắn các gói tốt hơn trong upsells kèm phần chênh lệch và thứ nó thêm vào — đừng ép khách. Nếu gói có has_blackout hoặc conditions, phải nói rõ điều kiện đó, KHÔNG tự tính lại hạn huỷ."
        : "Quote the CHEAPEST package (base) first, reading the figures verbatim. Then briefly mention the better packages in upsells with the extra cost and what it adds — do not push. If has_blackout or conditions are present, state them; never recompute a deadline.") +
      celebrationNote +
      cheaperNote +
      (unknownFacets.length ? ` (Ignored unknown facets: ${unknownFacets.join(", ")}.)` : ""),
    matched_rooms: [...new Set(pool.map((p) => p.roomNameVi))],
  };
}
