/**
 * Reservation business logic: date resolution, request validation, availability
 * and the write paths that create or change a booking.
 *
 * Everything a hotel would refuse, question or correct lives here as a
 * deterministic function, so the model cannot talk its way past it. The model's
 * job is to ask the guest for what is missing and to explain what came back —
 * never to decide whether a stay is legal, whether a room is free, or what it
 * costs.
 */

import { storage, hotelToday, hotelClock, nowIso, HOTEL_TZ } from "./storage";
import { checkOccupancy } from "./policy";
import { fitsPublishedCombination, findRoomType } from "./catalogue";
import type { Reservation, Room } from "@shared/schema";

/* ------------------------------------------------------------------ limits */

/** Longest stay the booking engine will take without a manager. */
export const MAX_NIGHTS = 30;
/** How far ahead the rate calendar is open. */
export const BOOKING_HORIZON_DAYS = 365;
/** At this many rooms the booking becomes a group and leaves the concierge. */
export const GROUP_ROOM_THRESHOLD = 10;
export const GROUP_VILLA_THRESHOLD = 5;
/** Minimum age to hold a reservation and check in alone. */
export const MIN_CHECKIN_AGE = 18;
/** A child is 12+ counted as an adult for occupancy — see the OCCUPANCY policy. */
export const CHILD_ADULT_AGE = 12;

/* -------------------------------------------------------------- date maths */

const DAY_MS = 86_400_000;

