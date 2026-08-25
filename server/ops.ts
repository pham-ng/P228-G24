/**
 * Operational concierge tools.
 *
 * agent.ts owns the conversational and PMS-read tools it shipped with. This
 * module owns everything that makes Aurea usable as a real hotel concierge:
 * the statutory lodging declaration, folio settlement, housekeeping and
 * engineering dispatch, laundry, luggage, transport, lost property, room moves,
 * express checkout, VAT invoices, loyalty, feedback and live weather.
 *
 * Three rules hold everywhere below.
 *
 * 1. Money only moves through `pricing.ts` (`priceService`, `postCharge`,
 *    `reverseCharge`, `folioSummary`). No tool multiplies a price itself.
 * 2. A tool never reports success for work it did not do. If all it managed was
 *    to raise a ticket, it says `done: false` plus `dispatched_to`, so the model
 *    cannot turn a queued request into a confirmation.
 * 3. Anything a human must finish — filing the police declaration, taking the
 *    money, issuing the e-invoice — is recorded as pending with the channel
 *    named, never as completed.
 */
import { storage, nowIso, hotelToday, hotelClock, HOTEL_TZ } from "./storage";
import {
  ensurePricingPolicies,
  folioSummary,
  getEntitlements,
  postCharge,
  priceService,
  quoteReservationCancellation,
  quoteServiceCancellation,
  reverseCharge,
  roundVnd,
} from "./pricing";
import type { ToolSpec } from "./openai";
import type {
  Conversation,
  Guest,
  Hotel,
  Payment,
  Reservation,
  Room,
  Service,
} from "@shared/schema";
import { DEPT_KEYS } from "@shared/schema";

/* ------------------------------------------------------------------ *
 * Time helpers — the hotel's clock, never the server's
 * ------------------------------------------------------------------ */

/** An unambiguous instant from a hotel-local date and HH:MM. */
export function hotelIso(date: string, hhmm: string) {
  const t = /^\d{2}:\d{2}$/.test(hhmm) ? hhmm : "00:00";
  return `${date}T${t}:00+07:00`;
}

function isIsoDate(s: unknown) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}
function isHHMM(s: unknown) {
  return typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}
