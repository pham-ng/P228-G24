/**
 * Money. One place, one answer.
 *
 * Every figure the concierge quotes or posts — member price, service charge,
 * VAT, cancellation fee, folio balance — is computed here from the `policies`
 * table. Neither the language model nor an individual tool is allowed to do
 * arithmetic on money, because two code paths doing the same sum is exactly how
 * `list_services` came to quote a member price while `book_service` posted the
 * rack rate to the folio.
 *
 * Reading order:
 *   ensurePricingPolicies()  — self-seeds the rule rows so the DB is the source
 *   getEntitlements()        — tier benefits, from the DB
 *   priceService()           — the ONLY function that prices a service line
 *   postCharge()/reverseCharge() — the ONLY way money reaches the folio
 *   folioSummary()           — subtotal → service charge → VAT → balance due
 *   quoteServiceCancellation()/quoteReservationCancellation()
 */
import { storage, nowIso } from "./storage";
import type { FolioCharge, Reservation, Service, ServiceBooking } from "@shared/schema";

/* ------------------------------------------------------------------ *
 * Rounding
 * ------------------------------------------------------------------ */

/** Vietnamese dong is quoted in thousands; never show a guest 1.610.333 ₫. */
export function roundVnd(n: number) {
  return Math.round(n / 1000) * 1000;
}
function round2(n: number) {
  return Math.round(n * 100) / 100;
}

/* ------------------------------------------------------------------ *
 * Policy rows this module owns
 * ------------------------------------------------------------------ */

const PEARL_CLUB_SOURCE = {
  sourceUrl: "https://vinpearl.com/vi/pearl-club",
  sourceTitle: "Vinpearl Pearl Club — quyền lợi hội viên",
};

/**
 * Tier benefits, lifted verbatim out of the old hardcoded switch in agent.ts so
 * behaviour does not change on the day this ships — but now editable by staff
 * in the policies table instead of requiring a deploy.
 */
export const DEFAULT_TIER_BENEFITS = {
  tiers: {
    diamond: {
      room: 10,
      spa: 30,
      golf: 33,
      fnb: 20,
      transport: 0,
      experience: 0,
      early_checkin_free_hours: 2,
      late_checkout_free_hours: 2,
      notes: [
        "10% off room rate",
        "30% off Akoya Spa",
        "33% off Vinpearl Golf",
        "20% off F&B (excl. alcohol)",
        "Complimentary Aquafield ticket",
        "Up to 2h early check-in & late checkout (subject to availability)",
      ],
    },
    platinum: {
      room: 7,
      spa: 30,
      golf: 33,
      fnb: 20,
      transport: 0,
      experience: 0,
      early_checkin_free_hours: 2,
      late_checkout_free_hours: 2,
      notes: [
        "7% off room rate",
        "30% off Akoya Spa",
        "33% off Vinpearl Golf",
        "20% off F&B (excl. alcohol)",
        "Complimentary Aquafield ticket",
        "Up to 2h early check-in & late checkout (subject to availability)",
      ],
    },
    gold: {
      room: 5,
      spa: 30,
      golf: 33,
      fnb: 20,
      transport: 0,
      experience: 0,
      early_checkin_free_hours: 2,
      late_checkout_free_hours: 2,
      notes: [
        "5% off room rate",
        "30% off Akoya Spa",
        "33% off Vinpearl Golf",
        "20% off F&B (excl. alcohol)",
        "Complimentary Aquafield ticket",
      ],
    },
    silver: {
      room: 5,
      spa: 30,
      golf: 33,
      fnb: 20,
      transport: 0,
      experience: 0,
      early_checkin_free_hours: 0,
      late_checkout_free_hours: 0,
      notes: [
        "5% off room rate",
        "30% off Akoya Spa",
        "33% off Vinpearl Golf",
        "20% off F&B (excl. alcohol)",
      ],
    },
    member: { alias: "silver" },
    none: {
      room: 0,
      spa: 0,
      golf: 0,
      fnb: 0,
      transport: 0,
      experience: 0,
      early_checkin_free_hours: 0,
      late_checkout_free_hours: 0,
      notes: [],
    },
  },
  /** Benefits that are never discounted, whatever the tier. */
  excluded: ["alcohol", "tobacco", "third-party tickets"],
};

