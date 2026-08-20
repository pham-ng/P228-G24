/**
 * The dining catalogue: grounded answers about the resort's restaurants and bars.
 *
 * Same doctrine as `catalogue.ts`, applied to food and drink. An opening hour, a
 * dish price, a seat count or a phone number may only leave the agent's mouth if
 * it is printed on the outlet's own page. Two failure modes are specifically
 * engineered out:
 *
 *   1. Inventing a menu. A guest asking whether a venue serves something gets an
 *      answer matched against the published dish list, not against what a
 *      Chinese restaurant "usually" has. A dish that is not on the page comes
 *      back as `not_listed` — not as a yes, and not as a flat "we don't serve it",
 *      because the pages print only a sample of each menu.
 *   2. Booking a table outside published hours. `windowFor()` checks a requested
 *      time against the published windows, so 23:00 at a kitchen that closes at
 *      22:00 is refused with the real closing time instead of accepted.
 */
import { storage } from "./storage";
import { fold } from "./catalogue";
import type { DiningVenue } from "@shared/schema";

export type Hours = { open: string; close: string };
export type MealWindow = Hours & { meal: string };
export type MenuItem = { name_vi: string; name_en: string | null; price: number | null };
export type MenuGroup = { group: string | null; items: MenuItem[] };

export type Venue = {
  row: DiningVenue;
  hours: Hours[];
  mealWindows: MealWindow[];
  cuisine: string[];
  dishesServed: string[];
  highlights: string[];
  goodFor: string[];
  amenities: string[];
  menu: MenuGroup[];
  images: string[];
};

const parse = <T,>(json: string, fallback: T): T => {
  try {
    return JSON.parse(json || "null") ?? fallback;
  } catch {
    return fallback;
  }
};

function hydrate(row: DiningVenue): Venue {
  return {
    row,
    hours: parse<Hours[]>(row.hours, []),
    mealWindows: parse<MealWindow[]>(row.mealWindows, []),
    cuisine: parse<string[]>(row.cuisine, []),
    dishesServed: parse<string[]>(row.dishesServed, []),
    highlights: parse<string[]>(row.highlights, []),
    goodFor: parse<string[]>(row.goodFor, []),
    amenities: parse<string[]>(row.amenities, []),
    menu: parse<MenuGroup[]>(row.menuGroups, []),
    images: parse<string[]>(row.images, []),
  };
}

export function listVenues(): Venue[] {
  return storage.listDiningVenues().map(hydrate);
}

/** Every dish on a venue's published sample menu, flattened. */
export function dishesOf(v: Venue): Array<MenuItem & { group: string | null }> {
  return v.menu.flatMap((g) => g.items.map((i) => ({ ...i, group: g.group })));
}

/**
 * Resolve a venue the guest named. Deliberately conservative: a query that does
 * not clearly land on one outlet returns null, because answering about the wrong
 * restaurant is worse than asking which one they meant. Kind words alone ("bar",
 * "nhà hàng") never pick a venue — there are three of each.
 */
export function findVenue(query: string): Venue | null {
  const venues = listVenues();
  if (!venues.length) return null;
  const q = fold(query);
  if (!q) return null;

  const exact = venues.find((v) => fold(v.row.code) === q || fold(v.row.nameVi) === q);
  if (exact) return exact;

  // Generic words carry no identifying signal and are dropped before scoring.
  const STOP = new Set([
    "nha", "hang", "quan", "bar", "restaurant", "lounge", "vinpearl", "resort",
    "nha trang", "cua", "the", "o", "tai", "vi", "va",
  ]);
  const words = q.split(" ").filter((w) => w.length > 1 && !STOP.has(w));
  if (!words.length) return null;

  let best: { v: Venue; score: number } | null = null;
  let runnerUp = 0;
  for (const v of venues) {
    const hay = `${fold(v.row.code)} ${fold(v.row.nameVi)} ${fold(v.row.slug)}`;
    let score = 0;
    for (const w of words) if (hay.includes(w)) score += w.length;
    if (!best || score > best.score) {
      runnerUp = best?.score ?? 0;
      best = { v, score };
    } else if (score > runnerUp) runnerUp = score;
  }
  // A tie means the query did not identify a venue — "bar bên hồ bơi" should hit
  // Pool Bar on the word "hồ bơi", but a bare "bar" must not pick one of three.
  if (!best || best.score < 3 || best.score === runnerUp) return null;
  return best.v;
}

/** Which published window, if any, contains `hhmm` (e.g. "19:30"). */
export function windowFor(v: Venue, hhmm: string): Hours | null {
  const mins = (t: string) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  };
  const at = mins(hhmm);
  if (Number.isNaN(at)) return null;
  return (
    v.hours.find((h) => {
      const o = mins(h.open);
      const c = mins(h.close);
      if (Number.isNaN(o) || Number.isNaN(c)) return false;
      return c > o ? at >= o && at <= c : at >= o || at <= c; // past-midnight safe
    }) ?? null
  );
}

/** Human-readable published hours, for a reply the guest can act on. */
export function hoursText(v: Venue): string {
  const main = v.hours.map((h) => `${h.open}–${h.close}`).join(", ");
  const meals = v.mealWindows.map((m) => `${m.meal} ${m.open}–${m.close}`).join(", ");
  return meals ? `${main} (${meals})` : main;
}

