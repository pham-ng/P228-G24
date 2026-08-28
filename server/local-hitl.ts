/**
 * Human-in-the-loop for the offline path.
 *
 * THE DEAD END THIS OPENS. The five approval-creating tools live in the hosted
 * agent's tool loop. `runOfflineTurn` has no tool loop. The form wizard could
 * call them, but it only fires on a *pending transaction*, and only a tool can
 * create one — and `WIZARD_ENABLED` is off by default anyway. So with
 * `LLM_MODE=local`, the mode this product actually runs in, `service_approvals`
 * had zero rows ever and `/staff/approvals` was permanently empty. The HITL
 * machinery was complete, verified end to end, and unreachable.
 *
 * WHAT THIS DOES NOT DO. It does not ask the model to fill in a form. A 4B
 * model inventing a checkout time, a date or a fee is precisely the failure
 * this product refuses to accept, and an approval carrying a hallucinated slot
 * is worse than no approval — a human would be approving something the guest
 * never asked for. So:
 *
 *   - the intent is matched deterministically, from the guest's own words;
 *   - the time is parsed by regex, and WHEN IT CANNOT BE PARSED THE REQUEST
 *     FALLS THROUGH to an ordinary human handoff rather than being guessed;
 *   - the fee always comes from the policy engine (`quoteLateCheckout`,
 *     `quoteEarlyCheckin`, `quoteReservationCancellation`), never from here;
 *   - the guest is told it is PENDING, never that it is done.
 *
 * Only the three kinds whose slots are fully derivable from the reservation on
 * the session are handled. `book_service`, `order_room_service` and
 * `cancel_service_booking` need an item or a booking id that free text does not
 * reliably carry, so they keep escalating to a person — which is the honest
 * outcome, not a gap.
 */
import { storage, nowIso, hotelToday } from "./storage";
import { quoteLateCheckout, quoteEarlyCheckin } from "./policy";
import { quoteReservationCancellation } from "./pricing";
import type { Conversation, Guest, Reservation, Room, Hotel } from "@shared/schema";

export type LocalApprovalKind =
  | "request_late_checkout"
  | "request_early_checkin"
  | "cancel_reservation";

export type TransactionPlan = { kind: LocalApprovalKind; want?: string };

/* Diacritic-folded so `tra phong muon` matches `trả phòng muộn`. Guests type
   without accents roughly a quarter of the time. */