/**
 * Service charge and VAT.
 *
 * `prices_include_tax: false` means catalogue prices are net ("++"), and the
 * folio adds 5% service charge then 8% VAT on top — the usual Vietnamese resort
 * convention. Flip it to `true` if your published prices are already gross; the
 * folio then shows the same grand total and reports tax as an extracted
 * breakdown instead of an added line.
 *
 * The 8% figure is the reduced VAT rate applied to accommodation and F&B; move
 * it back to 10 when the reduction lapses. Nothing in the code hardcodes it.
 */
export const DEFAULT_TAX_AND_SERVICE = {
  service_charge_pct: 5,
  vat_pct: 8,
  /** Vietnamese practice: VAT is computed on (net + service charge). */
  vat_applies_to_service_charge: true,
  prices_include_tax: false,
  currency: "VND",
  note: "Giá dịch vụ là giá net; hóa đơn cộng 5% phí phục vụ và 8% VAT.",
};

/** Cancellation of a booked service (spa slot, dinner table, tour seat…). */
export const DEFAULT_SERVICE_CANCELLATION = {
  free_until_hours_before: 24,
  fee_pct_inside_window: 50,
  no_show_fee_pct: 100,
  note: "Hủy trước 24 giờ: miễn phí. Trong 24 giờ: 50% giá đã đặt. Không đến: 100%.",
};

/** Cancellation of the stay itself. Fee basis is the first night's rate. */
export const DEFAULT_RESERVATION_CANCELLATION = {
  basis: "first_night",
  bands: [
    { min_days_before: 7, fee_pct: 0, label: "hủy miễn phí" },
    { min_days_before: 3, fee_pct: 50, label: "50% tiền phòng đêm đầu" },
    { min_days_before: 0, fee_pct: 100, label: "100% tiền phòng đêm đầu" },
  ],
  no_show_fee_pct: 100,
  note: "Tính theo số ngày trước ngày nhận phòng, theo giờ khách sạn.",
};

let ensured = false;

/**
 * Write the rule rows if they are absent. Called by every public function here,
 * so a database seeded before this module existed still gets the rules without
 * a migration step.
 */
export function ensurePricingPolicies() {
  if (ensured) return;
  ensured = true;
  const hotel = storage.getHotel();
  const hotelId = hotel?.id ?? 1;
  const seed = (
    code: string,
    topic: string,
    title: string,
    summary: string,
    rules: unknown,
    src: { sourceUrl: string; sourceTitle: string },
  ) => {
    if (storage.getPolicy(code)) return;
    storage.createPolicy({
      hotelId,
      code,
      topic,
      title,
      summary,
      rules: JSON.stringify(rules),
      sourceUrl: src.sourceUrl,
      sourceTitle: src.sourceTitle,
      updatedAt: nowIso(),
    });
  };

  seed(
    "TIER_BENEFITS",
    "payment",
    "Quyền lợi hội viên Pearl Club",
    "Phần trăm giảm giá theo hạng thẻ, áp dụng cho phòng, spa, golf, F&B.",
    DEFAULT_TIER_BENEFITS,
    PEARL_CLUB_SOURCE,
  );
  seed(
    "TAX_AND_SERVICE",
    "payment",
    "Phí phục vụ và thuế GTGT",
    DEFAULT_TAX_AND_SERVICE.note,
    DEFAULT_TAX_AND_SERVICE,
    {
      sourceUrl: "https://vinpearl.com/vi/dieu-khoan-va-dieu-kien",
      sourceTitle: "Điều khoản & điều kiện — giá và thuế",
    },
  );
  seed(
    "SERVICE_CANCELLATION",
    "booking",
    "Hủy dịch vụ đã đặt",
    DEFAULT_SERVICE_CANCELLATION.note,
    DEFAULT_SERVICE_CANCELLATION,
    {
      sourceUrl: "https://vinpearl.com/vi/dieu-khoan-va-dieu-kien",
      sourceTitle: "Điều khoản & điều kiện — hủy dịch vụ",
    },
  );
  seed(
    "RESERVATION_CANCELLATION",
    "booking",
    "Hủy đặt phòng",
    DEFAULT_RESERVATION_CANCELLATION.note,
    DEFAULT_RESERVATION_CANCELLATION,
    {
      sourceUrl: "https://vinpearl.com/vi/chinh-sach-huy-doi",
      sourceTitle: "Chính sách hủy / đổi đặt phòng",
    },
  );
}