/**
 * Answer "does this venue serve X?" against the published dish list. Matching is
 * on whole words in both directions — the same fix the room amenities needed,
 * where substring matching once answered a question about an iron with a desk.
 */
export function matchDish(v: Venue, asked: string) {
  const tokens = (s: string) => fold(s).split(" ").filter(Boolean);
  const want = tokens(asked);
  if (!want.length) return { asked, status: "unclear" as const, matches: [] as MenuItem[] };

  const seq = (hay: string[], needle: string[]) =>
    needle.length > 0 && hay.some((_, i) => needle.every((w, j) => hay[i + j] === w));

  const content = want.filter((w) => w.length > 2);
  const matches = dishesOf(v).filter((d) => {
    const hay = tokens(`${d.name_vi} ${d.name_en ?? ""} ${d.group ?? ""}`);
    if (seq(hay, want)) return true;
    return content.length > 1 && content.every((w) => hay.includes(w));
  });

  // The page also prints coarse category labels ("Hải sản", "Món chay"), which
  // answer a question the sample menu cannot.
  const categories = [...v.cuisine, ...v.dishesServed].filter((c) => {
    const hay = tokens(c);
    return seq(hay, want) || seq(want, hay);
  });

  return {
    asked,
    status: matches.length
      ? ("on_menu" as const)
      : categories.length
        ? ("in_published_categories" as const)
        : ("not_listed" as const),
    matches: matches.map((m) => ({ name_vi: m.name_vi, name_en: m.name_en, price: m.price, group: m.group })),
    categories,
  };
}

/**
 * Facts for one venue, plus answers to any dish question, plus an instruction
 * block that spells out what the agent may and may not say from this payload.
 */
export function venueFacts(query: string, dishQuestions: string[] = [], atTime?: string) {
  const all = listVenues();
  const known = all.map((v) => ({
    name: v.row.code,
    name_vi: v.row.nameVi,
    kind: v.row.kind,
    hours: hoursText(v),
  }));

  const v = findVenue(query);
  if (!v) {
    return {
      found: false,
      asked_for: query,
      venues: known,
      instruction:
        "No published outlet page matches this name closely enough to be sure. Do not answer from general knowledge and do not pick the nearest-sounding venue: list the outlets above and ask which one they mean.",
    };
  }

  const dishes = dishQuestions.filter(Boolean).map((d) => matchDish(v, d));
  const unpublished: string[] = [];
  if (!v.row.capacity) unpublished.push("seating capacity");
  if (!v.row.priceRange && !dishesOf(v).some((d) => d.price)) unpublished.push("prices");
  if (!v.row.lastOrder) unpublished.push("last order time");
  if (!v.hours.length) unpublished.push("opening hours");

  const requested = atTime ? windowFor(v, atTime) : null;
  const conflict =
    v.mealWindows.length > 0 && v.hours.length > 0
      ? "The page prints both an overall operating window and separate meal services, and the two do not agree. Quote both and say the property's own page lists them differently rather than picking one."
      : null;

  return {
    found: true,
    name: v.row.code,
    name_vi: v.row.nameVi,
    kind: v.row.kind,
    location: v.row.location,
    phone: v.row.phone,
    published_hours: v.hours,
    hours_text: hoursText(v),
    meal_windows: v.mealWindows,
    last_order: v.row.lastOrder,
    prep_time: v.row.prepTime,
    seating_capacity: v.row.capacity,
    price_range: v.row.priceRange,
    price_note: v.row.priceNote,
    cuisine: v.cuisine,
    dish_categories: v.dishesServed,
    highlights: v.highlights,
    good_for: v.goodFor,
    venue_amenities: v.amenities,
    menu_sample: v.menu,
    menu_sample_size: dishesOf(v).length,
    dish_answers: dishes,
    images: v.images,
    requested_time: atTime ?? null,
    open_at_requested_time: atTime ? !!requested : null,
    requested_time_window: requested,
    unpublished_fields: unpublished,
    hours_conflict: conflict,
    source: { file: v.row.sourceFile, url: v.row.sourceUrl },
    instruction: [
      "Only state facts that appear in this result. The menu here is the sample the page prints, not the whole menu.",
      "A dish whose status is not_listed is not on the published sample: say that, and do not claim the kitchen does or does not make it. If its status is in_published_categories, say the page lists that category but not the dish itself.",
      "Quote prices in VND exactly as given and never add, average or convert them.",
      atTime && !requested
        ? `The requested time ${atTime} falls outside the published hours (${hoursText(v)}). Say so with the real hours and offer a time inside them — never take a table at a closed venue.`
        : null,
      unpublished.length
        ? `The page does not publish: ${unpublished.join(", ")}. Say so instead of estimating.`
        : null,
      conflict,
      v.images.length > 0 
        ? `You MUST include the exact text [IMAGES: ${v.images.join(",")}] right after mentioning the venue name or inside its bullet point.` 
        : null,
      "A table is only booked when book_service returns a booking. This tool books nothing.",
    ]
      .filter(Boolean)
      .join(" "),
  };
}
