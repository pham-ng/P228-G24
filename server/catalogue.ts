/**
 * The room catalogue: grounded answers about a category's size, bed, view,
 * amenities and published party limit.
 *
 * The rule this module exists to enforce is narrow and deliberate: the agent may
 * only state what the property publishes. So every answer here is derived from
 * the parsed room pages in `room_types`, an amenity question is answered by
 * *matching against the published list* rather than by letting the model recall
 * what a resort room usually has, and anything the page is silent about comes
 * back explicitly marked as not published instead of as a plausible guess.
 */
import { storage } from "./storage";
import type { RoomType } from "@shared/schema";

/** Fold Vietnamese diacritics and case so "huong bien" matches "Hướng Biển". */
export function fold(s: string): string {
  return (s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export type Catalogued = {
  row: RoomType;
  amenities: string[];
  combinations: Array<{ adults: number; children: number }>;
  images: string[];
};

function hydrate(row: RoomType): Catalogued {
  return {
    row,
    amenities: JSON.parse(row.amenities || "[]"),
    combinations: JSON.parse(row.combinations || "[]"),
    images: JSON.parse(row.images || "[]"),
  };
}

/**
 * Resolve free text ("phòng hướng biển 2 giường đơn", "grand deluxe twin") to a
 * category. Scores by how many of the query's words appear in the candidate's
 * Vietnamese name plus inventory code, so a partial name still lands, and
 * returns null rather than a best-effort match when nothing overlaps.
 */
export function findRoomType(query: string): Catalogued | null {
  const rows = storage.listRoomTypes();
  if (!rows.length) return null;
  const q = fold(query);
  if (!q) return null;
  const exact = rows.find((r) => fold(r.code) === q || fold(r.nameVi) === q);
  if (exact) return hydrate(exact);

  const words = q.split(" ").filter((w) => w.length > 1);
  const score = (hay: string, row?: RoomType) => {
    let sc = 0;
    for (const w of words) if (hay.includes(w)) sc += w.length;
    if (!row) return sc;
    // A query asking for twin must not win a queen row, and vice versa: the
    // guest who asks about a twin room and is told about a double has been
    // given the wrong room, not an approximate one.
    const wantsTwin = /\b(2 giuong don|twin|hai giuong)\b/.test(q);
    const wantsDouble = /\b(giuong doi|double|queen|king)\b/.test(q);
    if (wantsTwin && row.bed === "double") sc -= 12;
    if (wantsDouble && row.bed === "twin") sc -= 12;
    const wantsOcean = /\b(huong bien|ocean|bien)\b/.test(q);
    if (wantsOcean && !row.oceanView) sc -= 8;
    if (!wantsOcean && row.oceanView) sc -= 2;
    return sc;
  };

  let best: { row: RoomType; score: number } | null = null;
  for (const r of rows) {
    const sc = score(`${fold(r.nameVi)} ${fold(r.code)}`, r);
    if (!best || sc > best.score) best = { row: r, score: sc };
  }
  if (!best || best.score <= 0) return null;

  // A category can exist in the inventory with no published page (the suite).
  // If the query describes one of those better than any page does, this is not a
  // near miss to be smoothed over — returning the closest page would answer a
  // question about the suite with the amenity list of a different room, which is
  // exactly the hallucination this module exists to prevent.
  const published = new Set(rows.map((r) => r.code));
  for (const code of new Set(storage.listRooms().map((r) => r.type))) {
    if (published.has(code)) continue;
    if (score(fold(code)) >= best.score) return null;
  }
  return hydrate(best.row);
}

/**
 * Answer "does this room have X?" strictly from the published amenity list.
 * Returns `listed` when a published label matches, `not_listed` otherwise —
 * never "probably yes".
 */
export function matchAmenity(amenities: string[], asked: string) {
  const a = fold(asked);
  if (!a) return { asked, status: "unclear" as const, matches: [] as string[] };
  // Substring matching answered "bàn là" (an iron) with "bàn làm việc" (a desk),
  // which is a wrong fact dressed up as a match. Matching runs on whole word
  // sequences instead, so an amenity only counts when every word the guest used
  // appears as a complete word in the label.
  const tok = (x: string) => fold(x).split(" ").filter(Boolean);
  const askedTokens = tok(asked);
  const seqIn = (hay: string[], needle: string[]) =>
    needle.length > 0 &&
    hay.some((_, i) => needle.every((w, j) => hay[i + j] === w));
  const matches = amenities.filter((label) => {
    const l = tok(label);
    if (seqIn(l, askedTokens) || seqIn(askedTokens, l)) return true;
    const content = askedTokens.filter((w) => w.length > 2);
    return content.length > 1 && content.every((w) => l.includes(w));
  });
  return {
    asked,
    status: matches.length ? ("listed" as const) : ("not_listed" as const),
    matches,
  };
}

/** Facts for one category, plus the answer to any amenity the guest asked about. */
export function roomTypeFacts(query: string, amenityQuestions: string[] = []) {
  const published = storage.listRoomTypes();
  const inventoryTypes = [...new Set(storage.listRooms().map((r) => r.type))];
  const known = inventoryTypes.map((code) => ({
    code,
    name_vi: published.find((r) => r.code === code)?.nameVi ?? null,
    published_page: published.some((r) => r.code === code),
  }));
  const hit = findRoomType(query);
  if (!hit) {
    // A category can be sellable and still have no published page — the suite is
    // one. That is a different answer from "no such room", and the agent has to
    // say which of the two it is.
    const q = fold(query);
    const inInventory = inventoryTypes.find((t) => fold(t) === q || (q.length > 3 && fold(t).includes(q)));
    return {
      found: false,
      query,
      in_inventory: inInventory ?? null,
      known_categories: known,
      instruction: inInventory
        ? `${inInventory} is a real category here but the property has not published a room page for it, so there is no amenity list, area or party limit to quote. Say the details are not published and offer to confirm with reception — do not describe the room.`
        : "No category matches this description. Ask the guest which category they mean, listing the known ones — do not describe a category that is not in known_categories.",
    };
  }
  const { row, amenities, combinations, images } = hit;
  const rooms = storage.listRooms().filter((r) => r.type === row.code);
  const asked = amenityQuestions.filter(Boolean).map((q) => matchAmenity(amenities, q));

  const unpublished: string[] = [];
  if (row.areaSqm == null) unpublished.push("area_sqm");
  if (row.maxGuests == null) unpublished.push("max_guests / combinations");

  return {
    found: true,
    code: row.code,
    name_vi: row.nameVi,
    area_sqm: row.areaSqm,
    bedrooms: row.bedrooms,
    bed: row.bed,
    ocean_view: !!row.oceanView,
    private_pool: !!row.privatePool,
    max_guests: row.maxGuests,
    occupancy_combinations: combinations,
    published_rate_per_night: rooms[0]?.baseRate ?? null,
    rooms_in_inventory: rooms.length,
    description: row.description,
    amenities,
    amenity_count: amenities.length,
    amenity_answers: asked,
    images,
    unpublished_fields: unpublished,
    source: { file: row.sourceFile, url: row.sourceUrl },
    instruction: [
      "Only state facts that appear in this result. The amenity list is the complete published list for this category.",
      "If the guest asked about something whose amenity_answers status is not_listed, say plainly that it is not in the published room description and offer to confirm with the front desk — never say the room has it, and never say it is definitely absent from the property.",
      unpublished.length
        ? `The room page does not publish: ${unpublished.join(", ")}. Say so instead of estimating, and offer to confirm with reception.`
        : null,
      row.maxGuests == null
        ? "This page publishes no maximum occupancy and no adult/child combination. If the guest named a party size, you may still say the category is sellable for it when availability says so, but in the same reply you must say the room page does not publish a maximum occupancy for this category and offer to confirm with reception before it is held."
        : null,
      "Quote the area in m² and the rate in VND exactly as given here.",
      images.length > 0 
        ? `You MUST include the exact text [IMAGES: ${images.join(",")}] right after mentioning the room name or inside its bullet point.` 
        : null,
    ]
      .filter(Boolean)
      .join(" "),
  };
}

/**
 * The published party limit for a category, when the page states one. Used to
 * tighten the generic occupancy policy: a page that says "maximum 4 (3 adults +
 * 1 child or 2 adults + 2 children)" rules out 4 adults even though the generic
 * cap is also 4.
 */
export function publishedOccupancy(roomTypeCode: string | null | undefined) {
  if (!roomTypeCode) return null;
  const row = storage.listRoomTypes().find((r) => r.code === roomTypeCode);
  if (!row || row.maxGuests == null) return null;
  const combinations: Array<{ adults: number; children: number }> = JSON.parse(row.combinations || "[]");
  return { code: row.code, nameVi: row.nameVi, maxGuests: row.maxGuests, combinations, sourceUrl: row.sourceUrl };
}

/**
 * Check a party against a category's published combinations.
 * `fits` is null when the page publishes no limit — the caller must fall back to
 * the generic occupancy policy rather than treat null as a pass.
 */
export function fitsPublishedCombination(
  roomTypeCode: string | null | undefined,
  adults: number,
  children: number,
) {
  const pub = publishedOccupancy(roomTypeCode);
  if (!pub) return null;
  const total = adults + children;
  const withinTotal = total <= pub.maxGuests;
  const combo = pub.combinations.find((c) => adults <= c.adults && children <= c.children);
  return {
    published_max_guests: pub.maxGuests,
    published_combinations: pub.combinations,
    party: { adults, children, total },
    fits: withinTotal && (pub.combinations.length === 0 || !!combo),
    matched_combination: combo ?? null,
    reason: withinTotal
      ? combo
        ? null
        : `The party fits ${pub.maxGuests} guests in total but not any published combination for ${pub.nameVi} (${pub.combinations
            .map((c) => `${c.adults} adults + ${c.children} children`)
            .join(" or ")}).`
      : `${total} guests exceed the published maximum of ${pub.maxGuests} for ${pub.nameVi}.`,
    source_url: pub.sourceUrl,
  };
}