function rulesOf<T>(code: string, fallback: T): { rules: T; cite: PolicyCite | null } {
  ensurePricingPolicies();
  const p = storage.getPolicy(code);
  if (!p) return { rules: fallback, cite: null };
  try {
    return {
      rules: { ...(fallback as object), ...JSON.parse(p.rules || "{}") } as T,
      cite: { code: p.code, title: p.title, source: p.sourceTitle, source_url: p.sourceUrl },
    };
  } catch {
    return { rules: fallback, cite: null };
  }
}

export type PolicyCite = { code: string; title: string; source: string; source_url: string };

/* ------------------------------------------------------------------ *
 * Tier entitlements
 * ------------------------------------------------------------------ */

export type DiscountBucket = "room" | "spa" | "golf" | "fnb" | "transport" | "experience";

export type Entitlements = {
  tier: string;
  roomDiscountPct: number;
  spaDiscountPct: number;
  golfDiscountPct: number;
  fnbDiscountPct: number;
  transportDiscountPct: number;
  experienceDiscountPct: number;
  earlyCheckinFreeHours: number;
  lateCheckoutFreeHours: number;
  notes: string[];
  excluded: string[];
  policy: PolicyCite | null;
};

export function getEntitlements(vipTier: string | null | undefined): Entitlements {
  const { rules, cite } = rulesOf("TIER_BENEFITS", DEFAULT_TIER_BENEFITS);
  const tiers = (rules as any).tiers ?? {};
  const key = String(vipTier || "none").toLowerCase();
  let row = tiers[key] ?? tiers.none ?? {};
  if (row && typeof row.alias === "string") row = tiers[row.alias] ?? {};
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    tier: key,
    roomDiscountPct: num(row.room),
    spaDiscountPct: num(row.spa),
    golfDiscountPct: num(row.golf),
    fnbDiscountPct: num(row.fnb),
    transportDiscountPct: num(row.transport),
    experienceDiscountPct: num(row.experience),
    earlyCheckinFreeHours: num(row.early_checkin_free_hours),
    lateCheckoutFreeHours: num(row.late_checkout_free_hours),
    notes: Array.isArray(row.notes) ? row.notes : [],
    excluded: Array.isArray((rules as any).excluded) ? (rules as any).excluded : [],
    policy: cite,
  };
}

const GOLF_RE = /\bgolf\b|s[aâ]n golf|driving range|caddie/i;

/**
 * Which discount bucket a catalogue row falls into.
 *
 * The old code tested `service.category === "golf"`, but the category column
 * only ever holds dining | spa | experience | transport | roomservice — so the
 * 33% golf benefit was unreachable. Golf is therefore detected from the name,
 * description and department instead of from a category that cannot hold it.
 */
export function bucketForService(svc: Pick<Service, "category" | "name" | "description" | "dept">): DiscountBucket {
  const haystack = `${svc.name} ${svc.description} ${svc.dept}`;
  if (GOLF_RE.test(haystack)) return "golf";
  switch (svc.category) {
    case "spa":
      return "spa";
    case "dining":
    case "roomservice":
      return "fnb";
    case "transport":
      return "transport";
    default:
      return "experience";
  }
}