function minutesOf(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}
function addDays(date: string, n: number) {
  const d = new Date(`${date}T00:00:00+07:00`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toLocaleDateString("en-CA", { timeZone: HOTEL_TZ });
}
function nightsBetween(a: string, b: string) {
  return Math.round(
    (new Date(`${b}T00:00:00+07:00`).getTime() - new Date(`${a}T00:00:00+07:00`).getTime()) /
      86_400_000,
  );
}
function vnd(n: number) {
  return `${roundVnd(n).toLocaleString("vi-VN")} ₫`;
}

/* ------------------------------------------------------------------ *
 * Operational rule rows
 *
 * These are seeded with sensible resort defaults so the tools work on day one,
 * and every one of them is editable in the policies table. The summary of each
 * says so, because a default is not the same thing as a published rule.
 * ------------------------------------------------------------------ */

const DEFAULTS_NOTE = "Giá trị mặc định do hệ thống tạo — ban quản lý cần xác nhận/cập nhật.";
const INTERNAL_SOURCE = {
  sourceUrl: "internal://aurea/operations",
  sourceTitle: "Aurea — cấu hình vận hành nội bộ",
};

export const DEFAULT_ROOM_SERVICE = {
  hours: { from: "06:00", to: "23:00" },
  all_night: false,
  eta_minutes: { normal: 35, peak: 50 },
  peak_windows: [
    { from: "07:00", to: "09:30" },
    { from: "18:30", to: "20:30" },
  ],
  min_order: 0,
  tray_fee: 0,
  note: DEFAULTS_NOTE,
};

export const DEFAULT_FACILITY_HOURS = {
  facilities: [
    { key: "pool", name: "Hồ bơi ngoài trời", from: "06:00", to: "20:00", note: "Không có cứu hộ sau 19:00." },
    { key: "gym", name: "Phòng tập", from: "05:30", to: "22:00", note: "" },
    /* 22:00, not the 21:00 this table was seeded with. Every other row here is a
       system-generated default awaiting management confirmation, but the spa's
       hours are KNOWN: the curated page "Akoya Spa — treatments and prices" says
       "open 09:00–22:00", checked against the official Vinpearl source in Phase B.
       Two rows of the corpus disagreed, and the invented one kept winning
       retrieval — the offline model answered "09:00 đến 21:00" in Vietnamese,
       Korean and Chinese. Replacing a placeholder with the sourced value is not
       a fact change; it is deleting a fact nobody ever established. */
    { key: "spa", name: "Akoya Spa", from: "09:00", to: "22:00", note: "Đặt trước ít nhất 2 giờ." },
    { key: "kids_club", name: "Kids Club", from: "08:00", to: "20:00", note: "Trẻ dưới 4 tuổi cần người lớn đi kèm." },
    { key: "beach", name: "Bãi biển riêng", from: "06:00", to: "18:30", note: "" },
    { key: "front_desk", name: "Lễ tân", from: "00:00", to: "23:59", note: "Phục vụ 24/7." },
    { key: "business_center", name: "Business Center", from: "08:00", to: "20:00", note: "" },
  ],
  note: DEFAULTS_NOTE,
};

export const DEFAULT_LAUNDRY = {
  levels: {
    regular: { turnaround_hours: 24, multiplier: 1 },
    express: { turnaround_hours: 4, multiplier: 1.5 },
  },
  cutoff_for_same_day: "10:00",
  price_list: [
    { item: "shirt", label: "Áo sơ mi", price: 90000 },
    { item: "trousers", label: "Quần dài", price: 110000 },
    { item: "dress", label: "Váy/đầm", price: 160000 },
    { item: "suit", label: "Bộ suit", price: 320000 },
    { item: "underwear", label: "Đồ lót", price: 50000 },
    { item: "other", label: "Món khác", price: 0 },
  ],
  note: `${DEFAULTS_NOTE} Món "other" phải để bộ phận giặt ủi báo giá, tuyệt đối không tự suy ra giá.`,
};

export const DEFAULT_TRANSPORT = {
  services: [
    { key: "airport_pickup", label: "Đón sân bay Cam Ranh", price: 750000, unit: "per car", lead_time_hours: 6, max_pax: 4 },
    { key: "airport_dropoff", label: "Tiễn sân bay Cam Ranh", price: 750000, unit: "per car", lead_time_hours: 4, max_pax: 4 },
    { key: "city_transfer", label: "Đưa đón trung tâm Nha Trang", price: 350000, unit: "per car", lead_time_hours: 2, max_pax: 4 },
    { key: "car_rental", label: "Thuê xe có tài xế (4 giờ)", price: 1200000, unit: "per car", lead_time_hours: 12, max_pax: 4 },
  ],
  note: `${DEFAULTS_NOTE} Xe lớn hơn 4 khách phải để bộ phận vận chuyển báo giá.`,
};

export const DEFAULT_LOYALTY_PROGRAM = {
  name: "Pearl Club",
  earn_rate_points_per_1000_vnd: 1,
  tier_thresholds: [
    { tier: "silver", min_points: 0 },
    { tier: "gold", min_points: 20000 },
    { tier: "platinum", min_points: 60000 },
    { tier: "diamond", min_points: 150000 },
  ],
  points_expire_months: 24,
  enrolment_channel: "front_desk_or_app",
  note: `${DEFAULTS_NOTE} Số điểm và ngưỡng hạng phải khớp với hệ thống Pearl Club thật trước khi công bố cho khách.`,
};

/**
 * Statutory lodging declaration. Aurea collects the fields and queues the job;
 * a human files it. Thông tư 55/2021/TT-BCA (sửa đổi bởi 66/2023/TT-BCA) yêu cầu
 * khai báo ngay khi khách đến, và Nghị định 282/2025 nâng mức phạt từ 15/12/2025.
 */
export const DEFAULT_LODGING_DECLARATION = {
  deadline_hours_after_arrival: 12,
  deadline_note: "Khai báo ngay khi khách đến; khách nước ngoài phải khai trong ngày.",
  channels: [
    { key: "police_portal", label: "Cổng khai báo lưu trú của Bộ Công an", url: "https://tbltkbtt.bocongan.gov.vn" },
    { key: "vneid", label: "Ứng dụng VNeID (tài khoản định danh mức 2)", url: "https://vneid.gov.vn" },
    { key: "ward_office", label: "Công an xã/phường nơi lưu trú", url: "" },
  ],
  required_fields_vietnamese: ["full_name", "id_number", "dob", "permanent_address", "arrival_at"],
  required_fields_foreigner: [
    "full_name",
    "id_number",
    "nationality",
    "dob",
    "visa_number",
    "entry_date",
    "entry_port",
    "arrival_at",
  ],
  penalty_note:
    "Không khai báo lưu trú cho khách nước ngoài có thể bị xử phạt tới 20 triệu đồng theo Nghị định 282/2025 (hiệu lực 15/12/2025).",
};

let opsEnsured = false;

export function ensureOpsPolicies() {
  if (opsEnsured) return;
  opsEnsured = true;
  ensurePricingPolicies();
  const hotel = storage.getHotel();
  const hotelId = hotel?.id ?? 1;
  const seed = (
    code: string,
    topic: string,
    title: string,
    summary: string,
    rules: unknown,
    src = INTERNAL_SOURCE,
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

  seed("ROOM_SERVICE", "booking", "Phục vụ tại phòng", DEFAULT_ROOM_SERVICE.note, DEFAULT_ROOM_SERVICE);
  seed("FACILITY_HOURS", "conduct", "Giờ mở cửa tiện ích", DEFAULT_FACILITY_HOURS.note, DEFAULT_FACILITY_HOURS);
  seed("LAUNDRY", "booking", "Dịch vụ giặt ủi", DEFAULT_LAUNDRY.note, DEFAULT_LAUNDRY);
  seed("TRANSPORT", "booking", "Dịch vụ đưa đón", DEFAULT_TRANSPORT.note, DEFAULT_TRANSPORT);
  seed("LOYALTY_PROGRAM", "payment", "Chương trình Pearl Club", DEFAULT_LOYALTY_PROGRAM.note, DEFAULT_LOYALTY_PROGRAM);
  seed(
    "LODGING_DECLARATION",
    "privacy",
    "Khai báo lưu trú theo quy định",
    "Thông tư 55/2021/TT-BCA sửa đổi bởi 66/2023/TT-BCA; mức phạt theo Nghị định 282/2025.",
    DEFAULT_LODGING_DECLARATION,
    {
      sourceUrl: "https://tbltkbtt.bocongan.gov.vn",
      sourceTitle: "Cổng khai báo lưu trú — Bộ Công an",
    },
  );
}

function rules<T>(code: string, fallback: T): { rules: T; cite: null | { code: string; title: string; source: string; source_url: string } } {
  ensureOpsPolicies();
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

/** Room-service operating rules, also used by `order_room_service` in agent.ts. */
export function roomServiceRules() {
  return rules("ROOM_SERVICE", DEFAULT_ROOM_SERVICE);
}

/** Is the kitchen open right now, and how long will delivery take? */
export function roomServiceWindow(now = hotelClock()) {
  const { rules: r, cite } = roomServiceRules();
  const from = r.hours?.from ?? "06:00";
  const to = r.hours?.to ?? "23:00";
  const t = minutesOf(now);
  const open = r.all_night || (t >= minutesOf(from) && t <= minutesOf(to));
  const peak = (r.peak_windows ?? []).some(
    (w: any) => t >= minutesOf(w.from) && t <= minutesOf(w.to),
  );
  return {
    open,
    peak,
    hours: `${from}–${to}`,
    eta_minutes: peak ? (r.eta_minutes?.peak ?? 50) : (r.eta_minutes?.normal ?? 35),
    min_order: Number(r.min_order) || 0,
    policy: cite,
  };
}

/* ------------------------------------------------------------------ *
 * Allergy / preference safety net
 * ------------------------------------------------------------------ */

const ALLERGY_RE =
  /(d[iị] [uứ]ng|allerg|kh[oô]ng [aă]n|no |free)\s*([\p{L}\s]{2,30})/giu;

/**
 * Pull allergy-shaped statements out of the stored preference array. Used to
 * warn on food orders rather than to block them — the kitchen decides, but the
 * ticket must carry the warning.
 */
export function allergyNotes(guest: Guest): string[] {
  let prefs: string[] = [];
  try {
    prefs = JSON.parse(guest.preferences || "[]");
  } catch {
    prefs = [];
  }
  const hits = prefs.filter((p) =>
    /d[iị] [uứ]ng|allerg|gluten|lactose|halal|vegan|thu[aầ]n ch[aay]|kh[oô]ng [aă]n|no nuts|peanut|seafood|h[aả]i s[aả]n/i.test(
      p,
    ),
  );
  ALLERGY_RE.lastIndex = 0;
  return hits;
}

/* ------------------------------------------------------------------ *
 * Request dispatch — one path for every operational ticket
 * ------------------------------------------------------------------ */

export type OpsCtx = {
  hotel: Hotel;
  guest: Guest;
  res?: Reservation;
  room?: Room;
  conv: Conversation;
};

type RaiseInput = {
  kind: string;
  dept: string;
  title: string;
  detail: string;
  summary: string;
  payload?: Record<string, unknown>;
  priority?: "low" | "normal" | "high" | "urgent";
  /** ISO instant the guest asked it to happen. Also becomes the task due date. */
  scheduledFor?: string | null;
  amount?: number | null;
  chargeId?: number | null;
  eventType?: string;
};

/**
 * Create the department task and the guest-request row together, so every
 * promise made in chat has exactly one auditable record and a status the guest
 * can be told about later via `get_request_status`.
 */
function raiseRequest(ctx: OpsCtx, input: RaiseInput) {
  ensureOpsPolicies();
  const dept = DEPT_KEYS.includes(input.dept as any) ? input.dept : "front_desk";
  const priority = input.priority ?? "normal";
  const slaMinutes =
    priority === "urgent" ? 15 : priority === "high" ? 30 : (ctx.hotel.slaMinutes || 60);
  const due = input.scheduledFor ?? new Date(Date.now() + slaMinutes * 60_000).toISOString();

  const task = storage.createTask({
    hotelId: ctx.hotel.id,
    reservationId: ctx.res?.id ?? null,
    roomId: ctx.res?.roomId ?? null,
    conversationId: ctx.conv.id,
    dept,
    title: input.title.slice(0, 80),
    detail: input.detail,
    priority,
    status: "open",
    source: "ai",
    assignedStaffId: null,
    dueAt: due,
    createdAt: nowIso(),
    resolvedAt: null,
  });

  const request = storage.createRequest({
    hotelId: ctx.hotel.id,
    reservationId: ctx.res?.id ?? null,
    guestId: ctx.guest.id,
    conversationId: ctx.conv.id,
    taskId: task.id,
    kind: input.kind,
    dept,
    summary: input.summary,
    payload: JSON.stringify(input.payload ?? {}),
    scheduledFor: input.scheduledFor ?? null,
    status: "open",
    amount: input.amount ?? null,
    chargeId: input.chargeId ?? null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    resolvedAt: null,
    resolutionNote: null,
  });

  storage.logEvent({
    type: input.eventType ?? `request.${input.kind}`,
    actor: "ai",
    summary: input.summary,
    payload: JSON.stringify({ requestId: request.id, taskId: task.id, ...(input.payload ?? {}) }),
    conversationId: ctx.conv.id,
    createdAt: nowIso(),
  });

  return { task, request, dept, sla_minutes: slaMinutes, due_at: due };
}

/** The honest shape of "we have taken this down and someone is on it". */
function queued(
  ctx: OpsCtx,
  r: ReturnType<typeof raiseRequest>,
  extra: Record<string, unknown> = {},
) {
  return {
    done: false,
    logged: true,
    request_id: r.request.id,
    task_id: r.task.id,
    dispatched_to: r.dept,
    status: "open",
    due_at: r.due_at,
    sla_minutes: r.sla_minutes,
    room: ctx.room?.number ?? null,
    instruction:
      "Yêu cầu đã được ghi nhận và chuyển bộ phận phụ trách — hãy nói với khách là đã tiếp nhận và bộ phận sẽ xác nhận, KHÔNG nói là đã hoàn tất.",
    ...extra,
  };
}

/* ------------------------------------------------------------------ *
 * Shared booking core — used by book_service, tours, meeting rooms, sitters
 * ------------------------------------------------------------------ */

export type BookResult = Record<string, unknown>;

/**
 * Book one catalogue service. This is the only place a service booking is
 * created, so the price quoted, the price charged and the price refunded on
 * cancellation are by construction the same number.
 */
export function bookCatalogueService(
  ctx: OpsCtx,
  input: { serviceId: number; date: string; slot: string; partySize?: number; note?: string; kind?: string },
): BookResult {
  ensureOpsPolicies();
  const { hotel, guest, res, room, conv } = ctx;
  if (!res) return { error: "No reservation linked — cannot book." };
  const svc = storage.getService(Number(input.serviceId));
  if (!svc) return { error: `No service with id ${input.serviceId}.` };

  const date = String(input.date);
  const slot = String(input.slot);
  if (!isIsoDate(date)) return { error: "date must be YYYY-MM-DD." };
  if (date < hotelToday()) return { error: "That date is in the past." };

  const slots: string[] = JSON.parse(svc.slots || "[]");
  if (slots.length && !slots.includes(slot))
    return { error: `${svc.name} does not run at ${slot}. Available: ${slots.join(", ")}` };

  const party = Math.max(1, Number(input.partySize ?? 1));

  /* Lead time — a slot that starts in ten minutes cannot be honoured. */
  const startsAt = new Date(hotelIso(date, slots.length ? slot : "00:00"));
  const leadHours = (startsAt.getTime() - Date.now()) / 3_600_000;
  const minLead = svc.category === "spa" ? 2 : 1;
  if (slots.length && leadHours < minLead)
    return {
      error: `${svc.name} cần đặt trước ít nhất ${minLead} giờ. Khung ${slot} ngày ${date} bắt đầu sau ${Math.max(0, Math.round(leadHours * 10) / 10)} giờ.`,
      suggestion: "Đề nghị khách chọn khung giờ muộn hơn, hoặc gọi lễ tân để xin ngoại lệ.",
    };

  /* Capacity across the property. */
  if (slots.length) {
    const taken = storage
      .bookingsFor(svc.id, date)
      .filter((b) => b.slot === slot)
      .reduce((n, b) => n + b.partySize, 0);
    if (taken + party > svc.capacityPerSlot)
      return {
        error: `Only ${Math.max(0, svc.capacityPerSlot - taken)} place(s) left at ${slot} on ${date}.`,
        suggestion: "Offer another slot from list_services.",
      };
  }

  /* The same guest booked into two places at once is an operational failure. */
  const clash = storage
    .bookingsForReservation(res.id)
    .find((b) => b.status === "confirmed" && b.date === date && b.slot === slot);
  if (clash) {
    const other = storage.getService(clash.serviceId);
    return {
      error: `Khách đã có lịch ${other?.name ?? `dịch vụ #${clash.serviceId}`} vào ${date} ${slot} (booking #${clash.id}).`,
      suggestion:
        "Xác nhận với khách muốn giữ lịch nào: đổi giờ dịch vụ mới, hoặc dùng modify_service_booking / cancel_service_booking cho lịch cũ trước.",
      conflicting_booking_id: clash.id,
    };
  }

  /* Price once. */
  const priced = priceService(svc, guest.vipTier, party, hotel.currency);

  const { rules: cancelRules } = rules("SERVICE_CANCELLATION", {
    free_until_hours_before: 24,
  } as any);
  const freeUntilHours = Number((cancelRules as any).free_until_hours_before) || 0;
  const cancelDeadline = new Date(startsAt.getTime() - freeUntilHours * 3_600_000).toISOString();

  const booking = storage.createBooking({
    serviceId: svc.id,
    reservationId: res.id,
    date,
    slot,
    partySize: party,
    status: "confirmed",
    createdAt: nowIso(),
    amount: priced.net_amount,
    chargeId: null,
    note: input.note ? String(input.note) : null,
    cancelDeadline,
    cancelledAt: null,
  });

  const charge = postCharge({
    reservationId: res.id,
    description: `${svc.name} — ${date} ${slot} × ${party}${priced.discount_pct ? ` (ưu đãi ${priced.discount_pct}% hạng ${guest.vipTier})` : ""}`,
    amount: priced.net_amount,
    category: svc.category === "spa" ? "spa" : svc.category === "dining" || svc.category === "roomservice" ? "fnb" : "fee",
    taxable: true,
    refType: "service_booking",
    refId: booking.id,
  });
  storage.updateBooking(booking.id, { chargeId: charge.id });

  const allergies = svc.category === "dining" || svc.category === "roomservice" ? allergyNotes(guest) : [];

  const task = storage.createTask({
    hotelId: hotel.id,
    reservationId: res.id,
    roomId: res.roomId,
    conversationId: conv.id,
    dept: svc.dept,
    title: `${svc.name} — ${date} ${slot}`,
    detail: `${guest.name} (room ${room?.number ?? "—"}), party of ${party}.${
      input.note ? ` Note: ${input.note}` : ""
    }${allergies.length ? ` ⚠ Ghi nhận từ hồ sơ khách: ${allergies.join("; ")}.` : ""} Đã ghi nợ ${vnd(priced.net_amount)} vào folio (line #${charge.id}).`,
    priority: "normal",
    status: "open",
    source: "ai",
    assignedStaffId: null,
    dueAt: hotelIso(date, slots.length ? slot : "00:00"),
    createdAt: nowIso(),
    resolvedAt: null,
  });

  const request = storage.createRequest({
    hotelId: hotel.id,
    reservationId: res.id,
    guestId: guest.id,
    conversationId: conv.id,
    taskId: task.id,
    kind: input.kind ?? "service_booking",
    dept: svc.dept,
    summary: `${svc.name} ${date} ${slot} × ${party} — ${vnd(priced.net_amount)}`,
    payload: JSON.stringify({ bookingId: booking.id, serviceId: svc.id, chargeId: charge.id }),
    scheduledFor: hotelIso(date, slots.length ? slot : "00:00"),
    status: "open",
    amount: priced.net_amount,
    chargeId: charge.id,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    resolvedAt: null,
    resolutionNote: null,
  });

  storage.logEvent({
    type: "booking.created",
    actor: "ai",
    summary: `Booked ${svc.name} for ${guest.name} on ${date} at ${slot} (party ${party}) — ${vnd(priced.net_amount)}.`,
    payload: JSON.stringify({
      bookingId: booking.id,
      taskId: task.id,
      requestId: request.id,
      chargeId: charge.id,
      amount: priced.net_amount,
      rackAmount: priced.rack_amount,
      discountPct: priced.discount_pct,
    }),
    conversationId: conv.id,
    createdAt: nowIso(),
  });

  return {
    booked: true,
    booking_id: booking.id,
    request_id: request.id,
    service: svc.name,
    date,
    slot,
    party_size: party,
    /* What actually went on the folio — the member price, not the rack rate. */
    charged: priced.net_amount,
    rack_amount: priced.rack_amount,
    member_discount_percent: priced.discount_pct,
    saved: priced.saved,
    price_calculation: priced.calculation,
    price_basis: "Giá net, chưa gồm phí phục vụ và VAT — xem get_folio để có tổng phải trả.",
    folio_charge_id: charge.id,
    currency: hotel.currency,
    free_cancellation_until: cancelDeadline,
    allergy_notes_on_file: allergies,
    dispatched_to: svc.dept,
    task_id: task.id,
    policy: priced.policy,
  };
}

/* ------------------------------------------------------------------ *
 * Payments
 * ------------------------------------------------------------------ */

function randomToken(n = 24) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < n; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function publicBaseUrl() {
  return (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
}

/**
 * Record that money is expected. Aurea holds no card credentials and talks to no
 * gateway, so nothing here claims a payment succeeded: the row starts `pending`
 * with `provider: "not_connected"` until a human confirms receipt through
 * `confirmPayment`.
 */
export function createPaymentIntent(
  ctx: OpsCtx,
  input: { amount: number; method: Payment["method"]; note?: string; expiresInHours?: number },
) {
  const { hotel, res } = ctx;
  if (!res) throw new Error("No reservation linked.");
  const token = randomToken();
  const base = publicBaseUrl();
  const provider = process.env.PAYMENT_PROVIDER || "not_connected";
  const expires = new Date(
    Date.now() + Math.max(1, input.expiresInHours ?? 24) * 3_600_000,
  ).toISOString();
  return storage.createPayment({
    hotelId: hotel.id,
    reservationId: res.id,
    amount: roundVnd(input.amount),
    currency: hotel.currency,
    method: input.method,
    status: "pending",
    provider,
    token,
    link: input.method === "payment_link" ? `${base || ""}/pay/${token}` : null,
    reference: null,
    chargeId: null,
    taskId: null,
    expiresAt: expires,
    paidAt: null,
    createdAt: nowIso(),
    note: input.note ?? null,
  });
}

/**
 * Mark a payment received and post it to the folio as a negative line. Called
 * by staff through the API, never by the model — the concierge cannot decide
 * that money arrived.
 */
export function confirmPayment(paymentId: number, reference: string, staffName = "staff") {
  const pay = storage.getPayment(paymentId);
  if (!pay) return { ok: false, error: `No payment #${paymentId}.` };
  if (pay.status === "paid") return { ok: false, error: `Payment #${paymentId} is already settled.` };
  const charge = postCharge({
    reservationId: pay.reservationId,
    description: `Thanh toán ${pay.method}${reference ? ` — ${reference}` : ""}`,
    amount: -Math.abs(pay.amount),
    category: "payment",
    taxable: false,
    refType: "payment",
    refId: pay.id,
  });
  const updated = storage.updatePayment(pay.id, {
    status: "paid",
    paidAt: nowIso(),
    reference: reference || null,
    chargeId: charge.id,
  });
  storage.logEvent({
    type: "payment.confirmed",
    actor: staffName,
    summary: `Payment #${pay.id} of ${vnd(pay.amount)} confirmed (${pay.method}).`,
    payload: JSON.stringify({ paymentId: pay.id, chargeId: charge.id, reference }),
    conversationId: null,
    createdAt: nowIso(),
  });
  return { ok: true, payment: updated, charge, folio: folioSummary(pay.reservationId) };
}

/* ------------------------------------------------------------------ *
 * Live weather
 * ------------------------------------------------------------------ */

const WMO: Record<number, string> = {
  0: "Trời quang",
  1: "Ít mây",
  2: "Có mây rải rác",
  3: "Nhiều mây",
  45: "Sương mù",
  48: "Sương mù đóng băng",
  51: "Mưa phùn nhẹ",
  53: "Mưa phùn",
  55: "Mưa phùn dày",
  61: "Mưa nhẹ",
  63: "Mưa vừa",
  65: "Mưa to",
  66: "Mưa lạnh nhẹ",
  67: "Mưa lạnh nặng",
  71: "Tuyết nhẹ",
  73: "Tuyết vừa",
  75: "Tuyết dày",
  80: "Mưa rào nhẹ",
  81: "Mưa rào",
  82: "Mưa rào rất to",
  95: "Dông",
  96: "Dông kèm mưa đá nhẹ",
  99: "Dông kèm mưa đá nặng",
};

/**
 * Real forecast from Open-Meteo (no API key required). On any failure this
 * returns `available: false` and instructs the model to say the forecast is
 * unavailable. It never invents weather — the previous implementation returned
 * one of three hardcoded scenarios chosen by date offset and presented it to
 * guests as a forecast.
 */
export async function fetchWeather(date: string, hotel: Hotel) {
  const lat = Number(process.env.WEATHER_LAT ?? 12.2388);
  const lon = Number(process.env.WEATHER_LON ?? 109.1967);
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,uv_index_max,sunrise,sunset` +
    `&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m` +
    `&timezone=${encodeURIComponent(HOTEL_TZ)}&forecast_days=10`;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(url, { signal: ctl.signal });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`Open-Meteo HTTP ${r.status}`);
    const j: any = await r.json();
    const idx: number = (j.daily?.time ?? []).indexOf(date);
    if (idx < 0)
      return {
        available: false,
        date,
        error: `Chưa có dự báo cho ngày ${date} (nhà cung cấp chỉ có ${j.daily?.time?.[0]} → ${j.daily?.time?.slice(-1)[0]}).`,
        instruction:
          "Nói rõ với khách là chưa có dự báo cho ngày đó và đề nghị hỏi lại gần ngày hơn. Không được tự mô tả thời tiết.",
      };
    const code = Number(j.daily.weather_code[idx]);
    const rain = Number(j.daily.precipitation_probability_max?.[idx] ?? 0);
    return {
      available: true,
      source: "Open-Meteo",
      source_url: "https://open-meteo.com/",
      location: `${hotel.name}, ${hotel.city}`,
      coordinates: { latitude: lat, longitude: lon },
      date,
      condition: WMO[code] ?? `Mã thời tiết WMO ${code}`,
      weather_code: code,
      temperature_max_c: j.daily.temperature_2m_max?.[idx] ?? null,
      temperature_min_c: j.daily.temperature_2m_min?.[idx] ?? null,
      rain_chance_percent: rain,
      precipitation_mm: j.daily.precipitation_sum?.[idx] ?? null,
      wind_max_kmh: j.daily.wind_speed_10m_max?.[idx] ?? null,
      uv_index_max: j.daily.uv_index_max?.[idx] ?? null,
      sunrise: j.daily.sunrise?.[idx] ?? null,
      sunset: j.daily.sunset?.[idx] ?? null,
      current:
        date === hotelToday() && j.current
          ? {
              temperature_c: j.current.temperature_2m,
              humidity_percent: j.current.relative_humidity_2m,
              condition: WMO[Number(j.current.weather_code)] ?? null,
              wind_kmh: j.current.wind_speed_10m,
              observed_at: j.current.time,
            }
          : null,
      instruction:
        "Trích dẫn đúng các con số này và nêu nguồn Open-Meteo. Gợi ý hoạt động dựa trên xác suất mưa và chỉ số UV, nhưng không thêm chi tiết thời tiết nào không có ở đây.",
    };
  } catch (e: any) {
    return {
      available: false,
      date,
      error: `Không lấy được dự báo: ${e?.message ?? e}`,
      instruction:
        "Nói với khách là hiện chưa lấy được dự báo thời tiết và đề nghị hỏi lễ tân. TUYỆT ĐỐI không tự bịa thời tiết.",
    };
  }
}

/* ------------------------------------------------------------------ *
 * Tool specifications
 * ------------------------------------------------------------------ */

const fn = (name: string, description: string, parameters: Record<string, unknown>): ToolSpec => ({
  type: "function",
  function: { name, description, parameters },
});

const noArgs = { type: "object", properties: {}, required: [] as string[] };

export const OPS_TOOLS: ToolSpec[] = [
  /* ---------------- P0 ---------------- */

  fn(
    "declare_lodging",
    "Collect and queue the guest's statutory lodging declaration (khai báo lưu trú) required of every Vietnamese accommodation provider. Records identity and, for foreigners, visa and entry details, then raises a front-desk task to file it through the Ministry of Public Security portal or VNeID. Aurea cannot file it itself, so the result always says submitted_to_authority: false — tell the guest their details are recorded and reception completes the filing.",
    {
      type: "object",
      properties: {
        full_name: { type: "string", description: "Họ tên đúng như trên giấy tờ." },
        id_type: { type: "string", enum: ["passport", "national_id", "other"] },
        id_number: { type: "string", description: "Số hộ chiếu hoặc số CCCD." },
        nationality: { type: "string", description: "Quốc tịch, ví dụ Việt Nam, Korea, France." },
        dob: { type: "string", description: "Ngày sinh YYYY-MM-DD." },
        gender: { type: "string", enum: ["male", "female", "other"] },
        permanent_address: { type: "string", description: "Địa chỉ thường trú." },
        visa_number: { type: "string", description: "Số thị thực — bắt buộc với khách nước ngoài nếu có." },
        entry_date: { type: "string", description: "Ngày nhập cảnh YYYY-MM-DD (khách nước ngoài)." },
        entry_port: { type: "string", description: "Cửa khẩu nhập cảnh (khách nước ngoài)." },
        is_foreigner: { type: "boolean", description: "true nếu khách không mang quốc tịch Việt Nam." },
      },
      required: ["full_name", "id_type", "id_number", "nationality"],
    },
  ),

  fn(
    "quote_cancellation",
    "Compute — without cancelling anything — what it would cost to cancel either the stay or one booked service. Returns the policy band, the fee, the refund and whether cancellation is even permitted (a guest already in house or checked out cannot cancel). Always call this and quote the fee before calling cancel_reservation or cancel_service_booking.",
    {
      type: "object",
      properties: {
        target: { type: "string", enum: ["reservation", "service_booking"], description: "Hủy đặt phòng hay hủy một dịch vụ đã đặt." },
        confirmation_code: { type: "string", description: "Mã đặt phòng; mặc định là đặt phòng của hội thoại này." },
        booking_id: { type: "number", description: "ID booking dịch vụ khi target = service_booking." },
      },
      required: ["target"],
    },
  ),

  fn(
    "settle_folio",
    "Start settlement of the outstanding folio balance: reads the folio (charges + service charge + VAT − payments already received), records a payment intent for the chosen method and raises a front-desk task to collect it. Aurea is not connected to a payment gateway, so this never charges a card: the result reports status pending and awaiting_staff_confirmation true. Tell the guest the amount and how it will be collected, never that payment is complete.",
    {
      type: "object",
      properties: {
        method: {
          type: "string",
          enum: ["card_on_file", "cash", "bank_transfer", "payment_link", "room_charge"],
          description: "Hình thức khách muốn thanh toán.",
        },
        amount: { type: "number", description: "Số tiền muốn trả; bỏ trống nghĩa là trả toàn bộ số còn lại." },
        note: { type: "string", description: "Ghi chú cho lễ tân, ví dụ chia hóa đơn." },
      },
      required: ["method"],
    },
  ),

  fn(
    "create_payment_link",
    "Create a single-use payment link for the outstanding balance (or a stated amount) that the guest can pay remotely. Returns the link and its expiry. The link is served by this property's own payment page; if no gateway is configured the result says provider not_connected, which means reception still has to take the money — say the link was created, never that it was paid.",
    {
      type: "object",
      properties: {
        amount: { type: "number", description: "Số tiền; bỏ trống = toàn bộ số dư còn lại." },
        expires_in_hours: { type: "number", description: "Hiệu lực của liên kết, mặc định 24 giờ." },
      },
      required: [],
    },
  ),

  fn(
    "request_housekeeping",
    "Dispatch a housekeeping request for the guest's room: cleaning, turndown, extra amenities, extra bed, linen or towel change, rubbish removal. Raises a real housekeeping task with the requested time and returns its id and SLA. It does not confirm the work is finished — report it as received and on the way.",
    {
      type: "object",
      properties: {
        service_type: {
          type: "string",
          enum: ["cleaning", "turndown", "amenities", "extra_bed", "linen_change", "towels", "trash", "other"],
        },
        items: {
          type: "array",
          items: { type: "string" },
          description: "Danh sách cụ thể khách yêu cầu, ví dụ ['2 khăn tắm','bàn chải'].",
        },
        preferred_time: { type: "string", description: "Giờ mong muốn HH:MM theo giờ khách sạn." },
        note: { type: "string", description: "Ghi chú, ví dụ 'gõ cửa trước', 'không vào khi có biển'." },
      },
      required: ["service_type"],
    },
  ),

  fn(
    "report_maintenance_issue",
    "Report a fault in the room or on the property (air-conditioning, plumbing, electrics, TV, wifi, door lock, furniture). Creates an engineering task with the severity you set, and escalates to a human immediately when the fault is a safety risk. Returns the ticket id — say an engineer is on the way, not that it is fixed.",
    {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["aircon", "plumbing", "electrical", "tv", "wifi", "door_lock", "furniture", "safe", "lighting", "other"],
        },
        description: { type: "string", description: "Hiện tượng cụ thể khách mô tả." },
        severity: { type: "string", enum: ["low", "normal", "high", "urgent"] },
        room_access_ok: { type: "boolean", description: "Khách có đồng ý cho vào phòng khi họ không có mặt hay không." },
        preferred_time: { type: "string", description: "Giờ khách muốn kỹ thuật vào, HH:MM." },
      },
      required: ["category", "description"],
    },
  ),

  fn(
    "get_guest_profile",
    "Read the full stored profile of the guest you are talking to: loyalty tier and the exact entitlement percentages that apply to them, stay history, stored preferences and allergy notes, identity fields already on file, whether their lodging declaration has been filed, open requests and folio balance. Call this before personalising anything, and before asking the guest for information the property already holds.",
    noArgs,
  ),

  fn(
    "modify_service_booking",
    "Change the date, time or party size of an existing service booking. Re-checks capacity and lead time, re-prices the line at the guest's member rate, reverses the old folio charge and posts the corrected one, so the folio always matches the booking. Returns the old and new amounts.",
    {
      type: "object",
      properties: {
        booking_id: { type: "number" },
        new_date: { type: "string", description: "YYYY-MM-DD" },
        new_slot: { type: "string", description: "HH:MM, phải nằm trong các khung giờ dịch vụ hỗ trợ." },
        new_party_size: { type: "number" },
        note: { type: "string" },
      },
      required: ["booking_id"],
    },
  ),

  fn(
    "extend_stay",
    "Check whether the guest's room is free for extra nights and, if it is, extend the reservation and post the additional room nights to the folio at their member rate. If the room is taken on any of the extra nights, it returns available: false with the blocking date so you can offer a room move instead of promising an extension.",
    {
      type: "object",
      properties: {
        new_check_out: { type: "string", description: "Ngày trả phòng mới YYYY-MM-DD." },
        extra_nights: { type: "number", description: "Số đêm muốn thêm — dùng khi khách nói 'thêm 2 đêm'." },
      },
      required: [],
    },
  ),

  fn(
    "request_invoice",
    "Request the VAT invoice (hóa đơn GTGT) for the stay with the buyer's legal details. Captures buyer name, tax code and address, computes the net / service charge / VAT / gross split from the folio, and queues accounting to issue the e-invoice to the given email. Returns status requested — the invoice number only exists after accounting issues it.",
    {
      type: "object",
      properties: {
        buyer_type: { type: "string", enum: ["personal", "company"] },
        buyer_name: { type: "string", description: "Tên cá nhân hoặc tên công ty trên hóa đơn." },
        tax_code: { type: "string", description: "Mã số thuế — bắt buộc khi buyer_type = company." },
        buyer_address: { type: "string", description: "Địa chỉ trên hóa đơn." },
        email: { type: "string", description: "Email nhận hóa đơn điện tử." },
        note: { type: "string" },
      },
      required: ["buyer_type", "buyer_name", "email"],
    },
  ),

  fn(
    "get_live_weather",
    "Real forecast for the property's location from Open-Meteo: condition, max/min temperature, rain probability, wind, UV index, sunrise and sunset, plus current conditions for today. If the provider cannot be reached the result says available: false — in that case tell the guest the forecast is unavailable and never describe the weather yourself.",
    {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD, mặc định hôm nay. Chỉ có dự báo trong khoảng 10 ngày." },
      },
      required: [],
    },
  ),

  /* ---------------- P1 ---------------- */

  fn(
    "request_wake_up_call",
    "Schedule a wake-up call for the guest's room at a given local time, optionally repeating every morning until departure. Creates a front-desk task timed to the minute. Confirm the exact date and time back to the guest.",
    {
      type: "object",
      properties: {
        time: { type: "string", description: "Giờ báo thức HH:MM theo giờ khách sạn." },
        date: { type: "string", description: "Ngày YYYY-MM-DD; mặc định hôm nay nếu giờ còn ở phía trước, nếu không thì ngày mai." },
        repeat_daily: { type: "boolean", description: "true = lặp lại mỗi sáng tới ngày trả phòng." },
        note: { type: "string", description: "Ví dụ 'gọi lại sau 10 phút nếu không bắt máy'." },
      },
      required: ["time"],
    },
  ),

  fn(
    "request_laundry",
    "Arrange laundry or pressing. Quotes each item from the published laundry price list with the express multiplier where relevant, warns when the same-day cutoff has passed, posts the estimate to the folio only after the guest confirms, and dispatches a pickup to the laundry department. Items not on the price list are sent for a staff quote instead of being priced by guesswork.",
    {
      type: "object",
      properties: {
        service_level: { type: "string", enum: ["regular", "express"] },
        items: {
          type: "array",
          description: "Danh sách món cần giặt.",
          items: {
            type: "object",
            properties: {
              item: { type: "string", enum: ["shirt", "trousers", "dress", "suit", "underwear", "other"] },
              quantity: { type: "number" },
              label: { type: "string", description: "Mô tả khi item = other." },
            },
            required: ["item", "quantity"],
          },
        },
        pickup_time: { type: "string", description: "Giờ lấy đồ HH:MM." },
        confirmed_by_guest: { type: "boolean", description: "true chỉ khi khách đã nghe báo giá và đồng ý." },
      },
      required: ["service_level", "items"],
    },
  ),

  fn(
    "request_luggage",
    "Arrange bell service: collect luggage from the room, deliver it to the room, or store it after checkout and before departure. Records the number of pieces and the time, and returns a storage ticket reference when the request is storage.",
    {
      type: "object",
      properties: {
        action: { type: "string", enum: ["pickup", "delivery", "storage", "retrieve_from_storage"] },
        pieces: { type: "number", description: "Số kiện hành lý." },
        time: { type: "string", description: "Giờ HH:MM." },
        location: { type: "string", description: "Nơi lấy/giao, ví dụ 'phòng 1204', 'sảnh chính'." },
        note: { type: "string" },
      },
      required: ["action", "pieces"],
    },
  ),

  fn(
    "book_transport",
    "Book resort transport: airport pickup or drop-off, a city transfer, or a car with driver. Quotes the published price with any member discount, enforces the lead time for that service, warns when the party exceeds one car, and dispatches to the transport department with the flight number where given.",
    {
      type: "object",
      properties: {
        service: { type: "string", enum: ["airport_pickup", "airport_dropoff", "city_transfer", "car_rental"] },
        date: { type: "string", description: "YYYY-MM-DD" },
        time: { type: "string", description: "HH:MM giờ khách sạn." },
        passengers: { type: "number" },
        flight_no: { type: "string", description: "Số hiệu chuyến bay khi đón/tiễn sân bay." },
        pickup_point: { type: "string" },
        drop_point: { type: "string" },
        note: { type: "string" },
      },
      required: ["service", "date", "time", "passengers"],
    },
  ),

  fn(
    "report_lost_item",
    "Open a lost-property case: what was lost, where and when it was last seen, and how to contact the guest if it is found. Creates a security/housekeeping search task with a case reference. Never say the item has been found — only that the search has started.",
    {
      type: "object",
      properties: {
        description: { type: "string", description: "Mô tả món đồ càng chi tiết càng tốt." },
        lost_where: { type: "string", description: "Nơi khách nghĩ đã để quên." },
        lost_when: { type: "string", description: "Thời điểm, ví dụ '2026-08-21 tối' hoặc 'sáng nay'." },
        value_estimate: { type: "number", description: "Giá trị ước tính, nếu khách nêu." },
        contact_preference: { type: "string", description: "Cách liên hệ khi tìm thấy." },
      },
      required: ["description"],
    },
  ),

  fn(
    "request_room_move",
    "Ask to change room, either because something is wrong with the current one or because the guest wants an upgrade. Lists the vacant rooms that are actually free for the remaining nights, and when a better category is requested quotes the rate difference for the remaining nights at the guest's member rate. It does not move the guest itself — the front desk approves and reassigns.",
    {
      type: "object",
      properties: {
        reason: { type: "string", description: "Lý do khách muốn đổi phòng." },
        preferred_type: { type: "string", description: "Loại phòng mong muốn, nếu khách nêu." },
        wants_upgrade: { type: "boolean", description: "true nếu đây là yêu cầu nâng cấp có thu phí." },
      },
      required: ["reason"],
    },
  ),

  fn(
    "express_checkout",
    "Set up express checkout: reads the final folio, records a payment intent for the chosen method, asks accounting to email the receipt, and queues front desk and housekeeping for the departure. Returns the exact balance due. The reservation is only marked checked_out by staff once payment is confirmed, so tell the guest what is owed and that reception will finalise it.",
    {
      type: "object",
      properties: {
        payment_method: { type: "string", enum: ["card_on_file", "cash", "bank_transfer", "payment_link"] },
        email: { type: "string", description: "Email nhận biên nhận." },
        departure_time: { type: "string", description: "Giờ rời khách sạn HH:MM, để bố trí hành lý và dọn phòng." },
      },
      required: ["payment_method"],
    },
  ),

  fn(
    "get_request_status",
    "Look up what has actually happened to the guest's requests: every housekeeping, engineering, laundry, transport, wake-up and lost-property ticket with its real department status, plus service bookings, payment intents and the lodging declaration. Use this whenever the guest asks 'is it done yet?' instead of reassuring them from memory.",
    {
      type: "object",
      properties: {
        request_id: { type: "number", description: "Chỉ tra một yêu cầu cụ thể." },
        only_open: { type: "boolean", description: "true = chỉ những việc chưa xong." },
      },
      required: [],
    },
  ),

  fn(
    "get_facility_hours",
    "Opening hours and access notes for the property's facilities (pool, gym, spa, kids club, beach, business centre, reception), with whether each is open at this moment in hotel time. Use this instead of guessing or quoting hours from a knowledge-base article that may be out of date.",
    {
      type: "object",
      properties: {
        facility: {
          type: "string",
          description: "Khóa tiện ích cụ thể, ví dụ pool, gym, spa, kids_club, beach, front_desk, business_center. Bỏ trống để lấy tất cả.",
        },
      },
      required: [],
    },
  ),

  /* ---------------- P2 ---------------- */

  fn(
    "add_guest_to_reservation",
    "Add an accompanying guest to the reservation. Checks the occupancy policy for the room first and refuses when the room limit would be exceeded, captures the companion's identity for the lodging declaration, and queues front desk to update the registration card and key.",
    {
      type: "object",
      properties: {
        name: { type: "string" },
        relation: { type: "string", description: "Quan hệ, ví dụ vợ/chồng, con, đồng nghiệp." },
        age: { type: "number", description: "Tuổi — bắt buộc với trẻ em để áp đúng chính sách." },
        id_type: { type: "string", enum: ["passport", "national_id", "other"] },
        id_number: { type: "string" },
        nationality: { type: "string" },
        dob: { type: "string", description: "YYYY-MM-DD" },
      },
      required: ["name"],
    },
  ),

  fn(
    "get_loyalty_status",
    "Read the guest's Pearl Club standing: current tier, points on file, the published thresholds, how far they are from the next tier and the exact benefit percentages their tier grants. Points come from the guest record — if none are recorded the result says so rather than estimating.",
    noArgs,
  ),

  fn(
    "enroll_loyalty",
    "Enrol a guest who has no tier into Pearl Club with their explicit consent, recording the enrolment date and contact email. Refuses if they are already a member. Membership number and card are issued by the programme, so the result is a queued enrolment, not an active card.",
    {
      type: "object",
      properties: {
        email: { type: "string" },
        phone: { type: "string" },
        consent: { type: "boolean", description: "Bắt buộc true — khách phải đồng ý rõ ràng." },
      },
      required: ["email", "consent"],
    },
  ),

  fn(
    "submit_feedback",
    "Record the guest's feedback or complaint with a 1–5 rating and category, and route it: anything at 3 or below, or any complaint, is escalated to a duty manager rather than filed silently. Use this when a guest praises or criticises the stay, so it reaches the department instead of dying in the chat.",
    {
      type: "object",
      properties: {
        rating: { type: "number", description: "1 đến 5." },
        category: {
          type: "string",
          enum: ["room", "dining", "spa", "service", "cleanliness", "facilities", "checkin", "billing", "general"],
        },
        comment: { type: "string" },
      },
      required: ["comment"],
    },
  ),

  fn(
    "book_meeting_room",
    "Request a meeting or event room for a date and time window with an attendee count, layout and AV needs. If a bookable catalogue row matches, it books and prices it like any other service; otherwise it raises a quote request to the events team. Never quote an event price that did not come back in the result.",
    {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD" },
        start: { type: "string", description: "HH:MM" },
        end: { type: "string", description: "HH:MM" },
        attendees: { type: "number" },
        layout: { type: "string", enum: ["theatre", "u_shape", "boardroom", "banquet", "classroom", "other"] },
        av_needs: { type: "array", items: { type: "string" }, description: "Ví dụ ['máy chiếu','micro không dây']." },
        catering: { type: "string", description: "Yêu cầu tiệc trà/ăn trưa, nếu có." },
      },
      required: ["date", "start", "end", "attendees"],
    },
  ),

  fn(
    "request_babysitting",
    "Request childcare: date, start time, duration, number of children and their ages. Enforces the notice period and flags children under the minimum age for the sitter service, and dispatches to the kids-club team. Charges are confirmed by the team, so quote only what the result returns.",
    {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD" },
        start: { type: "string", description: "HH:MM" },
        hours: { type: "number", description: "Số giờ." },
        children_count: { type: "number" },
        children_ages: { type: "array", items: { type: "number" } },
        note: { type: "string", description: "Dị ứng, thói quen ngủ, ghi chú của phụ huynh." },
      },
      required: ["date", "start", "hours", "children_count"],
    },
  ),

  fn(
    "book_local_tour",
    "Book an excursion or experience from the resort catalogue for a date and number of participants, priced at the guest's member rate. If nothing in the catalogue matches what the guest described, it returns the closest matches instead of inventing a tour, and can raise a request for the concierge desk to arrange an external operator.",
    {
      type: "object",
      properties: {
        service_id: { type: "number", description: "ID từ list_services nếu đã biết." },
        tour_name: { type: "string", description: "Tên hoặc mô tả tour khách muốn." },
        date: { type: "string", description: "YYYY-MM-DD" },
        slot: { type: "string", description: "HH:MM nếu tour có khung giờ." },
        participants: { type: "number" },
        note: { type: "string" },
      },
      required: ["date", "participants"],
    },
  ),

  fn(
    "request_medical_assistance",
    "Summon medical help for a guest. This always escalates to a human immediately and creates an urgent security and front-desk task; it never gives medical advice or a diagnosis. Use it the moment a guest describes illness or injury, and tell them help is on the way and, if the situation sounds severe, to call 115.",
    {
      type: "object",
      properties: {
        symptoms: { type: "string", description: "Nguyên văn khách mô tả." },
        severity: { type: "string", enum: ["mild", "moderate", "severe"] },
        needs_ambulance: { type: "boolean" },
        person: { type: "string", description: "Ai đang gặp vấn đề: khách, trẻ em, người đi cùng." },
        location: { type: "string", description: "Vị trí hiện tại của người bệnh." },
      },
      required: ["symptoms"],
    },
  ),
];

export const OPS_TOOL_NAMES = new Set(OPS_TOOLS.map((t) => t.function.name));

/* ------------------------------------------------------------------ *
 * Handlers
 * ------------------------------------------------------------------ */

function needRes(ctx: OpsCtx) {
  return ctx.res ? null : { error: "No reservation linked to this conversation." };
}

export async function runOpsTool(
  name: string,
  args: any,
  ctx: OpsCtx,
): Promise<Record<string, unknown> | null> {
  ensureOpsPolicies();
  const { hotel, guest, res, room, conv } = ctx;
  const a = args ?? {};

  switch (name) {
    /* ---------------------------------------------------------------- *
     * P0
     * ---------------------------------------------------------------- */

    case "declare_lodging": {
      const miss = needRes(ctx);
      if (miss) return miss;
      const { rules: dr, cite } = rules("LODGING_DECLARATION", DEFAULT_LODGING_DECLARATION);
      const foreigner =
        a.is_foreigner ?? !/vi[eệ]t\s*nam|vietnam|vn/i.test(String(a.nationality ?? ""));
      const required: string[] = foreigner
        ? (dr as any).required_fields_foreigner
        : (dr as any).required_fields_vietnamese;
      const provided: Record<string, unknown> = {
        full_name: a.full_name,
        id_number: a.id_number,
        nationality: a.nationality,
        dob: a.dob,
        permanent_address: a.permanent_address,
        visa_number: a.visa_number,
        entry_date: a.entry_date,
        entry_port: a.entry_port,
        arrival_at: res!.checkIn,
      };
      const missing = required.filter((f) => !provided[f]);

      const reg = storage.createRegistration({
        hotelId: hotel.id,
        reservationId: res!.id,
        guestId: guest.id,
        fullName: String(a.full_name),
        idType: String(a.id_type),
        idNumber: String(a.id_number),
        nationality: String(a.nationality),
        dob: a.dob ? String(a.dob) : null,
        gender: a.gender ? String(a.gender) : null,
        visaNumber: a.visa_number ? String(a.visa_number) : null,
        entryDate: a.entry_date ? String(a.entry_date) : null,
        entryPort: a.entry_port ? String(a.entry_port) : null,
        permanentAddress: a.permanent_address ? String(a.permanent_address) : null,
        arrivalAt: hotelIso(res!.checkIn, res!.checkInTime ?? hotel.checkInTime),
        departureAt: hotelIso(res!.checkOut, res!.checkOutTime),
        isForeigner: foreigner ? 1 : 0,
        status: missing.length ? "collected" : "queued",
        channel: null,
        submittedAt: null,
        submittedBy: null,
        receiptRef: null,
        taskId: null,
        note: missing.length ? `Thiếu: ${missing.join(", ")}` : null,
        createdAt: nowIso(),
      });

      /* Keep the guest record in step so we never ask twice. */
      storage.updateGuest(guest.id, {
        idType: String(a.id_type),
        idNumber: String(a.id_number),
        nationality: String(a.nationality),
        dob: a.dob ? String(a.dob) : guest.dob,
      });

      const r = raiseRequest(ctx, {
        kind: "lodging_declaration",
        dept: "front_desk",
        priority: "high",
        title: `Khai báo lưu trú — ${a.full_name}`,
        detail: `Khai báo lưu trú cho ${a.full_name} (${a.id_type} ${a.id_number}, ${a.nationality}${foreigner ? ", khách nước ngoài" : ""}), đặt phòng ${res!.confirmationCode}, phòng ${room?.number ?? "chưa xếp"}. Hồ sơ #${reg.id}.${missing.length ? ` THIẾU THÔNG TIN: ${missing.join(", ")} — phải bổ sung trước khi nộp.` : " Đủ thông tin, nộp qua cổng Bộ Công an hoặc VNeID."} ${(dr as any).penalty_note}`,
        summary: `Khai báo lưu trú #${reg.id} cho ${a.full_name} — chờ lễ tân nộp.`,
        payload: { registrationId: reg.id, foreigner, missing },
        eventType: "lodging.declaration_queued",
      });
      storage.updateRegistration(reg.id, { taskId: r.task.id, status: missing.length ? "collected" : "queued" });

      return {
        recorded: true,
        registration_id: reg.id,
        /* The single most important field: nothing has been filed yet. */
        submitted_to_authority: false,
        status: missing.length ? "collected_incomplete" : "queued_for_submission",
        missing_fields: missing,
        is_foreigner: !!foreigner,
        deadline_hours_after_arrival: (dr as any).deadline_hours_after_arrival,
        deadline_note: (dr as any).deadline_note,
        submission_channels: (dr as any).channels,
        legal_basis: "Thông tư 55/2021/TT-BCA, sửa đổi bởi Thông tư 66/2023/TT-BCA.",
        penalty_note: (dr as any).penalty_note,
        task_id: r.task.id,
        request_id: r.request.id,
        policy: cite,
        instruction: missing.length
          ? `Xin khách bổ sung: ${missing.join(", ")}. Nói rõ thông tin đã ghi nhận nhưng chưa đủ để nộp.`
          : "Nói với khách thông tin đã được ghi nhận và lễ tân sẽ hoàn tất việc khai báo với cơ quan chức năng. KHÔNG nói là đã khai báo xong.",
      };
    }

    case "quote_cancellation": {
      const target = String(a.target ?? "reservation");
      if (target === "service_booking") {
        const id = Number(a.booking_id);
        const booking = id ? storage.getBooking(id) : undefined;
        if (!booking) {
          const open = res
            ? storage
                .bookingsForReservation(res.id)
                .filter((b) => b.status === "confirmed")
                .map((b) => ({
                  booking_id: b.id,
                  service: storage.getService(b.serviceId)?.name ?? `#${b.serviceId}`,
                  date: b.date,
                  slot: b.slot,
                  amount: b.amount,
                }))
            : [];
          return { error: "Không tìm thấy booking dịch vụ đó.", active_bookings: open };
        }
        if (booking.status !== "confirmed")
          return { error: `Booking #${booking.id} đang ở trạng thái ${booking.status}, không thể hủy.` };
        const svc = storage.getService(booking.serviceId);
        const q = quoteServiceCancellation(booking, new Date(), hotel.currency);
        return {
          target: "service_booking",
          service: svc?.name ?? `#${booking.serviceId}`,
          date: booking.date,
          slot: booking.slot,
          free_cancellation_until: booking.cancelDeadline,
          ...q,
          instruction:
            "Báo rõ phí hủy và số tiền hoàn trước khi gọi cancel_service_booking. Nếu khách chưa đồng ý thì không hủy.",
        };
      }

      const code = String(a.confirmation_code || res?.confirmationCode || "").trim().toUpperCase();
      if (!code) return { error: "Không có mã đặt phòng." };
      const target_res = storage.getReservationByCode(code);
      if (!target_res) return { error: `Không tìm thấy đặt phòng ${code}.` };
      const q = quoteReservationCancellation(target_res, hotelToday(), hotel.currency);
      return {
        target: "reservation",
        ...q,
        instruction: q.cancellable
          ? "Báo phí hủy và xin khách xác nhận rõ ràng trước khi gọi cancel_reservation."
          : `Không được hủy: ${q.reason_not_cancellable} Hãy chuyển lễ tân qua escalate_to_human.`,
      };
    }

    case "settle_folio":
    case "express_checkout": {
      const miss = needRes(ctx);
      if (miss) return miss;
      const isExpress = name === "express_checkout";
      const folio = folioSummary(res!.id);
      /* Never let an unrecognised value reach the payments table: String(undefined)
       * silently stores the literal "undefined" as a payment method, which then
       * appears on a real folio and in accounting's task list. */
      const PAYMENT_METHODS: Payment["method"][] = [
        "card_on_file",
        "payment_link",
        "cash",
        "bank_transfer",
        "room_charge",
      ];
      const rawMethod = isExpress ? a.payment_method : a.method;
      if (typeof rawMethod !== "string" || !PAYMENT_METHODS.includes(rawMethod as Payment["method"]))
        return {
          error: `Hình thức thanh toán không hợp lệ: ${JSON.stringify(rawMethod ?? null)}.`,
          accepted_methods: PAYMENT_METHODS,
          instruction:
            "Hỏi khách muốn thanh toán bằng hình thức nào trong accepted_methods, rồi gọi lại tool. KHÔNG tự chọn hộ khách.",
        };
      const method = rawMethod as Payment["method"];
      const requested = Number(a.amount);
      const amount =
        Number.isFinite(requested) && requested > 0 ? roundVnd(requested) : folio.balance_due;

      if (folio.balance_due <= 0 && !(Number.isFinite(requested) && requested > 0))
        return {
          done: false,
          nothing_to_pay: true,
          folio,
          instruction:
            "Số dư đã bằng 0 hoặc âm — nói với khách là không còn khoản nào phải trả và mời kiểm tra lại bảng kê nếu cần.",
        };

      const pay = createPaymentIntent(ctx, {
        amount,
        method: method as Payment["method"],
        note: a.note ? String(a.note) : isExpress ? "express checkout" : undefined,
        expiresInHours: 24,
      });

      const openRequests = storage
        .requestsFor(res!.id)
        .filter((r0) => r0.status === "open" || r0.status === "in_progress");

      const r = raiseRequest(ctx, {
        kind: isExpress ? "express_checkout" : "folio_settlement",
        dept: "front_desk",
        priority: "high",
        title: isExpress
          ? `Express checkout — phòng ${room?.number ?? "—"}`
          : `Thu ${vnd(amount)} — ${res!.confirmationCode}`,
        detail: `${guest.name}, đặt phòng ${res!.confirmationCode}. Số dư ${vnd(folio.balance_due)}, khách chọn trả ${vnd(amount)} bằng ${method}. Payment intent #${pay.id}${pay.link ? ` (link ${pay.link})` : ""}. ${folio.breakdown}${isExpress ? ` Giờ rời: ${a.departure_time ?? "chưa nêu"}. Email biên nhận: ${a.email ?? guest.email ?? "chưa có"}.` : ""}${openRequests.length ? ` ⚠ Còn ${openRequests.length} yêu cầu chưa đóng.` : ""}`,
        summary: `${isExpress ? "Express checkout" : "Thanh toán"} ${vnd(amount)} — chờ lễ tân xác nhận.`,
        payload: { paymentId: pay.id, amount, method },
        eventType: isExpress ? "checkout.express_requested" : "payment.intent_created",
      });
      storage.updatePayment(pay.id, { taskId: r.task.id });

      if (isExpress) {
        raiseRequest(ctx, {
          kind: "housekeeping",
          dept: "housekeeping",
          title: `Dọn phòng sau khi khách rời — ${room?.number ?? "—"}`,
          detail: `Khách ${guest.name} express checkout${a.departure_time ? ` lúc ${a.departure_time}` : ""}.`,
          summary: `Dọn phòng ${room?.number ?? "—"} sau express checkout.`,
          scheduledFor: a.departure_time && isHHMM(a.departure_time) ? hotelIso(hotelToday(), String(a.departure_time)) : null,
        });
      }

      return {
        done: false,
        awaiting_staff_confirmation: true,
        payment_id: pay.id,
        payment_status: pay.status,
        gateway: pay.provider,
        method,
        amount_due: folio.balance_due,
        amount_to_pay: amount,
        currency: hotel.currency,
        payment_link: pay.link,
        expires_at: pay.expiresAt,
        folio,
        open_requests_before_departure: openRequests.map((o) => ({
          request_id: o.id,
          kind: o.kind,
          status: o.status,
          summary: o.summary,
        })),
        task_id: r.task.id,
        reservation_status: res!.status,
        instruction:
          "Đọc rõ số tiền còn phải trả và cách thu, rồi nói lễ tân sẽ xác nhận khi nhận được tiền. TUYỆT ĐỐI không nói đã thanh toán thành công hay đã trả phòng xong — hệ thống chưa nhận tiền và chưa đổi trạng thái đặt phòng.",
      };
    }

    case "create_payment_link": {
      const miss = needRes(ctx);
      if (miss) return miss;
      const folio = folioSummary(res!.id);
      const requested = Number(a.amount);
      const amount =
        Number.isFinite(requested) && requested > 0 ? roundVnd(requested) : folio.balance_due;
      if (amount <= 0)
        return { error: "Số dư hiện tại không còn khoản nào phải trả.", folio };
      const pay = createPaymentIntent(ctx, {
        amount,
        method: "payment_link",
        expiresInHours: Number(a.expires_in_hours) || 24,
        note: "created from chat",
      });
      const base = publicBaseUrl();
      return {
        created: true,
        payment_id: pay.id,
        amount,
        currency: hotel.currency,
        link: pay.link,
        link_is_absolute: !!base,
        expires_at: pay.expiresAt,
        gateway: pay.provider,
        paid: false,
        instruction: base
          ? "Gửi liên kết cho khách và nói liên kết có hiệu lực tới thời điểm ghi trong expires_at. Không nói là đã thanh toán."
          : "Chưa cấu hình PUBLIC_BASE_URL nên liên kết chỉ là đường dẫn tương đối — nói với khách rằng lễ tân sẽ gửi liên kết thanh toán, và ghi nhận yêu cầu.",
      };
    }

    case "request_housekeeping": {
      const type = String(a.service_type);
      const items: string[] = Array.isArray(a.items) ? a.items.map(String) : [];
      const when = isHHMM(a.preferred_time) ? String(a.preferred_time) : null;
      const labels: Record<string, string> = {
        cleaning: "Dọn phòng",
        turndown: "Dịch vụ chỉnh trang buổi tối",
        amenities: "Bổ sung đồ dùng",
        extra_bed: "Kê thêm giường",
        linen_change: "Đổi ga giường",
        towels: "Bổ sung khăn",
        trash: "Thu gom rác",
        other: "Yêu cầu buồng phòng",
      };
      const r = raiseRequest(ctx, {
        kind: "housekeeping",
        dept: "housekeeping",
        priority: type === "extra_bed" ? "high" : "normal",
        title: `${labels[type] ?? "Buồng phòng"} — phòng ${room?.number ?? "—"}`,
        detail: `${labels[type] ?? type} cho ${guest.name}, phòng ${room?.number ?? "chưa xếp"}.${items.length ? ` Hạng mục: ${items.join(", ")}.` : ""}${when ? ` Giờ mong muốn: ${when}.` : ""}${a.note ? ` Ghi chú: ${a.note}` : ""}`,
        summary: `${labels[type] ?? type} phòng ${room?.number ?? "—"}${when ? ` lúc ${when}` : ""}`,
        payload: { service_type: type, items, preferred_time: when },
        scheduledFor: when ? hotelIso(hotelToday(), when) : null,
      });
      return queued(ctx, r, {
        service_type: type,
        items,
        preferred_time: when,
        extra_bed_note:
          type === "extra_bed"
            ? "Giường phụ phụ thuộc chính sách số người/phòng và có thể phát sinh phụ phí — lễ tân xác nhận."
            : undefined,
      });
    }

    case "report_maintenance_issue": {
      const category = String(a.category);
      const severityIn = String(a.severity ?? "normal");
      const safety = /door_lock|electrical|safe/.test(category) || severityIn === "urgent";
      const priority = (safety ? "urgent" : severityIn) as "low" | "normal" | "high" | "urgent";
      const when = isHHMM(a.preferred_time) ? String(a.preferred_time) : null;

      const r = raiseRequest(ctx, {
        kind: "maintenance",
        dept: "engineering",
        priority,
        title: `Sự cố ${category} — phòng ${room?.number ?? "—"}`,
        detail: `${a.description} (phòng ${room?.number ?? "chưa xếp"}, khách ${guest.name}). Cho vào phòng khi khách vắng: ${a.room_access_ok === true ? "được" : a.room_access_ok === false ? "không" : "chưa rõ"}.${when ? ` Giờ mong muốn: ${when}.` : ""}`,
        summary: `Sự cố ${category} phòng ${room?.number ?? "—"}: ${String(a.description).slice(0, 80)}`,
        payload: { category, severity: priority, room_access_ok: a.room_access_ok ?? null },
        scheduledFor: when ? hotelIso(hotelToday(), when) : null,
        eventType: "maintenance.reported",
      });

      if (safety) {
        storage.updateConversation(conv.id, { mode: "human", unreadForStaff: 1 });
        raiseRequest(ctx, {
          kind: "maintenance",
          dept: "security",
          priority: "urgent",
          title: `An toàn — ${category} phòng ${room?.number ?? "—"}`,
          detail: `Sự cố có yếu tố an toàn/an ninh: ${a.description}. Cần người tới ngay.`,
          summary: `Cảnh báo an toàn phòng ${room?.number ?? "—"} (${category}).`,
        });
      }

      return queued(ctx, r, {
        category,
        severity: priority,
        escalated_to_human: safety,
        instruction: safety
          ? "Đây là sự cố có yếu tố an toàn: nói với khách bộ phận kỹ thuật và an ninh đang tới ngay, và hội thoại đã chuyển cho nhân viên. Không hứa thời gian sửa xong."
          : "Nói với khách đã ghi nhận và kỹ thuật sẽ tới trong khung SLA. Không nói là đã sửa xong.",
      });
    }

    case "get_guest_profile": {
      const ent = getEntitlements(guest.vipTier);
      let prefs: string[] = [];
      try {
        prefs = JSON.parse(guest.preferences || "[]");
      } catch {
        prefs = [];
      }
      const regs = res ? storage.registrationsFor(res.id) : [];
      const reqs = res ? storage.requestsFor(res.id) : [];
      const folio = res ? folioSummary(res.id) : null;
      const bookings = res
        ? storage.bookingsForReservation(res.id).map((b) => ({
            booking_id: b.id,
            service: storage.getService(b.serviceId)?.name ?? `#${b.serviceId}`,
            date: b.date,
            slot: b.slot,
            party_size: b.partySize,
            status: b.status,
            amount: b.amount,
          }))
        : [];
      return {
        guest: {
          name: guest.name,
          language: guest.lang,
          vip_tier: guest.vipTier,
          stays_count: guest.staysCount,
          phone_on_file: !!guest.phone,
          email: guest.email,
          loyalty_points: guest.loyaltyPoints,
          identity_on_file: {
            id_type: guest.idType,
            id_number: guest.idNumber ? `${String(guest.idNumber).slice(0, 3)}***` : null,
            nationality: guest.nationality,
            dob: guest.dob,
          },
        },
        preferences: prefs,
        allergy_or_diet_notes: allergyNotes(guest),
        staff_notes: guest.notes,
        entitlements: {
          tier: ent.tier,
          room_discount_pct: ent.roomDiscountPct,
          spa_discount_pct: ent.spaDiscountPct,
          golf_discount_pct: ent.golfDiscountPct,
          fnb_discount_pct: ent.fnbDiscountPct,
          transport_discount_pct: ent.transportDiscountPct,
          early_checkin_free_hours: ent.earlyCheckinFreeHours,
          late_checkout_free_hours: ent.lateCheckoutFreeHours,
          notes: ent.notes,
          excluded: ent.excluded,
          policy: ent.policy,
        },
        reservation: res
          ? {
              confirmation_code: res.confirmationCode,
              room: room?.number ?? null,
              room_type: room?.type ?? null,
              check_in: res.checkIn,
              check_in_time: res.checkInTime,
              check_out: res.checkOut,
              check_out_time: res.checkOutTime,
              nights: nightsBetween(res.checkIn, res.checkOut),
              adults: res.adults,
              children: res.children,
              rate_per_night: res.ratePerNight,
              status: res.status,
            }
          : null,
        lodging_declaration: regs.length
          ? regs.map((g) => ({ id: g.id, name: g.fullName, status: g.status, submitted_at: g.submittedAt }))
          : { status: "not_collected", note: "Chưa có hồ sơ khai báo lưu trú — dùng declare_lodging." },
        service_bookings: bookings,
        open_requests: reqs
          .filter((r0) => r0.status === "open" || r0.status === "in_progress")
          .map((r0) => ({ request_id: r0.id, kind: r0.kind, status: r0.status, summary: r0.summary })),
        folio_balance: folio ? folio.balance_due : null,
        folio_currency: hotel.currency,
        instruction:
          "Dùng đúng các phần trăm ưu đãi ở đây, không tự nhớ. Không đọc lại số giấy tờ đầy đủ cho khách qua chat.",
      };
    }

    case "modify_service_booking": {
      const miss = needRes(ctx);
      if (miss) return miss;
      const booking = storage.getBooking(Number(a.booking_id));
      if (!booking || booking.reservationId !== res!.id)
        return {
          error: "Không tìm thấy booking đó trong đặt phòng này.",
          active_bookings: storage
            .bookingsForReservation(res!.id)
            .filter((b) => b.status === "confirmed")
            .map((b) => ({
              booking_id: b.id,
              service: storage.getService(b.serviceId)?.name ?? `#${b.serviceId}`,
              date: b.date,
              slot: b.slot,
            })),
        };
      if (booking.status !== "confirmed")
        return { error: `Booking #${booking.id} đang ở trạng thái ${booking.status}.` };
      const svc = storage.getService(booking.serviceId);
      if (!svc) return { error: "Dịch vụ của booking này không còn trong danh mục." };

      const date = a.new_date ? String(a.new_date) : booking.date;
      const slot = a.new_slot ? String(a.new_slot) : booking.slot;
      const party = a.new_party_size ? Math.max(1, Number(a.new_party_size)) : booking.partySize;
      if (date === booking.date && slot === booking.slot && party === booking.partySize)
        return { error: "Không có thay đổi nào được yêu cầu." };
      if (!isIsoDate(date)) return { error: "new_date phải là YYYY-MM-DD." };
      if (date < hotelToday()) return { error: "Không thể đổi sang ngày đã qua." };

      const slots: string[] = JSON.parse(svc.slots || "[]");
      if (slots.length && !slots.includes(slot))
        return { error: `${svc.name} không có khung ${slot}. Khung hợp lệ: ${slots.join(", ")}` };

      /* Capacity, excluding this booking's own seats. */
      if (slots.length) {
        const taken = storage
          .bookingsFor(svc.id, date)
          .filter((b) => b.slot === slot && b.id !== booking.id)
          .reduce((n, b) => n + b.partySize, 0);
        if (taken + party > svc.capacityPerSlot)
          return {
            error: `Khung ${slot} ngày ${date} chỉ còn ${Math.max(0, svc.capacityPerSlot - taken)} chỗ.`,
            suggestion: "Đề xuất khung giờ khác từ list_services.",
          };
      }

      const startsAt = new Date(hotelIso(date, slots.length ? slot : "00:00"));
      const leadHours = (startsAt.getTime() - Date.now()) / 3_600_000;
      if (slots.length && leadHours < 1)
        return { error: `Khung mới bắt đầu sau ${Math.round(leadHours * 60)} phút — quá gấp để đổi.` };

      const priced = priceService(svc, guest.vipTier, party, hotel.currency);
      const oldAmount = booking.amount ?? 0;

      /* Reverse the old line, post the corrected one — the folio must not drift. */
      let reversal: ReturnType<typeof reverseCharge> = null;
      if (booking.chargeId) reversal = reverseCharge(booking.chargeId, `đổi lịch booking #${booking.id}`);
      const charge = postCharge({
        reservationId: res!.id,
        description: `${svc.name} — ${date} ${slot} × ${party} (đổi từ ${booking.date} ${booking.slot} × ${booking.partySize})`,
        amount: priced.net_amount,
        category: svc.category === "spa" ? "spa" : svc.category === "dining" || svc.category === "roomservice" ? "fnb" : "fee",
        taxable: true,
        refType: "service_booking",
        refId: booking.id,
      });

      const { rules: cr } = rules("SERVICE_CANCELLATION", { free_until_hours_before: 24 } as any);
      const updated = storage.updateBooking(booking.id, {
        date,
        slot,
        partySize: party,
        amount: priced.net_amount,
        chargeId: charge.id,
        cancelDeadline: new Date(
          startsAt.getTime() - (Number((cr as any).free_until_hours_before) || 0) * 3_600_000,
        ).toISOString(),
        note: a.note ? String(a.note) : booking.note,
      });

      const r = raiseRequest(ctx, {
        kind: "service_booking_change",
        dept: svc.dept,
        title: `Đổi lịch ${svc.name} → ${date} ${slot}`,
        detail: `Booking #${booking.id} của ${guest.name}: ${booking.date} ${booking.slot} × ${booking.partySize} → ${date} ${slot} × ${party}. Folio: hoàn ${vnd(oldAmount)}, ghi nợ ${vnd(priced.net_amount)}.${a.note ? ` Ghi chú: ${a.note}` : ""}`,
        summary: `Đổi lịch ${svc.name} sang ${date} ${slot} × ${party}`,
        payload: { bookingId: booking.id, chargeId: charge.id },
        scheduledFor: hotelIso(date, slots.length ? slot : "00:00"),
        amount: priced.net_amount,
        chargeId: charge.id,
        eventType: "booking.modified",
      });

      return {
        modified: true,
        booking_id: updated.id,
        service: svc.name,
        from: { date: booking.date, slot: booking.slot, party_size: booking.partySize, amount: oldAmount },
        to: { date, slot, party_size: party, amount: priced.net_amount },
        difference: roundVnd(priced.net_amount - oldAmount),
        old_charge_reversed: !!reversal,
        folio_charge_id: charge.id,
        member_discount_percent: priced.discount_pct,
        price_calculation: priced.calculation,
        currency: hotel.currency,
        free_cancellation_until: updated.cancelDeadline,
        task_id: r.task.id,
        instruction:
          "Xác nhận lịch mới và nêu chênh lệch tiền nếu có. Nếu chưa hoàn được khoản cũ (old_charge_reversed = false) thì phải nói khách rằng lễ tân sẽ điều chỉnh hóa đơn.",
      };
    }

    case "extend_stay": {
      const miss = needRes(ctx);
      if (miss) return miss;
      if (res!.status === "cancelled" || res!.status === "checked_out")
        return { error: `Đặt phòng đang ở trạng thái ${res!.status} — không thể gia hạn.` };

      const extra = Number(a.extra_nights);
      const newOut = a.new_check_out
        ? String(a.new_check_out)
        : Number.isFinite(extra) && extra > 0
          ? addDays(res!.checkOut, Math.floor(extra))
          : null;
      if (!newOut || !isIsoDate(newOut))
        return { error: "Cần new_check_out (YYYY-MM-DD) hoặc extra_nights." };
      if (newOut <= res!.checkOut)
        return { error: `Ngày trả phòng mới phải sau ${res!.checkOut}.` };

      const addedNights = nightsBetween(res!.checkOut, newOut);

      /* Is the same room actually free for the extra nights? */
      let blocker: { code: string; check_in: string } | null = null;
      if (res!.roomId) {
        const next = storage.nextReservationForRoom(res!.roomId, res!.checkOut);
        if (next && next.id !== res!.id && next.checkIn < newOut)
          blocker = { code: next.confirmationCode, check_in: next.checkIn };
      }
      if (blocker) {
        const r = raiseRequest(ctx, {
          kind: "room_move",
          dept: "front_desk",
          priority: "high",
          title: `Gia hạn tới ${newOut} — phòng ${room?.number ?? "—"} đã có khách`,
          detail: `${guest.name} muốn ở thêm tới ${newOut}, nhưng phòng ${room?.number ?? "—"} đã được đặt từ ${blocker.check_in} (${blocker.code}). Cần tìm phòng khác hoặc đổi phòng.`,
          summary: `Gia hạn tới ${newOut} cần đổi phòng.`,
          payload: { requestedCheckOut: newOut, blocker },
        });
        return {
          extended: false,
          available: false,
          requested_check_out: newOut,
          blocked_from: blocker.check_in,
          reason: `Phòng ${room?.number ?? "hiện tại"} đã có khách khác từ ${blocker.check_in}.`,
          escalated_request_id: r.request.id,
          task_id: r.task.id,
          instruction:
            "Nói rõ phòng hiện tại không còn trống cho các đêm thêm, và lễ tân đang tìm phòng thay thế. Không hứa là đã gia hạn.",
        };
      }

      const ent = getEntitlements(guest.vipTier);
      const nightly = roundVnd(res!.ratePerNight * (1 - ent.roomDiscountPct / 100));
      const total = roundVnd(nightly * addedNights);

      const oldOut = res!.checkOut;
      const updated = storage.updateReservation(res!.id, { checkOut: newOut });
      const charge = postCharge({
        reservationId: res!.id,
        description: `Gia hạn lưu trú ${addedNights} đêm (${oldOut} → ${newOut}) × ${vnd(nightly)}`,
        amount: total,
        category: "room",
        taxable: true,
        refType: "extend_stay",
        refId: res!.id,
      });

      const r = raiseRequest(ctx, {
        kind: "extend_stay",
        dept: "front_desk",
        priority: "high",
        title: `Gia hạn ${res!.confirmationCode} → ${newOut}`,
        detail: `${guest.name}, phòng ${room?.number ?? "—"}: ${oldOut} → ${newOut} (+${addedNights} đêm), ${vnd(nightly)}/đêm sau ưu đãi ${ent.roomDiscountPct}%, tổng ${vnd(total)} đã ghi nợ folio (line #${charge.id}). Cần cập nhật khóa phòng và lịch buồng phòng.`,
        summary: `Gia hạn tới ${newOut} (+${addedNights} đêm, ${vnd(total)}).`,
        payload: { newCheckOut: newOut, nights: addedNights, chargeId: charge.id },
        amount: total,
        chargeId: charge.id,
        eventType: "reservation.extended",
      });

      return {
        extended: true,
        available: true,
        confirmation_code: updated.confirmationCode,
        previous_check_out: oldOut,
        new_check_out: newOut,
        extra_nights: addedNights,
        rate_per_night_rack: res!.ratePerNight,
        rate_per_night_member: nightly,
        room_discount_percent: ent.roomDiscountPct,
        total_added: total,
        currency: hotel.currency,
        folio_charge_id: charge.id,
        price_basis: "Giá net, chưa gồm phí phục vụ và VAT — xem get_folio.",
        pms_updated: true,
        task_id: r.task.id,
        instruction:
          "Xác nhận ngày trả phòng mới, số đêm thêm và số tiền đã ghi vào hóa đơn phòng. Nhắc khách khóa phòng sẽ được gia hạn tại lễ tân.",
      };
    }

    case "request_invoice": {
      const miss = needRes(ctx);
      if (miss) return miss;
      const buyerType = String(a.buyer_type ?? "personal");
      if (buyerType === "company" && !a.tax_code)
        return {
          error: "Hóa đơn cho công ty bắt buộc phải có mã số thuế.",
          instruction: "Xin khách cung cấp mã số thuế và địa chỉ đăng ký của công ty.",
        };
      const email = String(a.email ?? guest.email ?? "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return { error: "Cần một email hợp lệ để gửi hóa đơn điện tử." };

      const folio = folioSummary(res!.id);
      const inv = storage.createInvoiceRequest({
        hotelId: hotel.id,
        reservationId: res!.id,
        buyerName: String(a.buyer_name),
        taxCode: a.tax_code ? String(a.tax_code) : null,
        buyerAddress: a.buyer_address ? String(a.buyer_address) : null,
        email,
        buyerType,
        netAmount: folio.taxable_subtotal + folio.non_taxable_subtotal,
        serviceCharge: folio.service_charge,
        vatAmount: folio.vat,
        grossAmount: folio.grand_total,
        status: "requested",
        invoiceNo: null,
        issuedAt: null,
        taskId: null,
        note: a.note ? String(a.note) : null,
        createdAt: nowIso(),
      });

      const r = raiseRequest(ctx, {
        kind: "invoice",
        dept: "front_desk",
        priority: "normal",
        title: `Hóa đơn GTGT — ${res!.confirmationCode}`,
        detail: `Xuất hóa đơn cho ${a.buyer_name}${a.tax_code ? ` (MST ${a.tax_code})` : ""}, ${buyerType === "company" ? "khách hàng doanh nghiệp" : "khách cá nhân"}. Địa chỉ: ${a.buyer_address ?? "—"}. Email: ${email}. Tiền dịch vụ ${vnd(inv.netAmount)}, phí phục vụ ${vnd(inv.serviceCharge)}, VAT ${vnd(inv.vatAmount)}, tổng ${vnd(inv.grossAmount)}. Yêu cầu #${inv.id}.`,
        summary: `Hóa đơn GTGT #${inv.id} — ${vnd(inv.grossAmount)}`,
        payload: { invoiceRequestId: inv.id },
        eventType: "invoice.requested",
      });
      storage.updateInvoiceRequest(inv.id, { taskId: r.task.id });

      return {
        requested: true,
        issued: false,
        invoice_request_id: inv.id,
        buyer_type: buyerType,
        buyer_name: inv.buyerName,
        tax_code: inv.taxCode,
        email,
        net_amount: inv.netAmount,
        service_charge: inv.serviceCharge,
        service_charge_pct: folio.service_charge_pct,
        vat_amount: inv.vatAmount,
        vat_pct: folio.vat_pct,
        gross_amount: inv.grossAmount,
        currency: hotel.currency,
        breakdown: folio.breakdown,
        task_id: r.task.id,
        instruction:
          "Đọc lại chính xác thông tin người mua để khách kiểm tra, nêu tổng tiền và nói hóa đơn điện tử sẽ được kế toán phát hành và gửi vào email. Không tự tạo số hóa đơn.",
      };
    }

    case "get_live_weather":
    case "get_weather": {
      const date = isIsoDate(a.date) ? String(a.date) : hotelToday();
      return (await fetchWeather(date, hotel)) as Record<string, unknown>;
    }

    /* ---------------------------------------------------------------- *
     * P1
     * ---------------------------------------------------------------- */

    case "request_wake_up_call": {
      const time = String(a.time ?? "");
      if (!isHHMM(time)) return { error: "time phải ở dạng HH:MM 24 giờ." };
      let date = isIsoDate(a.date) ? String(a.date) : null;
      if (!date) date = minutesOf(time) > minutesOf(hotelClock()) ? hotelToday() : addDays(hotelToday(), 1);
      if (res && date > res.checkOut)
        return { error: `Ngày ${date} sau ngày trả phòng ${res.checkOut}.` };
      const repeat = !!a.repeat_daily;
      const lastDay = repeat && res ? res.checkOut : date;

      const r = raiseRequest(ctx, {
        kind: "wake_up",
        dept: "front_desk",
        priority: "high",
        title: `Báo thức ${time} — phòng ${room?.number ?? "—"}`,
        detail: `Gọi báo thức cho ${guest.name}, phòng ${room?.number ?? "chưa xếp"}, ${repeat ? `mỗi sáng ${time} từ ${date} tới ${lastDay}` : `ngày ${date} lúc ${time}`}.${a.note ? ` Ghi chú: ${a.note}` : ""}`,
        summary: `Báo thức ${time}${repeat ? " (mỗi sáng)" : ` ngày ${date}`} phòng ${room?.number ?? "—"}`,
        payload: { time, date, repeat_daily: repeat, until: lastDay },
        scheduledFor: hotelIso(date, time),
      });
      return queued(ctx, r, {
        time,
        date,
        repeat_daily: repeat,
        repeats_until: repeat ? lastDay : null,
        instruction:
          "Nhắc lại chính xác ngày và giờ báo thức để khách xác nhận, và nói lễ tân sẽ thực hiện cuộc gọi.",
      });
    }

    case "request_laundry": {
      const miss = needRes(ctx);
      if (miss) return miss;
      const { rules: lr, cite } = rules("LAUNDRY", DEFAULT_LAUNDRY);
      const level = String(a.service_level ?? "regular");
      const levelCfg = (lr as any).levels?.[level] ?? (lr as any).levels.regular;
      const priceList: any[] = (lr as any).price_list ?? [];
      const items = Array.isArray(a.items) ? a.items : [];
      if (!items.length) return { error: "Chưa có món nào cần giặt." };

      const priced: any[] = [];
      const needQuote: any[] = [];
      let total = 0;
      for (const it of items) {
        const key = String(it.item);
        const qty = Math.max(1, Number(it.quantity ?? 1));
        const row = priceList.find((p) => p.item === key);
        if (!row || !row.price) {
          needQuote.push({ item: key, label: it.label ?? row?.label ?? key, quantity: qty });
          continue;
        }
        const unit = roundVnd(row.price * (Number(levelCfg?.multiplier) || 1));
        const line = roundVnd(unit * qty);
        total += line;
        priced.push({ item: key, label: row.label, quantity: qty, unit_price: unit, amount: line });
      }

      const cutoff = String((lr as any).cutoff_for_same_day ?? "10:00");
      const pastCutoff = minutesOf(hotelClock()) > minutesOf(cutoff);
      const turnaround = Number(levelCfg?.turnaround_hours) || 24;
      const confirmed = a.confirmed_by_guest === true;
      const pickup = isHHMM(a.pickup_time) ? String(a.pickup_time) : null;

      /* Money only moves once the guest has heard the number and agreed. */
      let charge: { id: number } | null = null;
      if (confirmed && total > 0) {
        charge = postCharge({
          reservationId: res!.id,
          description: `Giặt ủi ${level === "express" ? "hỏa tốc" : "thường"} — ${priced.map((p) => `${p.quantity}×${p.label}`).join(", ")}`,
          amount: total,
          category: "fee",
          taxable: true,
          refType: "laundry",
          refId: res!.id,
        });
      }

      const r = raiseRequest(ctx, {
        kind: "laundry",
        dept: "laundry",
        priority: level === "express" ? "high" : "normal",
        title: `Giặt ủi ${level} — phòng ${room?.number ?? "—"}`,
        detail: `${guest.name}, phòng ${room?.number ?? "chưa xếp"}. ${priced.map((p) => `${p.quantity}×${p.label}`).join(", ") || "—"}${needQuote.length ? `. Cần báo giá: ${needQuote.map((p) => `${p.quantity}×${p.label}`).join(", ")}` : ""}. Mức ${level} (${turnaround} giờ).${pickup ? ` Lấy đồ lúc ${pickup}.` : ""} ${confirmed ? `Khách đã đồng ý ${vnd(total)}, đã ghi folio${charge ? ` (line #${charge.id})` : ""}.` : "CHƯA ghi folio — khách chưa xác nhận báo giá."}`,
        summary: `Giặt ủi ${level} phòng ${room?.number ?? "—"} — ${vnd(total)}${confirmed ? "" : " (chờ khách xác nhận)"}`,
        payload: { level, priced, needQuote, confirmed },
        scheduledFor: pickup ? hotelIso(hotelToday(), pickup) : null,
        amount: confirmed ? total : null,
        chargeId: charge?.id ?? null,
      });

      return queued(ctx, r, {
        service_level: level,
        turnaround_hours: turnaround,
        priced_items: priced,
        items_needing_staff_quote: needQuote,
        estimate_total: total,
        currency: hotel.currency,
        charged_to_folio: !!charge,
        awaiting_guest_confirmation: !confirmed,
        same_day_cutoff: cutoff,
        past_same_day_cutoff: pastCutoff,
        expected_return: pastCutoff && level === "regular" ? "ngày hôm sau" : `sau khoảng ${turnaround} giờ`,
        policy: cite,
        instruction: confirmed
          ? "Xác nhận danh sách, tổng tiền và thời gian trả đồ."
          : "Báo giá từng món và tổng tiền, xin khách đồng ý, rồi gọi lại tool này với confirmed_by_guest = true. Chưa ghi nợ gì vào hóa đơn.",
      });
    }

    case "request_luggage": {
      const action = String(a.action);
      const pieces = Math.max(1, Number(a.pieces ?? 1));
      const time = isHHMM(a.time) ? String(a.time) : null;
      const labels: Record<string, string> = {
        pickup: "Lấy hành lý từ phòng",
        delivery: "Mang hành lý lên phòng",
        storage: "Gửi hành lý",
        retrieve_from_storage: "Lấy lại hành lý đã gửi",
      };
      const ticket = action === "storage" ? `LUG-${res?.confirmationCode ?? "NA"}-${Date.now().toString().slice(-5)}` : null;
      const r = raiseRequest(ctx, {
        kind: "luggage",
        dept: "bell",
        priority: time ? "high" : "normal",
        title: `${labels[action] ?? "Hành lý"} — ${pieces} kiện`,
        detail: `${labels[action] ?? action} cho ${guest.name}, ${pieces} kiện, phòng ${room?.number ?? "chưa xếp"}${a.location ? `, vị trí ${a.location}` : ""}${time ? `, lúc ${time}` : ""}.${ticket ? ` Mã phiếu gửi: ${ticket}.` : ""}${a.note ? ` Ghi chú: ${a.note}` : ""}`,
        summary: `${labels[action] ?? action} ${pieces} kiện${time ? ` lúc ${time}` : ""}`,
        payload: { action, pieces, time, location: a.location ?? null, ticket },
        scheduledFor: time ? hotelIso(hotelToday(), time) : null,
      });
      return queued(ctx, r, {
        action,
        pieces,
        time,
        storage_ticket: ticket,
        instruction: ticket
          ? "Đọc mã phiếu gửi cho khách và nhắc giữ mã để nhận lại hành lý."
          : "Xác nhận số kiện và giờ, nói bộ phận hành lý sẽ tới.",
      });
    }

    case "book_transport": {
      const { rules: tr, cite } = rules("TRANSPORT", DEFAULT_TRANSPORT);
      const key = String(a.service);
      const svcRow = ((tr as any).services ?? []).find((s: any) => s.key === key);
      if (!svcRow)
        return {
          error: `Không có dịch vụ vận chuyển "${key}" trong bảng giá.`,
          available: ((tr as any).services ?? []).map((s: any) => ({ key: s.key, label: s.label, price: s.price })),
        };
      const date = String(a.date);
      const time = String(a.time);
      if (!isIsoDate(date)) return { error: "date phải là YYYY-MM-DD." };
      if (!isHHMM(time)) return { error: "time phải là HH:MM." };
      const when = new Date(hotelIso(date, time));
      const leadHours = (when.getTime() - Date.now()) / 3_600_000;
      if (leadHours < Number(svcRow.lead_time_hours || 0))
        return {
          error: `${svcRow.label} cần đặt trước ít nhất ${svcRow.lead_time_hours} giờ; chuyến yêu cầu chỉ còn ${Math.max(0, Math.round(leadHours * 10) / 10)} giờ.`,
          suggestion: "Đề nghị khách chọn giờ muộn hơn, hoặc chuyển lễ tân xin ngoại lệ.",
        };

      const pax = Math.max(1, Number(a.passengers ?? 1));
      const maxPax = Number(svcRow.max_pax) || 4;
      const cars = Math.ceil(pax / maxPax);
      const ent = getEntitlements(guest.vipTier);
      const unit = roundVnd(svcRow.price * (1 - ent.transportDiscountPct / 100));
      const total = roundVnd(unit * cars);

      const charge = postCharge({
        reservationId: res?.id ?? 0,
        description: `${svcRow.label} — ${date} ${time}${cars > 1 ? ` × ${cars} xe` : ""}`,
        amount: total,
        category: "fee",
        taxable: true,
        refType: "transport",
        refId: res?.id ?? null,
      });

      const r = raiseRequest(ctx, {
        kind: "transport",
        dept: "transport",
        priority: "high",
        title: `${svcRow.label} — ${date} ${time}`,
        detail: `${guest.name} (phòng ${room?.number ?? "—"}), ${pax} khách, ${cars} xe.${a.flight_no ? ` Chuyến bay ${a.flight_no}.` : ""}${a.pickup_point ? ` Điểm đón: ${a.pickup_point}.` : ""}${a.drop_point ? ` Điểm đến: ${a.drop_point}.` : ""}${a.note ? ` Ghi chú: ${a.note}` : ""} Đã ghi folio ${vnd(total)} (line #${charge.id}).`,
        summary: `${svcRow.label} ${date} ${time} — ${pax} khách, ${vnd(total)}`,
        payload: { service: key, pax, cars, flight_no: a.flight_no ?? null, chargeId: charge.id },
        scheduledFor: hotelIso(date, time),
        amount: total,
        chargeId: charge.id,
        eventType: "transport.booked",
      });

      return queued(ctx, r, {
        service: key,
        label: svcRow.label,
        date,
        time,
        passengers: pax,
        cars_needed: cars,
        unit_price: unit,
        member_discount_percent: ent.transportDiscountPct,
        charged: total,
        currency: hotel.currency,
        folio_charge_id: charge.id,
        lead_time_hours: svcRow.lead_time_hours,
        flight_no: a.flight_no ?? null,
        price_basis: "Giá net, chưa gồm phí phục vụ và VAT.",
        policy: cite,
        instruction:
          cars > 1
            ? "Nói rõ cần nhiều xe và tổng tiền tương ứng, và bộ phận vận chuyển sẽ xác nhận biển số/tài xế."
            : "Xác nhận giờ, điểm đón và giá; bộ phận vận chuyển sẽ xác nhận tài xế.",
      });
    }

    case "report_lost_item": {
      const caseRef = `LF-${(res?.confirmationCode ?? "NA")}-${Date.now().toString().slice(-5)}`;
      const r = raiseRequest(ctx, {
        kind: "lost_item",
        dept: "housekeeping",
        priority: "high",
        title: `Thất lạc đồ — ${String(a.description).slice(0, 50)}`,
        detail: `Khách ${guest.name} (phòng ${room?.number ?? "—"}) báo thất lạc: ${a.description}. Nơi nghi để quên: ${a.lost_where ?? "chưa rõ"}. Thời điểm: ${a.lost_when ?? "chưa rõ"}.${a.value_estimate ? ` Giá trị ước tính ${vnd(Number(a.value_estimate))}.` : ""} Liên hệ: ${a.contact_preference ?? guest.phone}. Mã hồ sơ ${caseRef}. Quy trình: tìm tại khu vực nêu, ghi vào sổ lost & found, thông báo khách trong 24 giờ dù có tìm thấy hay không.`,
        summary: `Lost & found ${caseRef}: ${String(a.description).slice(0, 60)}`,
        payload: { caseRef, description: a.description, lost_where: a.lost_where ?? null },
        eventType: "lost_item.reported",
      });
      /* Anything valuable is also a security matter. */
      if (Number(a.value_estimate) >= 5_000_000) {
        raiseRequest(ctx, {
          kind: "lost_item",
          dept: "security",
          priority: "high",
          title: `Tài sản giá trị thất lạc — ${caseRef}`,
          detail: `Giá trị ước tính ${vnd(Number(a.value_estimate))}. ${a.description}. Cần kiểm tra camera và lập biên bản.`,
          summary: `An ninh vào cuộc vụ ${caseRef}.`,
        });
      }
      return queued(ctx, r, {
        case_reference: caseRef,
        found: false,
        instruction:
          "Đọc mã hồ sơ cho khách, nói rõ đang tìm và sẽ phản hồi trong 24 giờ. TUYỆT ĐỐI không nói đã tìm thấy.",
      });
    }

    case "request_room_move": {
      const miss = needRes(ctx);
      if (miss) return miss;
      const wantsUpgrade = a.wants_upgrade === true;
      const remaining = Math.max(1, nightsBetween(hotelToday() > res!.checkIn ? hotelToday() : res!.checkIn, res!.checkOut));

      /* Rooms genuinely free for the rest of the stay. */
      const busy = new Set(
        storage
          .listReservations()
          .filter(
            (r0) =>
              r0.id !== res!.id &&
              r0.status !== "cancelled" &&
              r0.roomId &&
              r0.checkIn < res!.checkOut &&
              r0.checkOut > res!.checkIn,
          )
          .map((r0) => r0.roomId as number),
      );
      const candidates = storage
        .listRooms()
        .filter((rm) => rm.id !== res!.roomId && !busy.has(rm.id) && rm.status !== "out_of_order")
        .filter((rm) => (a.preferred_type ? rm.type.toLowerCase().includes(String(a.preferred_type).toLowerCase()) : true));

      const ent = getEntitlements(guest.vipTier);
      const options = candidates.slice(0, 8).map((rm) => {
        const diffPerNight = Math.max(0, roundVnd((rm.baseRate || 0) - res!.ratePerNight));
        const memberDiff = roundVnd(diffPerNight * (1 - ent.roomDiscountPct / 100));
        return {
          room: rm.number,
          type: rm.type,
          floor: rm.floor,
          housekeeping_status: rm.status,
          base_rate: rm.baseRate,
          rate_difference_per_night: diffPerNight,
          member_rate_difference_per_night: memberDiff,
          upgrade_cost_remaining_nights: roundVnd(memberDiff * remaining),
        };
      });

      const r = raiseRequest(ctx, {
        kind: "room_move",
        dept: "front_desk",
        priority: wantsUpgrade ? "normal" : "high",
        title: `${wantsUpgrade ? "Nâng cấp phòng" : "Đổi phòng"} — ${room?.number ?? "—"}`,
        detail: `${guest.name} xin ${wantsUpgrade ? "nâng cấp" : "đổi"} phòng. Lý do: ${a.reason}.${a.preferred_type ? ` Mong muốn: ${a.preferred_type}.` : ""} Còn ${remaining} đêm. Phòng trống phù hợp: ${options.map((o) => `${o.room} (${o.type})`).join(", ") || "không có"}. Lễ tân quyết định và xếp lại phòng.`,
        summary: `${wantsUpgrade ? "Nâng cấp" : "Đổi"} phòng ${room?.number ?? "—"}: ${String(a.reason).slice(0, 60)}`,
        payload: { wantsUpgrade, options },
        eventType: "room_move.requested",
      });

      return queued(ctx, r, {
        wants_upgrade: wantsUpgrade,
        remaining_nights: remaining,
        current_room: room?.number ?? null,
        current_type: room?.type ?? null,
        current_rate_per_night: res!.ratePerNight,
        member_room_discount_percent: ent.roomDiscountPct,
        available_options: options,
        moved: false,
        instruction:
          options.length === 0
            ? "Nói rõ hiện chưa có phòng trống phù hợp cho các đêm còn lại và lễ tân đang tìm giải pháp."
            : "Nêu các phòng trống và chênh lệch giá cho số đêm còn lại. Nói rõ lễ tân sẽ xác nhận và thực hiện việc đổi phòng — chưa đổi.",
      });
    }

    case "get_request_status": {
      const onlyOpen = a.only_open === true;
      const id = Number(a.request_id);
      const all = res ? storage.requestsFor(res.id) : [];
      const chosen = Number.isFinite(id) && id > 0 ? all.filter((r0) => r0.id === id) : all;
      if (Number.isFinite(id) && id > 0 && !chosen.length)
        return { error: `Không có yêu cầu #${id} trong đặt phòng này.` };

      const rows = chosen
        .filter((r0) => (onlyOpen ? r0.status === "open" || r0.status === "in_progress" : true))
        .map((r0) => {
          const task = r0.taskId ? storage.listTasks().find((t) => t.id === r0.taskId) : undefined;
          return {
            request_id: r0.id,
            kind: r0.kind,
            summary: r0.summary,
            dept: r0.dept,
            /* The department's own status wins — the request row can lag. */
            status: task?.status ?? r0.status,
            created_at: r0.createdAt,
            scheduled_for: r0.scheduledFor,
            due_at: task?.dueAt ?? null,
            assigned_to: task?.assignedStaffId ? storage.getStaff(task.assignedStaffId)?.name ?? null : null,
            resolved_at: task?.resolvedAt ?? r0.resolvedAt,
            amount: r0.amount,
          };
        });

      const bookings = res
        ? storage.bookingsForReservation(res.id).map((b) => ({
            booking_id: b.id,
            service: storage.getService(b.serviceId)?.name ?? `#${b.serviceId}`,
            date: b.date,
            slot: b.slot,
            status: b.status,
            amount: b.amount,
          }))
        : [];
      const pays = res
        ? storage.paymentsFor(res.id).map((p) => ({
            payment_id: p.id,
            amount: p.amount,
            method: p.method,
            status: p.status,
            gateway: p.provider,
            paid_at: p.paidAt,
          }))
        : [];
      const regs = res
        ? storage.registrationsFor(res.id).map((g) => ({
            registration_id: g.id,
            name: g.fullName,
            status: g.status,
            submitted_at: g.submittedAt,
            channel: g.channel,
          }))
        : [];

      return {
        reservation: res?.confirmationCode ?? null,
        requests: rows,
        open_count: rows.filter((r0) => r0.status === "open" || r0.status === "in_progress").length,
        service_bookings: bookings,
        payments: pays,
        lodging_declarations: regs,
        checked_at: `${hotelToday()} ${hotelClock()}`,
        instruction:
          "Trả lời khách theo đúng trạng thái ở đây. Việc nào chưa 'done' thì nói là đang xử lý, không nói đã xong.",
      };
    }

    case "get_facility_hours": {
      const { rules: fr, cite } = rules("FACILITY_HOURS", DEFAULT_FACILITY_HOURS);
      const list: any[] = (fr as any).facilities ?? [];
      const key = a.facility ? String(a.facility).toLowerCase() : null;
      const now = hotelClock();
      const chosen = key
        ? list.filter((f) => f.key === key || f.name.toLowerCase().includes(key))
        : list;
      if (key && !chosen.length)
        return {
          error: `Không có tiện ích "${key}" trong danh mục.`,
          available: list.map((f) => f.key),
        };
      return {
        hotel_time: now,
        hotel_date: hotelToday(),
        facilities: chosen.map((f) => ({
          key: f.key,
          name: f.name,
          opens: f.from,
          closes: f.to,
          open_now: minutesOf(now) >= minutesOf(f.from) && minutesOf(now) <= minutesOf(f.to),
          note: f.note || null,
        })),
        policy: cite,
        instruction:
          "Nêu giờ mở/đóng và trạng thái hiện tại. Nếu tiện ích đang đóng, đề xuất phương án thay thế đang mở.",
      };
    }

    /* ---------------------------------------------------------------- *
     * P2
     * ---------------------------------------------------------------- */

    case "add_guest_to_reservation": {
      const miss = needRes(ctx);
      if (miss) return miss;
      const age = Number(a.age);
      const isChild = Number.isFinite(age) && age < 12;
      const newAdults = res!.adults + (isChild ? 0 : 1);
      const newChildren = res!.children + (isChild ? 1 : 0);

      /* Occupancy is a published rule, not a judgement call. */
      const occ = storage.getPolicy("OCCUPANCY");
      let limit = 4;
      try {
        limit = JSON.parse(occ?.rules || "{}")?.hotel_room?.max_occupants_including_children_under_4 ?? 4;
      } catch {
        limit = 4;
      }
      const total = newAdults + newChildren;
      if (total > limit)
        return {
          added: false,
          error: `Phòng chỉ cho phép tối đa ${limit} người; thêm khách này sẽ thành ${total}.`,
          current: { adults: res!.adults, children: res!.children },
          suggestion: "Đề nghị khách đặt thêm phòng, hoặc chuyển lễ tân để kiểm tra phòng lớn hơn.",
          policy: occ
            ? { code: occ.code, title: occ.title, source: occ.sourceTitle, source_url: occ.sourceUrl }
            : null,
        };

      storage.updateReservation(res!.id, { adults: newAdults, children: newChildren });

      let regId: number | null = null;
      if (a.id_number) {
        const reg = storage.createRegistration({
          hotelId: hotel.id,
          reservationId: res!.id,
          guestId: null,
          fullName: String(a.name),
          idType: String(a.id_type ?? "other"),
          idNumber: String(a.id_number),
          nationality: String(a.nationality ?? "—"),
          dob: a.dob ? String(a.dob) : null,
          gender: null,
          visaNumber: null,
          entryDate: null,
          entryPort: null,
          permanentAddress: null,
          arrivalAt: hotelIso(res!.checkIn, res!.checkInTime ?? hotel.checkInTime),
          departureAt: hotelIso(res!.checkOut, res!.checkOutTime),
          isForeigner: /vi[eệ]t\s*nam|vietnam/i.test(String(a.nationality ?? "")) ? 0 : 1,
          status: "collected",
          channel: null,
          submittedAt: null,
          submittedBy: null,
          receiptRef: null,
          taskId: null,
          note: "Khách đi cùng, thêm qua chat.",
          createdAt: nowIso(),
        });
        regId = reg.id;
      }

      const r = raiseRequest(ctx, {
        kind: "add_guest",
        dept: "front_desk",
        title: `Thêm khách đi cùng — ${a.name}`,
        detail: `Thêm ${a.name}${a.relation ? ` (${a.relation})` : ""}${Number.isFinite(age) ? `, ${age} tuổi` : ""} vào đặt phòng ${res!.confirmationCode}. Số khách mới: ${newAdults} người lớn, ${newChildren} trẻ em.${regId ? ` Hồ sơ khai báo lưu trú #${regId} đã tạo.` : " CHƯA có giấy tờ — phải thu khi khách tới để khai báo lưu trú."} Cần cập nhật phiếu đăng ký và làm thẻ khóa.`,
        summary: `Thêm khách ${a.name} vào ${res!.confirmationCode}`,
        payload: { name: a.name, registrationId: regId },
      });

      return {
        added: true,
        name: a.name,
        adults: newAdults,
        children: newChildren,
        occupancy_limit: limit,
        registration_id: regId,
        needs_identity_documents: !regId,
        pms_updated: true,
        task_id: r.task.id,
        instruction: regId
          ? "Xác nhận đã thêm khách và nhắc rằng lễ tân sẽ hoàn tất khai báo lưu trú."
          : "Xác nhận đã thêm khách, và xin giấy tờ (hộ chiếu/CCCD) để hoàn tất khai báo lưu trú theo quy định.",
      };
    }

    case "get_loyalty_status": {
      const { rules: lp, cite } = rules("LOYALTY_PROGRAM", DEFAULT_LOYALTY_PROGRAM);
      const ent = getEntitlements(guest.vipTier);
      const enrolled = Boolean(guest.loyaltyEnrolledAt) || guest.vipTier !== "none";
      const pointsRecorded = Number.isFinite(Number(guest.loyaltyPoints))
        ? Number(guest.loyaltyPoints)
        : 0;
      const hasPoints = pointsRecorded > 0 || Boolean(guest.loyaltyEnrolledAt);

      const thresholds: Array<{ tier: string; min_points: number }> = [
        ...(((lp as any).tier_thresholds ?? []) as Array<{ tier: string; min_points: number }>),
      ].sort((x, y) => x.min_points - y.min_points);

      const next = thresholds.find((t) => t.min_points > pointsRecorded) ?? null;

      return {
        program: (lp as any).name ?? "Pearl Club",
        enrolled,
        tier: guest.vipTier,
        tier_label: guest.vipTier === "none" ? "Chưa là thành viên" : guest.vipTier,
        points: hasPoints ? pointsRecorded : null,
        points_on_file: hasPoints,
        points_note: hasPoints
          ? null
          : "Hồ sơ chưa ghi nhận điểm tích luỹ — KHÔNG được suy đoán hay ước lượng số điểm cho khách.",
        benefits: {
          room_discount_pct: ent.roomDiscountPct,
          fnb_discount_pct: ent.fnbDiscountPct,
          spa_discount_pct: ent.spaDiscountPct,
          golf_discount_pct: ent.golfDiscountPct,
          transport_discount_pct: ent.transportDiscountPct,
          experience_discount_pct: ent.experienceDiscountPct,
          free_early_checkin_hours: ent.earlyCheckinFreeHours,
          free_late_checkout_hours: ent.lateCheckoutFreeHours,
          notes: ent.notes,
          excluded: ent.excluded,
        },
        thresholds,
        next_tier: next
          ? {
              tier: next.tier,
              min_points: next.min_points,
              points_needed: hasPoints ? Math.max(0, next.min_points - pointsRecorded) : null,
            }
          : null,
        earn_rate_points_per_1000_vnd: (lp as any).earn_rate_points_per_1000_vnd ?? null,
        points_expire_months: (lp as any).points_expire_months ?? null,
        can_enrol: !enrolled,
        policy: cite,
        instruction: enrolled
          ? "Nêu đúng hạng và phần trăm ưu đãi trong kết quả này. Nếu points_on_file là false thì nói rõ là hệ thống chưa ghi nhận điểm và mời khách hỏi lễ tân, tuyệt đối không đưa ra con số."
          : "Khách chưa là thành viên — có thể mời khách tham gia qua enroll_loyalty nếu khách muốn.",
      };
    }

    case "enroll_loyalty": {
      const { rules: lp, cite } = rules("LOYALTY_PROGRAM", DEFAULT_LOYALTY_PROGRAM);
      const program = (lp as any).name ?? "Pearl Club";

      if (a.consent !== true) {
        return {
          enrolled: false,
          error: "consent_required",
          instruction: `Phải hỏi và nhận được sự đồng ý rõ ràng của khách trước khi ghi danh ${program}, vì việc này lưu thông tin cá nhân của khách.`,
        };
      }

      const already = Boolean(guest.loyaltyEnrolledAt) || guest.vipTier !== "none";
      if (already) {
        return {
          enrolled: false,
          already_member: true,
          tier: guest.vipTier,
          enrolled_at: guest.loyaltyEnrolledAt ?? null,
          instruction: "Khách đã là thành viên — hãy dùng get_loyalty_status để trả lời thay vì ghi danh lại.",
        };
      }

      const email = String(a.email ?? "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return {
          enrolled: false,
          error: "invalid_email",
          instruction: "Xin lại địa chỉ email hợp lệ của khách để ghi danh.",
        };
      }
      const phone = a.phone ? String(a.phone).trim() : guest.phone ?? null;

      const enrolledAt = nowIso();
      storage.updateGuest(guest.id, {
        loyaltyEnrolledAt: enrolledAt,
        ...(guest.email ? {} : { email }),
        ...(phone && !guest.phone ? { phone } : {}),
      } as Partial<Guest>);

      const r = raiseRequest(ctx, {
        kind: "loyalty_enrolment",
        dept: "front_desk",
        priority: "low",
        title: `Ghi danh ${program} — ${guest.name}`,
        detail: `Khách ${guest.name} đồng ý tham gia ${program}. Email: ${email}. Điện thoại: ${
          phone ?? "chưa có"
        }. Cần tạo số thành viên trong hệ thống ${program} và gửi thẻ/email chào mừng. Aurea CHƯA cấp được số thành viên.`,
        summary: `Ghi danh ${program}: ${guest.name} (${email})`,
        payload: { email, phone, consent: true, enrolledAt },
      });

      return {
        enrolled: false,
        registration_recorded: true,
        program,
        email,
        phone,
        enrolled_at: enrolledAt,
        membership_number: null,
        membership_number_note:
          "Số thành viên và thẻ do chương trình phát hành — lễ tân sẽ hoàn tất và thông báo lại cho khách.",
        status: "pending_membership_issue",
        tier_on_activation: (((lp as any).tier_thresholds ?? [])[0]?.tier) ?? "silver",
        request_id: r.request.id,
        task_id: r.task.id,
        dispatched_to: r.dept,
        policy: cite,
        instruction:
          "Cảm ơn khách đã tham gia, xác nhận đã ghi nhận đăng ký, và nói rõ lễ tân sẽ cấp số thành viên. KHÔNG bịa số thẻ hay nói thẻ đã kích hoạt.",
      };
    }

    case "submit_feedback": {
      const comment = String(a.comment ?? "").trim();
      if (comment.length < 2) {
        return {
          recorded: false,
          error: "empty_comment",
          instruction: "Hỏi khách nội dung góp ý cụ thể trước khi ghi nhận.",
        };
      }

      const ratingRaw = Number(a.rating);
      const rating = Number.isFinite(ratingRaw)
        ? Math.min(5, Math.max(1, Math.round(ratingRaw)))
        : null;
      const category = String(a.category ?? "general");

      const negativeText =
        /kh[oô]ng h[aà]i l[oò]ng|t[eệ]|b[aẩ]n|h[oỏ]ng|ph[aà]n [aá]nh|khi[eế]u n[aạ]i|complain|dirty|broken|rude|awful|terrible|disappointed|smell|m[uù]i|[oồ]n/i.test(
          comment,
        );
      const escalate = (rating !== null && rating <= 3) || negativeText;
      const sentiment = escalate
        ? "negative"
        : rating !== null && rating >= 4
          ? "positive"
          : "neutral";

      const deptByCategory: Record<string, string> = {
        room: "housekeeping",
        cleanliness: "housekeeping",
        dining: "fnb",
        spa: "spa",
        facilities: "maintenance",
        checkin: "front_desk",
        billing: "front_desk",
        service: "front_desk",
        general: "front_desk",
      };

      let taskId: number | null = null;
      let dispatchedTo: string | null = null;
      let requestId: number | null = null;

      if (escalate) {
        const r = raiseRequest(ctx, {
          kind: "feedback_complaint",
          dept: deptByCategory[category] ?? "front_desk",
          priority: rating !== null && rating <= 2 ? "high" : "normal",
          title: `Phản ánh của khách — ${category}${rating !== null ? ` (${rating}/5)` : ""}`,
          detail: `Khách ${guest.name}${room ? ` phòng ${room.number}` : ""} phản ánh về ${category}${
            rating !== null ? ` — đánh giá ${rating}/5` : ""
          }:\n\n"${comment}"\n\nTrực ban cần liên hệ khách để xin lỗi và xử lý, sau đó cập nhật kết quả.`,
          summary: `Phản ánh (${category}${rating !== null ? `, ${rating}/5` : ""}): ${comment.slice(0, 120)}`,
          payload: { rating, category, comment },
          eventType: "feedback.escalated",
        });
        taskId = r.task.id;
        dispatchedTo = r.dept;
        requestId = r.request.id;
      }

      const fb = storage.createFeedback({
        hotelId: hotel.id,
        reservationId: res?.id ?? null,
        guestId: guest.id,
        conversationId: conv.id,
        rating,
        category,
        comment,
        sentiment,
        taskId,
        status: "new",
        createdAt: nowIso(),
      } as any);

      if (!escalate) {
        storage.logEvent({
          type: "feedback.received",
          actor: "ai",
          summary: `Góp ý (${category}${rating !== null ? `, ${rating}/5` : ""}): ${comment.slice(0, 120)}`,
          payload: JSON.stringify({ feedbackId: fb.id, rating, category }),
          conversationId: conv.id,
          createdAt: nowIso(),
        });
      }

      return {
        recorded: true,
        feedback_id: fb.id,
        rating,
        category,
        sentiment,
        escalated: escalate,
        dispatched_to: dispatchedTo,
        task_id: taskId,
        request_id: requestId,
        instruction: escalate
          ? "Xin lỗi khách một cách chân thành, xác nhận đã chuyển trực ban/bộ phận liên quan và họ sẽ liên hệ khách. KHÔNG hứa bồi thường, giảm giá hay tặng dịch vụ."
          : "Cảm ơn khách đã góp ý và cho biết phản hồi đã được ghi nhận và chuyển tới bộ phận liên quan.",
      };
    }

    case "book_meeting_room": {
      const miss = needRes(ctx);
      if (miss) return miss;

      const date = String(a.date ?? "");
      const start = String(a.start ?? "");
      const end = String(a.end ?? "");
      if (!isIsoDate(date)) return { error: "date must be YYYY-MM-DD." };
      if (!isHHMM(start) || !isHHMM(end)) return { error: "start and end must be HH:MM." };
      if (date < hotelToday()) return { error: "That date is in the past." };
      if (minutesOf(end) <= minutesOf(start)) {
        return { error: "end must be later than start." };
      }
      const attendees = Math.max(1, Math.round(Number(a.attendees) || 0));
      if (!attendees) return { error: "attendees is required." };

      const hours = (minutesOf(end) - minutesOf(start)) / 60;
      const layout = a.layout ? String(a.layout) : null;
      const avNeeds: string[] = Array.isArray(a.av_needs) ? a.av_needs.map(String) : [];
      const catering = a.catering ? String(a.catering) : null;

      /* A meeting room is bookable only if the catalogue actually has one that
       * seats the party. Otherwise this becomes a quote request — an event is
       * never auto-confirmed at a price nobody published. */
      const candidates = storage
        .listServices()
        .filter((s) =>
          /(meeting|h[oọ]p|conference|h[oộ]i (ngh[iị]|th[aả]o)|ballroom|event|s[uự] ki[eệ]n|banquet|ti[eệ]c)/i.test(
            `${s.name} ${s.description ?? ""} ${s.category ?? ""} ${s.dept ?? ""}`,
          ),
        );

      const fitting = candidates.filter((s) => {
        const cap = Number((s as any).capacity);
        return !Number.isFinite(cap) || cap <= 0 || cap >= attendees;
      });

      const detail = `Yêu cầu phòng họp/sự kiện.
Ngày: ${date}, ${start}–${end} (${hours} giờ)
Số người: ${attendees}${layout ? `\nKiểu bố trí: ${layout}` : ""}${
        avNeeds.length ? `\nThiết bị AV: ${avNeeds.join(", ")}` : ""
      }${catering ? `\nTiệc/ăn uống: ${catering}` : ""}
Khách: ${guest.name}${room ? ` (phòng ${room.number})` : ""} — đặt phòng ${res!.confirmationCode}.`;

      if (fitting.length === 1) {
        const booked = bookCatalogueService(ctx, {
          serviceId: fitting[0].id,
          date,
          slot: start,
          partySize: attendees,
          note: detail,
          kind: "meeting_room",
        });
        if (!(booked as any).error) {
          return {
            ...booked,
            venue: fitting[0].name,
            attendees,
            from: start,
            to: end,
            hours,
            layout,
            av_needs: avNeeds,
            catering_requested: catering,
            setup_confirmed_by_events_team: false,
            instruction:
              "Xác nhận đã giữ phòng và mức giá đúng như kết quả trả về. Nói rõ bộ phận sự kiện sẽ xác nhận lại cách bố trí, thiết bị và phần ăn uống — KHÔNG tự báo giá cho những phần đó.",
          };
        }
      }

      const r = raiseRequest(ctx, {
        kind: "meeting_room_quote",
        dept: "front_desk",
        priority: "high",
        title: `Báo giá phòng họp ${date} ${start}–${end} (${attendees} khách)`,
        detail: `${detail}\n\nBộ phận sự kiện cần kiểm tra phòng trống, báo giá và xác nhận với khách. ${
          candidates.length
            ? `Các không gian gần đúng trong danh mục: ${candidates.map((s) => s.name).join(", ")}.`
            : "Danh mục hiện chưa có phòng họp phù hợp — cần xử lý thủ công."
        }`,
        summary: `Phòng họp ${date} ${start}–${end}, ${attendees} khách`,
        payload: { date, start, end, attendees, layout, avNeeds, catering },
        scheduledFor: hotelIso(date, start),
      });

      return queued(ctx, r, {
        booked: false,
        price: null,
        price_note:
          "Giá phòng họp/sự kiện do bộ phận sự kiện báo — KHÔNG được ước lượng hay đưa ra bất kỳ con số nào.",
        candidate_venues: candidates.map((s) => ({
          id: s.id,
          name: s.name,
          capacity: (s as any).capacity ?? null,
        })),
        attendees,
        from: start,
        to: end,
        hours,
        instruction:
          "Nói với khách là yêu cầu đã được chuyển tới bộ phận sự kiện và họ sẽ báo giá cùng phương án bố trí. KHÔNG khẳng định đã giữ được phòng và KHÔNG nêu giá.",
      });
    }

    case "request_babysitting": {
      const miss = needRes(ctx);
      if (miss) return miss;

      const date = String(a.date ?? "");
      const start = String(a.start ?? "");
      if (!isIsoDate(date)) return { error: "date must be YYYY-MM-DD." };
      if (!isHHMM(start)) return { error: "start must be HH:MM." };
      if (date < hotelToday()) return { error: "That date is in the past." };

      const hours = Number(a.hours);
      if (!Number.isFinite(hours) || hours <= 0) return { error: "hours must be a positive number." };
      const childrenCount = Math.max(1, Math.round(Number(a.children_count) || 0));
      if (!childrenCount) return { error: "children_count is required." };
      const ages: number[] = Array.isArray(a.children_ages)
        ? a.children_ages.map((x: unknown) => Number(x)).filter((n: number) => Number.isFinite(n))
        : [];
      const note = a.note ? String(a.note) : null;

      const MIN_AGE_MONTHS_NOTE = 1; // years — infants under 1 need the team's approval
      const LEAD_HOURS = 12;
      const startIso = hotelIso(date, start);
      const leadHours = (new Date(startIso).getTime() - Date.now()) / 3_600_000;
      const shortNotice = leadHours < LEAD_HOURS;
      const infants = ages.filter((n) => n < MIN_AGE_MONTHS_NOTE);

      const svc = storage
        .listServices()
        .find((s) =>
          /(babysit|tr[oô]ng tr[eẻ]|gi[uữ] tr[eẻ]|kids? club|childcare|nanny)/i.test(
            `${s.name} ${s.description ?? ""} ${s.category ?? ""}`,
          ),
        );

      const priced = svc ? priceService(svc, guest.vipTier, childrenCount, hotel.currency) : null;

      const r = raiseRequest(ctx, {
        kind: "babysitting",
        dept: "front_desk",
        priority: shortNotice ? "high" : "normal",
        title: `Trông trẻ ${date} ${start} — ${childrenCount} bé, ${hours} giờ`,
        detail: `Yêu cầu trông trẻ.
Ngày/giờ bắt đầu: ${date} ${start} — thời lượng ${hours} giờ
Số trẻ: ${childrenCount}${ages.length ? ` (tuổi: ${ages.join(", ")})` : " (chưa rõ tuổi)"}
Khách: ${guest.name}${room ? ` — phòng ${room.number}` : ""}${note ? `\nGhi chú của phụ huynh: ${note}` : ""}${
          infants.length ? `\nCẢNH BÁO: có trẻ dưới ${MIN_AGE_MONTHS_NOTE} tuổi — cần người trông có chứng chỉ và ban quản lý phê duyệt.` : ""
        }${shortNotice ? `\nCẢNH BÁO: đặt gấp, chỉ còn ${Math.max(0, Math.round(leadHours))} giờ (thường cần trước ${LEAD_HOURS} giờ) — phải xác nhận nhân sự trước khi hứa với khách.` : ""}
Kids club cần xác nhận nhân sự, phí và mẫu đồng ý của phụ huynh.`,
        summary: `Trông trẻ ${date} ${start}, ${childrenCount} bé, ${hours} giờ`,
        payload: { date, start, hours, childrenCount, ages, note, shortNotice },
        scheduledFor: startIso,
        amount: priced ? priced.net_amount : null,
      });

      return queued(ctx, r, {
        booked: false,
        date,
        start,
        hours,
        children_count: childrenCount,
        children_ages: ages,
        short_notice: shortNotice,
        lead_time_hours_required: LEAD_HOURS,
        infants_need_approval: infants.length > 0,
        indicative_price: priced
          ? {
              service: svc!.name,
              unit: svc!.unit,
              list_price: priced.rack_unit_price,
              member_price: priced.member_unit_price,
              discount_pct: priced.discount_pct,
              currency: priced.currency,
              basis: "Giá niêm yết cho thời lượng chuẩn — tổng phí theo số giờ thực tế do kids club chốt.",
            }
          : null,
        price_note: priced
          ? "Chỉ nêu đúng các con số trong indicative_price và nói rõ tổng phí cuối do bộ phận xác nhận."
          : "Danh mục chưa có giá dịch vụ trông trẻ — KHÔNG đưa ra bất kỳ con số nào.",
        parental_consent_required: true,
        instruction: shortNotice
          ? "Ghi nhận yêu cầu nhưng nói rõ đây là đặt gấp, bộ phận phải xác nhận có người trông hay không. KHÔNG khẳng định đã có người."
          : "Ghi nhận yêu cầu và cho biết kids club sẽ xác nhận người trông, phí và mẫu đồng ý của phụ huynh.",
      });
    }

    case "book_local_tour": {
      const miss = needRes(ctx);
      if (miss) return miss;

      const date = String(a.date ?? "");
      if (!isIsoDate(date)) return { error: "date must be YYYY-MM-DD." };
      if (date < hotelToday()) return { error: "That date is in the past." };
      const participants = Math.max(1, Math.round(Number(a.participants) || 0));
      if (!participants) return { error: "participants is required." };
      if (res!.checkOut && date > res!.checkOut) {
        return {
          booked: false,
          error: "after_checkout",
          check_out: res!.checkOut,
          instruction: `Ngày ${date} sau ngày khách trả phòng (${res!.checkOut}) — xác nhận lại ngày với khách hoặc hỏi khách có gia hạn lưu trú không.`,
        };
      }

      const slot = a.slot && isHHMM(String(a.slot)) ? String(a.slot) : null;
      const note = a.note ? String(a.note) : null;
      const wanted = String(a.tour_name ?? "").trim();

      const tours = storage
        .listServices()
        .filter((s) =>
          /(tour|excursion|tr[aả]i nghi[eệ]m|tham quan|du thuy[eề]n|cruise|l[aặ]n|snorkel|diving|island|đ[aả]o|city|kh[aá]m ph[aá])/i.test(
            `${s.name} ${s.description ?? ""} ${s.category ?? ""} ${s.dept ?? ""}`,
          ),
        );

      let svcId = Number(a.service_id) || 0;

      if (!svcId && wanted) {
        const needle = wanted.toLowerCase();
        const exact = tours.find((s) => s.name.toLowerCase() === needle);
        const partial = tours.filter(
          (s) =>
            s.name.toLowerCase().includes(needle) ||
            needle.includes(s.name.toLowerCase()) ||
            needle
              .split(/\s+/)
              .filter((w) => w.length > 3)
              .some((w) => `${s.name} ${s.description ?? ""}`.toLowerCase().includes(w)),
        );
        if (exact) svcId = exact.id;
        else if (partial.length === 1) svcId = partial[0].id;
        else {
          /* Never invent a tour. Hand back the real candidates and let the
           * model ask, or route it to the concierge desk. */
          const r = raiseRequest(ctx, {
            kind: "tour_request",
            dept: "front_desk",
            priority: "normal",
            title: `Tìm tour "${wanted.slice(0, 40)}" cho ${date}`,
            detail: `Khách ${guest.name}${room ? ` (phòng ${room.number})` : ""} muốn đi "${wanted}" ngày ${date}${
              slot ? ` khoảng ${slot}` : ""
            }, ${participants} người.${note ? `\nGhi chú: ${note}` : ""}\n\nDanh mục nội bộ không có tour khớp. Concierge cần kiểm tra với đối tác bên ngoài, báo giá và xác nhận với khách.`,
            summary: `Yêu cầu tour ngoài danh mục: "${wanted}" ${date}, ${participants} khách`,
            payload: { wanted, date, slot, participants, note },
            scheduledFor: slot ? hotelIso(date, slot) : null,
          });
          return queued(ctx, r, {
            booked: false,
            matched: false,
            price: null,
            price_note:
              "Chưa có tour khớp trong danh mục nên KHÔNG có giá — tuyệt đối không ước lượng.",
            closest_matches: (partial.length ? partial : tours).slice(0, 6).map((s) => ({
              id: s.id,
              name: s.name,
              price: s.price,
              unit: s.unit,
              description: (s.description ?? "").slice(0, 160),
            })),
            instruction:
              "Nói rõ chưa có tour đúng như khách mô tả trong danh mục resort, giới thiệu các lựa chọn gần nhất trong closest_matches (đúng tên và giá niêm yết), và cho biết concierge đang kiểm tra với đối tác bên ngoài.",
          });
        }
      }

      if (!svcId) {
        return {
          booked: false,
          matched: false,
          available_tours: tours.slice(0, 10).map((s) => ({
            id: s.id,
            name: s.name,
            price: s.price,
            unit: s.unit,
            description: (s.description ?? "").slice(0, 160),
          })),
          instruction:
            "Chưa rõ khách muốn tour nào — giới thiệu các tour trong available_tours và hỏi khách chọn, KHÔNG tự đặt.",
        };
      }

      const booked = bookCatalogueService(ctx, {
        serviceId: svcId,
        date,
        slot: slot ?? "08:00",
        partySize: participants,
        note: note ?? undefined,
        kind: "tour",
      });
      if ((booked as any).error) return booked as Record<string, unknown>;

      return {
        ...booked,
        matched: true,
        participants,
        date,
        slot: slot ?? "08:00",
        pickup_confirmed: false,
        instruction:
          "Xác nhận đã đặt tour với đúng tên, ngày, số khách và giá trong kết quả. Nói rõ giờ và điểm đón sẽ được bộ phận concierge xác nhận lại.",
      };
    }

    case "request_medical_assistance": {
      const symptoms = String(a.symptoms ?? "").trim();
      if (!symptoms) return { error: "symptoms is required." };
      const severity = ["mild", "moderate", "severe"].includes(String(a.severity))
        ? String(a.severity)
        : "moderate";
      const needsAmbulance = a.needs_ambulance === true || severity === "severe";
      const person = a.person ? String(a.person) : "khách";
      const location = a.location ? String(a.location) : room ? `phòng ${room.number}` : "chưa rõ";

      /* Medical events always go to a human immediately. This tool never
       * assesses, diagnoses or advises — it dispatches and escalates. */
      const r = raiseRequest(ctx, {
        kind: "medical_assistance",
        dept: "security",
        priority: "urgent",
        title: `Y TẾ KHẨN — ${location}`,
        detail: `HỖ TRỢ Y TẾ KHẨN CẤP.
Người cần giúp: ${person}
Vị trí: ${location}
Mức độ khách mô tả: ${severity}${needsAmbulance ? " — CÓ THỂ CẦN XE CẤP CỨU" : ""}
Nguyên văn khách mô tả: "${symptoms}"
Khách: ${guest.name}${guest.phone ? ` — ĐT ${guest.phone}` : ""}${
          res ? ` — đặt phòng ${res.confirmationCode}` : ""
        }

Cử người tới ngay, mang bộ sơ cứu. Nếu cần, gọi 115. Thông báo trực ban và lễ tân.`,
        summary: `Y tế khẩn cấp tại ${location}: ${symptoms.slice(0, 100)}`,
        payload: { symptoms, severity, needsAmbulance, person, location },
        scheduledFor: nowIso(),
        eventType: "medical.assistance_requested",
      });

      const fd = raiseRequest(ctx, {
        kind: "medical_assistance_frontdesk",
        dept: "front_desk",
        priority: "urgent",
        title: `Y TẾ KHẨN — hỗ trợ lễ tân ${location}`,
        detail: `Song song với an ninh: chuẩn bị liên hệ y tế/bệnh viện, hướng dẫn xe cấp cứu vào resort nếu cần, và thông báo trực ban. Chi tiết ở yêu cầu #${r.request.id}.`,
        summary: `Lễ tân hỗ trợ ca y tế tại ${location}`,
        payload: { linkedRequestId: r.request.id },
        scheduledFor: nowIso(),
        eventType: "medical.assistance_requested",
      });

      return {
        done: false,
        dispatched: true,
        escalate_to_human: true,
        handoff_required: true,
        priority: "urgent",
        request_id: r.request.id,
        task_id: r.task.id,
        front_desk_task_id: fd.task.id,
        dispatched_to: ["security", "front_desk"],
        location,
        severity,
        ambulance_flagged: needsAmbulance,
        emergency_number: "115",
        no_medical_advice: true,
        instruction:
          "Nói ngắn gọn và bình tĩnh: đã báo an ninh và lễ tân, người hỗ trợ đang tới ngay, và nếu tình trạng nguy cấp hãy gọi 115. TUYỆT ĐỐI KHÔNG chẩn đoán, không gợi ý thuốc, không đánh giá mức độ nguy hiểm. Cuộc hội thoại này phải được chuyển cho nhân viên.",
      };
    }

    default:
      /* Not an ops tool — agent.ts keeps handling its own tool names. */
      return null;
  }
}