/** True for a real calendar date in YYYY-MM-DD (rejects 2026-02-31). */
export function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function toUtc(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

export function addDays(iso: string, n: number): string {
  return new Date(toUtc(iso) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Nights between two ISO dates. Negative when the dates are reversed. */
export function nightsBetween(checkIn: string, checkOut: string): number {
  return Math.round((toUtc(checkOut) - toUtc(checkIn)) / DAY_MS);
}

/** 0 = Sunday. */
function weekday(iso: string): number {
  return new Date(toUtc(iso)).getUTCDay();
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0, "chủ nhật": 0, "chu nhat": 0, cn: 0,
  monday: 1, mon: 1, "thứ hai": 1, "thu hai": 1, "thứ 2": 1, "thu 2": 1,
  tuesday: 2, tue: 2, "thứ ba": 2, "thu ba": 2, "thứ 3": 2, "thu 3": 2,
  wednesday: 3, wed: 3, "thứ tư": 3, "thu tu": 3, "thứ 4": 3, "thu 4": 3,
  thursday: 4, thu: 4, "thứ năm": 4, "thu nam": 4, "thứ 5": 4,
  friday: 5, fri: 5, "thứ sáu": 5, "thu sau": 5, "thứ 6": 5, "thu 6": 5,
  saturday: 6, sat: 6, "thứ bảy": 6, "thu bay": 6, "thứ 7": 6, "thu 7": 6,
};

export type DateResolution = {
  /** Set when the expression was a range: the second date. */
  resolved_end?: string | null;
  resolved: string | null;
  /** Plain-language reading of the expression, for the agent to echo back. */
  interpretation?: string;
  /** True when the phrase has more than one defensible reading — ask the guest. */
  ambiguous?: boolean;
  note?: string;
  error?: string;
  /** The hotel's own current date and clock the resolution was made against. */
  hotel_date: string;
  hotel_time: string;
  hotel_timezone: string;
};

/**
 * Turn a human date phrase into an ISO date in the hotel's own timezone.
 *
 * The agent must never do this arithmetic itself: "tomorrow" for a guest
 * messaging at 01:30 hotel time is a genuine trap, and the guest's device
 * timezone is not the hotel's.
 */
export function resolveDate(expr: string, opts: { reference?: string } = {}): DateResolution {
  const today = opts.reference && isIsoDate(opts.reference) ? opts.reference : hotelToday();
  const clock = hotelClock();
  const base = {
    hotel_date: today,
    hotel_time: clock,
    hotel_timezone: HOTEL_TZ,
  };
  const raw = (expr ?? "").trim();
  if (!raw) return { ...base, resolved: null, error: "No date expression given." };

  const q = raw.toLowerCase().replace(/\s+/g, " ");
  const smallHours = Number(clock.slice(0, 2)) < 6;

  // "22/09 đến 24/09", "1/10 - 5/10", "Oct 1 to Oct 5": a range written as one
  // phrase. Resolve both ends rather than refusing the whole expression.
  const range = q.match(
    /^(.{2,30}?)\s*(?:đến|den|tới|toi|->|–|—|-|to|until|till|thru|through|và|va|and|,|;)\s*(.{2,30})$/,
  );
  if (range && !/^\d{4}-\d{2}-\d{2}$/.test(q)) {
    const from = resolveDate(range[1].trim(), opts);
    const to = resolveDate(range[2].trim(), opts);
    if (from.resolved && to.resolved)
      return {
        ...base,
        resolved: from.resolved,
        resolved_end: to.resolved,
        interpretation: `${from.resolved} → ${to.resolved}`,
        note:
          [from.note, to.note].filter(Boolean).join(" ") ||
          "Read as a date range: arrival then departure.",
      };
  }

  // Already ISO.
  if (/^\d{4}-\d{2}-\d{2}$/.test(q)) {
    if (!isIsoDate(q))
      return { ...base, resolved: null, error: `${raw} is not a real calendar date.` };
    return { ...base, resolved: q, interpretation: q };
  }

  // D/M or D/M/Y — day first, which is how Vietnam writes dates.
  const slash = q.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/);
  if (slash) {
    const d = Number(slash[1]);
    const m = Number(slash[2]);
    let y = slash[3] ? Number(slash[3]) : Number(today.slice(0, 4));
    if (y < 100) y += 2000;
    const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (!isIsoDate(iso))
      return { ...base, resolved: null, error: `${raw} is not a real calendar date.` };
    // A bare day/month already past this year almost certainly means next year.
    if (!slash[3] && iso < today) {
      const next = `${y + 1}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      return {
        ...base,
        resolved: next,
        interpretation: next,
        ambiguous: true,
        note: `${raw} has already passed in ${y}, so this reads as ${next}. Confirm the year with the guest.`,
      };
    }
    return { ...base, resolved: iso, interpretation: iso, note: "Read as day/month." };
  }

  const isTonight = /\b(tonight|to-night|tối nay|toi nay|đêm nay|dem nay)\b/.test(q);
  const isToday = /\b(today|hôm nay|hom nay|ngay hom nay)\b/.test(q);
  const isTomorrow = /\b(tomorrow|mai|ngày mai|ngay mai)\b/.test(q);
  const isDayAfter = /\b(day after tomorrow|ngày mốt|ngay mot|mốt|mot)\b/.test(q);

  if (isTonight)
    return {
      ...base,
      resolved: today,
      interpretation: today,
      ambiguous: smallHours,
      note: smallHours
        ? `It is ${clock} at the hotel, so "tonight" is ambiguous: the night that began yesterday evening is ending now. Read here as arrival on ${today}, but confirm with the guest.`
        : `"Tonight" is an arrival on ${today}.`,
    };

  if (isToday) return { ...base, resolved: today, interpretation: today };

  if (isDayAfter) {
    const d = addDays(today, 2);
    return { ...base, resolved: d, interpretation: d };
  }

  if (isTomorrow) {
    const d = addDays(today, 1);
    return {
      ...base,
      resolved: d,
      interpretation: d,
      ambiguous: smallHours,
      note: smallHours
        ? `It is ${clock} at the hotel. The hotel date already rolled over to ${today}, so "tomorrow" is ${d} — but a guest awake at this hour often means later today (${today}). Confirm.`
        : undefined,
    };
  }

  // "in 3 days", "3 ngày nữa", "sau 3 ngày"
  const inDays = q.match(/(?:in|sau)\s+(\d{1,3})\s*(?:days?|ngày|ngay)/) || q.match(/(\d{1,3})\s*(?:ngày|ngay)\s*(?:nữa|nua|sau|tới|toi)/);
  if (inDays) {
    const d = addDays(today, Number(inDays[1]));
    return { ...base, resolved: d, interpretation: d };
  }

  // Weekday, optionally with next/this.
  const nextWeek = /\b(next|tuần sau|tuan sau|tuần tới|tuan toi|sau)\b/.test(q);
  const thisWeek = /\b(this|tuần này|tuan nay|này|nay)\b/.test(q);
  for (const [name, dow] of Object.entries(WEEKDAYS)) {
    if (!new RegExp(`(^|[^a-zà-ỹ0-9])${name}([^a-zà-ỹ0-9]|$)`, "i").test(q)) continue;
    const cur = weekday(today);
    let delta = (dow - cur + 7) % 7;
    if (delta === 0) delta = 7; // "friday" said on a Friday means the next one
    if (nextWeek && delta < 7) delta += 7;
    const d = addDays(today, delta);
    return {
      ...base,
      resolved: d,
      interpretation: d,
      ambiguous: !nextWeek && !thisWeek,
      note:
        !nextWeek && !thisWeek
          ? `Today is ${today}. Read as the next ${name} → ${d}. If the guest meant the week after, that is ${addDays(d, 7)} — worth confirming.`
          : undefined,
    };
  }

  // "cuối tuần này" / "this weekend" → the coming Friday.
  if (/\b(weekend|cuối tuần|cuoi tuan)\b/.test(q)) {
    const cur = weekday(today);
    let delta = (5 - cur + 7) % 7;
    if (delta === 0) delta = 7;
    if (nextWeek) delta += 7;
    const d = addDays(today, delta);
    return {
      ...base,
      resolved: d,
      interpretation: d,
      ambiguous: true,
      note: `Read as the Friday of that weekend (${d}). A weekend stay is usually 2 nights to ${addDays(d, 2)} — confirm both dates.`,
    };
  }

  return {
    ...base,
    resolved: null,
    error: `Could not read "${raw}" as a date.`,
    note:
      "If this phrase held more than one date, call resolve_date once per date before asking the guest anything. Only ask the guest for a calendar date when a single date on its own cannot be read.",
  };
}

/* --------------------------------------------------- rate-calendar controls */

export type RestrictionHit = {
  code: string;
  date: string;
  room_type: string | null;
  label: string;
  reason: string;
  message: string;
};

/**
 * Apply the rate calendar to a window. `roomType` null checks only the
 * property-wide rows; passing a type also picks up that category's own rows.
 *
 * MinLOS / MaxLOS / closed-to-arrival are read from the arrival date,
 * closed-to-departure from the departure date, and stop-sell from every night
 * actually being sold — which is how a booking engine evaluates them.
 */
export function checkRestrictions(
  checkIn: string,
  checkOut: string,
  roomType?: string | null,
): RestrictionHit[] {
  const nights = nightsBetween(checkIn, checkOut);
  if (nights < 1) return [];
  const rows = storage
    .restrictionsBetween(checkIn, checkOut)
    .filter((r) => r.roomType === null || (roomType && r.roomType === roomType));
  const hits: RestrictionHit[] = [];
  const base = (r: (typeof rows)[number], code: string, message: string): RestrictionHit => ({
    code,
    date: r.date,
    room_type: r.roomType,
    label: r.label,
    reason: r.reason,
    message,
  });

  for (const r of rows) {
    const isNightSold = r.date >= checkIn && r.date < checkOut;
    if (r.stopSell && isNightSold)
      hits.push(
        base(
          r,
          "STOP_SELL",
          `${r.roomType ?? "The property"} is on stop sell for ${r.date} (${r.label}), so that night cannot be sold at all.`,
        ),
      );
    if (r.date === checkIn) {
      if (r.closedToArrival)
        hits.push(
          base(
            r,
            "CLOSED_TO_ARRIVAL",
            `${r.date} is closed to arrival (${r.label}). A stay may run through that date but cannot begin on it.`,
          ),
        );
      if (r.minLos && nights < r.minLos)
        hits.push(
          base(
            r,
            "MIN_LOS",
            `Arrivals on ${r.date} require a minimum stay of ${r.minLos} nights (${r.label}); this request is ${nights}.`,
          ),
        );
      if (r.maxLos && nights > r.maxLos)
        hits.push(
          base(
            r,
            "MAX_LOS",
            `Arrivals on ${r.date} are capped at ${r.maxLos} nights (${r.label}); this request is ${nights}.`,
          ),
        );
    }
    if (r.date === checkOut && r.closedToDeparture)
      hits.push(
        base(
          r,
          "CLOSED_TO_DEPARTURE",
          `${r.date} is closed to departure (${r.label}), so the stay has to end on a different date.`,
        ),
      );
  }
  return hits;
}

function restrictionSuggestion(code: string): string {
  switch (code) {
    case "MIN_LOS":
      return "Offer to extend the stay to the minimum, or offer dates outside the peak window. Do not book the short stay.";
    case "MAX_LOS":
      return "Offer to split the stay or pass it to reservations as a long-stay request.";
    case "CLOSED_TO_ARRIVAL":
      return "Offer the nearest date the guest can actually arrive on.";
    case "CLOSED_TO_DEPARTURE":
      return "Offer the nearest date the guest can depart on.";
    default:
      return "Offer another category or another window; nothing can be held on that date.";
  }
}

/* ------------------------------------------------------- request validation */

export type Problem = {
  /** Stable machine code — the benchmark asserts on these. */
  code: string;
  field?: string;
  message: string;
  /** What the agent should say or offer instead. */
  suggestion?: string;
};

export type StayRequest = {
  checkIn?: string;
  checkOut?: string;
  nights?: number;
  adults?: number;
  childAges?: number[];
  children?: number;
  rooms?: number;
  roomType?: string;
  guestName?: string;
  guestPhone?: string;
  /** The guest's stated nightly ceiling, so options above it are never offered. */
  maxRatePerNight?: number;
  /** Set when amending an existing stay whose arrival is legitimately in the past. */
  existingStay?: boolean;
};

export type Validation = {
  valid: boolean;
  /** Facts the hotel cannot proceed without. Ask for these. */
  missing: Problem[];
  /** Things the guest said that cannot be true or cannot be sold. Correct these. */
  problems: Problem[];
  /** Non-blocking things worth mentioning. */
  warnings: Problem[];
  normalised?: {
    checkIn: string;
    checkOut: string;
    nights: number;
    adults: number;
    childAges: number[];
    rooms: number;
    roomType?: string;
  };
  hotel_date: string;
  hotel_time: string;
};

/**
 * Everything a front desk would query before touching the rate calendar.
 * Returns *all* problems at once so the agent can ask one combined question
 * instead of dragging the guest through five turns.
 */
export function validateStayRequest(req: StayRequest): Validation {
  const today = hotelToday();
  const missing: Problem[] = [];
  const problems: Problem[] = [];
  const warnings: Problem[] = [];

  let checkIn = req.checkIn;
  let checkOut = req.checkOut;

  // ---- dates present and real
  if (checkIn !== undefined && !isIsoDate(checkIn)) {
    problems.push({
      code: "INVALID_DATE",
      field: "check_in",
      message: `"${checkIn}" is not a real calendar date.`,
      suggestion: "Ask for the arrival date, or resolve the phrase with resolve_date first.",
    });
    checkIn = undefined;
  }
  if (checkOut !== undefined && !isIsoDate(checkOut)) {
    problems.push({
      code: "INVALID_DATE",
      field: "check_out",
      message: `"${checkOut}" is not a real calendar date.`,
      suggestion: "Ask for the departure date, or resolve the phrase with resolve_date first.",
    });
    checkOut = undefined;
  }

  // Nights can stand in for a missing departure date.
  if (checkIn && !checkOut && req.nights !== undefined) {
    if (!Number.isInteger(req.nights) || req.nights < 1) {
      problems.push({
        code: "INVALID_NIGHTS",
        field: "nights",
        message: `A stay of ${req.nights} night(s) is not something the hotel can sell.`,
        suggestion: "Ask how many nights, at least one.",
      });
    } else {
      checkOut = addDays(checkIn, req.nights);
      warnings.push({
        code: "DERIVED_CHECKOUT",
        field: "check_out",
        message: `Departure derived as ${checkOut} from ${req.nights} night(s) after ${checkIn}.`,
        suggestion: "Confirm the departure date back to the guest.",
      });
    }
  }

  if (!checkIn)
    missing.push({
      code: "MISSING_CHECK_IN",
      field: "check_in",
      message: "No arrival date.",
      suggestion: "Ask which date the guest arrives.",
    });
  if (!checkOut)
    missing.push({
      code: "MISSING_CHECK_OUT",
      field: "check_out",
      message: "No departure date and no number of nights.",
      suggestion: "Ask for the departure date or how many nights.",
    });

  // ---- date relationship
  let nights = 0;
  if (checkIn && checkOut) {
    nights = nightsBetween(checkIn, checkOut);
    if (nights < 0) {
      problems.push({
        code: "REVERSED_DATES",
        message: `Departure ${checkOut} is before arrival ${checkIn}, so this stay cannot exist.`,
        suggestion: `Tell the guest the dates look swapped and offer the obvious reading: arrive ${checkOut}, depart ${checkIn} (${Math.abs(nights)} night(s)). Do not book until they confirm.`,
      });
    } else if (nights === 0) {
      problems.push({
        code: "SAME_DAY_STAY",
        message: `Arrival and departure are both ${checkIn}, which is a day-use booking, not an overnight stay.`,
        suggestion:
          "Ask whether the guest means to stay the night (departure the following day) or wants day use, which the front desk handles case by case.",
      });
    } else if (nights > MAX_NIGHTS) {
      problems.push({
        code: "MAX_STAY_EXCEEDED",
        message: `${nights} nights is beyond the ${MAX_NIGHTS}-night maximum the booking engine can confirm.`,
        suggestion: "Offer to pass a long-stay request to the reservations team for a quote.",
      });
    }
  }

  if (checkIn && isIsoDate(checkIn)) {
    if (checkIn < today && !req.existingStay) {
      problems.push({
        code: "ARRIVAL_IN_PAST",
        field: "check_in",
        message: `Arrival ${checkIn} is in the past — the hotel's date is ${today}.`,
        suggestion:
          "Ask whether the guest meant the same date next month or next year, and never silently shift the date yourself.",
      });
    }
    if (nightsBetween(today, checkIn) > BOOKING_HORIZON_DAYS) {
      problems.push({
        code: "BEYOND_BOOKING_HORIZON",
        field: "check_in",
        message: `Arrival ${checkIn} is more than ${BOOKING_HORIZON_DAYS} days out; the rate calendar is not open that far.`,
        suggestion: "Offer to note the request and have reservations follow up when rates open.",
      });
    }
  }

  // ---- rate calendar
  if (checkIn && checkOut && nights > 0) {
    for (const hit of checkRestrictions(checkIn, checkOut, req.roomType ?? null)) {
      problems.push({
        code: hit.code,
        field: "dates",
        message: hit.message,
        suggestion: restrictionSuggestion(hit.code),
      });
    }
  }

  // ---- party
  const adults = req.adults;
  if (adults === undefined) {
    missing.push({
      code: "MISSING_ADULTS",
      field: "adults",
      message: "Number of adults not stated.",
      suggestion:
        "Ask how many adults and how many children, since the package price assumes two adults per room.",
    });
  } else if (!Number.isInteger(adults) || adults < 1) {
    problems.push({
      code: "NO_ADULTS",
      field: "adults",
      message: `${adults} adults is not a bookable party — every room needs at least one adult of ${MIN_CHECKIN_AGE} or over.`,
      suggestion: "Ask who the adult on the booking will be.",
    });
  }

  let childAges = req.childAges;
  const childCount = req.children;
  // A caller that knows there is a child but not the age often sends a
  // placeholder — [null], [0.5 as "unknown"], an empty slot. That is a missing
  // age, not an invalid one: the guest still has to be asked.
  const blankAges =
    Array.isArray(childAges) && childAges.filter((a) => a === null || a === undefined).length;
  if (blankAges) {
    const known = (childAges ?? []).filter((a) => a !== null && a !== undefined) as number[];
    missing.push({
      code: "MISSING_CHILD_AGES",
      field: "child_ages",
      message: `${blankAges} child(ren) with no age given. Age decides occupancy, extra beds, buffet price and whether a child counts as an adult from ${CHILD_ADULT_AGE}.`,
      suggestion: "Ask the age, in years, of each child.",
    });
    childAges = known.length ? known : undefined;
    req = { ...req, childAges };
  }
  if (childAges === undefined && childCount !== undefined && childCount > 0) {
    missing.push({
      code: "MISSING_CHILD_AGES",
      field: "child_ages",
      message: `${childCount} child(ren) with no ages. Age decides occupancy, extra beds, buffet price and whether a child counts as an adult from ${CHILD_ADULT_AGE}.`,
      suggestion: "Ask the age of each child.",
    });
  }
  if (childAges) {
    if (childCount !== undefined && childCount !== childAges.length)
      problems.push({
        code: "CHILD_COUNT_MISMATCH",
        field: "child_ages",
        message: `The guest said ${childCount} child(ren) but gave ${childAges.length} age(s).`,
        suggestion: "Ask the guest to confirm how many children and their ages.",
      });
    for (const a of childAges) {
      if (!Number.isFinite(a) || a < 0 || a > 17) {
        problems.push({
          code: "INVALID_CHILD_AGE",
          field: "child_ages",
          message: `${a} is not a child's age. Anyone ${CHILD_ADULT_AGE} or over counts as an adult for occupancy, and ${MIN_CHECKIN_AGE}+ is an adult on the booking.`,
          suggestion: "Ask for each child's age in years.",
        });
      }
    }
    childAges = childAges.filter((a) => Number.isFinite(a) && a >= 0 && a <= 17);
    const twelvePlus = childAges.filter((a) => a >= CHILD_ADULT_AGE).length;
    if (twelvePlus > 0)
      warnings.push({
        code: "CHILD_COUNTS_AS_ADULT",
        field: "child_ages",
        message: `${twelvePlus} of the children are ${CHILD_ADULT_AGE} or over and count as adults for occupancy and buffet pricing.`,
      });
  }

  if ((adults ?? 0) < 1 && childAges && childAges.length > 0 && adults !== undefined) {
    problems.push({
      code: "UNACCOMPANIED_MINOR",
      message: `A booking of children with no adult cannot be confirmed — check-in requires an adult of ${MIN_CHECKIN_AGE} or over with ID.`,
      suggestion: "Escalate to the front desk rather than refusing flatly.",
    });
  }

  // ---- rooms
  const rooms = req.rooms ?? 1;
  if (!Number.isInteger(rooms) || rooms < 1) {
    problems.push({
      code: "INVALID_ROOM_COUNT",
      field: "rooms",
      message: `${rooms} rooms is not a bookable request.`,
    });
  } else {
    const villa = /villa/i.test(req.roomType ?? "");
    const threshold = villa ? GROUP_VILLA_THRESHOLD : GROUP_ROOM_THRESHOLD;
    if (rooms >= threshold)
      problems.push({
        code: "GROUP_BOOKING",
        field: "rooms",
        message: `${rooms} ${villa ? "villas" : "rooms"} is a group booking under the published booking classes (${threshold}+ ${villa ? "villas" : "rooms"} per night), which is contracted separately.`,
        suggestion: "Hand the request to the groups desk with the dates and party size.",
      });
  }

  // ---- room type must exist
  let roomType = req.roomType;
  if (roomType) {
    const types = [...new Set(storage.listRooms().map((r) => r.type))];
    const q = roomType!.toLowerCase().trim();
    // Prefer an exact name, then the closest containing name (shortest wins, so
    // "Deluxe Queen" does not silently become "Grand Deluxe Queen Bed").
    const contains = types.filter((t) => t.toLowerCase().includes(q)).sort((a, b) => a.length - b.length);
    const inverse = types.filter((t) => q.includes(t.toLowerCase())).sort((a, b) => b.length - a.length);
    // Guests name categories in Vietnamese ("Deluxe Giường Đôi"), which no
    // English inventory name contains. Falling through to UNKNOWN_ROOM_TYPE here
    // made the agent tell a guest their own room category did not exist, so the
    // published Vietnamese names are consulted before giving up.
    const hit =
      types.find((t) => t.toLowerCase() === q) ??
      contains[0] ??
      inverse[0] ??
      findRoomType(roomType!)?.row.code;
    if (!hit) {
      problems.push({
        code: "UNKNOWN_ROOM_TYPE",
        field: "room_type",
        message: `The property has no room type matching "${roomType}".`,
        suggestion: `Offer the real categories: ${types.join("; ")}.`,
      });
      roomType = undefined;
    } else {
      roomType = hit;
    }
  }

  // ---- occupancy against the published limits
  if (adults !== undefined && adults >= 1) {
    const occ = checkOccupancy({
      unit: /villa/i.test(roomType ?? "") ? "villa" : "room",
      adults: Math.ceil(adults / rooms),
      childAges: childAges ?? [],
      bedrooms: /villa/i.test(roomType ?? "") ? 3 : undefined,
    });
    // `occ.ok` is false precisely when the party is over the limit, so the
    // limit itself is the field to test.
    const published = fitsPublishedCombination(roomType, Math.ceil(adults / rooms), (childAges ?? []).length);
    if (published && published.fits === false) {
      problems.push({
        code: "OVER_PUBLISHED_OCCUPANCY",
        field: "adults",
        message: `${published.reason} Published limit: maximum ${published.published_max_guests} guests (${published.published_combinations
          .map((c) => `${c.adults} adults + ${c.children} children`)
          .join(" or ")}).`,
        suggestion:
          "Offer a second room of the same category, or a larger category, and re-quote. Quote the published combinations exactly.",
      });
    }
    if (occ.within_limit === false) {
      problems.push({
        code: "OVER_OCCUPANCY",
        message: `The party does not fit: ${occ.limit}.`,
        suggestion:
          occ.rooms_needed && occ.rooms_needed > rooms
            ? `Offer ${occ.rooms_needed} rooms, or a villa, and re-quote.`
            : "Offer a larger category or an extra room and re-quote.",
      });
    }
  }

  const valid = missing.length === 0 && problems.length === 0;
  return {
    valid,
    missing,
    problems,
    warnings,
    normalised:
      valid && checkIn && checkOut
        ? {
            checkIn,
            checkOut,
            nights,
            adults: adults!,
            childAges: childAges ?? [],
            rooms,
            roomType,
          }
        : undefined,
    hotel_date: today,
    hotel_time: hotelClock(),
  };
}