export function discountPctFor(bucket: DiscountBucket, ent: Entitlements): number {
  switch (bucket) {
    case "room":
      return ent.roomDiscountPct;
    case "spa":
      return ent.spaDiscountPct;
    case "golf":
      return ent.golfDiscountPct;
    case "fnb":
      return ent.fnbDiscountPct;
    case "transport":
      return ent.transportDiscountPct;
    default:
      return ent.experienceDiscountPct;
  }
}

/* ------------------------------------------------------------------ *
 * Pricing a service line — the single source of truth
 * ------------------------------------------------------------------ */

export type PricedService = {
  service_id: number;
  name: string;
  bucket: DiscountBucket;
  unit: string;
  quantity: number;
  /** Catalogue price for one unit, before any member benefit. */
  rack_unit_price: number;
  /** What this guest pays for one unit. */
  member_unit_price: number;
  discount_pct: number;
  /** quantity × member_unit_price — the amount that goes on the folio. */
  net_amount: number;
  /** What the same line would have cost at rack rate. */
  rack_amount: number;
  saved: number;
  currency: string;
  calculation: string;
  policy: PolicyCite | null;
};

/**
 * Price one service for one guest. `list_services`, `book_service`,
 * `modify_service_booking` and `order_room_service` all call this, so a quote
 * and the folio line can never disagree.
 */
export function priceService(
  svc: Service,
  vipTier: string | null | undefined,
  partySize = 1,
  currency = "VND",
): PricedService {
  const ent = getEntitlements(vipTier);
  const bucket = bucketForService(svc);
  const rackUnit = roundVnd(svc.price);
  const pct = rackUnit > 0 ? discountPctFor(bucket, ent) : 0;
  const perPerson = /person|kh[aá]ch|ng[uư][oơ]̀i/i.test(svc.unit);
  const quantity = perPerson ? Math.max(1, Math.floor(partySize || 1)) : 1;
  const memberUnit = pct > 0 ? roundVnd(svc.price * (1 - pct / 100)) : rackUnit;
  const net = roundVnd(memberUnit * quantity);
  const rack = roundVnd(rackUnit * quantity);
  return {
    service_id: svc.id,
    name: svc.name,
    bucket,
    unit: svc.unit,
    quantity,
    rack_unit_price: rackUnit,
    member_unit_price: memberUnit,
    discount_pct: pct,
    net_amount: net,
    rack_amount: rack,
    saved: rack - net,
    currency,
    calculation:
      rackUnit === 0
        ? `0 ${currency} (giá theo yêu cầu / menu à la carte, không áp dụng giảm giá tự động)`
        : pct > 0
        ? `${rackUnit.toLocaleString("vi-VN")} ${currency} − ${pct}% (${ent.tier}) = ${memberUnit.toLocaleString("vi-VN")} ${currency} × ${quantity} ${perPerson ? "khách" : "lần"} = ${net.toLocaleString("vi-VN")} ${currency}`
        : `${rackUnit.toLocaleString("vi-VN")} ${currency} × ${quantity} = ${net.toLocaleString("vi-VN")} ${currency} (hạng ${ent.tier} không có ưu đãi cho nhóm ${bucket})`,
    policy: ent.policy,
  };
}

/* ------------------------------------------------------------------ *
 * Folio: posting, reversing, totalling
 * ------------------------------------------------------------------ */

export type ChargeCategory =
  | "room"
  | "fnb"
  | "spa"
  | "minibar"
  | "fee"
  | "service_charge"
  | "vat"
  | "payment"
  | "adjustment";

/** The only sanctioned way to put money on a folio. */
export function postCharge(input: {
  reservationId: number;
  description: string;
  amount: number;
  category: ChargeCategory;
  /** false for taxes, fees already gross, payments and reversals. */
  taxable?: boolean;
  refType?: string | null;
  refId?: number | null;
}): FolioCharge {
  return storage.addCharge({
    reservationId: input.reservationId,
    description: input.description,
    amount: round2(input.amount),
    category: input.category,
    createdAt: nowIso(),
    taxable: input.taxable === false ? 0 : 1,
    refType: input.refType ?? null,
    refId: input.refId ?? null,
    voidedAt: null,
  });
}

