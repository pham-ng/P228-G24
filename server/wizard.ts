/**
 * Code-driven confirmation flow for the offline path.
 *
 * A 4B model cannot be trusted to drive a two-step "quote → confirm → execute"
 * exchange through tool calls: it forgets the pending action, re-quotes instead
 * of committing, or commits without asking. So the control flow lives here in
 * ordinary TypeScript, and the model is used only to phrase the sentence.
 *
 * WHAT THE PREVIOUS VERSION GOT WRONG, AND WHY THIS ONE IS SHAPED LIKE IT IS
 *
 * It decided "yes" with a substring regex that listed "hủy" (cancel) among the
 * AFFIRMATIVE words. Measured against real phrasings, that meant:
 *
 *     "tôi không muốn hủy nữa"   → executed the cancellation
 *     "đừng hủy"                 → executed the cancellation
 *     "phí hủy là bao nhiêu?"    → executed the cancellation
 *     "tôi muốn book thêm phòng" → executed it too, because "book" contains "ok"
 *
 * Cancelling a reservation is irreversible, chargeable, and reverses folio
 * lines. So confirmation here is deliberately strict and deliberately dumb:
 *
 *   1. NEGATIVE IS CHECKED FIRST and wins outright. If a guest might be
 *      declining, they are declining.
 *   2. AFFIRMATIVE requires a whole-word match against a short closed list,
 *      never a bare substring.
 *   3. A QUESTION IS NEVER A CONFIRMATION. "phí hủy là bao nhiêu?" asks about
 *      the action; it does not authorise it.
 *   4. ANYTHING ELSE IS AMBIGUOUS, and ambiguity hands the turn back rather
 *      than acting.
 *
 * The wizard also no longer answers on behalf of the whole turn: it reports
 * whether it actually handled the message, so an unrelated question ("mấy giờ ăn
 * sáng?") falls through to the normal agent instead of being trapped in a form.
 */

import type { Message } from "../shared/schema";
import { chat } from "./llm";

export type PendingTransactionType =
  | "cancellation"
  | "early_checkin"
  | "late_checkout"
  | "lodging";

export type PendingTransaction = {
  type: PendingTransactionType;
  details: { args?: any; result?: any };
  lastToolCall: string;
};

/* ------------------------------------------------------ pending detection */

/** Quote tools paired with the tool that actually commits the action. */
const FLOWS: Array<{ type: PendingTransactionType; quote: string; commits: string[] }> = [
  { type: "cancellation", quote: "quote_cancellation", commits: ["cancel_reservation", "cancel_service_booking"] },
  { type: "early_checkin", quote: "quote_early_checkin", commits: ["request_early_checkin"] },
  { type: "late_checkout", quote: "quote_late_checkout", commits: ["request_late_checkout"] },
];

/**
 * Find a quoted action that was never committed.
 *
 * Only the last few messages are scanned: a guest who priced a late checkout an
 * hour ago and has since moved on is not waiting on a confirmation, and treating
 * them as if they were is how every later question gets hijacked.
 */
export function detectPendingTransaction(history: Message[]): PendingTransaction | null {
  const recent = [...history.slice(-4)].reverse();
  const quoted = new Map<PendingTransactionType, { args?: any; result?: any }>();
  const committed = new Set<PendingTransactionType>();

  for (const m of recent) {
    if (!m.toolTrace) continue;
    let traces: Array<{ name: string; args?: any; result?: any }> = [];
    try {
      traces = JSON.parse(m.toolTrace);
    } catch {
      continue;
    }
    for (const t of traces) {
      for (const f of FLOWS) {
        if (f.commits.includes(t.name)) committed.add(f.type);
        if (t.name === f.quote && !quoted.has(f.type)) quoted.set(f.type, { args: t.args, result: t.result });
      }
    }
  }

  for (const f of FLOWS) {
    const q = quoted.get(f.type);
    if (q && !committed.has(f.type)) return { type: f.type, details: q, lastToolCall: f.quote };
  }
  return null;
}

/* --------------------------------------------------------- confirmation */

export type Confirmation = "yes" | "no" | "unclear";

/** Whole-word affirmatives. Short and closed on purpose. */
const YES = [
  "đồng ý",
  "xác nhận",
  "chắc chắn",
  "đúng rồi",
  "ok",
  "okay",
  "oke",
  "yes",
  "yep",
  "yeah",
  "sure",
  "confirm",
  "proceed",
];

/** Anything that could be a refusal. Checked first; a possible "no" wins. */
const NO = [
  "không",
  "thôi",
  "đừng",
  "bỏ qua",
  "từ chối",
  "khoan",
  "chờ đã",
  "no",
  "not",
  "stop",
  "nevermind",
  "never mind",
];

function fold(s: string): string {
  /* Lower-cased FIRST. "Đ" does not decompose under NFD, so replacing only the
     lower-case "đ" before lower-casing left "Đồng ý" folded as "đong y" — which
     never matched the affirmative "dong y", and a guest who capitalised their
     confirmation (as people do) was read as unclear. */
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .trim();
}

/** Whole-word / whole-phrase containment — never a bare substring, so "book"
 *  can no longer read as "ok" and "không" can no longer read as "no". */