/* ---------------------------------------------------------- availability */

const LIVE_STATUSES = new Set(["confirmed", "in_house"]);

/** Does an existing reservation collide with the requested window? */
function overlaps(r: Reservation, checkIn: string, checkOut: string): boolean {
  return LIVE_STATUSES.has(r.status) && r.checkIn < checkOut && r.checkOut > checkIn;
}

export type AvailabilityRow = {
  room_type: string;
  total_rooms: number;
  out_of_order: number;
  occupied_in_window: number;
  available: number;
  rate_per_night: number;
  currency: string;
  total_for_stay: number;
  fits_party: boolean;
  occupancy_limit: string;
  /** Set when the rate calendar blocks this category for the window. */
  restricted_reason: string | null;
  /** True when this is the category the guest named (or none was named). */
  matches_request: boolean;
  /** True when the guest gave a nightly budget and this rate is above it. */
  over_budget: boolean;
  /** How to talk about an option above the ceiling. */
  budget_note: string | null;
  /** Published size of the category, null when the room page does not state it. */
  area_sqm: number | null;
  /** Published maximum party for the category, null when not published. */
  published_max_guests: number | null;
  /** Why the published combinations rule this party out, when they do. */
  published_occupancy_note: string | null;
};

export type AvailabilityResult =
  | { ok: false; validation: Validation }
  | {
      ok: true;
      check_in: string;
      check_out: string;
      nights: number;
      rooms_requested: number;
      party: { adults: number; child_ages: number[] };
      currency: string;
      options: AvailabilityRow[];
      any_available: boolean;
      requested_room_type: string | null;
      requested_is_sellable: boolean;
      alternatives_to_offer: {
        room_type: string;
        rate_per_night: number;
        total_for_stay: number;
        available: number;
      }[];
      alternatives_instruction: string | null;
      budget_per_night: number | null;
      budget_instruction: string | null;
      note: string;
      warnings: Problem[];
    };