/**
 * Reverse a folio line by posting an offsetting line and marking the original
 * void. Nothing is deleted, so the trail a night auditor needs stays intact.
 * Returns null when the line does not exist or was already reversed — callers
 * must treat null as "nothing was refunded" and say so to the guest.
 */
export function reverseCharge(
  chargeId: number,
  reason: string,
): { original: FolioCharge; reversal: FolioCharge } | null {
  const original = storage.getCharge(chargeId);
  if (!original || original.voidedAt) return null;
  const reversal = storage.addCharge({
    reservationId: original.reservationId,
    description: `Hoàn/điều chỉnh: ${original.description} — ${reason}`,
    amount: round2(-original.amount),
    category: "adjustment",
    createdAt: nowIso(),
    taxable: original.taxable,
    refType: "reversal",
    refId: original.id,
    voidedAt: null,
  });
  storage.updateCharge(original.id, { voidedAt: nowIso() });
  return { original, reversal };
}

export type FolioSummary = {
  reservation_id: number;
  currency: string;
  prices_include_tax: boolean;
  lines: {
    id: number;
    description: string;
    amount: number;
    category: string;
    taxable: boolean;
    voided: boolean;
    created_at: string;
  }[];
  taxable_subtotal: number;
  non_taxable_subtotal: number;
  subtotal: number;
  service_charge_pct: number;
  service_charge: number;
  vat_pct: number;
  vat: number;
  grand_total: number;
  paid: number;
  balance_due: number;
  breakdown: string;
  policy: PolicyCite | null;
};

export function taxConfig() {
  return rulesOf("TAX_AND_SERVICE", DEFAULT_TAX_AND_SERVICE);
}

/**
 * Gross up a NET amount by service charge then VAT — for a guest asking "if a
 * service costs X, what do I actually pay?" before anything has been booked or
 * posted to a folio.
 *
 * This is the same compounding `folioSummary`'s `!includeTax` branch already
 * does per-charge, pulled out as its own function because that question has no
 * reservation or folio row behind it — a hosted-agent benchmark asked it and
 * the model, with no tool for it, did the arithmetic itself and got it wrong:
 * it summed both taxes on the net amount (12,000,000 + 5% + 8% = 13,560,000)
 * instead of compounding VAT on the service-charge-inclusive figure as
 * `vat_applies_to_service_charge: true` requires (12,000,000 -> 12,600,000 ->
 * 13,608,000). A ~50,000 VND-per-quote arithmetic error is exactly the class of
 * mistake this codebase's whole "never let the model compute money" rule
 * exists to prevent — it just had no tool to route through here.
 */
export function quoteTaxGrossUp(netAmount: number) {
  const { rules, cite } = taxConfig();
  const net = roundVnd(Math.max(0, Number(netAmount) || 0));
  const scPct = Number(rules.service_charge_pct) || 0;
  const vatPct = Number(rules.vat_pct) || 0;
  const serviceCharge = roundVnd((net * scPct) / 100);
  const vatBase = rules.vat_applies_to_service_charge ? net + serviceCharge : net;
  const vat = roundVnd((vatBase * vatPct) / 100);
  const total = roundVnd(net + serviceCharge + vat);
  return {
    net_amount: net,
    service_charge_pct: scPct,
    service_charge: serviceCharge,
    vat_pct: vatPct,
    vat_applies_to_service_charge: !!rules.vat_applies_to_service_charge,
    vat,
    total,
    currency: rules.currency ?? "VND",
    calculation: rules.vat_applies_to_service_charge
      ? `${net.toLocaleString("vi-VN")} + phí phục vụ ${scPct}% (${serviceCharge.toLocaleString("vi-VN")}) = ${(net + serviceCharge).toLocaleString("vi-VN")}; + VAT ${vatPct}% trên số đó (${vat.toLocaleString("vi-VN")}) = ${total.toLocaleString("vi-VN")} ${rules.currency ?? "VND"}.`
      : `${net.toLocaleString("vi-VN")} + phí phục vụ ${scPct}% (${serviceCharge.toLocaleString("vi-VN")}) + VAT ${vatPct}% trên giá gốc (${vat.toLocaleString("vi-VN")}) = ${total.toLocaleString("vi-VN")} ${rules.currency ?? "VND"}.`,
    policy: cite,
  };
}

