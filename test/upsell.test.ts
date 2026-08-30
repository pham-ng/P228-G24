/**
 * Conversion accounting for the upsell suggestions, and the rule that keeps the
 * feature on the hosted path only.
 *
 * Pure: no database, no model — impressions and bookings are inputs.
 *
 * SCOPE, because this is easy to get wrong twice:
 *
 * Upselling is a HOSTED-PATH feature by deliberate decision. `suggest_experiences`
 * sits in `OPENAI_ONLY_TOOLS` (server/agent.ts) because the 4B local model drops
 * qualifying conditions, mangles arithmetic in prose, and turns a suggestion into
 * a hard sell — a clumsy upsell costs more trust than the feature earns — and
 * because the tool block has to fit the 8K context the offline path lives in.
 * The offline concierge answers room questions from the catalogue instead.
 *
 * So there is deliberately NO offline renderer here. An earlier draft of this
 * file imported a `server/upsell-line` module that would have templated an offer
 * sentence onto local replies; that module was never written, and reinstating it
 * would quietly reverse the decision above. The last block of this file pins the
 * decision down so it cannot be reversed by accident.
 *
 *   npx tsx test/upsell.test.ts
 */
import { upsellMetrics } from "../server/upsell-metrics";
import { toolsForProvider } from "../server/agent";
import { upsellAllowed, UPSELL_COOLDOWN_TURNS, type UpsellGate } from "../server/crosssell";
import type { ServiceBooking, UpsellImpression } from "@shared/schema";