/**
 * Real availability, computed from the room list and the reservation book —
 * not a guess and not a static number.
 */
export function searchAvailability(req: StayRequest): AvailabilityResult {
  const v = validateStayRequest(req);
  if (!v.valid || !v.normalised) return { ok: false, validation: v };

  const { checkIn, checkOut, nights, adults, childAges, rooms, roomType } = v.normalised;
  const budget = typeof req.maxRatePerNight === "number" && req.maxRatePerNight > 0 ? req.maxRatePerNight : null;
  const hotel = storage.getHotel();
  const all = storage.listRooms();
  const live = storage.listReservations().filter((r) => overlaps(r, checkIn, checkOut));
  const busy = new Set(live.map((r) => r.roomId).filter((x): x is number => x != null));

  // Every category is priced, always. Filtering the list down to the one the
  // guest named would leave the agent with no alternative to offer when that
  // category is closed — which is exactly when an alternative is needed.
  const types = [...new Set(all.map((r) => r.type))];

  const options: AvailabilityRow[] = types.map((type) => {
    const inType = all.filter((r) => r.type === type);
    const oo = inType.filter((r) => r.status === "out_of_order");
    const free = inType.filter((r) => r.status !== "out_of_order" && !busy.has(r.id));
    const isVilla = /villa/i.test(type);
    const occ = checkOccupancy({
      unit: isVilla ? "villa" : "room",
      adults: Math.ceil(adults / rooms),
      childAges,
      bedrooms: isVilla ? 3 : undefined,
    });
    const rate = rateFor(type, inType);
    const published = fitsPublishedCombination(type, Math.ceil(adults / rooms), childAges.length);
    const cat = storage.listRoomTypes().find((r) => r.code === type);
    const blocked = checkRestrictions(checkIn, checkOut, type).filter((h) => h.room_type === type);
    return {
      room_type: type,
      total_rooms: inType.length,
      out_of_order: oo.length,
      occupied_in_window: inType.length - oo.length - free.length,
      available: blocked.length > 0 || rate <= 0 ? 0 : free.length,
      rate_per_night: rate,
      currency: hotel.currency,
      total_for_stay: rate * nights * rooms,
      fits_party:
        published && published.fits === false ? false : occ.ok ? occ.within_limit !== false : true,
      occupancy_limit: occ.ok ? (occ.limit ?? "") : "",
      area_sqm: cat?.areaSqm ?? null,
      published_max_guests: published?.published_max_guests ?? null,
      published_occupancy_note: published?.fits === false ? published.reason : null,
      restricted_reason:
        blocked.length > 0
          ? blocked.map((h) => h.message).join(" ")
          : rate <= 0
            ? "No published rate is loaded for this category, so it cannot be quoted or sold in chat. Send the guest to the reservations desk for it."
            : null,
      matches_request: !roomType || type.toLowerCase() === roomType.toLowerCase(),
      over_budget: budget != null && rate > budget,
      budget_note:
        budget != null && rate > budget
          ? `Above the guest's stated ceiling by ${(rate - budget).toLocaleString("vi-VN")} ${hotel.currency} a night. If you mention it at all, say it exceeds their ceiling in the same clause — never call it suitable, never call it within budget.`
          : null,
    };
  });

  const sellable = options.filter((o) => o.available >= rooms && o.fits_party && !o.over_budget);
  const requested = options.filter((o) => o.matches_request);
  const requestedSellable = requested.filter((o) => sellable.includes(o));
  const alternatives = sellable.filter((o) => !o.matches_request).slice(0, 3);
  return {
    ok: true,
    check_in: checkIn,
    check_out: checkOut,
    nights,
    rooms_requested: rooms,
    party: { adults, child_ages: childAges },
    currency: hotel.currency,
    options: options.sort((a, b) => a.rate_per_night - b.rate_per_night),
    any_available: sellable.length > 0,
    requested_room_type: roomType ?? null,
    requested_is_sellable: requestedSellable.length > 0,
    alternatives_to_offer:
      roomType && requestedSellable.length === 0
        ? alternatives.map((o) => ({
            room_type: o.room_type,
            rate_per_night: o.rate_per_night,
            total_for_stay: o.total_for_stay,
            available: o.available,
          }))
        : [],
    alternatives_instruction:
      roomType && requestedSellable.length === 0
        ? alternatives.length > 0
          ? "The category the guest named cannot be sold for these dates. Say why in one clause, then name at least one of alternatives_to_offer with its nightly rate in the same reply — do not merely ask whether they would like an alternative."
          : "The category the guest named cannot be sold and nothing else fits either. Say that plainly and offer to pass the request to the reservations desk."
        : null,
    budget_per_night: budget,
    budget_instruction: budget
      ? [
          `The guest's ceiling is ${budget.toLocaleString("vi-VN")} ${hotel.currency} a night.`,
          "Categories flagged over_budget must not be offered or described as suitable; if none remain, say so plainly.",
          // The model once wrote "trong ngân sách của bạn" and then, one sentence
          // later, that both rooms were 140.000 over it. Naming the exact gap per
          // row removes the room for that contradiction.
          options.some((o) => o.over_budget)
            ? `Over the ceiling right now: ${options
                .filter((o) => o.over_budget)
                .map(
                  (o) =>
                    `${o.room_type} is ${(o.rate_per_night - budget).toLocaleString("vi-VN")} ${hotel.currency} a night above it`,
                )
                .join("; ")}. Say the gap before anything else about these categories, and never put "trong ngân sách", "phù hợp ngân sách" or "within budget" in the same sentence as one of them.`
            : null,
        ]
          .filter(Boolean)
          .join(" ")
      : null,
    note:
      sellable.length > 0
        ? `Totals are room only, ${nights} night(s) × ${rooms} room(s), before the deposit taken at check-in. A category is only sellable if available ≥ rooms requested and it fits the party.`
        : "Nothing in the requested window fits both availability and the occupancy limits. Offer alternative dates or split the party across rooms — do not confirm anything.",
    warnings: v.warnings,
  };
}