/**
 * The folio as a guest should see it: charges, then service charge, then VAT,
 * then what has already been paid, then what is actually still owed.
 *
 * Reversed lines and their reversals both stay in `lines` but net to zero, and
 * payment lines are excluded from the tax base.
 */
export function folioSummary(reservationId: number): FolioSummary {
  const { rules, cite } = taxConfig();
  const currency = rules.currency || "VND";
  const rows = storage.listCharges(reservationId);

  /* NOTE on voided lines: reverseCharge() never deletes or excludes anything.
   * It stamps voidedAt on the original AND posts an equal negative contra line,
   * so the original stays in this sum and the contra line cancels it out. That
   * keeps the folio a real append-only ledger the guest can audit.
   * Consequence: voidedAt is a DISPLAY flag ("this line was later corrected"),
   * not an exclusion flag. Never make this loop skip voided rows - the contra
   * line would then subtract a second time and undercharge the guest. Equally,
   * never stamp voidedAt anywhere except reverseCharge(). */
  let taxable = 0;
  let nonTaxable = 0;
  let paid = 0;
  for (const c of rows) {
    if (c.category === "payment") {
      paid += -c.amount; // payments are posted as negative lines
      continue;
    }
    if (c.category === "service_charge" || c.category === "vat") continue; // recomputed below
    if (c.taxable) taxable += c.amount;
    else nonTaxable += c.amount;
  }

  const scPct = Number(rules.service_charge_pct) || 0;
  const vatPct = Number(rules.vat_pct) || 0;
  const includeTax = !!rules.prices_include_tax;

  let serviceCharge: number;
  let vat: number;
  let grand: number;
  let net = taxable;

  if (includeTax) {
    // Published prices are gross: extract the components, do not add them.
    const factor = 1 + scPct / 100 + (rules.vat_applies_to_service_charge ? 0 : vatPct / 100);
    const grossTaxable = taxable;
    const denominator = rules.vat_applies_to_service_charge
      ? (1 + scPct / 100) * (1 + vatPct / 100)
      : factor + vatPct / 100;
    net = roundVnd(grossTaxable / (denominator || 1));
    serviceCharge = roundVnd((net * scPct) / 100);
    vat = roundVnd(grossTaxable - net - serviceCharge);
    grand = roundVnd(grossTaxable + nonTaxable);
  } else {
    serviceCharge = roundVnd((taxable * scPct) / 100);
    const vatBase = rules.vat_applies_to_service_charge ? taxable + serviceCharge : taxable;
    vat = roundVnd((vatBase * vatPct) / 100);
    grand = roundVnd(taxable + nonTaxable + serviceCharge + vat);
  }

  const balance = roundVnd(grand - paid);

  return {
    reservation_id: reservationId,
    currency,
    prices_include_tax: includeTax,
    lines: rows.map((c) => ({
      id: c.id,
      description: c.description,
      amount: c.amount,
      category: c.category,
      taxable: !!c.taxable,
      voided: !!c.voidedAt,
      created_at: c.createdAt,
    })),
    taxable_subtotal: roundVnd(includeTax ? net : taxable),
    non_taxable_subtotal: roundVnd(nonTaxable),
    subtotal: roundVnd((includeTax ? net : taxable) + nonTaxable),
    service_charge_pct: scPct,
    service_charge: serviceCharge,
    vat_pct: vatPct,
    vat,
    grand_total: grand,
    paid: roundVnd(paid),
    balance_due: balance,
    breakdown: includeTax
      ? `Giá đã bao gồm thuế: tiền dịch vụ ${roundVnd(net).toLocaleString("vi-VN")} + phí phục vụ ${scPct}% ${serviceCharge.toLocaleString("vi-VN")} + VAT ${vatPct}% ${vat.toLocaleString("vi-VN")} = ${grand.toLocaleString("vi-VN")} ${currency}. Đã thanh toán ${roundVnd(paid).toLocaleString("vi-VN")}, còn lại ${balance.toLocaleString("vi-VN")} ${currency}.`
      : `Tiền dịch vụ ${roundVnd(taxable).toLocaleString("vi-VN")}${nonTaxable ? ` + khoản không chịu thuế ${roundVnd(nonTaxable).toLocaleString("vi-VN")}` : ""} + phí phục vụ ${scPct}% = ${serviceCharge.toLocaleString("vi-VN")} + VAT ${vatPct}% = ${vat.toLocaleString("vi-VN")} → tổng ${grand.toLocaleString("vi-VN")} ${currency}. Đã thanh toán ${roundVnd(paid).toLocaleString("vi-VN")}, còn lại ${balance.toLocaleString("vi-VN")} ${currency}.`,
    policy: cite,
  };
}