let failures = 0;
function ok(cond: boolean, msg: string) {
  if (cond) console.log(`  PASS  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}

let nextId = 1;
const imp = (o: Partial<UpsellImpression> & { reservationId: number; serviceId: number }): UpsellImpression =>
  ({
    id: nextId++,
    hotelId: 1,
    conversationId: 1,
    serviceName: `svc-${o.serviceId}`,
    position: 1,
    score: 6,
    why: "",
    dayPart: "morning",
    stayPhase: "mid_stay",
    wet: 0,
    price: 1000,
    createdAt: "2026-08-22T09:00:00.000Z",
    ...o,
  }) as UpsellImpression;

const bk = (o: Partial<ServiceBooking> & { reservationId: number; serviceId: number }): ServiceBooking =>
  ({
    id: nextId++,
    date: "2026-08-22",
    slot: "14:00",
    partySize: 1,
    status: "confirmed",
    createdAt: "2026-08-22T14:00:00.000Z",
    amount: 1000,
    ...o,
  }) as ServiceBooking;

console.log("=== ATTRIBUTION ===");

const basic = upsellMetrics(
  [imp({ reservationId: 1, serviceId: 10 }), imp({ reservationId: 2, serviceId: 10 })],
  [bk({ reservationId: 1, serviceId: 10 })],
);
ok(basic.impressions === 2, "both impressions counted");
ok(basic.conversions === 1, "only the reservation that booked converts");
ok(basic.attachRate === 0.5, "attach rate is booked guests over shown guests");
ok(basic.revenue === 1000, "revenue comes from the booking amount, not the list price");

const wrongService = upsellMetrics(
  [imp({ reservationId: 1, serviceId: 10 })],
  [bk({ reservationId: 1, serviceId: 99 })],
);
ok(wrongService.conversions === 0, "booking a different service is not a conversion");

const wrongGuest = upsellMetrics(
  [imp({ reservationId: 1, serviceId: 10 })],
  [bk({ reservationId: 2, serviceId: 10 })],
);
ok(wrongGuest.conversions === 0, "another guest's booking is not credited");

/* The direction of time is the whole difference between "the suggestion sold
   this" and "the guest had already bought it". */
const before = upsellMetrics(
  [imp({ reservationId: 1, serviceId: 10, createdAt: "2026-08-22T15:00:00.000Z" })],
  [bk({ reservationId: 1, serviceId: 10, createdAt: "2026-08-22T14:00:00.000Z" })],
);
ok(before.conversions === 0, "a booking made BEFORE the offer is never credited to it");

const cancelled = upsellMetrics(
  [imp({ reservationId: 1, serviceId: 10 })],
  [bk({ reservationId: 1, serviceId: 10, status: "cancelled" })],
);
ok(cancelled.conversions === 0, "a cancelled booking is not a sale");

/* Repetition must not inflate the numbers: showing the same guest the same
   service three times and selling once is one sale out of three impressions. */
const repeated = upsellMetrics(
  [
    imp({ reservationId: 1, serviceId: 10, createdAt: "2026-08-22T09:00:00.000Z" }),
    imp({ reservationId: 1, serviceId: 10, createdAt: "2026-08-22T10:00:00.000Z" }),
    imp({ reservationId: 1, serviceId: 10, createdAt: "2026-08-22T11:00:00.000Z" }),
  ],
  [bk({ reservationId: 1, serviceId: 10 })],
);
ok(repeated.impressions === 3 && repeated.conversions === 1, "one sale is credited once, not once per impression");
ok(repeated.perOffer[0].conversion === 1 / 3, "per-offer conversion is sales over times shown");
ok(repeated.attachRate === 1, "attach rate is per guest, so this guest is fully attached");

console.log("=== SLICES ===");
const sliced = upsellMetrics(
  [
    imp({ reservationId: 1, serviceId: 10, position: 1, wet: 1 }),
    imp({ reservationId: 2, serviceId: 11, position: 3, wet: 0, dayPart: "evening" }),
  ],
  [bk({ reservationId: 1, serviceId: 10 })],
);
ok(sliced.byPosition.find((p) => p.position === 1)!.conversion === 1, "position 1 conversion tracked");
ok(sliced.byPosition.find((p) => p.position === 3)!.conversion === 0, "position 3 conversion tracked");
ok(sliced.byContext.find((c) => c.context === "rain")!.booked === 1, "the rain rule can be judged on its own");
ok(sliced.byContext.some((c) => c.context === "evening"), "dry turns are sliced by day part");

ok(upsellMetrics([], []).attachRate === 0, "no impressions divides by zero safely");

console.log("=== WHEN TO STAY QUIET ===");
/* The model decides when to call `suggest_experiences`, and it cannot see that
   the guest's last message tripped a guard flag or that the conversation is
   already marked unhappy. Until this gate existed, nothing stopped a spa offer
   landing on top of a complaint. */
const calm: UpsellGate = {
  escalated: false,
  flagged: false,
  sentiment: "neutral",
  turnsSinceLast: null,
  stayPhase: "mid_stay",
  dayPart: "afternoon",
};
ok(upsellAllowed(calm).ok, "a calm mid-stay afternoon may carry an offer");

ok(!upsellAllowed({ ...calm, escalated: true }).ok, "never upsell on a turn that went to a human");
ok(upsellAllowed({ ...calm, escalated: true }).reason === "escalated", "and the logged reason names the handoff");
ok(!upsellAllowed({ ...calm, flagged: true }).ok, "never upsell alongside a guard flag");
ok(!upsellAllowed({ ...calm, sentiment: "negative" }).ok, "never upsell to an unhappy guest");
ok(!upsellAllowed({ ...calm, stayPhase: "departure_day" }).ok, "never upsell to someone checking out");
ok(!upsellAllowed({ ...calm, dayPart: "night" }).ok, "never upsell in the middle of the night");

/* A positive guest is still a guest, and an unjudged conversation is not
   evidence of anything — neither may be treated as a reason to stay silent. */
ok(upsellAllowed({ ...calm, sentiment: "positive" }).ok, "a happy guest may be offered something");
ok(upsellAllowed({ ...calm, sentiment: null }).ok, "an unjudged conversation is not treated as unhappy");
ok(upsellAllowed({ ...calm, stayPhase: "arrival_day" }).ok, "arrival day is a fine time to suggest");

console.log("=== COOLDOWN ===");
ok(upsellAllowed({ ...calm, turnsSinceLast: null }).ok, "never offered before means no cooldown");
for (let t = 0; t < UPSELL_COOLDOWN_TURNS; t++)
  ok(!upsellAllowed({ ...calm, turnsSinceLast: t }).ok, `${t} turn(s) after the last offer is too soon`);
ok(upsellAllowed({ ...calm, turnsSinceLast: UPSELL_COOLDOWN_TURNS }).ok, "after the cooldown it may ask again");
ok(upsellAllowed({ ...calm, turnsSinceLast: 99 }).ok, "and long afterwards too");

/* Reasons are ordered so the one that gets logged is the real cause. A guest
   who is both unhappy AND escalated was escalated because they were unhappy;
   reporting "cooldown" there would send someone reading the logs the wrong way. */
ok(
  upsellAllowed({ ...calm, escalated: true, sentiment: "negative", turnsSinceLast: 0 }).reason === "escalated",
  "the people-first reason wins when several apply",
);

/* Deliberately NOT ported from the earlier offline design: a language gate.
   That design templated the sentence, so a language with no template meant no
   offer. The hosted model writes the sentence itself, so refusing to sell to a
   Korean guest would be enforcing a constraint that no longer exists. */
ok(
  upsellAllowed({ ...calm }).ok && !("lang" in calm),
  "the gate does not judge language — the hosted model renders the sentence",
);

console.log("=== UPSELL IS HOSTED-PATH ONLY ===");
/* The offline model never sees these three. This is the product decision, not
   an oversight, and it is asserted rather than described because the cost of
   reversing it silently is a 4B model hard-selling a guest in prose it cannot
   keep straight. If this ever needs to change, change it here first. */
const localTools = toolsForProvider("local").map((t) => t.function.name);
const hostedTools = toolsForProvider("openai").map((t) => t.function.name);
for (const t of ["suggest_experiences", "recommend_room_packages", "compare_room_types"]) {
  ok(!localTools.includes(t), `the offline model is not offered ${t}`);
  ok(hostedTools.includes(t), `the hosted model is offered ${t}`);
}
ok(localTools.length < hostedTools.length, "the offline tool block is the smaller one, as the 8K budget requires");
/* Everything the offline path DOES get must still be there — withholding the
   upsell tools must never quietly withhold the ones that answer questions. */
for (const t of ["escalate_to_human", "get_guest_profile", "request_medical_assistance"])
  ok(localTools.includes(t), `${t} is untouched by the upsell decision`);

console.log(failures === 0 ? "\nALL UPSELL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