/**
 * Nightly rate for a category. Taken from a live reservation on that category
 * where one exists, so quotes match what the property is actually charging.
 */
function rateFor(type: string, inType: Room[]): number {
  const published = inType.find((r) => (r.baseRate ?? 0) > 0)?.baseRate ?? 0;
  if (published > 0) return published;
  const ids = new Set(inType.map((r) => r.id));
  const res = storage
    .listReservations()
    .filter((r) => r.roomId != null && ids.has(r.roomId) && r.ratePerNight > 0)
    .sort((a, b) => b.checkIn.localeCompare(a.checkIn));
  return res[0]?.ratePerNight ?? 0;
}

/**
 * A nightly ceiling the guest stated in their own words, in VND.
 * "ngân sách 2.500.000", "tối đa 2,5 triệu", "under 3 million a night", "dưới 2tr5".
 * Returns null when no ceiling was expressed — never a guess.
 */
export function extractBudget(text: string): number | null {
  const t = text.toLowerCase().replace(/\s+/g, " ");
  if (!/(ngân sách|tối đa|dưới|không quá|khoảng|budget|max(imum)?|under|below|no more than|up to)/.test(t))
    return null;
  const found: number[] = [];
  // 2.500.000 / 2,500,000 / 2500000
  for (const m of t.matchAll(/(\d{1,3}(?:[.,]\d{3}){1,3}|\d{6,9})\s*(vnd|vnđ|đ|d\b)?/g)) {
    const n = Number(m[1].replace(/[.,]/g, ""));
    if (n >= 100_000 && n <= 100_000_000) found.push(n);
  }
  // 2,5 triệu / 2.5 million / 3 triệu / 2tr5 / 2tr
  for (const m of t.matchAll(/(\d+(?:[.,]\d+)?)\s*(triệu|trieu|million|tr\b)/g)) {
    const n = Math.round(Number(m[1].replace(",", ".")) * 1_000_000);
    if (n >= 100_000 && n <= 100_000_000) found.push(n);
  }
  for (const m of t.matchAll(/(\d+)\s*tr\s*(\d)/g)) {
    found.push(Number(m[1]) * 1_000_000 + Number(m[2]) * 100_000);
  }
  if (!found.length) return null;
  return Math.max(...found);
}