/* ------------------------------------------------------------------ *
 * Cancellation
 * ------------------------------------------------------------------ */

function hoursBetween(a: Date, b: Date) {
  return (b.getTime() - a.getTime()) / 3_600_000;
}

export type ServiceCancellationQuote = {
  quoted: boolean;
  error?: string;
  booking_id: number;
  booked_amount: number;
  hours_before_start: number | null;
  free_until_hours_before: number;
  fee_pct: number;
  fee: number;
  refund: number;
  currency: string;
  band: string;
  calculation: string;
  policy: PolicyCite | null;
};

/**
 * What cancelling a booked service costs right now. Uses the amount actually
 * posted to the folio, not a recomputed rack price.
 */
export function quoteServiceCancellation(
  booking: ServiceBooking,
  now = new Date(),
  currency = "VND",
): ServiceCancellationQuote {
  const { rules, cite } = rulesOf("SERVICE_CANCELLATION", DEFAULT_SERVICE_CANCELLATION);
  const amount = roundVnd(booking.amount ?? 0);
  const startIso = `${booking.date}T${booking.slot.length === 5 ? booking.slot : "00:00"}:00+07:00`;
  const start = new Date(startIso);
  const valid = !Number.isNaN(start.getTime());
  const hours = valid ? round2(hoursBetween(now, start)) : null;
  const freeUntil = Number(rules.free_until_hours_before) || 0;

  let pct: number;
  let band: string;
  if (hours === null) {
    pct = Number(rules.fee_pct_inside_window) || 0;
    band = "không đọc được giờ bắt đầu — áp mức trong hạn hủy";
  } else if (hours < 0) {
    pct = Number(rules.no_show_fee_pct) || 0;
    band = "đã qua giờ hẹn (no-show)";
  } else if (hours >= freeUntil) {
    pct = 0;
    band = `hủy trước ${freeUntil} giờ — miễn phí`;
  } else {
    pct = Number(rules.fee_pct_inside_window) || 0;
    band = `trong ${freeUntil} giờ trước giờ hẹn`;
  }

  const fee = roundVnd((amount * pct) / 100);
  return {
    quoted: true,
    booking_id: booking.id,
    booked_amount: amount,
    hours_before_start: hours,
    free_until_hours_before: freeUntil,
    fee_pct: pct,
    fee,
    refund: roundVnd(amount - fee),
    currency,
    band,
    calculation: `${band}: ${pct}% × ${amount.toLocaleString("vi-VN")} ${currency} = ${fee.toLocaleString("vi-VN")} ${currency} phí hủy, hoàn ${roundVnd(amount - fee).toLocaleString("vi-VN")} ${currency}.`,
    policy: cite,
  };
}