const fold = (s: string) =>
  (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").normalize("NFC").replace(/đ/g, "d").toLowerCase();

const LATE_CHECKOUT =
  /tra phong muon|checkout muon|check out muon|tra phong tre|o them den|late check.?out|late departure|늦게 체크아웃|레이트 체크아웃|レイトチェックアウト|遅いチェックアウト|延迟退房|晚退房|поздний выезд|поздн\w* выезд/i;

const EARLY_CHECKIN =
  /nhan phong som|check.?in som|den som nhan phong|early check.?in|early arrival|얼리 체크인|일찍 체크인|アーリーチェックイン|早いチェックイン|提前入住|早入住|ранний заезд|ранн\w* заезд/i;

const CANCEL_RESERVATION =
  /huy (dat )?phong|huy (dat )?cho|huy booking|khong o nua|cancel (my )?(reservation|booking|stay)|예약 취소|취소하고 싶|予約(を)?キャンセル|キャンセルしたい|取消预订|取消订房|отмен\w* брониров|отменить заезд/i;

/**
 * Pull a 24-hour time out of the guest's message.
 *
 * Returns null rather than a default when nothing is found. That matters: a
 * missing time is exactly the case where guessing produces an approval for a
 * departure the guest never requested, so the caller escalates to a person
 * instead.
 *
 * AMBIGUITY IS RESOLVED BY THE TRANSACTION, not by chance. "4 giờ" carries no
 * am/pm, but a late checkout at 04:00 and an early check-in at 16:00 are both
 * nonsense — so a bare hour reads as afternoon for a late departure and as
 * morning for an early arrival. The guest's verbatim sentence is carried into
 * the approval summary either way, so a human sees what was actually written.
 */
export function parseRequestedTime(text: string, kind: LocalApprovalKind): string | null {
  if (kind === "cancel_reservation") return null;
  const t = fold(text);

  /**
   * Vietnamese diacritic folding makes two very common words collide:
   * `tôi` (I) and `tối` (evening) both fold to `toi`, and `sáng` (morning)
   * collides with `sang` (over/across). Detecting the evening marker anywhere
   * in the sentence therefore read "TÔI muốn nhận phòng sớm lúc 10:00" as an
   * evening request and produced an early check-in at 22:00 — found by running
   * the real endpoint, not by the unit tests, which had no leading "Tôi".
   *
   * So markers are split. The unambiguous ones may appear anywhere; the two
   * that collide only count when they FOLLOW the time, which is where a real
   * "10 giờ tối" puts them.
   */
  const PM_ANY = /\bpm\b|chieu|오후|午後|下午|晚上|вечер/;
  const AM_ANY = /\bam\b|오전|午前|上午|早上|утр/;
  const PM_AFTER = /^\s*(gio|h|:)?\s*\d{0,2}\s*(toi|dem)\b/;
  const AM_AFTER = /^\s*(gio|h|:)?\s*\d{0,2}\s*sang\b/;

  /**
   * Two accepted shapes, tried in order:
   *   1. an hour with a unit — `16:00`, `16h30`, `4 giờ`, `4시`, `16時`, `4点`
   *   2. a bare hour carrying am/pm — `4pm`, `9am`
   *
   * No trailing `\b`. `\b` is ASCII-only in JavaScript, so after `시`, `時` or
   * `点` there is no word boundary at all and every CJK time failed to match
   * while the Latin ones passed — the kind of gap that looks like the feature
   * works until a Korean guest uses it.
   */
  const m =
    t.match(/\b(\d{1,2})\s*(?::|h|gio|시|時|点)\s*(\d{2})?/) ??
    t.match(/\b(\d{1,2})\s*(?=am|pm)()/);
  if (!m) return null;

  /* What follows the time is where an adjacent marker has to be. */
  const tail = t.slice((m.index ?? 0) + m[0].length);
  const pm = PM_ANY.test(t) || PM_AFTER.test(tail);
  const am = AM_ANY.test(t) || AM_AFTER.test(tail);

  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  if (!Number.isFinite(hour) || hour > 23 || minute > 59) return null;

  if (hour <= 12) {
    if (pm && hour < 12) hour += 12;
    else if (!am && hour < 12) {
      /* No marker: read it as the only sensible time for this transaction. */
      if (kind === "request_late_checkout" && hour <= 11) hour += 12;
    }
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** Which transaction, if any, this message is asking for. */
export function detectTransactionRequest(text: string): TransactionPlan | null {
  const t = fold(text);
  /* Cancellation is checked first: "huỷ trả phòng muộn" is a cancellation, and
     the late-checkout words appear in it. */
  if (CANCEL_RESERVATION.test(t) || CANCEL_RESERVATION.test(text)) return { kind: "cancel_reservation" };
  for (const [re, kind] of [
    [LATE_CHECKOUT, "request_late_checkout"],
    [EARLY_CHECKIN, "request_early_checkin"],
  ] as const) {
    if (re.test(t) || re.test(text)) {
      const want = parseRequestedTime(text, kind);
      return want ? { kind, want } : null; // no time -> a person reads it
    }
  }
  return null;
}

export type ApprovalOutcome = { approvalId: number; taskId: number; fee: number; summary: string };

/**
 * Create the pending approval, the task behind it, and the audit trail.
 *
 * Nothing is written to the reservation or the folio here — `finalizeApproval`
 * in ops.ts does that, and only after a human presses approve. This function's
 * whole job is to put a correct, complete request in front of that human.
 */
export function createLocalApproval(
  plan: TransactionPlan,
  ctx: { hotel: Hotel; conv: Conversation; guest: Guest; res: Reservation; room?: Room; guestText: string },
): ApprovalOutcome | { error: string } {
  const { hotel, conv, guest, res, room, guestText } = ctx;

  /* One pending request per kind per conversation. A guest who asks twice needs
     one decision from one person, not two competing approvals. */
  const existing = storage
    .listApprovals()
    .find((a) => a.conversationId === conv.id && a.kind === plan.kind && a.status === "pending");
  if (existing) return { error: `already pending as approval #${existing.id}` };

  let fee = 0;
  let summary = "";
  let payload: Record<string, unknown> = {};
  let dept = "front_desk";
  let title = "";

  if (plan.kind === "request_late_checkout") {
    if (!plan.want) return { error: "no requested time" };
    if (plan.want <= res.checkOutTime) return { error: "already departing at or after that time" };
    const next = res.roomId ? storage.nextReservationForRoom(res.roomId, res.checkOut) : undefined;
    const quote = quoteLateCheckout({
      requestedTime: plan.want,
      ratePerNight: res.ratePerNight,
      currency: hotel.currency,
      vipTier: guest.vipTier,
      roomResoldSameDay: !!next && next.id !== res.id && next.checkIn === res.checkOut,
      adults: res.adults,
      children: res.children,
      standardCheckoutTime: hotel.checkOutTime,
    });
    /* A policy refusal is not an approval request. If the room is resold the
       answer is no, and putting it in a queue would only delay telling the
       guest that. */
    if (!quote.quoted || quote.max_possible_time) return { error: quote.error ?? "not possible" };
    fee = quote.fee ?? 0;
    dept = "housekeeping";
    title = `CẦN DUYỆT — Trả phòng muộn ${plan.want} — phòng ${room?.number ?? "—"}`;
    summary = `Trả phòng muộn ${plan.want} — ${res.confirmationCode} — ${fee.toLocaleString("vi-VN")} ${hotel.currency}`;
    payload = { reservationId: res.id, want: plan.want, fee };
  } else if (plan.kind === "request_early_checkin") {
    if (!plan.want) return { error: "no requested time" };
    /* An "early" arrival at or after the standard time is not early, and the
       policy engine happily quoted 22:00 at zero fee. Mirrors the guard the
       late-checkout branch already had against a departure that is not late. */
    if (plan.want >= hotel.checkInTime) return { error: "not earlier than standard check-in" };
    const quote = quoteEarlyCheckin({
      requestedTime: plan.want,
      ratePerNight: res.ratePerNight,
      currency: hotel.currency,
      standardCheckinTime: hotel.checkInTime,
      vipTier: guest.vipTier,
    });
    if (!quote.quoted) return { error: quote.error ?? "not possible" };
    fee = quote.fee ?? 0;
    title = `CẦN DUYỆT — Nhận phòng sớm ${plan.want} — phòng ${room?.number ?? "—"}`;
    summary = `Nhận phòng sớm ${plan.want} — ${res.confirmationCode} — ${fee.toLocaleString("vi-VN")} ${hotel.currency}`;
    payload = { reservationId: res.id, want: plan.want, fee };
  } else {
    const quote = quoteReservationCancellation(res, hotelToday(), hotel.currency);
    fee = quote.fee ?? 0;
    title = `CẦN DUYỆT — Hủy đặt phòng ${res.confirmationCode}`;
    summary = `Hủy đặt phòng ${res.confirmationCode} — phí ${fee.toLocaleString("vi-VN")} ${hotel.currency} (${quote.band})`;
    payload = { reservationId: res.id, code: res.confirmationCode, band: quote.band, fee };
  }

  const task = storage.createTask({
    hotelId: hotel.id,
    reservationId: res.id,
    roomId: res.roomId,
    conversationId: conv.id,
    dept,
    title,
    /* The guest's own sentence goes in verbatim. Every slot above was derived,
       and the person approving has to be able to check that derivation against
       what was actually said — especially the time, where a bare hour was read
       as afternoon or morning by rule. */
    detail:
      `${guest.name} (phòng ${room?.number ?? "—"}) viết: "${guestText.replace(/\s+/g, " ").slice(0, 300)}"\n` +
      `${summary}. ĐANG CHỜ DUYỆT — chưa có gì được ghi vào đặt phòng hay hoá đơn.`,
    priority: "normal",
    status: "open",
    source: "ai",
    assignedStaffId: null,
    dueAt: new Date(Date.now() + hotel.slaMinutes * 60_000).toISOString(),
    createdAt: nowIso(),
    resolvedAt: null,
  });

  const approval = storage.createApproval({
    hotelId: hotel.id,
    reservationId: res.id,
    guestId: guest.id,
    conversationId: conv.id,
    taskId: task.id,
    kind: plan.kind,
    summary,
    payload: JSON.stringify(payload),
    amount: fee,
    status: "pending",
    createdAt: nowIso(),
    resolvedAt: null,
    resolvedBy: null,
    rejectionReason: null,
  });

  storage.logEvent({
    type: "approval.queued_offline",
    actor: "ai",
    summary: `${summary} — chờ duyệt (luồng offline).`,
    payload: JSON.stringify({ approvalId: approval.id, taskId: task.id, kind: plan.kind, fee }),
    conversationId: conv.id,
    createdAt: nowIso(),
  });

  return { approvalId: approval.id, taskId: task.id, fee, summary };
}

/**
 * What the guest is told.
 *
 * Written here rather than generated, because the one thing this sentence must
 * never do is imply the change has been made. A model asked to phrase "pending"
 * will sometimes phrase it as "done", and by then the guest has planned their
 * morning around a checkout nobody approved.
 */
const PENDING_LINE: Record<string, (fee: string) => string> = {
  vi: (f) => `Em đã ghi nhận yêu cầu và chuyển lễ tân duyệt${f}. Đây chưa phải xác nhận — em sẽ báo lại ngay khi có kết quả ạ.`,
  en: (f) => `I've logged your request and sent it to the front desk for approval${f}. This is not a confirmation yet — I'll come back to you as soon as it's decided.`,
  ko: (f) => `요청을 접수하여 프런트 승인 대기로 전달했습니다${f}. 아직 확정은 아니며, 결정되는 대로 바로 알려드리겠습니다.`,
  ja: (f) => `ご依頼を承り、フロントの承認待ちとして登録しました${f}。まだ確定ではございません。決まり次第すぐにご連絡いたします。`,
  zh: (f) => `已记录您的请求并转前台审批${f}。目前尚未确认，一有结果我们会立即通知您。`,
  ru: (f) => `Заявка принята и передана на согласование стойке регистрации${f}. Это ещё не подтверждение — сообщим сразу после решения.`,
};

const FEE_CLAUSE: Record<string, (amount: string) => string> = {
  vi: (a) => ` (phí dự kiến ${a})`,
  en: (a) => ` (estimated fee ${a})`,
  ko: (a) => ` (예상 요금 ${a})`,
  ja: (a) => `（概算料金 ${a}）`,
  zh: (a) => `（预计费用 ${a}）`,
  ru: (a) => ` (ориентировочная стоимость ${a})`,
};

export function pendingApprovalLine(lang: string, fee: number, currency: string): string {
  const l = PENDING_LINE[lang] ? lang : "vi";
  const clause = fee > 0 ? (FEE_CLAUSE[l] ?? FEE_CLAUSE.vi)(`${fee.toLocaleString("vi-VN")} ${currency}`) : "";
  return PENDING_LINE[l](clause);
}