/* -------------------------------------------------------------- write paths */

function code(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `VPNT-${out}`;
}

export type CreateResult =
  | { ok: false; validation?: Validation; problems?: Problem[]; missing?: Problem[] }
  | {
      ok: true;
      confirmation_code: string;
      room_number: string;
      room_type: string;
      check_in: string;
      check_out: string;
      nights: number;
      adults: number;
      children: number;
      rate_per_night: number;
      total_room_charge: number;
      currency: string;
      deposit_due_at_check_in: number;
      status: string;
      warnings: Problem[];
    };

/**
 * Create a real reservation. Refuses on any validation problem, on missing
 * identity, and when the category is not actually free for the window.
 */
export function createReservation(
  req: StayRequest & { guestName?: string; guestPhone?: string; guestLang?: string },
): CreateResult {
  const v = validateStayRequest(req);
  const missing: Problem[] = [...v.missing];
  if (!req.guestName || req.guestName.trim().length < 2)
    missing.push({
      code: "MISSING_GUEST_NAME",
      field: "guest_name",
      message: "No guest name. The name on the booking must match the ID shown at check-in.",
      suggestion: "Ask for the full name as printed on the passport or ID card.",
    });
  const nameLooksReal =
    !!req.guestName &&
    req.guestName.trim().split(/\s+/).length >= 2 &&
    !/^(website enquiry|bench|guest|khách|test)\b/i.test(req.guestName.trim()) &&
    !/[0-9@]/.test(req.guestName);
  if (req.guestName && !nameLooksReal)
    missing.push({
      code: "INVALID_GUEST_NAME",
      field: "guest_name",
      message: `"${req.guestName}" is not a usable name for a booking — it must be the guest's own full name as printed on their ID.`,
      suggestion: "Ask the guest to type their full name; never take it from a chat profile or invent one.",
    });
  const phoneLooksReal = !!req.guestPhone && /^[+()\d\s.-]{8,20}$/.test(req.guestPhone.trim());
  if (req.guestPhone && !phoneLooksReal)
    missing.push({
      code: "INVALID_GUEST_PHONE",
      field: "guest_phone",
      message: `"${req.guestPhone}" is not a usable phone number.`,
      suggestion: "Ask the guest for the number they can be reached on, and never reuse a placeholder from the chat profile.",
    });
  if (!req.guestPhone || req.guestPhone.replace(/\D/g, "").length < 8)
    missing.push({
      code: "MISSING_GUEST_PHONE",
      field: "guest_phone",
      message: "No contact number for the booking.",
      suggestion: "Ask for a phone number reachable on the day of arrival.",
    });
  if (!req.roomType)
    missing.push({
      code: "MISSING_ROOM_TYPE",
      field: "room_type",
      message: "No room category chosen.",
      suggestion: "Show what is available for those dates and let the guest pick.",
    });

  if (missing.length > 0 || v.problems.length > 0)
    return { ok: false, validation: v, problems: v.problems, missing };

  const n = v.normalised!;
  const avail = searchAvailability({ ...req, roomType: n.roomType });
  if (!avail.ok) return { ok: false, validation: avail.validation };
  const row = avail.options.find((o) => o.room_type === n.roomType);
  if (!row || row.available < n.rooms)
    return {
      ok: false,
      problems: [
        {
          code: "NOT_AVAILABLE",
          message: `${n.roomType} has ${row?.available ?? 0} room(s) free for ${n.checkIn} → ${n.checkOut}; ${n.rooms} requested.`,
          suggestion: "Offer another category or other dates, and do not hold anything.",
        },
      ],
    };
  if (!row.fits_party)
    return {
      ok: false,
      problems: [
        { code: "OVER_OCCUPANCY", message: `Party does not fit ${n.roomType}: ${row.occupancy_limit}.` },
      ],
    };
  if (n.rooms > 1)
    return {
      ok: false,
      problems: [
        {
          code: "MULTI_ROOM_NOT_SUPPORTED",
          message: `A ${n.rooms}-room booking has to be built by the reservations team so the rooms are linked.`,
          suggestion: "Escalate with the dates, party and category.",
        },
      ],
    };

  const hotel = storage.getHotel();
  const all = storage.listRooms();
  const liveRes = storage.listReservations().filter((r) => overlaps(r, n.checkIn, n.checkOut));
  const busy = new Set(liveRes.map((r) => r.roomId).filter((x): x is number => x != null));
  const room = all.find(
    (r) => r.type === n.roomType && r.status !== "out_of_order" && !busy.has(r.id),
  )!;

  // Reuse the guest profile when the phone number is already on file.
  const digits = req.guestPhone!.replace(/\D/g, "");
  const existing = storage.listGuests().find((g) => g.phone.replace(/\D/g, "") === digits);
  const guest =
    existing ??
    storage.createGuest({
      name: req.guestName!.trim(),
      phone: req.guestPhone!.trim(),
      email: null,
      lang: req.guestLang ?? "vi",
      vipTier: "none",
      preferences: JSON.stringify([]),
      notes: null,
      staysCount: 0,
    });

  const cc = code();
  const total = row.rate_per_night * n.nights;
  const res = storage.createReservation({
    hotelId: hotel.id,
    guestId: guest.id,
    roomId: room.id,
    confirmationCode: cc,
    checkIn: n.checkIn,
    checkOut: n.checkOut,
    checkOutTime: hotel.checkOutTime,
    adults: n.adults,
    children: n.childAges.length,
    ratePerNight: row.rate_per_night,
    status: "confirmed",
    source: "ai_agent",
  });
  storage.addCharge({
    reservationId: res.id,
    description: `Room ${room.number} (${room.type}) — ${n.nights} night(s) @ ${row.rate_per_night.toLocaleString("vi-VN")}`,
    amount: total,
    category: "room",
    createdAt: nowIso(),
  });
  storage.logEvent({
    type: "reservation.created",
    actor: "ai",
    summary: `Reservation ${cc} created for ${guest.name}: ${n.checkIn} → ${n.checkOut}, ${room.type} room ${room.number}.`,
    payload: JSON.stringify({ code: cc, nights: n.nights, total }),
    conversationId: null,
    createdAt: nowIso(),
  });

  const deposit = /villa/i.test(room.type) ? 3_000_000 : 1_000_000;
  return {
    ok: true,
    confirmation_code: cc,
    room_number: room.number,
    room_type: room.type,
    check_in: n.checkIn,
    check_out: n.checkOut,
    nights: n.nights,
    adults: n.adults,
    children: n.childAges.length,
    rate_per_night: row.rate_per_night,
    total_room_charge: total,
    currency: hotel.currency,
    deposit_due_at_check_in: deposit,
    status: "confirmed",
    warnings: v.warnings,
  };
}