export type ReservationCancellationQuote = {
  quoted: boolean;
  error?: string;
  confirmation_code?: string;
  status?: string;
  cancellable?: boolean;
  reason_not_cancellable?: string | null;
  days_before_arrival?: number;
  band?: string;
  fee_pct?: number;
  basis?: string;
  basis_amount?: number;
  fee?: number;
  nights?: number;
  room_charges_on_folio?: number;
  service_bookings_to_cancel?: number;
  currency?: string;
  calculation?: string;
  policy?: PolicyCite | null;
};

/** What cancelling the stay costs, and whether it may be cancelled at all. */
export function quoteReservationCancellation(
  res: Reservation,
  today: string,
  currency = "VND",
): ReservationCancellationQuote {
  const { rules, cite } = rulesOf("RESERVATION_CANCELLATION", DEFAULT_RESERVATION_CANCELLATION);
  const msDay = 86_400_000;
  const arrival = new Date(`${res.checkIn}T00:00:00+07:00`);
  const ref = new Date(`${today}T00:00:00+07:00`);
  const days = Math.round((arrival.getTime() - ref.getTime()) / msDay);
  const nights = Math.max(
    1,
    Math.round(
      (new Date(`${res.checkOut}T00:00:00+07:00`).getTime() - arrival.getTime()) / msDay,
    ),
  );

  let cancellable = true;
  let why: string | null = null;
  if (res.status === "cancelled") {
    cancellable = false;
    why = "Đặt phòng này đã được hủy trước đó.";
  } else if (res.status === "checked_out") {
    cancellable = false;
    why = "Khách đã trả phòng — không thể hủy, cần xử lý như tranh chấp hóa đơn.";
  } else if (res.status === "in_house") {
    cancellable = false;
    why =
      "Khách đang lưu trú (in_house) — đây là rút ngắn kỳ nghỉ/trả phòng sớm, không phải hủy. Chuyển lễ tân xử lý.";
  }

  const bands: { min_days_before: number; fee_pct: number; label: string }[] = (rules as any).bands ?? [];
  const sorted = [...bands].sort((a, b) => b.min_days_before - a.min_days_before);
  const band =
    days < 0
      ? { min_days_before: -1, fee_pct: Number(rules.no_show_fee_pct) || 100, label: "quá ngày nhận phòng (no-show)" }
      : sorted.find((b) => days >= b.min_days_before) ?? sorted[sorted.length - 1];

  const basisAmount = roundVnd(res.ratePerNight);
  const fee = roundVnd((basisAmount * (band?.fee_pct ?? 0)) / 100);
  const roomCharges = storage
    .listCharges(res.id)
    .filter((c) => c.category === "room" && !c.voidedAt)
    .reduce((n, c) => n + c.amount, 0);
  const openBookings = storage
    .bookingsForReservation(res.id)
    .filter((b) => b.status === "confirmed").length;

  return {
    quoted: true,
    confirmation_code: res.confirmationCode,
    status: res.status,
    cancellable,
    reason_not_cancellable: why,
    days_before_arrival: days,
    band: band?.label ?? "—",
    fee_pct: band?.fee_pct ?? 0,
    basis: String(rules.basis || "first_night"),
    basis_amount: basisAmount,
    fee,
    nights,
    room_charges_on_folio: roundVnd(roomCharges),
    service_bookings_to_cancel: openBookings,
    currency,
    calculation: `Còn ${days} ngày trước ngày nhận phòng (${res.checkIn}) → ${band?.label}: ${band?.fee_pct ?? 0}% × ${basisAmount.toLocaleString("vi-VN")} ${currency} (tiền phòng đêm đầu) = ${fee.toLocaleString("vi-VN")} ${currency}.`,
    policy: cite,
  };
}