function hasPhrase(text: string, phrase: string): boolean {
  const t = fold(text);
  const p = fold(phrase).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${p}(?![\\p{L}\\p{N}])`, "u").test(t);
}

/**
 * Read the guest's answer to a pending confirmation.
 *
 * Ordering is the safety property: a refusal is honoured even when an
 * affirmative word is also present ("ok thôi, đừng hủy"), and a question is
 * never treated as consent.
 */
export function readConfirmation(input: string): Confirmation {
  const text = (input ?? "").trim();
  if (!text) return "unclear";

  // A question asks about the action; it does not authorise it.
  if (/[?？]/.test(text)) return "unclear";
  if (/(?:^|\s)(bao nhieu|the nao|la gi|how much|what is|when|why)(?:\s|$)/.test(fold(text))) {
    return "unclear";
  }

  if (NO.some((n) => hasPhrase(text, n))) return "no";
  if (YES.some((y) => hasPhrase(text, y))) return "yes";
  return "unclear";
}

/* ------------------------------------------------------------- executing */

export type WizardOutcome = {
  /** False when the wizard declined the turn — the agent then proceeds normally. */
  handled: boolean;
  reply: string;
  toolTrace: any[];
  completed: boolean;
};

/**
 * The tool and arguments a confirmed transaction commits, or null when the quote
 * did not carry what the commit needs.
 *
 * No default time is invented. The previous version fell back to "10:00" and
 * "14:00" and wrote them into the PMS, booking an arrival hour the guest never
 * asked for. Missing data asks a question; it does not guess.
 */
function commitFor(pending: PendingTransaction): { tool: string; args: Record<string, unknown> } | null {
  const a = (pending.details.args ?? {}) as Record<string, any>;
  const r = (pending.details.result ?? {}) as Record<string, any>;

  if (pending.type === "cancellation") {
    if (a.booking_id != null) return { tool: "cancel_service_booking", args: { booking_id: a.booking_id } };
    const code = a.confirmation_code ?? r.confirmation_code;
    return code ? { tool: "cancel_reservation", args: { confirmation_code: code } } : null;
  }
  if (pending.type === "early_checkin") {
    const t = a.requested_time ?? r.requested_arrival_time;
    return t ? { tool: "request_early_checkin", args: { requested_time: t } } : null;
  }
  if (pending.type === "late_checkout") {
    const t = a.requested_time ?? r.new_departure_time;
    return t ? { tool: "request_late_checkout", args: { requested_time: t } } : null;
  }
  return null;
}

const LABEL: Record<PendingTransactionType, string> = {
  cancellation: "hủy",
  early_checkin: "nhận phòng sớm",
  late_checkout: "trả phòng muộn",
  lodging: "khai báo lưu trú",
};

/**
 * Phrase a sentence with the local model, falling back to a fixed line.
 *
 * The model only rewords a decision already made. It is never given a figure and
 * is told not to introduce one, because this path is short-lived enough that a
 * fabricated number would reach the guest before anything else caught it.
 */
async function say(instruction: string, fallback: string): Promise<string> {
  try {
    const r = await chat({
      messages: [
        {
          role: "system",
          content:
            "Bạn là lễ tân khách sạn. Viết đúng MỘT câu tiếng Việt, lịch sự, ngắn gọn. Không thêm thông tin và không nêu bất kỳ con số nào.",
        },
        { role: "user", content: instruction },
      ],
      maxTokens: 120,
      temperature: 0,
    });
    return (r.choices[0]?.message?.content ?? "").trim() || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Handle one turn of a pending confirmation.
 *
 * Returns `handled: false` when the guest's message is not an answer to the
 * question we asked — the agent then treats it as an ordinary request, which is
 * what stops a stale quote from swallowing every later question.
 */
export async function processFormWizardTurn(
  pending: PendingTransaction,
  guestInput: string,
  convContext: any,
  runToolFn: (name: string, args: any, ctx: any) => Promise<any>,
): Promise<WizardOutcome> {
  const answer = readConfirmation(guestInput);
  const label = LABEL[pending.type];
  const trace: any[] = [];

  if (answer === "unclear") {
    return { handled: false, reply: "", toolTrace: trace, completed: false };
  }

  if (answer === "no") {
    const reply = await say(
      `Khách từ chối tiếp tục yêu cầu ${label}. Viết một câu xác nhận đã dừng theo ý khách.`,
      `Dạ vâng, em đã dừng yêu cầu ${label} theo ý anh/chị ạ.`,
    );
    return { handled: true, reply, toolTrace: trace, completed: true };
  }

  const commit = commitFor(pending);
  if (!commit) {
    const reply = await say(
      `Khách đã đồng ý ${label} nhưng hệ thống thiếu thông tin bắt buộc. Viết một câu hỏi lại khách thông tin còn thiếu.`,
      `Dạ, anh/chị vui lòng cho em xin lại thông tin cụ thể (giờ hoặc mã đặt phòng) để em thực hiện ${label} ạ.`,
    );
    return { handled: true, reply, toolTrace: trace, completed: false };
  }

  const t0 = Date.now();
  let result: any;
  try {
    result = await runToolFn(commit.tool, commit.args, { conversation: convContext });
  } catch (e: any) {
    result = { error: e?.message ?? String(e) };
  }
  trace.push({ name: commit.tool, args: commit.args, result, ms: Date.now() - t0 });

  const failed =
    result && typeof result === "object" && (result.error || result.cancelled === false || result.approved === false);
  const reply = failed
    ? await say(
        `Yêu cầu ${label} KHÔNG thực hiện được. Viết một câu báo khách rằng chưa xử lý được và lễ tân sẽ hỗ trợ.`,
        `Dạ, em chưa thực hiện được yêu cầu ${label} — em sẽ nhờ lễ tân hỗ trợ anh/chị ngay ạ.`,
      )
    : await say(
        `Yêu cầu ${label} đã hoàn tất. Viết một câu xác nhận ngắn gọn, ấm áp.`,
        `Dạ, em đã hoàn tất yêu cầu ${label} cho anh/chị ạ.`,
      );

  return { handled: true, reply, toolTrace: trace, completed: true };
}