export type ChangeResult =
  | { ok: false; problems: Problem[]; missing?: Problem[]; validation?: Validation }
  | {
      ok: true;
      confirmation_code: string;
      previous: { check_in: string; check_out: string; nights: number };
      updated: { check_in: string; check_out: string; nights: number };
      rate_per_night: number;
      previous_room_charge: number;
      new_room_charge: number;
      difference: number;
      currency: string;
      note: string;
      warnings: Problem[];
    };

/** Move the dates of an existing reservation, with the same validation. */
export function changeReservationDates(input: {
  confirmationCode: string;
  checkIn?: string;
  checkOut?: string;
  nights?: number;
}): ChangeResult {
  const res = storage.getReservationByCode(input.confirmationCode);
  if (!res)
    return {
      ok: false,
      problems: [
        {
          code: "RESERVATION_NOT_FOUND",
          message: `No reservation with code ${input.confirmationCode}.`,
          suggestion: "Ask the guest to re-read the code from the confirmation email.",
        },
      ],
    };
  if (res.status === "checked_out" || res.status === "cancelled")
    return {
      ok: false,
      problems: [
        {
          code: "RESERVATION_CLOSED",
          message: `Reservation ${res.confirmationCode} is ${res.status} and cannot be modified.`,
          suggestion: "Offer to take a new booking or escalate for a retroactive change.",
        },
      ],
    };

  const checkIn = input.checkIn ?? res.checkIn;
  const v = validateStayRequest({
    checkIn,
    checkOut: input.checkOut,
    nights: input.nights,
    adults: res.adults,
    children: res.children,
    childAges: Array.from({ length: res.children }, () => 6),
    rooms: 1,
    roomType: storage.getRoom(res.roomId)?.type,
    existingStay: true,
  });
  if (!v.valid || !v.normalised)
    return { ok: false, problems: v.problems, missing: v.missing, validation: v };

  const n = v.normalised;
  // In-house guests cannot move their arrival; that is a new stay.
  if (res.status === "in_house" && n.checkIn !== res.checkIn)
    return {
      ok: false,
      problems: [
        {
          code: "ALREADY_IN_HOUSE",
          message: `The guest is already in house since ${res.checkIn}, so the arrival date cannot be changed.`,
          suggestion: "Offer to extend or shorten the departure date instead.",
        },
      ],
    };

  // The assigned room must be free for the new window, ignoring this booking.
  const clash = storage
    .listReservations()
    .find((r) => r.id !== res.id && r.roomId === res.roomId && overlaps(r, n.checkIn, n.checkOut));
  if (clash)
    return {
      ok: false,
      problems: [
        {
          code: "ROOM_NOT_FREE",
          message: `Room ${storage.getRoom(res.roomId)?.number} is already sold from ${clash.checkIn} to ${clash.checkOut}.`,
          suggestion: "Offer to move the guest to another room of the same category, or other dates.",
        },
      ],
    };

  const hotel = storage.getHotel();
  const before = { check_in: res.checkIn, check_out: res.checkOut, nights: nightsBetween(res.checkIn, res.checkOut) };
  storage.updateReservation(res.id, { checkIn: n.checkIn, checkOut: n.checkOut });
  const prevCharge = res.ratePerNight * before.nights;
  const newCharge = res.ratePerNight * n.nights;
  storage.addCharge({
    reservationId: res.id,
    description: `Date change ${before.check_in}→${before.check_out} to ${n.checkIn}→${n.checkOut} — room charge adjusted`,
    amount: newCharge - prevCharge,
    category: "room",
    createdAt: nowIso(),
  });
  storage.logEvent({
    type: "reservation.dates_changed",
    actor: "ai",
    summary: `${res.confirmationCode}: ${before.check_in}→${before.check_out} became ${n.checkIn}→${n.checkOut}.`,
    payload: JSON.stringify({ before, after: n }),
    conversationId: null,
    createdAt: nowIso(),
  });

  return {
    ok: true,
    confirmation_code: res.confirmationCode,
    previous: before,
    updated: { check_in: n.checkIn, check_out: n.checkOut, nights: n.nights },
    rate_per_night: res.ratePerNight,
    previous_room_charge: prevCharge,
    new_room_charge: newCharge,
    difference: newCharge - prevCharge,
    currency: hotel.currency,
    note:
      newCharge === prevCharge
        ? "Same number of nights, so the room charge is unchanged."
        : newCharge > prevCharge
          ? "The extra night(s) have been added to the folio at the same nightly rate."
          : "The folio has been credited for the night(s) removed. A rate-plan penalty may still apply — the front desk confirms that.",
    warnings: v.warnings,
  };
}
