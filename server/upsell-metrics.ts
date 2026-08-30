/**
 * Did the suggestions sell anything?
 *
 * The ranking in `crosssell.ts` was written from reasoning: rain favours the
 * spa, evening favours dinner, a guest who asked about massage should be shown
 * massage. Every one of those weights was plausible and none of them were
 * measured, which is the difference between a demo and a product. This module
 * is the measurement.
 *
 * Conversion is DERIVED rather than written at booking time. A booking is
 * credited to a suggestion when the same reservation books the same service
 * after it was shown; nothing writes back into `upsell_impressions`. That
 * matters because a second write path could disagree with `service_bookings`,
 * and the bookings table is the one that decides what the guest actually pays.
 *
 * The attribution window is deliberately generous — the whole stay, not a few
 * minutes. A guest who is told about the sunset cruise in the morning and books
 * it that evening was still sold by the suggestion; a short window would score
 * that as a failure and would push the weights toward whatever converts
 * instantly, which is not the same thing as whatever earns money.
 */
import type { ServiceBooking, UpsellImpression } from "@shared/schema";

export type OfferStat = {
  serviceId: number;
  name: string;
  shown: number;
  booked: number;
  /** booked / shown, 0-1. */
  conversion: number;
  /** Revenue from the credited bookings, in hotel currency. */
  revenue: number;
  avgScore: number;
  /** Mean rank when shown — position 1 converts better than position 3. */
  avgPosition: number;
};

export type UpsellMetrics = {
  impressions: number;
  /** Distinct reservations that were shown at least one suggestion. */
  guestsShown: number;
  /** Distinct reservations that took at least one suggestion. */
  guestsBooked: number;
  /** guestsBooked / guestsShown — the number the industry calls attach rate. */
  attachRate: number;
  conversions: number;
  revenue: number;
  perOffer: OfferStat[];
  /** Conversion by rank, to show whether position or relevance is doing the work. */
  byPosition: Array<{ position: number; shown: number; booked: number; conversion: number }>;
  /** Conversion split by the signal that earned the offer its place. */
  byContext: Array<{ context: string; shown: number; booked: number; conversion: number }>;
};

const pct = (n: number, d: number) => (d > 0 ? n / d : 0);

export function upsellMetrics(
  impressions: UpsellImpression[],
  bookings: ServiceBooking[],
): UpsellMetrics {
  /* Index the confirmed bookings by reservation+service. Cancelled bookings are
     excluded: a sale that was undone is not a sale, and counting it would make
     a suggestion that guests regret look like the best performer. */
  const sold = new Map<string, ServiceBooking[]>();
  for (const b of bookings) {
    if (b.status !== "confirmed") continue;
    const k = `${b.reservationId}:${b.serviceId}`;
    (sold.get(k) ?? sold.set(k, []).get(k)!).push(b);
  }

  /* One credit per reservation+service, given to the FIRST impression. Showing
     the same guest the same spa three times and booking once is one sale, not
     three; crediting each impression would inflate conversion for whatever the
     ranking happens to repeat most. */
  const credited = new Set<string>();
  const converted = new Set<number>();
  const revenueOf = new Map<number, number>();

  const ordered = [...impressions].sort((a, b) => a.id - b.id);
  for (const imp of ordered) {
    const k = `${imp.reservationId}:${imp.serviceId}`;
    if (credited.has(k)) continue;
    const matches = sold.get(k);
    if (!matches) continue;
    /* Only a booking made at or after the offer can have been caused by it. */
    const after = matches.filter((b) => b.createdAt >= imp.createdAt);
    if (!after.length) continue;
    credited.add(k);
    converted.add(imp.id);
    revenueOf.set(imp.id, after.reduce((n, b) => n + (b.amount ?? 0), 0));
  }

  const perOfferMap = new Map<number, OfferStat>();
  const posMap = new Map<number, { shown: number; booked: number }>();
  const ctxMap = new Map<string, { shown: number; booked: number }>();

  for (const imp of ordered) {
    const hit = converted.has(imp.id);

    const o =
      perOfferMap.get(imp.serviceId) ??
      perOfferMap
        .set(imp.serviceId, {
          serviceId: imp.serviceId,
          name: imp.serviceName,
          shown: 0,
          booked: 0,
          conversion: 0,
          revenue: 0,
          avgScore: 0,
          avgPosition: 0,
        })
        .get(imp.serviceId)!;
    o.shown++;
    o.avgScore += imp.score;
    o.avgPosition += imp.position;
    if (hit) {
      o.booked++;
      o.revenue += revenueOf.get(imp.id) ?? 0;
    }

    const p = posMap.get(imp.position) ?? posMap.set(imp.position, { shown: 0, booked: 0 }).get(imp.position)!;
    p.shown++;
    if (hit) p.booked++;

    /* The context key is what a manager would ask about: does the rain rule
       work, does the evening rule work. */
    const ctx = imp.wet ? "rain" : imp.dayPart;
    const c = ctxMap.get(ctx) ?? ctxMap.set(ctx, { shown: 0, booked: 0 }).get(ctx)!;
    c.shown++;
    if (hit) c.booked++;
  }

  const perOffer = [...perOfferMap.values()]
    .map((o) => ({
      ...o,
      conversion: pct(o.booked, o.shown),
      avgScore: o.shown ? Math.round((o.avgScore / o.shown) * 10) / 10 : 0,
      avgPosition: o.shown ? Math.round((o.avgPosition / o.shown) * 10) / 10 : 0,
    }))
    .sort((a, b) => b.booked - a.booked || b.shown - a.shown);

  const shownRes = new Set(ordered.map((i) => i.reservationId));
  const bookedRes = new Set(ordered.filter((i) => converted.has(i.id)).map((i) => i.reservationId));

  return {
    impressions: ordered.length,
    guestsShown: shownRes.size,
    guestsBooked: bookedRes.size,
    attachRate: pct(bookedRes.size, shownRes.size),
    conversions: converted.size,
    revenue: [...revenueOf.values()].reduce((n, v) => n + v, 0),
    perOffer,
    byPosition: [...posMap.entries()]
      .map(([position, v]) => ({ position, ...v, conversion: pct(v.booked, v.shown) }))
      .sort((a, b) => a.position - b.position),
    byContext: [...ctxMap.entries()]
      .map(([context, v]) => ({ context, ...v, conversion: pct(v.booked, v.shown) }))
      .sort((a, b) => b.shown - a.shown),
  };
}
