/**
 * Deterministic policy engine.
 *
 * Every number the agent quotes for late departure, early arrival, occupancy or
 * deposits is computed here from the `policies` table — never by the language
 * model. Each function returns the band it landed in, the arithmetic it did and
 * the source URL of the rule it applied, so the reply can cite it and staff can
 * audit it in the tool trace.
 */
import { storage } from "./storage";
import type { Policy } from "@shared/schema";

export type Band = { from: string; to: string; pct: number; label: string };

function rulesOf(code: string): { policy: Policy; rules: any } | null {
  const policy = storage.getPolicy(code);
  if (!policy) return null;
  let rules: any = {};
  try {
    rules = JSON.parse(policy.rules || "{}");
  } catch {
    rules = {};
  }
  return { policy, rules };
}

function isHHMM(s: string) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

function toMinutes(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function roundVnd(n: number) {
  return Math.round(n / 1000) * 1000;
}

function pickBand(bands: Band[], hhmm: string): Band | null {
  const t = toMinutes(hhmm);
  for (const b of bands) {
    if (t >= toMinutes(b.from) && t <= toMinutes(b.to)) return b;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Late departure
 * ------------------------------------------------------------------ */

export type LateCheckoutQuote = {
  quoted: boolean;
  error?: string;
  requested_time?: string;
  standard_checkout_time?: string;
  hours_beyond_standard?: number;
  band?: string;
  percent_of_package_rate?: number;
  package_rate_per_night?: number;
  fee?: number;
  currency?: string;
  charged_per?: string;
  party_size_affects_fee?: boolean;
  waiver?: string | null;
  availability?: string;
  max_possible_time?: string | null;
  how_to_answer?: string;
  calculation?: string;
  policy?: { code: string; title: string; source: string; source_url: string };
  internal_rule?: { code: string; title: string; note: string } | null;
};

export function quoteLateCheckout(input: {
  requestedTime: string;
  ratePerNight: number;
  currency: string;
  vipTier: string;
  roomResoldSameDay: boolean;
  adults?: number;
  children?: number;
  standardCheckoutTime?: string;
}): LateCheckoutQuote {
  const found = rulesOf("LATE_CHECKOUT");
  if (!found) return { quoted: false, error: "LATE_CHECKOUT policy is not loaded." };
  const { policy, rules } = found;
  const want = String(input.requestedTime || "").trim();
  if (!isHHMM(want)) return { quoted: false, error: "requested_time must be HH:MM in 24-hour form." };

  const standard = input.standardCheckoutTime || rules.standard_checkout_time || "12:00";
  if (toMinutes(want) <= toMinutes(standard)) {
    return {
      quoted: true,
      requested_time: want,
      standard_checkout_time: standard,
      hours_beyond_standard: 0,
      band: "within standard checkout",
      percent_of_package_rate: 0,
      fee: 0,
      currency: input.currency,
      calculation: `${want} is not later than the standard checkout ${standard}, so no late-departure charge applies.`,
      policy: {
        code: policy.code,
        title: policy.title,
        source: policy.sourceTitle,
        source_url: policy.sourceUrl,
      },
      internal_rule: null,
    };
  }

  const bands: Band[] = rules.bands ?? [];
  const band = pickBand(bands, want);
  if (!band)
    return {
      quoted: false,
      error: `No published band covers ${want}. Escalate to the front desk instead of quoting.`,
    };

  const gross = (input.ratePerNight * band.pct) / 100;
  let fee = roundVnd(gross);

  // Discretionary loyalty waiver — an Aurea-side rule, flagged as such.
  const loyalty = rulesOf("LOYALTY_LATE_CHECKOUT");
  let waiver: string | null = null;
  let internalRule: LateCheckoutQuote["internal_rule"] = null;
  if (loyalty) {
    const tiers: string[] = loyalty.rules.tiers ?? [];
    const until: string = loyalty.rules.free_until ?? "14:00";
    if (tiers.includes(input.vipTier) && toMinutes(want) <= toMinutes(until)) {
      fee = 0;
      waiver = `${input.vipTier} tier — departure up to ${until} waived as a goodwill gesture`;
      internalRule = {
        code: loyalty.policy.code,
        title: loyalty.policy.title,
        note: loyalty.policy.sourceTitle,
      };
    }
  }

  const maxPossible = input.roomResoldSameDay ? (rules.max_when_room_resold ?? "14:00") : null;
  const blocked = !!maxPossible && toMinutes(want) > toMinutes(maxPossible);

  const hours = Math.round(((toMinutes(want) - toMinutes(standard)) / 60) * 10) / 10;

  return {
    quoted: true,
    requested_time: want,
    standard_checkout_time: standard,
    hours_beyond_standard: hours,
    band: band.label,
    percent_of_package_rate: band.pct,
    package_rate_per_night: input.ratePerNight,
    fee,
    currency: input.currency,
    charged_per: rules.charged_per ?? "per room, per stay",
    party_size_affects_fee: false,
    waiver,
    availability: blocked
      ? `The room is occupied again the same day, so departure cannot go beyond ${maxPossible}.`
      : "Subject to room availability on the day — the front desk confirms it at departure.",
    max_possible_time: blocked ? maxPossible : null,
    how_to_answer:
      "State the band, the amount and what it is charged per, and say the front desk confirms the time on the day. Do not offer to check, hold, arrange or guarantee the time yourself, and do not attach conditions the policy does not contain.",
    calculation: waiver
      ? `${want} falls in the ${band.label} band (${band.pct}% of the package rate = ${roundVnd(gross).toLocaleString("vi-VN")} ${input.currency}), waived to 0 by the loyalty rule.`
      : `${want} falls in the ${band.label} band: ${band.pct}% × ${input.ratePerNight.toLocaleString("vi-VN")} ${input.currency} package rate = ${fee.toLocaleString("vi-VN")} ${input.currency}. Charged ${rules.charged_per ?? "per room"}, so the number of guests in the room does not change it.`,
    policy: {
      code: policy.code,
      title: policy.title,
      source: policy.sourceTitle,
      source_url: policy.sourceUrl,
    },
    internal_rule: internalRule,
  };
}

/* ------------------------------------------------------------------ *
 * Early arrival
 * ------------------------------------------------------------------ */

export function quoteEarlyCheckin(input: {
  requestedTime: string;
  ratePerNight: number;
  currency: string;
  standardCheckinTime?: string;
}) {
  const found = rulesOf("EARLY_CHECKIN");
  if (!found) return { quoted: false, error: "EARLY_CHECKIN policy is not loaded." };
  const { policy, rules } = found;
  const want = String(input.requestedTime || "").trim();
  if (!isHHMM(want)) return { quoted: false, error: "requested_time must be HH:MM in 24-hour form." };

  const standard = input.standardCheckinTime || rules.standard_checkin_time || "14:00";
  const cite = {
    code: policy.code,
    title: policy.title,
    source: policy.sourceTitle,
    source_url: policy.sourceUrl,
  };

  if (toMinutes(want) >= toMinutes(standard))
    return {
      quoted: true,
      requested_time: want,
      standard_checkin_time: standard,
      fee: 0,
      currency: input.currency,
      band: "standard check-in",
      calculation: `${want} is at or after the standard check-in ${standard}, so no early-arrival charge applies.`,
      policy: cite,
    };

  const band = pickBand(rules.bands ?? [], want);
  if (!band)
    return {
      quoted: true,
      requested_time: want,
      standard_checkin_time: standard,
      fee: 0,
      currency: input.currency,
      band: "free early-arrival window",
      availability: "Subject to a room being ready — the front desk must confirm.",
      calculation: `${want} is inside the free early-arrival window (no published percentage applies below the standard check-in time), so there is no charge, only an availability check.`,
      policy: cite,
    };

  const fee = roundVnd((input.ratePerNight * band.pct) / 100);
  return {
    quoted: true,
    requested_time: want,
    standard_checkin_time: standard,
    band: band.label,
    percent_of_package_rate: band.pct,
    package_rate_per_night: input.ratePerNight,
    fee,
    currency: input.currency,
    payable: rules.payable ?? "immediately once the early arrival is confirmed",
    availability: "Early arrival must be confirmed in advance and is subject to availability.",
    calculation: `${want} falls in the ${band.label} band: ${band.pct}% × ${input.ratePerNight.toLocaleString("vi-VN")} ${input.currency} = ${fee.toLocaleString("vi-VN")} ${input.currency}.`,
    policy: cite,
  };
}

/* ------------------------------------------------------------------ *
 * Occupancy / extra beds
 * ------------------------------------------------------------------ */

export function checkOccupancy(input: {
  unit: "room" | "villa";
  adults: number;
  childAges?: number[];
  bedrooms?: number;
}) {
  const found = rulesOf("OCCUPANCY");
  if (!found) return { ok: false, error: "OCCUPANCY policy is not loaded." };
  const { policy, rules } = found;
  const adults = Math.max(0, Math.floor(input.adults || 0));
  const ages = (input.childAges ?? []).map((a) => Number(a)).filter((a) => !Number.isNaN(a));
  const bedrooms = Math.max(1, Math.floor(input.bedrooms ?? 1));
  const cite = {
    code: policy.code,
    title: policy.title,
    source: policy.sourceTitle,
    source_url: policy.sourceUrl,
  };

  const under4 = ages.filter((a) => a < 4).length;
  const child4to11 = ages.filter((a) => a >= 4 && a < 12).length;
  const counted12plus = ages.filter((a) => a >= 12).length;
  const adultEquivalent = adults + counted12plus;

  if (input.unit === "villa") {
    const perBedroom = rules.villa ?? {};
    const maxAdults = (perBedroom.adults_per_bedroom ?? 2) * bedrooms;
    const maxChildrenUnder12 = (perBedroom.children_under_12_per_bedroom ?? 2) * bedrooms;
    const childrenUnder12 = under4 + child4to11;
    const withinAdults = adultEquivalent <= maxAdults;
    const withinChildren = childrenUnder12 <= maxChildrenUnder12;
    return {
      ok: withinAdults && withinChildren,
      unit: "villa",
      bedrooms,
      party: { adults, children_by_age: ages, adults_or_12_plus: adultEquivalent },
      limit: `${perBedroom.adults_per_bedroom ?? 2} adults + ${perBedroom.children_under_12_per_bedroom ?? 2} children under 12 per bedroom → ${maxAdults} adults + ${maxChildrenUnder12} children for ${bedrooms} bedroom(s)`,
      within_limit: withinAdults && withinChildren,
      extra_bed: perBedroom.extra_bed ?? "not available in villas",
      package_includes: `${perBedroom.package_default_adults_per_bedroom ?? 2} adults per bedroom`,
      surcharge_applies: adultEquivalent > (perBedroom.package_default_adults_per_bedroom ?? 2) * bedrooms || child4to11 > 0,
      surcharge_amount: null,
      surcharge_note: rules.surcharge_note,
      age_rule_when_no_document: rules.age_by_height,
      policy: cite,
    };
  }

  const room = rules.hotel_room ?? {};
  const maxTotal = room.max_occupants_including_children_under_4 ?? 4;
  const total = adultEquivalent + under4 + child4to11;
  const packageAdults = room.package_default_adults ?? 2;
  return {
    ok: total <= maxTotal,
    unit: "room",
    party: {
      adults,
      children_by_age: ages,
      counted_as_adult_12_plus: counted12plus,
      children_4_to_under_12: child4to11,
      children_under_4: under4,
      total_occupants: total,
    },
    limit: `${maxTotal} occupants per room including children under 4 (${(room.allowed_combinations ?? []).join(" or ")})`,
    within_limit: total <= maxTotal,
    rooms_needed: Math.ceil(total / maxTotal),
    max_extra_beds: room.max_extra_beds ?? 1,
    extra_bed_note: room.extra_bed_note,
    package_includes: `${packageAdults} adults`,
    surcharge_applies: adultEquivalent > packageAdults || child4to11 > 0,
    surcharge_amount: null,
    surcharge_note: rules.surcharge_note,
    age_rule_when_no_document: rules.age_by_height,
    policy: cite,
  };
}

/* ------------------------------------------------------------------ *
 * Generic structured lookup
 * ------------------------------------------------------------------ */

export const POLICY_TOPICS = [
  "checkout",
  "checkin",
  "occupancy",
  "deposit",
  "payment",
  "conduct",
  "booking",
  "dispute",
  "privacy",
] as const;

export function getPolicyByTopic(topic: string) {
  const list = topic === "all" ? storage.listPolicies() : storage.policiesByTopic(topic);
  if (!list.length)
    return {
      found: false,
      note: `No policy record for topic "${topic}". Topics available: ${POLICY_TOPICS.join(", ")}.`,
    };
  return {
    found: true,
    policies: list.map((p) => ({
      code: p.code,
      topic: p.topic,
      title: p.title,
      summary: p.summary,
      rules: JSON.parse(p.rules || "{}"),
      source: p.sourceTitle,
      source_url: p.sourceUrl,
      updated_at: p.updatedAt,
    })),
  };
}
