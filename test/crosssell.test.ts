/**
 * Unit tests for in-stay cross-sell and pre-arrival targeting.
 * Pure: no database, no model, no clock — the time of day is an input.
 *
 *   npx tsx test/crosssell.test.ts
 */

import {
  suggestInStay,
  preArrivalTargets,
  dayPartOf,
  phaseOf,
  nightsBetween,
  isWet,
  eligibleOffers,
} from "../server/crosssell";
import type { Service, Offer, Reservation } from "@shared/schema";

let failures = 0;
function ok(cond: boolean, msg: string) {
  if (cond) console.log(`  PASS  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}

const svc = (o: Partial<Service> & { id: number; name: string; category: string; price: number }): Service =>
  ({
    description: "",
    unit: "per person",
    dept: "spa",
    slots: JSON.stringify(["09:00", "14:00", "19:00"]),
    capacityPerSlot: 5,
    active: 1,
    images: "[]",
    ...o,
  }) as Service;

/* A catalogue shaped like the property's real one. */
const SERVICES: Service[] = [
  svc({ id: 1, name: "Akoya Spa — Balinese Massage 90'", category: "spa", price: 2300000 }),
  svc({ id: 2, name: "Lotus Restaurant — dinner buffet", category: "dining", price: 650000 }),
  svc({ id: 3, name: "Lotus Restaurant — lunch buffet", category: "dining", price: 650000 }),
  svc({ id: 4, name: "VinWonders Nha Trang — day ticket", category: "experience", price: 1050000 }),
  svc({ id: 5, name: "VinWonders — 2-day unlimited pass", category: "experience", price: 1280000 }),
  svc({ id: 6, name: "Beach & water sports desk", category: "experience", price: 0 }),
  svc({ id: 7, name: "In-room dining — Phở bò", category: "roomservice", price: 250000, slots: "[]" }),
  svc({ id: 8, name: "Aquafield Nha Trang — Korean sauna", category: "experience", price: 0 }),
];

const OFFERS: Offer[] = [
  { id: 1, hotelId: 1, title: "Ocean view upgrade", body: "Move up", segment: "in_house", price: 430000, active: 1 },
  { id: 2, hotelId: 1, title: "Akoya Spa 30%", body: "Members", segment: "vip", price: null, active: 1 },
  { id: 3, hotelId: 1, title: "Return-stay credit", body: "Next time", segment: "departing", price: null, active: 1 },
] as Offer[];

const GUEST = { vipTier: "platinum", preferences: "[]", staysCount: 2 };
const STAY = { checkIn: "2026-08-20", checkOut: "2026-08-25", status: "in_house" } as Reservation;

const base = {
  services: SERVICES,
  offers: OFFERS,
  guest: GUEST,
  reservation: STAY,
  today: "2026-08-22",
  lang: "vi" as const,
};

console.log("=== TIME & STAY HELPERS ===");
ok(dayPartOf("08:30") === "morning", "08:30 -> morning");
ok(dayPartOf("14:00") === "afternoon", "14:00 -> afternoon");
ok(dayPartOf("19:30") === "evening", "19:30 -> evening");
ok(dayPartOf("23:30") === "night", "23:30 -> night");
ok(nightsBetween("2026-08-22", "2026-08-25") === 3, "3 nights left");
ok(phaseOf(STAY, "2026-08-20") === "arrival_day", "arrival day detected");
ok(phaseOf(STAY, "2026-08-25") === "departure_day", "departure day detected");
ok(phaseOf(STAY, "2026-08-22") === "mid_stay", "mid stay detected");
ok(isWet({ rainChance: 80 }), "80% rain is wet");
ok(!isWet({ rainChance: 10 }), "10% rain is not wet");
ok(isWet({ condition: "Mưa rào" }), "Vietnamese 'mưa' detected");
ok(!isWet(undefined), "no forecast is not treated as rain");

console.log("=== TIME OF DAY ===");
const evening = suggestInStay({ ...base, clock: "19:00" });
ok(
  evening.suggestions.some((s) => /dinner/i.test(s.name)),
  "evening suggests the dinner buffet",
);
ok(
  !evening.suggestions.some((s) => /lunch/i.test(s.name)),
  "evening never suggests the lunch buffet",
);
const morning = suggestInStay({ ...base, clock: "08:00" });
ok(
  morning.suggestions.some((s) => /VinWonders|Beach/i.test(s.name)),
  "morning favours outdoor activities",
);
ok(evening.day_part === "evening" && morning.day_part === "morning", "day part reported back");

console.log("=== WEATHER ===");
const rainy = suggestInStay({ ...base, clock: "09:00", weather: { rainChance: 85 } });
ok(
  !rainy.suggestions.some((s) => /Beach|water sports/i.test(s.name)),
  "rain drops the beach and water sports",
);
ok(
  rainy.suggestions.some((s) => /Spa|sauna/i.test(s.name)),
  "rain promotes indoor spa / sauna",
);
ok(
  rainy.suggestions.every((s) => s.why.length > 0),
  "every suggestion explains itself",
);
ok(
  rainy.suggestions.some((s) => /mưa/i.test(s.why)),
  "the rain is given as the reason, in the guest's language",
);

console.log("=== STAY LENGTH ===");
/* A two-day pass a guest cannot finish is money taken for nothing. */
const lastNight = suggestInStay({
  ...base,
  clock: "09:00",
  today: "2026-08-24",
  reservation: { ...STAY, checkOut: "2026-08-25" } as Reservation,
});
ok(
  !lastNight.suggestions.some((s) => /2-day/i.test(s.name)),
  "a 2-day pass is not offered with only one night left",
);
const longStay = suggestInStay({ ...base, clock: "09:00", today: "2026-08-21" });
ok(longStay.nights_left === 4, "nights left computed from today, not from the booking length");

console.log("=== ALREADY BOOKED ===");
const booked = suggestInStay({ ...base, clock: "19:00", alreadyBooked: [2] });
ok(
  !booked.suggestions.some((s) => s.service_id === 2),
  "a service the guest already booked is never suggested again",
);

console.log("=== NOISE CONTROL ===");
ok(
  !suggestInStay({ ...base, clock: "19:00" }).suggestions.some((s) => s.category === "roomservice"),
  "in-room dining is a channel, not a pitch",
);
const cats = suggestInStay({ ...base, clock: "19:00", limit: 5 }).suggestions.map((s) => s.category);
ok(new Set(cats).size === cats.length, "at most one suggestion per category — advice, not a menu");
ok(suggestInStay({ ...base, clock: "19:00" }).suggestions.length <= 3, "never more than three suggestions");

console.log("=== INTEREST OVERRIDE ===");
const wantsSpa = suggestInStay({ ...base, clock: "09:00", interest: "massage" });
ok(wantsSpa.suggestions[0].category === "spa", "what the guest asked for outranks every other signal");

console.log("=== OFFERS ===");
const inHouse = eligibleOffers(OFFERS, GUEST, "mid_stay");
ok(inHouse.some((o) => /Ocean view/.test(o.title)), "in-house guest sees the in-house offer");
ok(inHouse.some((o) => /Akoya/.test(o.title)), "platinum guest sees the VIP offer");
ok(!inHouse.some((o) => /Return-stay/.test(o.title)), "departing offer withheld mid-stay");
const leaving = eligibleOffers(OFFERS, GUEST, "departure_day");
ok(leaving.some((o) => /Return-stay/.test(o.title)), "departing offer appears on departure day");
ok(!leaving.some((o) => /Ocean view/.test(o.title)), "an upgrade is not pitched to someone leaving");

console.log("=== PRE-ARRIVAL WINDOW ===");
const RES = (o: Partial<Reservation> & { id: number; checkIn: string; checkOut: string; status: string }) =>
  ({ hotelId: 1, guestId: 1, roomId: null, confirmationCode: `C${o.id}`, adults: 2, children: 0, ratePerNight: 1, source: "direct", checkOutTime: "12:00", ...o }) as any;

const targets = preArrivalTargets(
  [
    RES({ id: 1, checkIn: "2026-08-24", checkOut: "2026-08-28", status: "confirmed", guestName: "A", vipTier: "none" }), // 2 days
    RES({ id: 2, checkIn: "2026-08-25", checkOut: "2026-08-26", status: "confirmed", guestName: "B", vipTier: "platinum" }), // 3 days
    RES({ id: 3, checkIn: "2026-08-30", checkOut: "2026-08-31", status: "confirmed", guestName: "C" }), // 8 days — too early
    RES({ id: 4, checkIn: "2026-08-23", checkOut: "2026-08-24", status: "confirmed", guestName: "D" }), // 1 day — too late
    RES({ id: 5, checkIn: "2026-08-24", checkOut: "2026-08-26", status: "cancelled", guestName: "E" }), // cancelled
  ],
  "2026-08-22",
);
ok(targets.length === 2, `only the 48–72h window is targeted (got ${targets.length})`);
ok(!targets.some((t) => t.confirmationCode === "C5"), "a cancelled reservation is never contacted");
ok(!targets.some((t) => t.daysUntilArrival > 3 || t.daysUntilArrival < 2), "window bounds respected");
ok(targets[0].daysUntilArrival <= targets[1].daysUntilArrival, "soonest arrival first");
ok(
  targets.find((t) => t.confirmationCode === "C1")!.angle.includes("dài"),
  "a 4-night stay gets the long-stay angle",
);
ok(
  targets.find((t) => t.confirmationCode === "C2")!.angle.includes("hội viên"),
  "a platinum guest gets the member angle",
);
ok(targets.every((t) => t.angle.length > 0), "every target has a reason to be contacted");

console.log(failures === 0 ? "\nALL CROSS-SELL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
