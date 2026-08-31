import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import type { Server } from "node:http";
import { storage, nowIso, db, hotelToday } from "./storage";
import { upsellMetrics } from "./upsell-metrics";
import { log } from "./log";
import {
  decodeWav,
  transcribe,
  isSttLang,
  sttAvailable,
  STT_MAX_SECONDS,
  STT_SAMPLE_RATE,
} from "./stt";
import { seedIfEmpty } from "./seed";
import { runAgent, analyseConversation, personaliseCampaign } from "./agent";
import { readGuestSentiment } from "./sentiment-net";
import { chat, LlmError } from "./openai";
import { reindex, indexStats, hybridSearch } from "./retrieval";
import { getPolicyByTopic } from "./policy";
import {
  bookCatalogueService,
  confirmPayment,
  createPaymentIntent,
  ensureOpsPolicies,
  finalizeApproval,
  hotelIso,
  runOpsTool,
  lodgingRequirements,
  missingLodgingFields,
  orderRoomService,
  roomServiceWindow,
} from "./ops";
import { AgentTracer } from "./tracer";
import { redactCards } from "./guard";
import { listGuardLayers, setGuardLayer, ALWAYS_ON, type GuardLayer } from "./guard-config";
import { can, capabilitiesOf, visibleDepartments, canReadConversation, actorLabel, type Actor, type Capability } from "./rbac";
import { generatePrometheusMetrics } from "./metrics";
import QRCode from "qrcode";
import { buildVietQrPayload } from "./vietqr";
import { listBackups, performDatabaseBackup } from "./backup";
import { issueSession, actorForToken } from "./staff-session";
import { guestRequests, codeFailures, limited, blockedBy, clientKey } from "./ratelimit";
import { recordChatMetrics } from "./metrics";
import { parseCccdQr, maskId } from "./cccd";
import { synthesise, ttsAvailable, ttsLangs, isTtsLang, TTS_MAX_CHARS } from "./tts";
import { xepHang, QueueFullError, conChoDuoc, trangThaiHang, tomTatHang } from "./queue";
import { providerHealth } from "./llm";
import { synthesiseJa, jaAvailable, warmJaTts } from "./tts-ja";
import { findCheckinMatches, performCheckIn } from "./checkin";
/* Cùng bộ luật mà bảng chấm tay và giám khảo máy dùng. Nhập vào chứ không
   chép lại: một bản sao ở đây là một đường để ba nơi trôi khỏi nhau, đúng
   kiểu lỗi đã dìm kappa xuống 0,36. */
import { HANDLING_PASS, SOURCE_PASS } from "../bench/rubric";
import { aggregateSignals } from "./observability";
import { preArrivalTargets } from "./crosssell";
import { langfuseConfig, saveLangfuseSettings, clearLangfuseSettings } from "./langfuse";
import { ensurePricingPolicies, folioSummary, priceService } from "./pricing";
import { listVenues, dishesOf, hoursText } from "./dining";
import { fold } from "./catalogue";
import { searchAvailability, checkRestrictions, resolveDate, validateStayRequest } from "./booking";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { conversations, tasks as tasksTable, messages as messagesTable } from "@shared/schema";
import { eq } from "drizzle-orm";
import * as z from "zod";

/** Parse a JSON column back to a value for the API, tolerating null/garbage. */
function safeParse(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Never let a staff PIN cross the API boundary. */
function safeStaff<T extends { pin?: string } | undefined>(s: T) {
  if (!s) return null;
  const { pin: _pin, ...rest } = s as { pin?: string };
  return rest;
}


/**
 * Wrap an async handler so a rejected promise reaches the error middleware.
 *
 * It used to answer the request itself, stamping 500 on anything that was not
 * an `LlmError` — which meant a `ZodError` from `.parse()` (how every handler
 * in this file validates) came back as "Internal Server Error" with the raw
 * issue array as the message. Two error policies also drifted apart: the one
 * here and the one in index.ts, and the one that ran was decided by whether a
 * route happened to be wrapped.
 *
 * Delegating to `next` leaves exactly one policy. `LlmError` still surfaces its
 * own status because the middleware already reads `err.status`.
 */
const asyncH =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

const today = hotelToday;

/**
 * The same conversation, cut down to what a kiosk actually needs.
 *
 * `conversationDetail` is built for the staff inbox, and it was being returned
 * verbatim to guests. A confirmation code — the only credential on the guest
 * surface — therefore bought the guest's full record including `idNumber`,
 * `idType`, `nationality`, `dob` and the internal staff `notes`, plus the folio
 * with amounts, every operations task, and the assigned staff member. The
 * statutory ID fields are the serious ones: they exist for the lodging
 * declaration and have no business leaving the building.
 *
 * The kiosk reads exactly five things — `conversation.id`, `conversation.mode`,
 * `guest.name`, `guest.lang`, and `messages` — so everything else was shipped
 * to nobody. Checked across the whole client: `folioTotal`, `charges`, `tasks`
 * and `assignedStaff` are referenced only by the staff inbox and reservations
 * pages.
 *
 * `messages` keeps `toolTrace`, because the kiosk parses it to show the guest
 * which document an answer came from — that transparency is a product feature,
 * not an oversight.
 */
function guestSafeDetail(detail: NonNullable<ReturnType<typeof conversationDetail>>) {
  const { conversation, guest, messages } = detail;
  return {
    conversation: {
      id: conversation.id,
      mode: conversation.mode,
      channel: conversation.channel,
      lastMessageAt: conversation.lastMessageAt,
    },
    /* Name and language only. The guest knows their own phone number; an
       attacker holding a guessed code should not learn it. */
    guest: { name: guest?.name ?? "", lang: guest?.lang ?? "vi" },
    /**
     * `system` messages are internal annotations and never belong to the guest.
     *
     * The kiosk renders them as centred grey text, so every one of them was
     * being shown: "Conversation opened on whatsapp for reservation
     * VPNT-9K52JH" — the internal channel name and the booking reference, in
     * English, in the middle of a Japanese guest's thread. Adding the booking
     * note made it obvious, because that one is written for the staff member
     * who opens the conversation behind the approval and reads as nonsense to
     * the guest who tapped the button.
     *
     * Filtered here rather than in the client: the staff inbox needs them, and
     * this is the one function that already decides what the guest audience
     * may see.
     */
    messages: messages.filter((m) => m.role !== "system"),
  };
}

function conversationDetail(id: number) {
  const conv = storage.getConversation(id);
  if (!conv) return null;
  const guest = storage.getGuest(conv.guestId)!;
  const reservation = storage.getReservation(conv.reservationId) ?? null;
  const room = storage.getRoom(reservation?.roomId ?? null) ?? null;
  const charges = reservation ? storage.listCharges(reservation.id) : [];
  return {
    conversation: conv,
    guest: { ...guest, preferences: JSON.parse(guest.preferences || "[]") as string[] },
    reservation,
    room,
    folioTotal: Math.round(charges.reduce((n, c) => n + c.amount, 0) * 100) / 100,
    charges,
    messages: storage.listMessages(id),
    tasks: storage.listTasks().filter((t) => t.conversationId === id),
    assignedStaff: conv.assignedStaffId ? safeStaff(storage.getStaff(conv.assignedStaffId)) : null,
  };
}

/** Runs the agent for a conversation and persists the reply. */
async function respondWithAi(conversationId: number) {
  const result = await runAgent(conversationId);

  /**
   * Card numbers are screened on the way IN and were never screened on the way
   * out. A model that echoes one back — from history, from a passage, or from
   * nowhere at all — puts it in the transcript and the database permanently.
   * Luhn keeps this off booking references and phone numbers.
   *
   * Deliberately ONLY card numbers. A general PII filter over the reply is the
   * obvious next step and would be wrong here: the phone and email patterns
   * would redact the hotel's own front-desk number and reservations address,
   * which is a correct answer to a common question. Blocking a real answer is a
   * worse failure for this product than the leak it would prevent, and the
   * guest's own details are already scoped out of the payload upstream.
   */
  const outbound = redactCards(result.reply);
  if (outbound.found) {
    console.warn(`[guard] card number removed from the AI reply on conversation #${conversationId}`);
  }

  storage.addMessage({
    conversationId,
    role: "ai",
    authorName: "Aurea Agent",
    body: outbound.text,
    toolTrace: result.trace.length ? JSON.stringify(result.trace) : null,
    latencyMs: result.latencyMs,
    createdAt: nowIso(),
  });
  /**
   * Ghi số đo cho Prometheus.
   *
   * `recordChatMetrics` tồn tại từ đầu và **chưa từng có ai gọi**. Hệ quả:
   * `aurea_chat_requests_total`, `aurea_escalations_total` và
   * `aurea_response_latency_avg_ms` vĩnh viễn bằng 0 — ba trong chín chỉ số là
   * đồ trang trí. Không có gì báo lỗi; endpoint vẫn trả 200, Prometheus vẫn thu
   * thập được, và biểu đồ vẫn vẽ ra một đường thẳng ở đáy trông như một hệ
   * thống không ai dùng.
   */
  recordChatMetrics(result.latencyMs, result.escalated === true);

  const conv = storage.getConversation(conversationId)!;
  if (conv.firstResponseSeconds == null) {
    storage.updateConversation(conversationId, {
      firstResponseSeconds: Math.max(1, Math.round(result.latencyMs / 1000)),
    });
  }
  /* An unhappy guest usually says nothing and leaves. The thumbs-down path
     below handles the ones who press the button; this reads the complaint out
     of the message itself, off the vector retrieval already computed for this
     turn — a cosine, not a second model call. */
  const lastGuest = [...storage.listMessages(conversationId)].reverse().find((m) => m.role === "guest");
  if (lastGuest) {
    const mood = readGuestSentiment(lastGuest.body);
    if (mood) escalateUnhappyGuest(conversationId, lastGuest.body, mood.score);
  }

  /* Errors are logged, not swallowed. This used to end in
     `.catch(() => undefined)`, and because the classifier's failure value is
     also "neutral" a broken call and a genuinely neutral guest were
     indistinguishable — measured on this database, 33 of the conversations
     that went through the AI path never received a topic at all and nothing
     anywhere recorded why. */
  analyseConversation(conversationId).catch((e) =>
    console.warn(`[insights] sentiment classify failed for conversation #${conversationId}:`, e?.message ?? e),
  );
  return result;
}

/**
 * Hand an unhappy guest to the front desk, on the same terms the thumbs-down
 * button already uses: the conversation goes to a human, an URGENT task opens
 * with the standard ten-minute SLA, and the guest is told a person is coming.
 *
 * Deliberately reuses that contract rather than inventing a second, quieter
 * one — staff already know what this task means and how fast to answer it.
 * Guarded against re-firing: a guest who is unhappy for three messages in a
 * row needs one person, not three tasks.
 */
const UNHAPPY_TASK_TITLE = "⚠️ Khách có dấu hiệu không hài lòng";

function escalateUnhappyGuest(conversationId: number, guestText: string, score: number) {
  const conv = storage.getConversation(conversationId);
  if (!conv) return;
  const alreadyOpen = storage
    .listTasks()
    /* Matched on the title, not on a new `source` value: the tasks board
       renders source as "AI" or "Staff", so inventing a third value would
       have labelled these tasks as Staff-created. */
    .some((t) => t.conversationId === conversationId && t.status !== "done" && t.title === UNHAPPY_TASK_TITLE);
  if (alreadyOpen) return;

  storage.updateConversation(conversationId, {
    mode: "human",
    unreadForStaff: 1,
    sentiment: "negative",
    sentimentSource: "model_realtime",
    sentimentAt: nowIso(),
    lastMessageAt: nowIso(),
  });
  const task = storage.createTask({
    hotelId: conv.hotelId,
    reservationId: conv.reservationId ?? null,
    roomId: null,
    conversationId,
    dept: "front_desk",
    title: UNHAPPY_TASK_TITLE,
    detail: `Phát hiện từ tin nhắn của khách (độ tin cậy ${(score * 100).toFixed(0)}%): "${guestText.replace(/\s+/g, " ").slice(0, 200)}". Khách chưa bấm phản hồi — hãy chủ động liên hệ.`,
    priority: "urgent",
    status: "open",
    source: "ai",
    assignedStaffId: null,
    dueAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    createdAt: nowIso(),
    resolvedAt: null,
  });
  storage.logEvent({
    type: "conversation.sentiment_escalated",
    actor: "system",
    summary: `Hội thoại #${conversationId} chuyển Lễ tân — phát hiện khách không hài lòng.`,
    payload: JSON.stringify({ taskId: task.id, score }),
    conversationId,
    createdAt: nowIso(),
  });
}

/**
 * Every /api route except the guest-facing ones is a staff surface: it reads
 * other guests' names, folios, conversations and tasks. Until this file was
 * patched, all of it was open to anyone who could reach the port.
 *
 * The included frontend does not send a staff token yet, so the default is
 * warn-only: the hole is logged on every request instead of silently ignored.
 * Set STAFF_API_TOKEN and API_AUTH_ENFORCE=1 to close it, which is required
 * before this ever faces a real network.
 */
const STAFF_API_TOKEN = process.env.STAFF_API_TOKEN || "";
const API_AUTH_ENFORCE = process.env.API_AUTH_ENFORCE === "1";

/**
 * The guest chat is NOT under /api/guest/*. A guest message is posted to the
 * shared route POST /api/conversations/:id/messages with body.from === "guest",
 * the same route staff use with from === "staff". So the guest surface can only
 * be recognised by method + shape, not by a path prefix.
 *
 * express.json() is registered in index.ts before registerRoutes(), so req.body
 * is already parsed by the time this guard runs.
 *
 * WARNING: this allowlist covers guest SENDING only. Whatever else the guest UI
 * fetches to render a thread (conversation detail, hotel info, service list) is
 * still treated as staff surface, because client/ has not been audited to
 * establish the real guest surface. Identify those calls before switching
 * API_AUTH_ENFORCE on, or the guest app will break along with the dashboard.
 */
function isGuestRoute(req: Request) {
  if (
    req.method === "POST" &&
    /^\/api\/conversations\/\d+\/messages\/?$/.test(req.path) &&
    (req.body as { from?: unknown } | undefined)?.from === "guest"
  )
    return true;

  /* The guest thread polls GET /api/conversations/:id every few seconds to
   * pick up staff replies. That path also serves STAFF reading any OTHER
   * guest's conversation, so it cannot be exempted by shape alone — that
   * would let anyone read any conversation by guessing sequential ids. The
   * guest's own confirmation code (already the bearer secret /api/guest/session
   * trusts) doubles as the credential here: only exempt when the code in the
   * query string actually owns this specific conversation. */
  /**
   * The guest's thumbs-up / thumbs-down.
   *
   * This was missing, and with API_AUTH_ENFORCE=1 the button returned 401 to
   * every guest — the kiosk has no staff token and never will. The `feedback`
   * table being empty was the symptom. It matters more than most: the whole
   * unhappy-guest escalation contract (urgent task, ten-minute SLA, apology) was
   * modelled on this path, and the sentiment classifier exists to catch the
   * guests who DON'T press it.
   *
   * Exempted on the same terms as the read below — the confirmation code must
   * own this exact conversation. Not shape alone: a bare `from: "guest"` would
   * let anyone post feedback on a guessed id and open urgent front-desk tasks
   * at will, which is a denial-of-service on a real hotel's queue.
   */
  /* A payment link is opened by a guest who has no session and no confirmation
     code — the token in the URL is the whole credential, which is why the
     handler returns only an amount and a status. Path-matched rather than added
     to PUBLIC_REFERENCE_ROUTES, which compares exact strings and would never
     match a token. */
  if (req.method === "GET" && /^\/api\/pay\/[A-Za-z0-9_-]{8,}$/.test(req.path)) return true;

  const fbMatch = req.method === "POST" && req.path.match(/^\/api\/conversations\/(\d+)\/feedback\/?$/);
  if (fbMatch) {
    const code = (req.body as { code?: unknown } | undefined)?.code;
    if (typeof code !== "string" || !code) return false;
    const reservation = storage.getReservationByCode(code);
    if (!reservation) return false;
    const conv = storage.getConversationForReservation(reservation.id);
    return !!conv && conv.id === Number(fbMatch[1]);
  }

  const convMatch = req.method === "GET" && req.path.match(/^\/api\/conversations\/(\d+)\/?$/);
  if (convMatch) {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (!code) return false;
    const reservation = storage.getReservationByCode(code);
    if (!reservation) return false;
    const conv = storage.getConversationForReservation(reservation.id);
    return !!conv && conv.id === Number(convMatch[1]);
  }

  if (req.method === "GET" && (req.path === "/api/guest/keys" || req.path === "/api/guest/keys/")) return true;
  if (req.method === "POST" && req.path === "/api/guest/session") return true;
  /* Kiosk tự phục vụ: khách chưa có mã đặt phòng nào để trình, vì cái họ đang
     làm CHÍNH LÀ để lấy mã đó. Bù lại bằng bộ đếm chống dò trong handler. */
  if (req.method === "POST" && req.path === "/api/guest/checkin") return true;
  /* Đọc thành tiếng: khách bấm nghe trước khi có phiên nào, và câu cần đọc
     vốn đã hiển thị trên màn hình họ — không có gì bí mật để lộ. */
  if (req.method === "POST" && req.path === "/api/guest/speak") return true;

  /**
   * The kiosk's transactional routes — availability, booking, menu, ordering.
   *
   * Exempted on SHAPE, exactly like `/api/guest/session` above, and the handler
   * does the code check. The first version resolved the code HERE and returned
   * false when it did not match, which read as "stricter" and was the opposite:
   * a request with a bad code never reached a handler, so neither the guest
   * throttle nor `codeFailures` ever ran, while a good code returned 200 and a
   * bad one 401.
   *
   * That is an unthrottled oracle for confirmation codes — measured at 40 wrong
   * codes in a row with no 429, against `/api/guest/session` blocking after 30.
   * It matters more than it used to: since these routes exist, a code is not
   * only a key to a conversation, it is the authority to put a spa treatment
   * and a room-service order on someone's folio.
   */
  if (
    req.method === "GET" &&
    (req.path === "/api/guest/availability" || req.path === "/api/guest/menu" || req.path === "/api/guest/my-requests")
  )
    return true;
  if (req.method === "POST" && (req.path === "/api/guest/book" || req.path === "/api/guest/order")) return true;
  if (req.method === "POST" && req.path === "/api/guest/request") return true;
  /* Voice input. Exempted on shape like the routes above; the handler resolves
     the code and charges the enumeration budget on a miss. The code travels in
     the query string because the BODY is audio — and it is the same credential
     the thread poll above already puts there. */
  if (req.method === "POST" && req.path === "/api/guest/transcribe") return true;
  if (req.method === "GET" && req.path === "/api/guest/voice") return true;
  /* Sống chưa, và còn bao nhiêu người trước mặt. Cả hai đều không trả dữ liệu
     của ai, và cả hai đều được hỏi bởi thứ không cầm token: healthcheck của
     Docker, uptime monitor, và kiosk đang đếm chỗ trong hàng. */
  if (req.method === "GET" && (req.path === "/api/health" || req.path === "/api/queue")) return true;

  /* Staff login itself must be reachable without the token — the PIN check
   * inside the handler IS the credential check, and it is what MINTS the
   * token the client presents on every request after this one. */
  if (req.method === "POST" && req.path === "/api/staff/login") return true;

  return false;
}

/** Public reference data with no guest PII — safe exactly like a hotel's own
 * public website page. The guest app needs these before any session exists.
 * /api/staff is the login page's team picker — names/roles only, PINs are
 * already stripped in the handler — and must load before login succeeds. */
const PUBLIC_REFERENCE_ROUTES = new Set([
  "/api/hotel",
  "/api/dining-venues",
  "/api/room-types",
  "/api/service-groups",
  "/api/staff",
  "/api/guest/keys",
]);

let warnedOnce = false;

/**
 * Marks a request as belonging to a GUEST rather than to staff.
 *
 * The two audiences hit some of the same handlers — `GET /api/conversations/:id`
 * serves the kiosk polling its own thread and staff reading anybody's — and the
 * handler had no way to tell them apart, so it returned the staff-shaped
 * payload to both. `guestScoped` is set here, in the one place that already
 * decides which audience this is, so a handler cannot forget to ask.
 */
export function isGuestScoped(req: Request): boolean {
  return (req as Request & { guestScoped?: boolean }).guestScoped === true;
}

/** Who is making this request. Null on the guest surface and before sign-in. */
function actorOf(req: Request): Actor | null {
  return (req as Request & { actor?: Actor }).actor ?? null;
}

/**
 * Refuse unless the caller holds the capability. Answers 403 itself.
 *
 * 403 rather than 404: the caller IS authenticated, they simply do not do this
 * job, and telling a spa therapist that the approvals endpoint exists costs
 * nothing while pretending it does not would make a real misconfiguration
 * impossible to debug.
 *
 * @returns true when the caller should stop.
 */
function denied(req: Request, res: Response, cap: Capability): boolean {
  const actor = actorOf(req);
  if (can(actor, cap)) return false;
  res.status(403).json({
    message: "Tài khoản của bạn không có quyền xem mục này.",
    required: cap,
    yourDepartment: actor?.dept ?? null,
    yourRole: actor?.role ?? null,
  });
  return true;
}

function staffApiGuard(req: Request, res: Response, next: () => void) {
  if (!req.path.startsWith("/api/")) return next();
  if (isGuestRoute(req)) {
    (req as Request & { guestScoped?: boolean }).guestScoped = true;
    return next();
  }
  if (req.method === "GET" && PUBLIC_REFERENCE_ROUTES.has(req.path)) return next();

  const presented =
    (req.headers["x-staff-token"] as string | undefined) ||
    (typeof req.headers.authorization === "string" && req.headers.authorization.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : undefined);

  /* A per-session token identifies the person, which is what makes roles
     enforceable and what puts a name in the audit trail. */
  const actor = actorForToken(presented);
  if (actor) {
    (req as Request & { actor?: Actor }).actor = actor;
    return next();
  }

  /* The legacy shared token still works, as a SERVICE identity with full
     access. Benches, the demo builder and the maintenance scripts present it,
     and breaking them to tighten a boundary they are not part of would be a bad
     trade. It is distinguishable in the audit trail as `service`. */
  if (STAFF_API_TOKEN && presented === STAFF_API_TOKEN) {
    (req as Request & { actor?: Actor }).actor = {
      id: 0, name: "service", role: "manager", dept: "front_desk", service: true,
    };
    return next();
  }

  if (API_AUTH_ENFORCE) {
    res.status(401).json({ message: "Staff authentication required." });
    return;
  }

  if (!warnedOnce) {
    warnedOnce = true;
    console.warn(
      "[security] /api/* staff routes are UNAUTHENTICATED. Set STAFF_API_TOKEN and API_AUTH_ENFORCE=1 " +
        "before exposing this server to any network. Guest folios, conversations and staff records are readable by anyone.",
    );
  }
  console.warn(`[security] unauthenticated staff API call: ${req.method} ${req.path}`);
  return next();
}

/**
 * Dựng lại chỉ mục sau khi sửa nội dung, và **nói ra khi hỏng**.
 *
 * Ba tuyến KB trước đây gọi `void reindex().catch(() => {})` — bắn đi rồi quên,
 * nuốt lỗi im lặng. Nếu dịch vụ nhúng chết giữa chừng thì bài viết vẫn lưu
 * thành công, chỉ mục nằm lại nửa vời, và không ai được báo gì cả. Người biên
 * tập tin là đã xong; khách nhận câu trả lời từ một kho đã lỗi thời.
 *
 * Giờ chờ nó xong rồi trả kết quả về cho người bấm, và ghi một dòng nhật ký dù
 * thành công hay thất bại. Chờ được là nhờ dựng tăng dần: sửa một bài chỉ đụng
 * vài chunk, không còn là 65 giây nhúng lại cả kho.
 */
async function reindexAndReport(req: Request, ly_do: string) {
  try {
    const r = await reindex();
    storage.logEvent({
      type: r.embedError ? "retrieval.reindex_failed" : "retrieval.reindexed",
      actor: actorLabel(actorOf(req)),
      summary: r.embedError
        ? `Dựng lại chỉ mục THẤT BẠI sau ${ly_do}: ${r.embedError}. Chỉ mục có ${r.vectorCount}/${r.chunks} chunk còn vector.`
        : `Chỉ mục cập nhật sau ${ly_do}: +${r.added} mới, ${r.changed} sửa, ${r.removed} xoá, ${r.kept} giữ nguyên.`,
      payload: null,
      conversationId: null,
      createdAt: nowIso(),
    });
    if (r.embedError) console.error(`[retrieval] reindex failed after ${ly_do}: ${r.embedError}`);
    return r;
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    console.error(`[retrieval] reindex threw after ${ly_do}: ${msg}`);
    storage.logEvent({
      type: "retrieval.reindex_failed",
      actor: actorLabel(actorOf(req)),
      summary: `Dựng lại chỉ mục ném lỗi sau ${ly_do}: ${msg}`,
      payload: null,
      conversationId: null,
      createdAt: nowIso(),
    });
    return { embedError: msg, chunks: 0, vectorCount: 0, added: 0, changed: 0, kept: 0, removed: 0, embedded: 0, model: "" };
  }
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  seedIfEmpty();
  /* Money and operational policy rows must exist before the first tool call,
   * or the first guest gets hard-coded defaults with no audit trail. */
  ensurePricingPolicies();
  ensureOpsPolicies();

  app.use(staffApiGuard);

  // Build the retrieval index once at boot, in the background, so the agent has
  // embeddings available without blocking the port from opening.
  void (async () => {
    try {
      const stats = indexStats();
      if (stats.chunks === 0 || stats.embedded === 0) {
        const r = await reindex();
        console.log(
          `[retrieval] indexed ${r.chunks} chunks, ${r.embedded} embedded with ${r.model}` +
            (r.embedError ? ` (embedding stopped: ${r.embedError})` : ""),
        );
      } else {
        console.log(`[retrieval] index ready: ${stats.chunks} chunks, ${stats.embedded} embedded`);
      }
    } catch (e: any) {
      console.error("[retrieval] index build failed:", e?.message ?? e);
    }
  })();

  /* Warm-up tiếng Nhật (Kokoro + kuroshiro) ngay khi khởi động.
     Không block port — nếu chưa có weights, warmJaTts() tự thoát sớm. */
  void warmJaTts();

  /* ---------------- property & directory ---------------- */

  app.get("/api/hotel", (_req, res) => {
    res.json(storage.getHotel());
  });

  app.patch("/api/hotel", (req, res) => {
    if (denied(req, res, "configure")) return;
    const schema = z.object({
      brandVoice: z.string().min(20).optional(),
      slaMinutes: z.number().int().min(1).max(240).optional(),
      aiEnabled: z.number().int().min(0).max(1).optional(),
      checkInTime: z.string().optional(),
      checkOutTime: z.string().optional(),
      /**
       * VietQR beneficiary. Validated here rather than at QR build time so a
       * typo is refused while someone is looking at the form, not discovered
       * later by a guest whose transfer went nowhere.
       *
       * `bankBin` is the 6-digit NAPAS acquirer id, not the SWIFT code. Empty
       * strings are allowed so the fields can be cleared, which is the only way
       * to switch the QR off again.
       */
      bankBin: z.string().regex(/^(\d{6})?$/, "Mã BIN phải gồm đúng 6 chữ số.").optional(),
      bankAccountNumber: z.string().regex(/^([A-Za-z0-9]{4,24})?$/, "Số tài khoản không hợp lệ.").optional(),
      bankAccountName: z.string().max(60).optional(),
    });
    const patch = schema.parse(req.body);
    res.json(storage.updateHotel(patch));
  });

  app.get("/api/staff", (_req, res) => {
    res.json(storage.listStaff().map(({ pin, ...s }) => s));
  });

  app.post("/api/staff/login", (req, res) => {
    const { name, pin } = z.object({ name: z.string(), pin: z.string() }).parse(req.body);
    const s = storage.authStaff(name, pin);
    if (!s) return res.status(401).json({ message: "Wrong name or PIN." });
    const { pin: _p, ...safe } = s;
    /* A token bound to THIS person, so every later request carries who made it.
       `capabilities` rides along so the client can hide what the server would
       refuse anyway — the check that matters is the server's. */
    const staffApiToken = issueSession(s);
    res.json({
      ...safe,
      staffApiToken,
      capabilities: capabilitiesOf({ id: s.id, name: s.name, role: s.role, dept: s.dept }),
    });
  });

  /* ---------------- guest surface ---------------- */

  app.get("/api/guest/keys", (_req, res) => {
    /**
     * The demo room-picker: every guest's confirmation code, name, tier, room
     * number and dates, with no authentication at all.
     *
     * It used to be OPT-OUT — off in production, on everywhere else — which
     * sounded careful and was not, because `DEMO.md` tells an operator to run
     * the product with `npm run dev`. Under the documented way of running it,
     * this endpoint was serving the whole guest directory to anyone who could
     * reach the port.
     *
     * That is also what made a second factor on the kiosk pointless: a
     * confirmation code plus a surname or a room number is no stronger than the
     * code alone when one unauthenticated GET hands over all three. And since
     * the booking and ordering routes exist, a code is the authority to put
     * charges on someone's folio.
     *
     * Now OPT-IN in every environment. A demo sets EXPOSE_GUEST_KEYS=1
     * deliberately, for the length of the demo.
     */
    if (process.env.EXPOSE_GUEST_KEYS !== "1") {
      res.status(404).json({ message: "Not found." });
      return;
    }
    // The deep-link directory a real deployment would issue per reservation.
    const rows = storage.listReservations().map((r) => {
      const g = storage.getGuest(r.guestId)!;
      const room = storage.getRoom(r.roomId);
      return {
        confirmationCode: r.confirmationCode,
        guestName: g.name,
        lang: g.lang,
        vipTier: g.vipTier,
        room: room?.number ?? null,
        checkIn: r.checkIn,
        checkOut: r.checkOut,
        status: r.status,
      };
    });
    res.json(rows);
  });

  app.post(
    "/api/guest/session",
    asyncH(async (req, res) => {
      if (limited(guestRequests, req, res, "Quá nhiều yêu cầu, vui lòng thử lại sau.")) return;

      const { code } = z.object({ code: z.string().min(4) }).parse(req.body);
      const reservation = storage.getReservationByCode(code);

      /**
       * The code is checked BEFORE the throttle is enforced, deliberately.
       *
       * A hotel is the worst case for per-address limiting: every guest on the
       * wifi shares one NAT address, so refusing a CORRECT code because the
       * budget is spent means one person mistyping locks out the building.
       * Charging only misses, and letting a correct code through regardless,
       * keeps enumeration bounded — an attacker's attempts are almost all
       * misses — without ever turning a real guest away.
       *
       * The budget is deliberately NOT reset on success. It was, briefly, to be
       * kind to a guest who mistypes and then gets it right — but that guest is
       * already served, because a correct code bypasses the throttle entirely.
       * The reset bought them nothing and handed an attacker holding one valid
       * code an unlimited budget: interleave the good code, counter cleared,
       * enumerate on. Misses now accumulate no matter what else happens.
       */
      if (!reservation) {
        codeFailures.penalise(clientKey(req));
        if (blockedBy(codeFailures, req, res, "Sai mã quá nhiều lần. Vui lòng liên hệ lễ tân.")) return;
        return res.status(404).json({ message: "No reservation with that code." });
      }
      let conv = storage.getConversationForReservation(reservation.id);
      if (!conv) {
        conv = storage.createConversation({
          hotelId: reservation.hotelId,
          guestId: reservation.guestId,
          reservationId: reservation.id,
          channel: "webchat",
          mode: "ai",
          assignedStaffId: null,
          sentiment: "neutral",
          /* A brand-new conversation has no verdict yet. NULL means "nobody has
             judged this", which is not the same as "the guest is fine". */
          sentimentSource: null,
          sentimentAt: null,
          topic: null,
          unreadForStaff: 0,
          lastMessageAt: nowIso(),
          createdAt: nowIso(),
          firstResponseSeconds: null,
        });
      }
      /* Always a guest here — this route exists only for the kiosk. */
      res.json({ conversationId: conv.id, ...guestSafeDetail(conversationDetail(conv.id)!) });
    }),
  );

  /* ---------------- structured booking from the kiosk ---------------- */

  /**
   * Why a booking is made by picking, not by typing.
   *
   * `book_service` is a TOOL, so it only ever ran on the hosted path — with
   * `LLM_MODE=local` (what the product actually ships with) a guest asking to
   * book anything was answered with an abstention and a handoff. Free text was
   * also the wrong input for it: an item, a date, a slot and a party size have
   * to be exactly right to charge someone, and a 4B model extracting four slots
   * from a sentence gets one of them wrong often enough to matter.
   *
   * Picking sidesteps both. The guest chooses from the catalogue the hotel
   * published, so every field is already valid before the request is sent, and
   * no model is involved in the transaction at all.
   *
   * `bookCatalogueService` is reused untouched — it is the only place a
   * booking is created, so lead time, capacity, double-booking, member pricing
   * and the HITL gate behave identically here and on the hosted path. Nothing
   * is charged: it writes `pending_approval` and a staff member approving it
   * is what posts the folio line.
   */
  const guestBookingCtx = (code: string) => {
    const res = storage.getReservationByCode(code);
    if (!res) return null;
    const hotel = storage.getHotel();
    const guest = storage.getGuest(res.guestId);
    const conv = storage.getConversationForReservation(res.id);
    if (!hotel || !guest || !conv) return null;
    return { hotel, guest, res, room: storage.getRoom(res.roomId), conv };
  };

  /**
   * Resolve a kiosk request's confirmation code, charging the enumeration
   * budget for a miss. Answers the request itself and returns null when it
   * cannot proceed, so callers read as `const ctx = ...; if (!ctx) return;`.
   *
   * The order is the one `/api/guest/session` established and it is not
   * arbitrary: a CORRECT code is served even when the budget is spent, because
   * a hotel is a NAT and every guest on the wifi shares one address — refusing
   * a real guest because a stranger mistyped is worse than the enumeration it
   * prevents. Only misses are charged, and the budget is never reset on
   * success, or an attacker holding one valid code could launder it.
   */
  const guestCtxOrDeny = (req: Request, res: Response, code: string) => {
    const ctx = guestBookingCtx(code);
    if (ctx) return ctx;
    codeFailures.penalise(clientKey(req));
    if (blockedBy(codeFailures, req, res, "Sai mã quá nhiều lần. Vui lòng liên hệ lễ tân.")) return null;
    res.status(404).json({ message: "No reservation with that code." });
    return null;
  };

  app.get(
    "/api/guest/availability",
    asyncH(async (req, res) => {
      if (limited(guestRequests, req, res, "Quá nhiều yêu cầu, vui lòng thử lại sau.")) return;
      const q = z
        .object({ code: z.string().min(4), serviceId: z.coerce.number().int().positive(), date: z.string() })
        .parse(req.query);

      const ctx = guestCtxOrDeny(req, res, q.code);
      if (!ctx) return;
      const svc = storage.getService(q.serviceId);
      if (!svc || !svc.active) return res.status(404).json({ message: "No such service." });

      const slots: string[] = JSON.parse(svc.slots || "[]");
      const booked = storage.bookingsFor(svc.id, q.date);
      /* Seats already committed include the ones only PENDING approval. A slot
         held by a request the desk has not answered yet is not free — offering
         it again would let two guests be told yes for one table. */
      const taken = (slot: string) =>
        booked
          .filter((b) => b.slot === slot && b.status !== "cancelled" && b.status !== "rejected")
          .reduce((n, b) => n + b.partySize, 0);

      const priced = priceService(svc, ctx.guest.vipTier, 1, ctx.hotel.currency);
      res.json({
        serviceId: svc.id,
        name: svc.name,
        date: q.date,
        currency: ctx.hotel.currency,
        unit: svc.unit,
        rackPrice: priced.rack_amount,
        memberPrice: priced.net_amount,
        discountPercent: priced.discount_pct,
        capacityPerSlot: svc.capacityPerSlot,
        /* An empty list means the service has no published schedule — a beach
           desk rather than a spa — and is bookable on the date alone. */
        slots: slots.map((slot) => ({ slot, seatsLeft: Math.max(0, svc.capacityPerSlot - taken(slot)) })),
      });
    }),
  );

  /**
   * Does this deployment have a microphone to offer?
   *
   * The kiosk asks before rendering the button. A mic that triggers a 240 MB
   * model download mid-conversation over hotel wifi is worse than no mic: the
   * guest taps, waits minutes, and concludes the product is broken. So the
   * button only exists once the weights are on disk.
   */
  /**
   * Hàng đợi đầy là 429, không phải 500.
   *
   * Khác biệt không phải hình thức: 500 nói "hệ thống hỏng", 429 kèm
   * `Retry-After` nói "đang bận, thử lại sau chừng này giây". Người dùng đọc
   * được cái thứ hai; và các nhánh `catch` ở đây vốn gói mọi lỗi thành 500,
   * nên một hàng đợi đầy sẽ hiện ra như một sản phẩm hỏng.
   */
  const tuChoiVìĐông = (res: Response, e: unknown): boolean => {
    if (!(e instanceof QueueFullError)) return false;
    res.setHeader("Retry-After", String(e.retryAfterSeconds));
    res.status(429).json({
      message: "Máy đang đọc cho khách khác. Anh/chị thử lại sau ít giây giúp em ạ.",
      retryAfterSeconds: e.retryAfterSeconds,
    });
    return true;
  };

  /**
   * Máy này còn sống không — công khai, không cần xác thực.
   *
   * VÌ SAO CÔNG KHAI. Đây là thứ mà Docker healthcheck, uptime monitor và một
   * người vừa được gửi link đều hỏi trước tiên, và cả ba đều KHÔNG có token.
   * Trước tuyến này `/api/health` trả 401, nghĩa là cách duy nhất để biết dịch
   * vụ còn sống là tự mở trình duyệt ra bấm thử.
   *
   * KHÔNG trả gì nhạy cảm: không tên khách, không cấu hình, không đường dẫn.
   * Chỉ đủ để trả lời "có dùng được không, và nếu chậm thì vì sao".
   */
  app.get("/api/health", (_req, res) => {
    const llm = providerHealth();
    const idx = (() => {
      try {
        return indexStats();
      } catch {
        return null;
      }
    })();
    const sanSang = !!llm.local.available;
    res.status(sanSang ? 200 : 503).json({
      status: sanSang ? "ok" : "degraded",
      /* Không có model trả lời thì kiosk vẫn mở được nhưng không trả lời được —
         đó là "degraded", không phải "ok", và monitor phải thấy khác nhau. */
      uptimeSeconds: Math.round(process.uptime()),
      model: {
        engine: llm.local.available ? "up" : "down",
        name: process.env.LOCAL_AGENT_MODEL ?? null,
      },
      retrieval: idx ? { chunks: idx.chunks, embedded: idx.embedded, model: idx.model } : null,
      voice: {
        stt: sttAvailable(),
        tts: ttsAvailable() || jaAvailable(),
        ttsLangs: [...ttsLangs(), ...(jaAvailable() ? (["ja"] as const) : [])],
      },
      queue: tomTatHang(),
    });
  });

  /**
   * Còn bao nhiêu người trước mặt.
   *
   * Kiosk hỏi tuyến này TRONG LÚC đang chờ câu trả lời của chính nó. Không có
   * nó thì một lượt 13,7 giây — hoặc 41 giây khi có ba người — chỉ là một dấu
   * xoay không giải thích gì, và người thứ ba kết luận sản phẩm hỏng trong khi
   * nó đang chạy đúng.
   */
  app.get("/api/queue", (_req, res) => res.json(trangThaiHang("chat")));

  app.get("/api/guest/voice", (_req, res) =>
    res.json({
      stt: sttAvailable(),
      maxSeconds: STT_MAX_SECONDS,
      sampleRate: STT_SAMPLE_RATE,
      tts: ttsAvailable() || jaAvailable(),
      /* jaAvailable() → Kokoro ONNX đã có trên đĩa, dùng được cho tiếng Nhật.
         Piper vẫn xử lý 5 ngôn ngữ còn lại; tiếng Nhật đi qua kokoro-js. */
      ttsLangs: [
        ...ttsLangs(),
        ...(jaAvailable() ? (["ja"] as const) : []),
      ],
      ttsMaxChars: TTS_MAX_CHARS,
    }),
  );

  /**
   * Speech to text, entirely on this machine.
   *
   * The audio never leaves the property. That is the whole reason a model is
   * carried at all — the browser's own `SpeechRecognition` is more accurate and
   * far faster, and it works by uploading the guest's voice to Google. A room
   * number, a complaint and a voice print is a worse disclosure than any text
   * this system already argues about.
   *
   * The body is a 16 kHz mono 16-bit WAV, resampled by the browser. Sending the
   * recorder's native webm/opus instead would put an ffmpeg subprocess in the
   * path of every utterance; the phone already owns a decoder and a resampler.
   */
  app.post(
    "/api/guest/transcribe",
    express.raw({ type: ["audio/wav", "audio/wave", "application/octet-stream"], limit: "4mb" }),
    asyncH(async (req, res) => {
      if (limited(guestRequests, req, res, "Quá nhiều yêu cầu, vui lòng thử lại sau.")) return;
      const q = z
        .object({ code: z.string().min(4), lang: z.string().default("vi") })
        .parse(req.query);
      if (!isSttLang(q.lang)) return res.status(400).json({ message: `Unsupported language ${q.lang}.` });
      /* Giữ kiểu đã thu hẹp: `q.lang` là thuộc tính nên TypeScript bỏ phép thu
         hẹp ngay khi nó đi vào một closure. */
      const sttLang = q.lang;

      const ctx = guestCtxOrDeny(req, res, q.code);
      if (!ctx) return;

      const audio = req.body;
      if (!Buffer.isBuffer(audio) || audio.length === 0)
        return res.status(400).json({ message: "Send a 16 kHz mono WAV as the request body." });

      let pcm;
      try {
        pcm = decodeWav(audio);
      } catch (e) {
        return res.status(400).json({ message: (e as Error).message });
      }

      const t0 = Date.now();
      try {
        const out = await xepHang("speech", () => transcribe(pcm, sttLang));
        /* The transcript is NOT posted as a message here. Recognition is
           imperfect enough on four-second Vietnamese that the guest must see
           what was heard and be able to fix it before it becomes a request the
           hotel acts on — the kiosk puts it in the composer, not in the thread. */
        res.json({
          text: out.text,
          model: out.model,
          lang: out.lang,
          audioSeconds: Number(out.audioSeconds.toFixed(2)),
          ms: out.ms,
          rtf: Number(out.rtf.toFixed(2)),
        });
      } catch (e) {
        if (tuChoiVìĐông(res, e)) return;
        log(`stt: failed after ${Date.now() - t0}ms: ${(e as Error).message}`);
        res.status(503).json({ message: "Chưa nhận dạng được giọng nói. Anh/chị nhập giúp em bằng chữ ạ." });
      }
    }),
  );

  app.post(
    "/api/guest/book",
    asyncH(async (req, res) => {
      if (limited(guestRequests, req, res, "Quá nhiều yêu cầu, vui lòng thử lại sau.")) return;
      const body = z
        .object({
          code: z.string().min(4),
          serviceId: z.number().int().positive(),
          date: z.string(),
          slot: z.string().default(""),
          partySize: z.number().int().min(1).max(20).default(1),
          note: z.string().max(300).optional(),
        })
        .parse(req.body);

      const ctx = guestCtxOrDeny(req, res, body.code);
      if (!ctx) return;

      /**
       * A guest may not queue an unbounded number of approvals.
       *
       * Every booking opens a staff task, so a valid code held by someone
       * bored is a queue-flooding tool. The rate limit above throttles the
       * SPEED; this bounds the TOTAL a single stay can have outstanding, which
       * is the number that actually costs the front desk its attention.
       */
      const pending = storage
        .bookingsForReservation(ctx.res.id)
        .filter((b) => b.status === "pending_approval").length;
      if (pending >= 5)
        return res.status(429).json({
          message: "Bạn đang có 5 yêu cầu chờ lễ tân xác nhận. Vui lòng đợi được duyệt trước khi đặt thêm.",
        });

      const out = bookCatalogueService(ctx, {
        serviceId: body.serviceId,
        date: body.date,
        slot: body.slot,
        partySize: body.partySize,
        note: body.note,
      });
      /* The core reports a refusal (past date, no seats, too little lead time,
         a clash) as an `error` field rather than by throwing. Those are answers
         to the guest, not faults — 409, so the client can show the reason. */
      if (out.error) return res.status(409).json(out);

      /**
       * Leave a trace in the thread.
       *
       * The guest booked by tapping, so nothing was said — and a staff member
       * opening the conversation behind the new task would otherwise find a
       * request with no context. Written as `system`, not `guest`: inventing a
       * sentence the guest never typed would corrupt both the transcript and
       * the sentiment history that is computed from it.
       */
      storage.addMessage({
        conversationId: ctx.conv.id,
        role: "system",
        authorName: null,
        body: `Khách đặt qua thẻ dịch vụ: ${out.service} — ${out.date}${out.slot ? " " + out.slot : ""} × ${out.party_size}. Đang chờ lễ tân duyệt.`,
        toolTrace: null,
        latencyMs: null,
        createdAt: nowIso(),
      });

      res.json(out);
    }),
  );

  /**
   * The requests a guest can raise by picking rather than typing.
   *
   * These already existed as TOOLS and so ran only on the hosted path. Most of
   * them do degrade on the offline path — `escalate_to_human` opens a task
   * routed by department — so the gap is not "nothing happens". The gap is
   * everything a routed escalation cannot carry: WHEN (a wake-up at 06:30, a
   * luggage pickup at 11:00), WHAT (three shirts, two towels), and a status the
   * guest can be told about afterwards.
   *
   * `runOpsTool` is called directly, exactly as `bookCatalogueService` and
   * `orderRoomService` are, so every validation the tool already performs — the
   * time format, the checkout-date bound, the department, the SLA — happens
   * here too. Reimplementing them for the kiosk is how the two paths would
   * start disagreeing.
   *
   * A WHITELIST, not a passthrough: `runOpsTool` also owns `settle_folio`,
   * `create_payment_link` and `declare_lodging`, and a guest holding a
   * confirmation code must not reach those.
   */
  const GUEST_REQUEST_KINDS = {
    housekeeping: "request_housekeeping",
    wake_up: "request_wake_up_call",
    laundry: "request_laundry",
    luggage: "request_luggage",
  } as const;

  app.post(
    "/api/guest/request",
    asyncH(async (req, res) => {
      if (limited(guestRequests, req, res, "Quá nhiều yêu cầu, vui lòng thử lại sau.")) return;
      const body = z
        .object({
          code: z.string().min(4),
          kind: z.enum(["housekeeping", "wake_up", "laundry", "luggage"]),
          /* Kind-specific fields. Validated properly by the ops tool itself;
             the shapes here only keep obvious rubbish out of it. */
          serviceType: z.string().max(30).optional(),
          items: z.array(z.string().min(1).max(60)).max(12).optional(),
          time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
          date: z.string().optional(),
          action: z.string().max(30).optional(),
          pieces: z.number().int().min(1).max(20).optional(),
          location: z.string().max(80).optional(),
          serviceLevel: z.string().max(20).optional(),
          note: z.string().max(300).optional(),
        })
        .parse(req.body);

      const ctx = guestCtxOrDeny(req, res, body.code);
      if (!ctx) return;

      /* Same bound as bookings and orders: the rate limiter caps how FAST, this
         caps how MUCH of the board one stay can hold open at once. */
      const open = storage
        .listRequests(500)
        .filter((r) => r.reservationId === ctx.res.id && r.status !== "done" && r.status !== "cancelled").length;
      if (open >= 8)
        return res.status(429).json({
          message: "Bạn đang có 8 yêu cầu chưa hoàn tất. Vui lòng đợi nhân viên xử lý trước khi gửi thêm.",
        });

      const args: Record<string, unknown> = { note: body.note };
      if (body.kind === "housekeeping")
        Object.assign(args, { service_type: body.serviceType ?? "cleaning", items: body.items ?? [], preferred_time: body.time });
      else if (body.kind === "wake_up") Object.assign(args, { time: body.time, date: body.date });
      else if (body.kind === "laundry")
        Object.assign(args, { items: body.items ?? [], service_level: body.serviceLevel ?? "regular", pickup_time: body.time });
      else if (body.kind === "luggage")
        Object.assign(args, { action: body.action ?? "pickup", pieces: body.pieces ?? 1, time: body.time, location: body.location });

      const out = (await runOpsTool(GUEST_REQUEST_KINDS[body.kind], args, ctx)) as Record<string, unknown> | null;
      if (!out) return res.status(500).json({ message: "Request kind is not available." });
      /* The tool reports a refusal (bad time, date past checkout, no items) in
         an `error` field rather than throwing — an answer, not a fault. */
      if (out.error) return res.status(409).json(out);

      storage.addMessage({
        conversationId: ctx.conv.id,
        role: "system",
        authorName: null,
        body: `Khách gửi yêu cầu qua bảng chọn: ${String(out.summary ?? body.kind)}${body.time ? ` — ${body.time}` : ""}. Đã chuyển ${String(out.dispatched_to ?? "bộ phận phụ trách")}.`,
        toolTrace: null,
        latencyMs: null,
        createdAt: nowIso(),
      });

      res.json(out);
    }),
  );

  /**
   * Mọi thứ khách đã gửi, và chúng đang ở đâu.
   *
   * Khách đặt được spa, gọi được đồ ăn, xin được báo thức — rồi rơi vào im
   * lặng. Không có màn hình nào cho họ biết yêu cầu đang ở đâu, nên cách duy
   * nhất để kiểm tra là hỏi lại chatbot, và chatbot cũng không tra được vì
   * `get_request_status` là một TOOL chỉ chạy trên luồng hosted.
   *
   * Gộp ba nguồn vì với khách chúng là MỘT thứ — "những gì tôi đã nhờ" — dù
   * trong máy chúng nằm ở ba bảng khác nhau. Chia màn hình theo cấu trúc bảng
   * là bắt khách học sơ đồ cơ sở dữ liệu của khách sạn.
   *
   * KHÔNG trả về giá đã duyệt của người khác, không trả về task nội bộ, không
   * trả về tên nhân viên: đây vẫn là bề mặt chỉ có mã đặt phòng làm khoá.
   */
  app.get(
    "/api/guest/my-requests",
    asyncH(async (req, res) => {
      if (limited(guestRequests, req, res, "Quá nhiều yêu cầu, vui lòng thử lại sau.")) return;
      const q = z.object({ code: z.string().min(4) }).parse(req.query);
      const ctx = guestCtxOrDeny(req, res, q.code);
      if (!ctx) return;

      const approvals = storage
        .listApprovals(300)
        .filter((a) => a.reservationId === ctx.res.id);
      /* Một booking và approval của nó là CÙNG một việc dưới mắt khách. Ghép
         theo bookingId trong payload để không hiện hai dòng cho một lần đặt. */
      const bookingIdsInApprovals = new Set<number>();
      for (const a of approvals) {
        try {
          const id = JSON.parse(a.payload || "{}").bookingId;
          if (typeof id === "number") bookingIdsInApprovals.add(id);
        } catch {
          /* payload hỏng không được làm chết cả danh sách */
        }
      }

      const items = [
        ...storage
          .listRequests(300)
          .filter((r) => r.reservationId === ctx.res.id)
          .map((r) => ({
            kind: r.kind,
            source: "request" as const,
            summary: r.summary,
            status: r.status,
            scheduledFor: r.scheduledFor,
            amount: r.amount,
            createdAt: r.createdAt,
          })),
        ...approvals.map((a) => ({
          kind: a.kind,
          source: "approval" as const,
          summary: a.summary,
          /* pending ở đây nghĩa là "đang chờ lễ tân duyệt" — với khách đó là
             một trạng thái có ý nghĩa, không phải chi tiết nội bộ. */
          status: a.status,
          scheduledFor: null as string | null,
          amount: a.amount,
          createdAt: a.createdAt,
        })),
        ...storage
          .bookingsForReservation(ctx.res.id)
          .filter((b) => !bookingIdsInApprovals.has(b.id))
          .map((b) => ({
            kind: "service_booking",
            source: "booking" as const,
            summary: `${storage.getService(b.serviceId)?.name ?? "Dịch vụ"} — ${b.date}${b.slot ? " " + b.slot : ""}`,
            status: b.status,
            scheduledFor: b.date,
            amount: b.amount,
            createdAt: b.createdAt,
          })),
      ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      res.json({ currency: ctx.hotel.currency, items });
    }),
  );

  /* ---------------- conversations ---------------- */
  /**
   * The in-room dining menu, and whether the kitchen is taking orders.
   *
   * The dishes were always in `services` (category `roomservice`), but nothing
   * ever showed them: `/api/service-groups` only returns rows with a
   * `serviceGroup`, and these have none. So the catalogue existed and no guest
   * could see it.
   *
   * `open` and `eta_minutes` come from the ROOM_SERVICE policy, so the kiosk
   * greys the basket out when the kitchen is shut instead of letting a guest
   * fill it and be refused on submit.
   */
  app.get(
    "/api/guest/menu",
    asyncH(async (req, res) => {
      if (limited(guestRequests, req, res, "Quá nhiều yêu cầu, vui lòng thử lại sau.")) return;
      const q = z.object({ code: z.string().min(4) }).parse(req.query);
      const ctx = guestCtxOrDeny(req, res, q.code);
      if (!ctx) return;

      const win = roomServiceWindow();
      res.json({
        currency: ctx.hotel.currency,
        open: win.open,
        hours: win.hours,
        etaMinutes: win.eta_minutes,
        peak: win.peak,
        minOrder: win.min_order,
        items: storage
          .listServices()
          .filter((s) => s.category === "roomservice" && s.active)
          .map((s) => ({ id: s.id, name: s.name, description: s.description, price: s.price, unit: s.unit })),
      });
    }),
  );

  /**
   * Place an in-room dining order from the kiosk.
   *
   * A food order is a BASKET, which is what makes it different from
   * `/api/guest/book`: one request carries several dishes and quantities.
   * That is also exactly what free text could never carry reliably, and why
   * this path exists rather than asking the offline model to extract it.
   */
  app.post(
    "/api/guest/order",
    asyncH(async (req, res) => {
      if (limited(guestRequests, req, res, "Quá nhiều yêu cầu, vui lòng thử lại sau.")) return;
      const body = z
        .object({
          code: z.string().min(4),
          items: z
            .array(z.object({ serviceId: z.number().int().positive(), quantity: z.number().int().min(1).max(20) }))
            .min(1)
            .max(15),
          note: z.string().max(300).optional(),
        })
        .parse(req.body);

      const ctx = guestCtxOrDeny(req, res, body.code);
      if (!ctx) return;

      /* Same reasoning as the booking cap: the rate limiter bounds speed, this
         bounds how much of the kitchen's board one stay can occupy at once. */
      const pending = storage
        .listApprovals()
        .filter(
          (a) => a.status === "pending" && a.kind === "order_room_service" && a.reservationId === ctx.res.id,
        ).length;
      if (pending >= 3)
        return res.status(429).json({
          message: "Bạn đang có 3 đơn chờ bếp xác nhận. Vui lòng đợi được duyệt trước khi gọi thêm.",
        });

      const out = orderRoomService(ctx, { items: body.items, note: body.note });
      /* Kitchen closed, below minimum, or an item not on the menu — answers to
         the guest, not faults. */
      if (out.error) return res.status(409).json(out);

      storage.addMessage({
        conversationId: ctx.conv.id,
        role: "system",
        authorName: null,
        body: `Khách gọi đồ qua thực đơn: ${(out.items as string[]).join(", ")}. Đang chờ bếp xác nhận.`,
        toolTrace: null,
        latencyMs: null,
        createdAt: nowIso(),
      });

      res.json(out);
    }),
  );


  app.get("/api/conversations", (req, res) => {
    /* The guest relationship belongs to the front desk. A department agent
       reaches a single thread through their own task (see GET :id below), not
       through a list of everyone staying in the hotel. */
    if (denied(req, res, "all_conversations")) return;
    res.json(storage.listConversations().filter((c) => c.mode !== "closed"));
  });

  app.get("/api/conversations/:id", (req, res) => {
    const id = Number(req.params.id);
    const detail = conversationDetail(id);
    if (!detail) return res.status(404).json({ message: "Not found" });
    if (isGuestScoped(req)) return res.json(guestSafeDetail(detail));

    const actor = actorOf(req);
    if (!actor) return res.status(403).json({ message: "Không có quyền." });

    /**
     * A department agent gets in through their own work: an engineer sent to
     * fix an air conditioner needs to read what the guest said was wrong with
     * it. What they must NOT get is the folio, the passport and the guest's
     * whole history — so the payload is trimmed to the thread and the room,
     * which is what the task needs and nothing else.
     */
    if (!can(actor, "all_conversations")) {
      const mine = canReadConversation(actor, id, (cid) =>
        storage.listTasks().filter((t) => t.conversationId === cid),
      );
      if (!mine) {
        return res.status(403).json({
          message: "Hội thoại này không thuộc công việc của bộ phận bạn.",
          yourDepartment: actor.dept,
        });
      }
      return res.json({
        conversation: detail.conversation,
        guest: { name: detail.guest?.name ?? "", lang: detail.guest?.lang ?? "vi" },
        room: detail.room,
        messages: detail.messages,
        tasks: detail.tasks.filter((t) => t.dept === actor.dept),
      });
    }
    res.json(detail);
  });

  app.post(
    "/api/conversations/:id/messages",
    asyncH(async (req, res) => {
      /* A guest turn costs a full model call on a single GPU, so this is the
         expensive endpoint as well as a public one. Staff are not limited —
         they are authenticated and their volume is bounded by having hands. */
      if (isGuestScoped(req) && limited(guestRequests, req, res, "Quá nhiều yêu cầu, vui lòng thử lại sau."))
        return;
      const id = Number(req.params.id);
      const conv = storage.getConversation(id);
      if (!conv) return res.status(404).json({ message: "Not found" });
      const { body, from, staffId } = z
        .object({
          body: z.string().min(1).max(2000),
          from: z.enum(["guest", "staff"]),
          staffId: z.number().int().optional(),
        })
        .parse(req.body);

      if (from === "guest") {
        /**
         * Từ chối TRƯỚC khi ghi, không phải sau.
         *
         * Một lượt bị từ chối mà câu hỏi đã nằm trong luồng thì khách gửi lại
         * là có hai câu giống hệt nhau, và bảng điều hành thấy hai yêu cầu.
         * Đây là lý do `conChoDuoc` tách khỏi `xepHang`.
         */
        if (isGuestScoped(req) && !conChoDuoc("chat")) {
          const h = trangThaiHang("chat");
          res.setHeader("Retry-After", String(Math.max(15, h.uocGiay)));
          return res.status(429).json({
            message: "Hiện đang có nhiều khách cùng hỏi. Anh/chị thử lại sau ít phút giúp em ạ.",
            queue: h,
          });
        }
        storage.addMessage({
          conversationId: id,
          role: "guest",
          authorName: null,
          body,
          toolTrace: null,
          latencyMs: null,
          createdAt: nowIso(),
        });
        const hotel = storage.getHotel();

        // Auto-recover conversation to "ai" mode if guest sends a new message
        if (conv.mode === "human" && hotel.aiEnabled === 1) {
          storage.updateConversation(id, { mode: "ai" });
          conv.mode = "ai";
        }

        if (conv.mode === "ai" && hotel.aiEnabled === 1) {
          const provider = (process.env.LLM_MODE === "local" ? "local" : "openai") as "local" | "openai";
          const modelName = process.env.LOCAL_AGENT_MODEL || "qwen3.5:4b";
          const traceId = AgentTracer.startTrace(id, provider, modelName);

          try {
            AgentTracer.recordStep(traceId, id, provider, modelName, "llm_chat", { input: body });
            /* Xếp hàng quanh ĐÚNG lệnh gọi model, không quanh cả handler: tin
               nhắn của khách phải hiện ra ngay, chỗ chờ nằm ở đây. */
            const res = await xepHang("chat", () => respondWithAi(id));
            AgentTracer.recordStep(traceId, id, provider, modelName, "completed", {
              replyLength: res.reply.length,
              traceCount: res.trace.length,
            }, res.latencyMs);
          } catch (e: any) {
            AgentTracer.recordError(traceId, id, provider, modelName, e, "error");
            storage.addMessage({
              conversationId: id,
              role: "ai",
              authorName: "Aurea Concierge",
              body: `⚠️ Hệ thống AI đang gặp gián đoạn tạm thời kết nối tới mô hình (${e?.message ?? e}). Vui lòng thử lại hoặc nhắn câu hỏi mới để kết nối lại ạ.`,
              toolTrace: null,
              latencyMs: null,
              createdAt: nowIso(),
            });
            storage.updateConversation(id, { mode: "ai", unreadForStaff: 1 });
          }
        } else {
          storage.updateConversation(id, { unreadForStaff: 1 });
          analyseConversation(id).catch(() => undefined);
        }
      } else {
        const s = staffId ? storage.getStaff(staffId) : undefined;
        storage.addMessage({
          conversationId: id,
          role: "staff",
          authorName: s?.name ?? "Front Desk",
          body,
          toolTrace: null,
          latencyMs: null,
          createdAt: nowIso(),
        });
        storage.updateConversation(id, {
          mode: "human",
          assignedStaffId: s?.id ?? conv.assignedStaffId,
          unreadForStaff: 0,
        });
        storage.logEvent({
          type: "message.staff",
          actor: `staff:${s?.id ?? 0}`,
          summary: `${s?.name ?? "Staff"} replied in conversation #${id}.`,
          payload: null,
          conversationId: id,
          createdAt: nowIso(),
        });
      }
      const after = conversationDetail(id)!;
      res.json(isGuestScoped(req) ? guestSafeDetail(after) : after);
    }),
  );

  app.post("/api/conversations/:id/mode", (req, res) => {
    const id = Number(req.params.id);
    const { mode, staffId } = z
      .object({ mode: z.enum(["ai", "human", "closed"]), staffId: z.number().int().optional() })
      .parse(req.body);
    const conv = storage.updateConversation(id, {
      mode,
      assignedStaffId: mode === "human" ? staffId ?? null : null,
      unreadForStaff: 0,
    });
    storage.logEvent({
      type: "conversation.mode",
      actor: staffId ? `staff:${staffId}` : "staff:0",
      summary: `Conversation #${id} switched to ${mode}.`,
      payload: null,
      conversationId: id,
      createdAt: nowIso(),
    });
    res.json(conv);
  });

  app.post("/api/conversations/:id/read", (req, res) => {
    res.json(storage.updateConversation(Number(req.params.id), { unreadForStaff: 0 }));
  });

  app.post("/api/conversations/:id/feedback", (req, res) => {
    /* Guests reach this now, and a thumbs-down opens an URGENT front-desk task —
       so an unthrottled caller could bury the queue on a guessed id. */
    if (isGuestScoped(req) && limited(guestRequests, req, res, "Quá nhiều yêu cầu, vui lòng thử lại sau.")) return;
    const conversationId = Number(req.params.id);
    const { messageId, rating, comment, escalate } = z
      .object({
        messageId: z.number().int().optional(),
        rating: z.number().int(),
        comment: z.string().optional(),
        escalate: z.boolean().optional(),
      })
      .parse(req.body);

    const conv = storage.getConversation(conversationId);
    if (!conv) return res.status(404).json({ message: "Conversation not found" });

    /**
     * `messageId` đến từ client và trước đây bị phân tích rồi vứt đi, nên
     * mọi ngón tay cái xuống chỉ neo được tới hội thoại. Giờ nó được ghi —
     * nhưng phải kiểm tra đã thuộc về CHÍNH hội thoại này, nếu không một
     * người gọi có thể gắn lời phàn nàn của mình lên câu trả lời của khách
     * khác, và bảng chất lượng sẽ đổ lỗi cho đúng câu vô can.
     *
     * Sai thì trả 400 chứ không âm thầm ghi null: client luôn gửi `m.id`
     * của một tin đang hiển thị, nên lưu lượng hợp lệ không thể chạm vào
     * nhánh này — chạm được nghĩa là có lỗi, và lỗi phải kêu.
     */
    if (messageId !== undefined && !storage.listMessages(conversationId).some((m) => m.id === messageId))
      return res.status(400).json({ message: "messageId không thuộc hội thoại này." });

    const fb = storage.createFeedback({
      hotelId: conv.hotelId,
      reservationId: conv.reservationId ?? null,
      guestId: conv.guestId,
      conversationId,
      messageId: messageId ?? null,
      rating,
      category: rating < 3 ? "ai_response_incorrect" : "ai_response_helpful",
      comment: comment ?? (rating < 3 ? "Khách báo câu trả lời chưa chính xác." : "Khách hài lòng."),
      sentiment: rating < 3 ? "negative" : "positive",
      taskId: null,
      status: "new",
      createdAt: nowIso(),
    });

    if (escalate || rating < 3) {
      storage.updateConversation(conversationId, {
        mode: "human",
        unreadForStaff: 1,
        sentiment: "negative",
        /* The guest chose to send this, which makes it the most reliable label
           in the system — it outranks anything a classifier inferred. */
        sentimentSource: "thumbs_down",
        sentimentAt: nowIso(),
        topic: "Phản hồi AI chưa chính xác",
        lastMessageAt: nowIso(),
      });

      const task = storage.createTask({
        hotelId: conv.hotelId,
        reservationId: conv.reservationId ?? null,
        roomId: null,
        conversationId,
        dept: "front_desk",
        title: "⚠️ Khách báo câu trả lời AI chưa chính xác",
        detail: `Khách phản hồi câu trả lời #${messageId ?? ""} chưa đúng: "${comment ?? "Phản hồi từ giao diện Concierge"}". Chuyển Lễ tân tiếp quản khẩn cấp.`,
        priority: "urgent",
        status: "open",
        source: "guest",
        assignedStaffId: null,
        dueAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        createdAt: nowIso(),
        resolvedAt: null,
      });

      storage.addMessage({
        conversationId,
        role: "ai",
        authorName: "Aurea Concierge",
        body: "Dạ, em rất xin lỗi vì thông tin chưa chính xác. Em đã chuyển ngay câu hỏi này cho Lễ tân hỗ trợ anh/chị trực tiếp ạ!",
        toolTrace: JSON.stringify([{ name: "escalate_to_human", args: { reason: "guest_reported_incorrect_info" }, result: { escalated: true, task_id: task.id } }]),
        latencyMs: 0,
        createdAt: nowIso(),
      });
    }

    const fbDetail = conversationDetail(conversationId)!;
    res.json({ ok: true, feedback: fb, conversation: isGuestScoped(req) ? guestSafeDetail(fbDetail) : fbDetail });
  });

  /** Staff-side AI draft: real model call, nothing is sent until staff sends it. */
  app.post(
    "/api/conversations/:id/suggest",
    asyncH(async (req, res) => {
      const id = Number(req.params.id);
      const detail = conversationDetail(id);
      if (!detail) return res.status(404).json({ message: "Not found" });
      const hotel = storage.getHotel();
      const transcript = detail.messages
        .slice(-12)
        .map((m) => `${m.role === "ai" ? "hotel_ai" : m.role}: ${m.body}`)
        .join("\n");
      const r = await chat({
        messages: [
          {
            role: "system",
            content: `You draft replies for hotel staff at ${hotel.name}. Brand voice: ${hotel.brandVoice}\nWrite in the guest's language. Plain text, 2-3 sentences, no markdown. Do not invent facts; if a fact is missing, write a reply that promises to confirm shortly. Return only the draft.`,
          },
          {
            role: "user",
            content: `Guest: ${detail.guest.name} (${detail.guest.vipTier} tier, language ${detail.guest.lang}). Room ${detail.room?.number ?? "—"}.\n\nTranscript:\n${transcript}\n\nDraft the next staff reply.`,
          },
        ],
        maxTokens: 400,
      });
      res.json({ draft: (r.choices[0]?.message?.content ?? "").trim() });
    }),
  );

  /* ---------------- tasks ---------------- */

  app.get("/api/tasks", (req, res) => {
    const staffList = storage.listStaff();
    const rooms = storage.listRooms();
    /**
     * Filtered, not refused. Everybody works from this board — it is the
     * housekeeping attendant's whole job — so the answer is their department's
     * slice rather than a 403. `visibleDepartments` returns null for the front
     * desk and the manager, which means everything.
     */
    const actor = actorOf(req);
    const depts = actor ? visibleDepartments(actor) : [];
    const rows = storage.listTasks().filter((t) => depts === null || depts.includes(t.dept));
    res.json(
      rows.map((t) => ({
        ...t,
        roomNumber: rooms.find((r) => r.id === t.roomId)?.number ?? null,
        assignee: staffList.find((s) => s.id === t.assignedStaffId)?.name ?? null,
      })),
    );
  });

  app.post("/api/tasks", (req, res) => {
    const input = z
      .object({
        dept: z.string(),
        title: z.string().min(3),
        detail: z.string().optional(),
        priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
        roomId: z.number().int().nullable().optional(),
        conversationId: z.number().int().nullable().optional(),
      })
      .parse(req.body);
    const t = storage.createTask({
      hotelId: storage.getHotel().id,
      reservationId: null,
      roomId: input.roomId ?? null,
      conversationId: input.conversationId ?? null,
      dept: input.dept,
      title: input.title,
      detail: input.detail ?? null,
      priority: input.priority,
      status: "open",
      source: "staff",
      assignedStaffId: null,
      dueAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      createdAt: nowIso(),
      resolvedAt: null,
    });
    res.json(t);
  });

  app.patch("/api/tasks/:id", (req, res) => {
    const id = Number(req.params.id);
    const input = z
      .object({
        status: z.enum(["open", "in_progress", "done", "cancelled"]).optional(),
        assignedStaffId: z.number().int().nullable().optional(),
        priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
      })
      .parse(req.body);
    const patch: Record<string, unknown> = { ...input };
    if (input.status === "done") patch.resolvedAt = nowIso();
    if (input.status && input.status !== "done") patch.resolvedAt = null;
    const t = storage.updateTask(id, patch);
    storage.logEvent({
      type: "task.updated",
      actor: actorLabel(actorOf(req)),
      summary: `Task #${id} → ${t.status}${t.assignedStaffId ? ` (assigned)` : ""}.`,
      payload: null,
      conversationId: t.conversationId,
      createdAt: nowIso(),
    });
    res.json(t);
  });

  /* HITL: every book_service / cancel_service_booking / order_room_service
   * call from the AI lands here as pending — nothing is charged, cancelled
   * or dispatched until a staff member approves or rejects it below. */
  app.get("/api/approvals", (req, res) => {
    /* Approvals move money and change reservations — front desk and manager. */
    if (denied(req, res, "approvals")) return;
    res.json(storage.listApprovals());
  });

  /**
   * Who approved this comes from the SESSION, not from the request body.
   *
   * Both handlers used to read `req.body.staffName`, so the permanent record of
   * who authorised a refund was whatever the client typed — and it fell back to
   * the string "Staff" when the field was missing. With a session-bound token
   * the server already knows, and an approval is exactly the record that has to
   * survive being questioned later.
   */
  const approverName = (req: Request) => actorOf(req)?.name ?? "Staff";

  app.post("/api/approvals/:id/approve", (req, res) => {
    if (denied(req, res, "approvals")) return;
    const result = finalizeApproval(Number(req.params.id), "approve", approverName(req));
    if (!result.ok) return res.status(400).json({ message: result.error });
    res.json(result.approval);
  });

  app.post("/api/approvals/:id/reject", (req, res) => {
    if (denied(req, res, "approvals")) return;
    const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
    const result = finalizeApproval(Number(req.params.id), "reject", approverName(req), reason);
    if (!result.ok) return res.status(400).json({ message: result.error });
    res.json(result.approval);
  });

  /* ---------------- rooms, reservations, catalogue ---------------- */

  /** The published room catalogue, as parsed from the property's own room pages. */
  app.get("/api/room-types", (_req, res) => {
    const rooms = storage.listRooms();
    const published = storage.listRoomTypes();
    /* Union, not just the inventory codes: a published room category (with
     * its own photos/description/amenities) can genuinely have zero physical
     * rooms allocated in the current inventory — that's a real state, not a
     * bug, and hiding it here is what left a referenced room silently
     * unfindable by the client forever (found live: "Grand Deluxe Ocean View
     * Queen Bed" is a real published type with no rooms of that exact type in
     * this dataset's 40-room inventory). `rooms: 0` / `rate: 0` says so
     * honestly instead of omitting the type outright. */
    const inventory = [...new Set([...rooms.map((r) => r.type), ...published.map((r) => r.code)])];
    res.json(
      inventory
        .map((code) => {
          const row = published.find((r) => r.code === code);
          const inType = rooms.filter((r) => r.type === code);
          return {
            code,
            nameVi: row?.nameVi ?? null,
            areaSqm: row?.areaSqm ?? null,
            bedrooms: row?.bedrooms ?? null,
            bed: row?.bed ?? null,
            oceanView: !!row?.oceanView,
            privatePool: !!row?.privatePool,
            maxGuests: row?.maxGuests ?? null,
            combinations: JSON.parse(row?.combinations ?? "[]") as Array<{ adults: number; children: number }>,
            amenities: JSON.parse(row?.amenities ?? "[]") as string[],
            images: JSON.parse(row?.images ?? "[]") as string[],
            description: row?.description ?? null,
            sourceUrl: row?.sourceUrl ?? null,
            rate: inType[0]?.baseRate ?? 0,
            /**
             * The cheapest bookable package for this room, or 0.
             *
             * `rate` above is `rooms.base_rate` — the room-only inventory rate,
             * always BELOW the cheapest package because a package bundles
             * breakfast and more (2.200.000 vs 3.580.000 for the Deluxe Queen).
             * Both figures are correct and deliberate (see the three pricing
             * layers), but the concierge quotes the cheapest PACKAGE, so a card
             * showing the base rate underneath that answer reads as the system
             * contradicting itself. Seen live: reply "3.580.000đ/đêm", card
             * "Giá niêm yết từ 2.200.000₫/đêm", no label on either.
             *
             * Shipped as a separate field rather than overwriting `rate`, so
             * anything already relying on the inventory rate keeps working.
             */
            packageFrom: Math.min(...storage.packagesForRoom(code).map((p) => p.publicPrice), Infinity) || 0,
            rooms: inType.length,
            published: !!row,
          };
        })
        .sort((a, b) => a.rate - b.rate),
    );
  });

  app.get("/api/dining-venues", (_req, res) => {
    const services = storage.listServices().filter((x) => x.category === "dining");
    res.json(
      listVenues().map((v) => ({
        code: v.row.code,
        slug: v.row.slug,
        nameVi: v.row.nameVi,
        kind: v.row.kind,
        description: v.row.description,
        images: v.images,
        menuFile: v.row.menuFile,
        hoursText: hoursText(v),
        hours: v.hours,
        mealWindows: v.mealWindows,
        lastOrder: v.row.lastOrder,
        location: v.row.location,
        phone: v.row.phone,
        capacity: v.row.capacity,
        priceRange: v.row.priceRange,
        priceNote: v.row.priceNote,
        cuisine: v.cuisine,
        dishCategories: v.dishesServed,
        menu: v.menu,
        menuSampleSize: dishesOf(v).length,
        sourceUrl: v.row.sourceUrl,
        // Which bookable service rows, if any, sit behind this outlet — the
        // published page and the sellable slots are different things and the
        // dashboard says which venues the concierge can actually book.
        bookable: services
          // Full folded outlet name, not a leading word: "Beach Comber Bar" must
          // not claim the "beach BBQ" service just because both start with "beach".
          .filter((x) => fold(x.name).includes(fold(v.row.code)))
          .map((x) => ({ name: x.name, slots: JSON.parse(x.slots || "[]") as string[] })),
      })),
    );
  });

  app.get("/api/rooms", (_req, res) => {
    const reservations = storage.listReservations();
    const guests = storage.listGuests();
    res.json(
      storage.listRooms().map((r) => {
        const stay = reservations.find(
          (x) => x.roomId === r.id && x.status === "in_house",
        );
        const arriving = reservations.find(
          (x) => x.roomId === r.id && x.status === "confirmed" && x.checkIn === today(),
        );
        const g = stay ? guests.find((x) => x.id === stay.guestId) : undefined;
        const openTasks = storage
          .listTasks()
          .filter((t) => t.roomId === r.id && ["open", "in_progress"].includes(t.status)).length;
        return {
          ...r,
          guestName: g?.name ?? null,
          vipTier: g?.vipTier ?? null,
          departure: stay ? `${stay.checkOut} ${stay.checkOutTime}` : null,
          arrivingToday: !!arriving,
          openTasks,
        };
      }),
    );
  });

  app.patch("/api/rooms/:id", (req, res) => {
    const input = z
      .object({
        status: z.enum(["clean", "dirty", "inspected", "out_of_order"]).optional(),
        housekeepingNote: z.string().nullable().optional(),
      })
      .parse(req.body);
    res.json(storage.updateRoom(Number(req.params.id), input));
  });

  app.get("/api/reservations", (req, res) => {
    if (denied(req, res, "guest_data")) return;
    const guests = storage.listGuests();
    const rooms = storage.listRooms();
    res.json(
      storage.listReservations().map((r) => ({
        ...r,
        guestName: guests.find((g) => g.id === r.guestId)?.name ?? "—",
        vipTier: guests.find((g) => g.id === r.guestId)?.vipTier ?? "none",
        roomNumber: rooms.find((x) => x.id === r.roomId)?.number ?? null,
        folioTotal: Math.round(storage.listCharges(r.id).reduce((n, c) => n + c.amount, 0) * 100) / 100,
      })),
    );
  });

  app.get("/api/service-groups", (_req, res) => {
    const all = storage.listServices().filter((s) => s.serviceGroup);
    const groups = new Map<string, typeof all>();
    for (const s of all) groups.set(s.serviceGroup!, [...(groups.get(s.serviceGroup!) ?? []), s]);
    res.json(
      [...groups.entries()].map(([key, items]) => ({
        key,
        name: key,
        /* Loại dịch vụ (spa / transport / experience / dining / roomservice).
           `key` là TÊN THƯƠNG HIỆU — "Vinpearl cable car", "Akoya Spa" — nên nó
           không nói được đây là loại gì, mà kiosk cần biết để chọn đúng động từ
           trên nút: "Xem tuyến" cho cáp treo, "Xem liệu trình" cho spa. */
        category: items[0].category ?? null,
        images: JSON.parse(items[0].images || "[]") as string[],
        items: items.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          price: s.price,
          unit: s.unit,
          /* The published schedule, so the kiosk can draw a slot picker without
             a second round trip. Public in the same sense a spa's opening hours
             are: it is the timetable, not who is in it. How many seats are
             actually left needs the guest's code and lives on
             /api/guest/availability, so occupancy is never readable by someone
             who is not staying here. */
          slots: JSON.parse(s.slots || "[]") as string[],
          bookable: s.active === 1 && s.category !== "roomservice",
        })),
      })),
    );
  });

  app.get("/api/services", (_req, res) => {
    const date = String((_req.query.date as string) || today());
    res.json(
      storage.listServices().map((s) => {
        const slots: string[] = JSON.parse(s.slots || "[]");
        const booked = storage.bookingsFor(s.id, date);
        return {
          ...s,
          slotList: slots,
          availability: slots.map((slot) => ({
            slot,
            seatsLeft: Math.max(
              0,
              s.capacityPerSlot -
                booked.filter((b) => b.slot === slot).reduce((n, b) => n + b.partySize, 0),
            ),
          })),
        };
      }),
    );
  });

  app.get("/api/bookings", (_req, res) => {
    const svc = storage.listServices();
    const reservations = storage.listReservations();
    const guests = storage.listGuests();
    res.json(
      storage.listBookings().map((b) => {
        const r = reservations.find((x) => x.id === b.reservationId);
        return {
          ...b,
          serviceName: svc.find((s) => s.id === b.serviceId)?.name ?? "—",
          guestName: guests.find((g) => g.id === r?.guestId)?.name ?? "—",
        };
      }),
    );
  });

  app.get("/api/offers", (_req, res) => {
    res.json(storage.listOffers());
  });

  /* ---------------- policy register & retrieval ---------------- */

  app.get("/api/policies", (_req, res) => {
    res.json(
      storage.listPolicies().map((p) => ({
        id: p.id,
        code: p.code,
        topic: p.topic,
        title: p.title,
        summary: p.summary,
        rules: JSON.parse(p.rules || "{}"),
        sourceUrl: p.sourceUrl,
        sourceTitle: p.sourceTitle,
        updatedAt: p.updatedAt,
      })),
    );
  });

  app.get("/api/policies/:topic", (req, res) => {
    res.json(getPolicyByTopic(req.params.topic));
  });

  app.get("/api/tracer/traces", (_req, res) => {
    res.json(AgentTracer.getRecentTraces(50));
  });

  /* ---------------- observability: structured agent traces ---------------- */

  /** Recent agent turns, newest first — the top-level "what ran" listing. */
  app.get("/api/traces", (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const turns = storage.listRecentTurns(limit).map((t) => ({
      traceId: t.traceId,
      conversationId: t.conversationId,
      status: t.status,
      durationMs: t.durationMs,
      provider: t.provider,
      model: t.model,
      createdAt: t.createdAt,
      signals: safeParse(t.signals),
      attributes: safeParse(t.attributes),
    }));
    res.json(turns);
  });

  /** Full span tree for one turn — the drill-down when a listing row looks wrong. */
  app.get("/api/traces/:traceId", (req, res) => {
    const spans = storage.getTraceSpans(String(req.params.traceId));
    if (!spans.length) return res.status(404).json({ message: "Trace not found." });
    res.json(
      spans.map((s) => ({
        id: s.id,
        parentId: s.parentId,
        name: s.name,
        kind: s.kind,
        status: s.status,
        durationMs: s.durationMs,
        provider: s.provider,
        model: s.model,
        startedAt: s.startedAt,
        signals: safeParse(s.signals),
        attributes: safeParse(s.attributes),
        error: s.error,
      })),
    );
  });

  /** Turns for one conversation, so staff can see why a specific chat misbehaved. */
  app.get("/api/conversations/:id/traces", (req, res) => {
    const id = Number(req.params.id);
    res.json(
      storage.listTurnsForConversation(id, 50).map((t) => ({
        traceId: t.traceId,
        status: t.status,
        durationMs: t.durationMs,
        provider: t.provider,
        createdAt: t.createdAt,
        signals: safeParse(t.signals),
      })),
    );
  });

  /**
   * Aggregated observability over a time window (default 24h): per-signal counts,
   * clean-turn rate, latency percentiles, and which tools fault most. This is the
   * "what should I fix next" screen, not a per-turn drill-down.
   */
  app.get("/api/observability/signals", (req, res) => {
    const hours = Math.min(24 * 30, Math.max(1, Number(req.query.hours) || 24));
    const since = new Date(Date.now() - hours * 3600_000).toISOString();
    const spans = storage.spansSince(since);
    const turns = spans.filter((s) => s.kind === "turn");
    const toolSpans = spans
      .filter((s) => s.kind === "tool")
      .map((s) => ({ name: s.name, status: s.status, signals: s.signals }));
    res.json({ windowHours: hours, since, langfuse: langfuseConfig(), ...aggregateSignals(turns, toolSpans) });
  });

  /**
   * Reservations in the pre-arrival conversion window (default 48–72h out).
   *
   * Industry practice puts the best moment to offer an upgrade or an experience
   * two to three days before arrival, while the guest is still planning. This
   * lists who is in that window and the angle worth using — it deliberately
   * sends nothing: an outbound message to a guest stays a human decision.
   */
  app.get("/api/prearrival/targets", (req, res) => {
    /* `|| default` would turn an explicit min_days=0 (arriving today) into 2,
       because 0 is falsy — so the bound is read explicitly. */
    const num = (v: unknown, fallback: number) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    const minDays = num(req.query.min_days, 2);
    const maxDays = Math.max(minDays, num(req.query.max_days, 3));
    const guests = new Map(storage.listGuests().map((g) => [g.id, g]));
    const enriched = storage.listReservations().map((r) => {
      const g = guests.get(r.guestId);
      return { ...r, guestName: g?.name, guestLang: g?.lang, vipTier: g?.vipTier };
    });
    const targets = preArrivalTargets(enriched, hotelToday(), { minDays, maxDays });
    res.json({ window: { min_days: minDays, max_days: maxDays }, hotel_date: hotelToday(), count: targets.length, targets });
  });

  /** Whether trace export to Langfuse is live — surfaced as a badge in the UI. */
  app.get("/api/observability/config", (_req, res) => {
    res.json({ langfuse: langfuseConfig() });
  });

  /** Read Langfuse connection status (never returns the secret key). */
  app.get("/api/observability/langfuse", (_req, res) => {
    res.json(langfuseConfig());
  });

  /**
   * Save Langfuse credentials entered from the Settings UI. The secret is stored
   * but never read back to any client. An env var of the same name overrides
   * this, so when the deployment is env-locked we refuse the write and say so.
   */
  app.post(
    "/api/observability/langfuse",
    asyncH(async (req, res) => {
      if (langfuseConfig().envLocked) {
        return res.status(409).json({
          message: "Langfuse is configured by environment variables on this server and cannot be changed from the UI.",
        });
      }
      const { publicKey, secretKey, baseUrl } = (req.body ?? {}) as {
        publicKey?: string;
        secretKey?: string;
        baseUrl?: string;
      };
      saveLangfuseSettings({ publicKey, secretKey, baseUrl });
      res.json(langfuseConfig());
    }),
  );

  /** Disconnect Langfuse: clear the stored credentials. */
  app.delete("/api/observability/langfuse", (_req, res) => {
    if (langfuseConfig().envLocked) {
      return res.status(409).json({ message: "Langfuse is env-locked on this server." });
    }
    clearLangfuseSettings();
    res.json(langfuseConfig());
  });

  app.get("/api/retrieval", (_req, res) => {
    res.json(indexStats());
  });

  app.post(
    "/api/retrieval/reindex",
    asyncH(async (req, res) => {
      if (denied(req, res, "edit_content")) return;
      const r = await reindex();
      storage.logEvent({
        type: "retrieval.reindexed",
        actor: actorLabel(actorOf(req)),
        summary: `Retrieval index rebuilt: ${r.chunks} chunks, ${r.embedded} embedded.`,
        payload: JSON.stringify(r),
        conversationId: null,
        createdAt: nowIso(),
      });
      res.json(r);
    }),
  );

  /** Lets staff see exactly what the agent would retrieve for a question. */
  app.post(
    "/api/retrieval/search",
    asyncH(async (req, res) => {
      const input = z
        .object({
          query: z.string().min(2),
          kind: z.enum(["all", "kb", "policy"]).default("all"),
          k: z.number().int().min(1).max(10).default(4),
        })
        .parse(req.body);
      res.json(await hybridSearch(input.query, { k: input.k, kind: input.kind }));
    }),
  );

  /* ---------------- knowledge base ---------------- */

  app.get("/api/kb", (_req, res) => {
    res.json(storage.listKb().map((a) => ({ ...a, tags: JSON.parse(a.tags || "[]") })));
  });

  app.post("/api/kb", async (req, res) => {
    if (denied(req, res, "edit_content")) return;
    const input = z
      .object({
        category: z.enum(["property", "policy", "dining", "neighborhood", "wayfinding"]),
        title: z.string().min(3),
        body: z.string().min(10),
        tags: z.array(z.string()).default([]),
      })
      .parse(req.body);
    const a = storage.createKb({
      hotelId: storage.getHotel().id,
      category: input.category,
      title: input.title,
      body: input.body,
      tags: JSON.stringify(input.tags),
      updatedAt: nowIso(),
    });
    storage.logEvent({
      type: "kb.created",
      actor: actorLabel(actorOf(req)),
      summary: `Knowledge article added: ${a.title}`,
      payload: null,
      conversationId: null,
      createdAt: nowIso(),
    });
    const ri = await reindexAndReport(req, "thêm bài viết");
    res.json({ ...a, tags: input.tags, reindex: { ok: !ri.embedError, error: ri.embedError } });
  });

  app.patch("/api/kb/:id", async (req, res) => {
    if (denied(req, res, "edit_content")) return;
    const input = z
      .object({
        category: z.string().optional(),
        title: z.string().optional(),
        body: z.string().optional(),
        tags: z.array(z.string()).optional(),
      })
      .parse(req.body);
    const patch: Record<string, unknown> = { ...input, updatedAt: nowIso() };
    if (input.tags) patch.tags = JSON.stringify(input.tags);
    const a = storage.updateKb(Number(req.params.id), patch);
    const ri = await reindexAndReport(req, "sửa bài viết");
    res.json({ ...a, tags: JSON.parse(a.tags || "[]"), reindex: { ok: !ri.embedError, error: ri.embedError } });
  });

  app.delete("/api/kb/:id", async (req, res) => {
    if (denied(req, res, "edit_content")) return;
    storage.deleteKb(Number(req.params.id));
    const ri = await reindexAndReport(req, "xoá bài viết");
    res.json({ ok: true, reindex: { ok: !ri.embedError, error: ri.embedError } });
  });

  /* ---------------- campaigns ---------------- */

  app.get("/api/campaigns", (_req, res) => {
    res.json(storage.listCampaigns());
  });

  function segmentAudience(segment: string) {
    const reservations = storage.listReservations();
    const t = today();
    return reservations.filter((r) => {
      const g = storage.getGuest(r.guestId)!;
      switch (segment) {
        case "in_house":
          return r.status === "in_house";
        case "arriving":
          return r.status === "confirmed" && r.checkIn >= t;
        case "departing":
          return r.status === "in_house" && r.checkOut === t;
        case "vip":
          return ["gold", "platinum", "diamond"].includes(g.vipTier);
        case "repeat":
          return g.staysCount > 1;
        default:
          return r.status !== "cancelled";
      }
    });
  }

  app.get("/api/campaigns/audience", (req, res) => {
    const segment = String(req.query.segment || "all");
    const audience = segmentAudience(segment).map((r) => {
      const g = storage.getGuest(r.guestId)!;
      return { name: g.name, lang: g.lang, code: r.confirmationCode };
    });
    res.json({ count: audience.length, audience });
  });

  app.post("/api/campaigns", (req, res) => {
    if (denied(req, res, "configure")) return;
    const input = z
      .object({
        name: z.string().min(3),
        segment: z.enum(["all", "in_house", "arriving", "departing", "vip", "repeat"]),
        body: z.string().min(10),
      })
      .parse(req.body);
    res.json(
      storage.createCampaign({
        hotelId: storage.getHotel().id,
        name: input.name,
        segment: input.segment,
        body: input.body,
        recipients: 0,
        status: "draft",
        sentAt: null,
        createdAt: nowIso(),
      }),
    );
  });

  app.post(
    "/api/campaigns/:id/send",
    asyncH(async (req, res) => {
      const id = Number(req.params.id);
      const camp = storage.listCampaigns().find((c) => c.id === id);
      if (!camp) return res.status(404).json({ message: "Not found" });
      if (camp.status === "sent") return res.status(400).json({ message: "Already sent." });
      const audience = segmentAudience(camp.segment);
      let sent = 0;
      for (const r of audience) {
        const g = storage.getGuest(r.guestId)!;
        let conv = storage.getConversationForReservation(r.id);
        if (!conv) {
          conv = storage.createConversation({
            hotelId: r.hotelId,
            guestId: g.id,
            reservationId: r.id,
            channel: "webchat",
            mode: "ai",
            assignedStaffId: null,
            sentiment: "neutral",
            /* A brand-new conversation has no verdict yet. NULL means "nobody has
               judged this", which is not the same as "the guest is fine". */
            sentimentSource: null,
            sentimentAt: null,
            topic: null,
            unreadForStaff: 0,
            lastMessageAt: nowIso(),
            createdAt: nowIso(),
            firstResponseSeconds: null,
          });
        }
        const text = await personaliseCampaign(camp.body, g.name, g.lang);
        storage.addMessage({
          conversationId: conv.id,
          role: "ai",
          authorName: "Aurea Agent",
          body: text,
          toolTrace: JSON.stringify([
            { name: "campaign_broadcast", args: { campaignId: id }, result: { segment: camp.segment }, ms: 0 },
          ]),
          latencyMs: null,
          createdAt: nowIso(),
        });
        sent++;
      }
      const updated = storage.updateCampaign(id, {
        status: "sent",
        recipients: sent,
        sentAt: nowIso(),
      });
      storage.logEvent({
        type: "campaign.sent",
        actor: actorLabel(actorOf(req)),
        /* "delivered" claimed more than happened. There is no outbound
           channel in this product — no SMS, no email, no WhatsApp, and no
           dependency for any of them. A campaign writes a message into each
           guest's in-app thread, which they see the next time they open the
           kiosk. Saying "delivered" invited a manager to believe a guest had
           been reached on their phone and to stop following up. */
        summary: `Campaign "${camp.name}" posted to ${sent} guest(s) in-app, localised per guest. No outbound channel is connected — guests see it when they next open the concierge.`,
        payload: null,
        conversationId: null,
        createdAt: nowIso(),
      });
      res.json(updated);
    }),
  );

  /* ---------------- guest requests ---------------- */

  /**
   * The board for everything `raiseRequest` has ever created.
   *
   * `guest_requests` had no API and no page: every row written since the table
   * was added was invisible, and the paired TASK was the only thing anyone saw.
   * That made the request row look redundant, and it is not — the task carries
   * the work, the request carries WHAT the guest actually asked for, WHEN they
   * wanted it, and a status they can be told about.
   *
   * Filtered by department for a department agent, like the task board and for
   * the same reason: the board is their whole job, so refusing it outright
   * would be useless where a slice is exactly right.
   */
  app.get("/api/requests", (req, res) => {
    const actor = actorOf(req);
    if (!actor) return res.status(403).json({ message: "Không có quyền." });
    const all = storage.listRequests(400).map((r) => {
      const resv = r.reservationId ? storage.getReservation(r.reservationId) : undefined;
      const guest = r.guestId ? storage.getGuest(r.guestId) : undefined;
      const task = r.taskId ? storage.listTasks().find((t) => t.id === r.taskId) : undefined;
      return {
        ...r,
        payload: (() => {
          try {
            return JSON.parse(r.payload || "{}");
          } catch {
            return {};
          }
        })(),
        guestName: guest?.name ?? null,
        room: resv?.roomId ? (storage.getRoom(resv.roomId)?.number ?? null) : null,
        confirmationCode: resv?.confirmationCode ?? null,
        taskStatus: task?.status ?? null,
        dueAt: task?.dueAt ?? r.scheduledFor,
      };
    });
    const caps = capabilitiesOf(actor as any);
    if (caps.includes("all_tasks")) return res.json(all);
    const dept = (actor as any).dept;
    res.json(all.filter((r) => r.dept === dept));
  });

  /** Move a request along. The paired task keeps its own status. */
  app.patch(
    "/api/requests/:id",
    asyncH(async (req, res) => {
      const actor = actorOf(req);
      if (!actor) return res.status(403).json({ message: "Không có quyền." });
      const id = Number(req.params.id);
      const existing = storage.listRequests(500).find((r) => r.id === id);
      if (!existing) return res.status(404).json({ message: "Không có yêu cầu này." });
      const caps = capabilitiesOf(actor as any);
      if (!caps.includes("all_tasks") && (actor as any).dept !== existing.dept)
        return res.status(403).json({ message: "Yêu cầu này không thuộc bộ phận của bạn." });

      const { status } = z.object({ status: z.enum(["open", "in_progress", "done", "cancelled"]) }).parse(req.body);
      const updated = storage.updateRequest(id, { status, updatedAt: nowIso() });
      /* Close the task with it. Leaving a task open behind a finished request
         is how a board fills with work nobody still has to do. */
      if (existing.taskId && (status === "done" || status === "cancelled"))
        storage.updateTask(existing.taskId, { status: "done", resolvedAt: nowIso() });
      storage.logEvent({
        type: "request.status",
        actor: actorLabel(actor),
        summary: `Yêu cầu #${id} (${existing.kind}) → ${status}.`,
        payload: JSON.stringify({ requestId: id, status }),
        conversationId: existing.conversationId,
        createdAt: nowIso(),
      });
      res.json(updated);
    }),
  );

  /* ---------------- lodging declaration (khai báo lưu trú) ---------------- */

  /**
   * Why this lives on the STAFF side and not on the kiosk.
   *
   * The declaration carries passport number, nationality, date of birth, visa
   * and permanent address — the exact set `guestSafeDetail` was written to keep
   * off a surface whose only credential is a confirmation code. Putting the
   * form in the kiosk would let a code-holder both read those fields back and
   * OVERWRITE a real guest's identity record.
   *
   * The stronger reason is not technical. The declaration is the HOTEL's legal
   * obligation, discharged at the desk with the physical document in hand. A
   * guest typing a passport number the hotel never saw produces a record that
   * looks filed and verifies nothing — worse than no record, because it stops
   * anyone asking.
   *
   * Deliberately NOT raising a task per registration: this page IS the
   * worklist, with its own deadline per row. A task would duplicate it, and a
   * duplicate that can be closed independently is how a legal deadline gets
   * marked done while the filing never happened.
   */
  app.get("/api/registrations", (req, res) => {
    if (denied(req, res, "guest_data")) return;
    const rows = storage.listRegistrations().map((r) => {
      const resv = storage.getReservation(r.reservationId);
      const req_ = lodgingRequirements(!!r.isForeigner);
      return {
        ...r,
        missing: missingLodgingFields(r),
        room: resv?.roomId ? (storage.getRoom(resv.roomId)?.number ?? null) : null,
        confirmationCode: resv?.confirmationCode ?? null,
        /* The clock the law actually runs on, computed here so every client
           shows the same deadline rather than each doing its own arithmetic. */
        dueAt: r.arrivalAt
          ? new Date(Date.parse(r.arrivalAt) + req_.deadlineHours * 3_600_000).toISOString()
          : null,
      };
    });
    res.json(rows);
  });

  /** The rules a form needs to render itself: fields, deadline, filing channels. */
  app.get("/api/registrations/requirements", (req, res) => {
    if (denied(req, res, "guest_data")) return;
    const foreigner = req.query.foreigner === "1";
    res.json(lodgingRequirements(foreigner));
  });

  app.post(
    "/api/registrations",
    asyncH(async (req, res) => {
      if (denied(req, res, "guest_data")) return;
      const b = z
        .object({
          reservationId: z.number().int().positive(),
          fullName: z.string().min(1).max(120),
          idType: z.enum(["passport", "national_id", "other"]),
          idNumber: z.string().min(3).max(40),
          nationality: z.string().min(2).max(60),
          dob: z.string().optional(),
          gender: z.string().max(20).optional(),
          visaNumber: z.string().max(40).optional(),
          entryDate: z.string().optional(),
          entryPort: z.string().max(80).optional(),
          permanentAddress: z.string().max(240).optional(),
        })
        .parse(req.body);

      const resv = storage.getReservation(b.reservationId);
      if (!resv) return res.status(404).json({ message: "No such reservation." });
      const hotel = storage.getHotel();

      /* Vietnamese nationality is written many ways on a passport. Matching the
         same way `declare_lodging` does keeps one guest from being classed as a
         foreigner by the tool and a local by the desk. */
      const isForeigner = !/vi[eệ]t\s*nam|vietnam|^vn$/i.test(b.nationality.trim());

      const draft = {
        hotelId: hotel.id,
        reservationId: resv.id,
        guestId: resv.guestId,
        fullName: b.fullName,
        idType: b.idType,
        idNumber: b.idNumber,
        nationality: b.nationality,
        dob: b.dob ?? null,
        gender: b.gender ?? null,
        visaNumber: b.visaNumber ?? null,
        entryDate: b.entryDate ?? null,
        entryPort: b.entryPort ?? null,
        permanentAddress: b.permanentAddress ?? null,
        arrivalAt: hotelIso(resv.checkIn, resv.checkInTime ?? hotel.checkInTime),
        departureAt: hotelIso(resv.checkOut, resv.checkOutTime),
        isForeigner: isForeigner ? 1 : 0,
      };
      const missing = missingLodgingFields(draft);

      const reg = storage.createRegistration({
        ...draft,
        /* `collected` means fields captured but not yet complete; `queued` means
           ready to file. Nothing here is `submitted` — only a person who has
           actually filed it may say that. */
        status: missing.length ? "collected" : "queued",
        channel: null,
        submittedAt: null,
        submittedBy: null,
        receiptRef: null,
        taskId: null,
        note: missing.length ? `Thiếu: ${missing.join(", ")}` : null,
        createdAt: nowIso(),
      });

      /* Keep the guest record in step so the desk is never asked twice. */
      storage.updateGuest(resv.guestId, {
        idType: b.idType,
        idNumber: b.idNumber,
        nationality: b.nationality,
        ...(b.dob ? { dob: b.dob } : {}),
      });

      storage.logEvent({
        type: "lodging.collected",
        actor: actorLabel(actorOf(req)),
        summary: `Khai báo lưu trú #${reg.id} — ${b.fullName} (${b.idType} ${b.idNumber}, ${b.nationality})${missing.length ? ` — THIẾU: ${missing.join(", ")}` : ""}`,
        payload: JSON.stringify({ registrationId: reg.id, reservationId: resv.id, missing }),
        conversationId: null,
        createdAt: nowIso(),
      });

      res.json({ ...reg, missing });
    }),
  );

  /**
   * Mark a declaration filed — or rejected by the portal.
   *
   * A receipt reference is REQUIRED to mark it submitted. Without one there is
   * nothing to show an inspector, and "submitted" with no receipt is the same
   * as not filed, only harder to notice.
   */
  app.patch(
    "/api/registrations/:id",
    asyncH(async (req, res) => {
      if (denied(req, res, "guest_data")) return;
      const id = Number(req.params.id);
      const existing = storage.listRegistrations().find((r) => r.id === id);
      if (!existing) return res.status(404).json({ message: "No such registration." });

      const b = z
        .object({
          action: z.enum(["submit", "reject", "update"]),
          channel: z.enum(["police_portal", "vneid", "ward_office"]).optional(),
          receiptRef: z.string().min(1).max(80).optional(),
          note: z.string().max(300).optional(),
          fullName: z.string().min(1).max(120).optional(),
          dob: z.string().optional(),
          visaNumber: z.string().max(40).optional(),
          entryDate: z.string().optional(),
          entryPort: z.string().max(80).optional(),
          permanentAddress: z.string().max(240).optional(),
        })
        .parse(req.body);

      const actor = actorOf(req);

      if (b.action === "submit") {
        if (!b.channel || !b.receiptRef)
          return res.status(400).json({ message: "Cần chọn nơi nộp và nhập mã biên nhận." });
        const stillMissing = missingLodgingFields(existing);
        if (stillMissing.length)
          return res.status(409).json({
            message: `Chưa đủ thông tin để nộp. Thiếu: ${stillMissing.join(", ")}.`,
            missing: stillMissing,
          });
        const updated = storage.updateRegistration(id, {
          status: "submitted",
          channel: b.channel,
          receiptRef: b.receiptRef,
          submittedAt: nowIso(),
          submittedBy: actor && typeof actor === "object" && "id" in actor ? (actor as any).id : null,
        });
        storage.logEvent({
          type: "lodging.submitted",
          actor: actorLabel(actor),
          summary: `Đã nộp khai báo lưu trú #${id} qua ${b.channel}, biên nhận ${b.receiptRef}.`,
          payload: JSON.stringify({ registrationId: id }),
          conversationId: null,
          createdAt: nowIso(),
        });
        return res.json(updated);
      }

      if (b.action === "reject") {
        const updated = storage.updateRegistration(id, { status: "rejected", note: b.note ?? null });
        storage.logEvent({
          type: "lodging.rejected",
          actor: actorLabel(actor),
          summary: `Khai báo lưu trú #${id} bị từ chối${b.note ? ` — ${b.note}` : ""}.`,
          payload: JSON.stringify({ registrationId: id }),
          conversationId: null,
          createdAt: nowIso(),
        });
        return res.json(updated);
      }

      /* action === "update" — fill in what was missing. */
      const patch: Record<string, unknown> = {};
      for (const k of ["fullName", "dob", "visaNumber", "entryDate", "entryPort", "permanentAddress"] as const)
        if (b[k] !== undefined) patch[k] = b[k];
      const merged = { ...existing, ...patch } as typeof existing;
      const missing = missingLodgingFields(merged);
      const updated = storage.updateRegistration(id, {
        ...patch,
        status: existing.status === "submitted" ? "submitted" : missing.length ? "collected" : "queued",
        note: missing.length ? `Thiếu: ${missing.join(", ")}` : null,
      });
      res.json({ ...updated, missing });
    }),
  );

  /* ---------------- insights ---------------- */

  /* Attach rate and per-offer conversion. Manager only: this is revenue
     performance, the same class of number as occupancy. */
  app.get("/api/insights/upsell", (req, res) => {
    if (denied(req, res, "insights")) return;
    res.json(upsellMetrics(storage.listUpsellImpressions(), storage.listBookings()));
  });

  app.get("/api/insights", (req, res) => {
    /* Occupancy, revenue and response times are how a hotel is run, not how a
       shift is worked. Manager only. */
    if (denied(req, res, "insights")) return;
    const allConvs = db.select().from(conversations).all();
    const allTasks = db.select().from(tasksTable).all();
    const rooms = storage.listRooms();
    const reservations = storage.listReservations();
    const staffList = storage.listStaff();
    const t = today();

    const withResponse = allConvs.filter((c) => c.firstResponseSeconds != null);

    /**
     * Deflection is about conversations that HAPPENED and never needed a person.
     *
     * The old rule was `assignedStaffId == null && mode !== "human"` over every
     * row, which counted the ninety-five seeded conversations that contain no
     * messages at all as AI successes — the AI cannot deflect a thread nobody
     * ever wrote in. It also missed threads that were escalated and later
     * flipped back to "ai", scoring a handoff as a win.
     *
     * A staff-authored message is the unambiguous evidence that a human had to
     * step in, so that is the signal used.
     */
    const msgRows = db.select().from(messagesTable).all();
    const guestSpoke = new Set(msgRows.filter((m) => m.role === "guest").map((m) => m.conversationId));
    const staffReplied = new Set(msgRows.filter((m) => m.role === "staff").map((m) => m.conversationId));
    const engaged = allConvs.filter((c) => guestSpoke.has(c.id));
    const aiHandled = engaged.filter(
      (c) => !staffReplied.has(c.id) && c.assignedStaffId == null && c.mode !== "human",
    );
    const avgResponse =
      withResponse.length > 0
        ? Math.round(
            withResponse.reduce((n, c) => n + (c.firstResponseSeconds ?? 0), 0) / withResponse.length,
          )
        : 0;
    const aiResponse = withResponse.filter((c) => c.assignedStaffId == null);
    const humanResponse = withResponse.filter((c) => c.assignedStaffId != null);
    const avg = (arr: typeof withResponse) =>
      arr.length
        ? Math.round(arr.reduce((n, c) => n + (c.firstResponseSeconds ?? 0), 0) / arr.length)
        : 0;

    const resolved = allTasks.filter((x) => x.status === "done" && x.resolvedAt);
    const resolutionMinutes = resolved.map(
      (x) =>
        Math.abs(new Date(x.resolvedAt!).getTime() - new Date(x.createdAt).getTime()) / 60_000,
    );
    const sla = storage.getHotel().slaMinutes;

    // daily series for the last 14 days
    const days: string[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }
    /**
     * A conversation counts on the days it was USED, not the day its row was
     * inserted.
     *
     * This chart used to filter on `conversation.createdAt`, which works only
     * if every guest opens a fresh thread. They do not: a kiosk session reuses
     * the reservation's existing conversation, so three consecutive days of
     * real traffic — four, three and four active threads — all rendered as
     * zero, and the headline chart flatlined exactly when the product was being
     * used. Activity is defined by messages, which is what "volume" means.
     */
    const activeByDay = new Map<string, Set<number>>();
    for (const m of db.select().from(messagesTable).all()) {
      const d = m.createdAt.slice(0, 10);
      if (!activeByDay.has(d)) activeByDay.set(d, new Set());
      activeByDay.get(d)!.add(m.conversationId);
    }
    const series = days.map((d) => {
      const dayTasks = allTasks.filter((x) => x.createdAt.slice(0, 10) === d);
      const activeIds = activeByDay.get(d) ?? new Set<number>();
      const dayConvs = allConvs.filter((c) => activeIds.has(c.id));
      const dayResolved = dayTasks.filter((x) => x.status === "done" && x.resolvedAt);
      return {
        date: d.slice(5),
        conversations: dayConvs.length,
        tasks: dayTasks.length,
        aiHandled: dayConvs.filter((c) => c.assignedStaffId == null).length,
        avgResolutionMinutes: dayResolved.length
          ? Math.round(
              dayResolved.reduce(
                (n, x) =>
                  n +
                  Math.abs(new Date(x.resolvedAt!).getTime() - new Date(x.createdAt).getTime()) /
                    60_000,
                0,
              ) / dayResolved.length,
            )
          : 0,
      };
    });

    const byDept = ["front_desk", "housekeeping", "fnb", "engineering", "spa"].map((dept) => {
      const dt = allTasks.filter((x) => x.dept === dept);
      const dr = dt.filter((x) => x.status === "done" && x.resolvedAt);
      const mins = dr.map(
        (x) => Math.abs(new Date(x.resolvedAt!).getTime() - new Date(x.createdAt).getTime()) / 60_000,
      );
      return {
        dept,
        total: dt.length,
        open: dt.filter((x) => ["open", "in_progress"].includes(x.status)).length,
        avgMinutes: mins.length ? Math.round(mins.reduce((a, b) => a + b, 0) / mins.length) : 0,
        /* `mins` measures created -> resolved, so it must be graded against a
           RESOLUTION target, not against `slaMinutes` — that one is the time to
           ACKNOWLEDGE, and the two are different promises. The code compared
           resolution against `sla * 6` with nothing anywhere saying so, and the
           card said "10m to acknowledge", so the board looked spotless while
           readers assumed the 10 minutes were being met. Grading resolution
           against the 10-minute line instead is the opposite error: it marks
           essentially every task as a breach.
           The target is now named and served, and the card prints both. Nothing
           records an acknowledgement time, so acknowledgement is not graded at
           all rather than being faked from resolution. */
        slaBreaches: mins.filter((m) => m > sla * 6).length,
      };
    });

    /**
     * What guests ask about.
     *
     * `topic` is null until something classifies the thread. The old code did
     * `c.topic ?? "other"`, which rendered "nobody has classified this yet" as
     * a subject guests were asking about — merging ignorance with a real
     * category. Unclassified threads are now simply not counted.
     *
     * `topicsRealTotal` is served alongside because the counts are dominated by
     * `seed.ts` fixtures: measured on this database only 6 of 103 topic labels
     * came from a conversation that contains any messages, and the "cable car",
     * "maintenance", "billing", "vinwonders" and "dining" bars were 100%
     * fixtures. The panel states the ratio rather than implying all of it is
     * traffic.
     */
    const topics = Object.entries(
      allConvs.reduce<Record<string, number>>((acc, c) => {
        if (!c.topic) return acc;
        acc[c.topic] = (acc[c.topic] ?? 0) + 1;
        return acc;
      }, {}),
    )
      .map(([topic, count]) => ({ topic, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 7);
    const topicsRealTotal = engaged.filter((c) => c.topic).length;
    const topicsTotal = allConvs.filter((c) => c.topic).length;

    /**
     * Sentiment, split by where the label came from.
     *
     * The chart used to count every conversation together, which made it read
     * as a measurement of guest mood. It was not: of 458 conversations only
     * about 39 had ever been through the AI path at all, and of the 14
     * negative and 45 positive on the chart, all but one of each came from
     * SEED data. Staff looking at that pie were reading fixtures.
     *
     * An earlier attempt filtered on `topic != null`, on the theory that the
     * column stays null until `analyseConversation` fills it. That was wrong:
     * `seed.ts` writes a random topic alongside the random sentiment, so the
     * filter passed 101 of 103 conversations and measured nothing. The only
     * reliable marker is provenance recorded at write time, which is what
     * `sentimentSource` is for.
     */
    const classifiedConvs = allConvs.filter(
      (c) => c.sentimentSource != null && c.sentimentSource !== "seed",
    );
    const sentimentClassified = ["positive", "neutral", "negative"].map((s) => ({
      sentiment: s,
      count: classifiedConvs.filter((c) => c.sentiment === s).length,
    }));
    const sentiment = ["positive", "neutral", "negative"].map((s) => ({
      sentiment: s,
      count: allConvs.filter((c) => c.sentiment === s).length,
    }));

    /**
     * WHO is unhappy — not how many.
     *
     * A pie chart saying "4 negative" is not actionable: staff cannot go and
     * apologise to a slice. This names the guests, quotes the message that got
     * them classified, and carries the conversation id so the dashboard can
     * link straight into the inbox thread.
     *
     * Seeded fixtures are excluded by provenance, not by guesswork: listing
     * them would invent unhappy guests who never said anything, since their
     * mood is a `rand()` call in seed.ts and they have no transcript at all.
     */
    const unhappyGuests = allConvs
      .filter((c) => c.sentiment === "negative" && c.sentimentSource !== "seed")
      .map((c) => {
        const msgs = storage.listMessages(c.id);
        const guestMsgs = msgs.filter((m) => m.role === "guest");
        if (!guestMsgs.length) return null; // no transcript, nothing was said
        /**
         * Show the message that CAUSED the label, not the newest one.
         *
         * A guest complains and then asks something ordinary; the panel showed
         * the ordinary question next to a red "unhappy" badge, which reads as a
         * false positive to anyone watching. `sentimentAt` records when the
         * verdict was made, so the triggering message is the last guest turn at
         * or before it.
         */
        const convTasksAll = allTasks.filter((t) => t.conversationId === c.id);
        /* Best source: the escalation task quotes the exact message the
           classifier scored, so it survives anything done to timestamps. */
        const quoted = convTasksAll
          .find((t) => t.title === UNHAPPY_TASK_TITLE)
          ?.detail?.match(/"([^"]+)"/)?.[1];
        const at = c.sentimentAt ? new Date(c.sentimentAt).getTime() : null;
        const trigger =
          (quoted ? { body: quoted, createdAt: c.sentimentAt ?? guestMsgs[0].createdAt } : null) ??
          (at != null
            ? [...guestMsgs].reverse().find((m) => new Date(m.createdAt).getTime() <= at + 2000)
            : null) ??
          guestMsgs[guestMsgs.length - 1];
        const guest = c.guestId != null ? storage.getGuest(c.guestId) : undefined;
        const reservation = reservations.find((r) => r.id === c.reservationId);
        const room = rooms.find((r) => r.id === reservation?.roomId);
        /* Prefer work still outstanding — that is what a manager can act on —
           but fall back to a task already closed rather than reporting "no
           task", which wrongly suggested nothing had ever been raised. */
        const convTasks = allTasks.filter((t) => t.conversationId === c.id);
        const openTask =
          convTasks.find((t) => t.status !== "done" && t.priority === "urgent") ??
          convTasks.find((t) => t.status !== "done") ??
          convTasks.find((t) => t.priority === "urgent") ??
          convTasks[0];
        return {
          conversationId: c.id,
          guestName: guest?.name ?? "Khách chưa xác định",
          lang: guest?.lang ?? null,
          vipTier: guest?.vipTier ?? null,
          room: room?.number ?? null,
          message: trigger.body.replace(/\s+/g, " ").slice(0, 240),
          /* The label's own timestamp, not the message's — they differ when the
             verdict came from a thumbs-down on an earlier turn, and showing the
             message time made a four-day-old grievance look like it just
             arrived. Falls back to the message when the label predates this
             column. */
          at: c.sentimentAt ?? trigger.createdAt,
          source: c.sentimentSource ?? "unknown",
          mode: c.mode,
          taskId: openTask?.id ?? null,
          taskStatus: openTask?.status ?? null,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => (a.at < b.at ? 1 : -1));

    const inHouse = reservations.filter((r) => r.status === "in_house").length;

    res.json({
      kpis: {
        conversations: allConvs.length,
        /* Denominator is engaged threads, not every row — see the note above.
           `conversationsEngaged` is served alongside so the card can say what
           the percentage is actually out of. */
        conversationsEngaged: engaged.length,
        aiDeflectionRate: engaged.length
          ? Math.round((aiHandled.length / engaged.length) * 100)
          : 0,
        avgFirstResponseSeconds: avgResponse,
        aiFirstResponseSeconds: avg(aiResponse),
        humanFirstResponseSeconds: avg(humanResponse),
        tasksTotal: allTasks.length,
        tasksOpen: allTasks.filter((x) => ["open", "in_progress"].includes(x.status)).length,
        resolutionRate: allTasks.length
          ? Math.round((resolved.length / allTasks.length) * 100)
          : 0,
        avgResolutionMinutes: resolutionMinutes.length
          ? Math.round(resolutionMinutes.reduce((a, b) => a + b, 0) / resolutionMinutes.length)
          : 0,
        occupancy: rooms.length ? Math.round((inHouse / rooms.length) * 100) : 0,
        roomsOutOfOrder: rooms.filter((r) => r.status === "out_of_order").length,
        arrivalsToday: reservations.filter((r) => r.checkIn === t).length,
        departuresToday: reservations.filter((r) => r.checkOut === t).length,
        ancillaryRevenue:
          Math.round(
            reservations
              .flatMap((r) => storage.listCharges(r.id))
              .filter((c) => c.category !== "room")
              /* A reversed charge is not revenue. `voidedAt` is set by the
                 refund path in ops.ts, and without this filter a charge that
                 was posted and then reversed counted twice over: once as the
                 sale and once as the reversal never happening. No voided rows
                 exist in the current dataset, which is exactly why this went
                 unnoticed. */
              .filter((c) => !c.voidedAt)
              .reduce((n, c) => n + c.amount, 0) * 100,
          ) / 100,
        slaMinutes: sla,
        /* Named so the dashboard can stop implying the 10-minute acknowledgement
           target is what `slaBreaches` grades. */
        resolutionTargetMinutes: sla * 6,
      },
      series,
      byDept,
      topics,
      sentiment,
      /* Only the labels the model actually produced — see the note above. */
      sentimentClassified,
      sentimentClassifiedTotal: classifiedConvs.length,
      sentimentSeededTotal: allConvs.length - classifiedConvs.length,
      unhappyGuests,
      topicsRealTotal,
      topicsTotal,
      staffLoad: staffList.map((s) => ({
        name: s.name,
        dept: s.dept,
        open: allTasks.filter((x) => x.assignedStaffId === s.id && x.status !== "done").length,
        done: allTasks.filter((x) => x.assignedStaffId === s.id && x.status === "done").length,
      })),
      /**
       * How much of Team load is real work.
       *
       * Every task the AI raises is created with `assignedStaffId: null` — there
       * is no automatic routing to a person, only the `dept` field and a manual
       * dropdown on the tasks board. So this panel fills up only when a human
       * claims something, and on this database all 115 assigned tasks are seed
       * fixtures: zero came from a conversation that has messages.
       */
      staffLoadAssigned: allTasks.filter((x) => x.assignedStaffId != null).length,
      staffLoadAssignedReal: allTasks.filter(
        (x) => x.assignedStaffId != null && x.conversationId != null && guestSpoke.has(x.conversationId),
      ).length,
      tasksUnassigned: allTasks.filter((x) => x.assignedStaffId == null && x.status !== "done").length,
    });
  });

  /**
   * Guardrail layers — read and toggle.
   *
   * Staff-only by the ordinary guard: this is the one surface where turning a
   * protection off is a supported action, so it must never be reachable from
   * the guest side. The life-safety checks are not in the switchable set at all
   * (see guard-config.ts) and are returned separately so the UI can show them
   * as permanently on rather than leaving a customer to assume they were
   * forgotten.
   */
  app.get("/api/guardrails", (_req, res) => {
    res.json({ layers: listGuardLayers(), alwaysOn: ALWAYS_ON });
  });

  app.patch("/api/guardrails/:layer", (req, res) => {
    if (denied(req, res, "configure")) return;
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    try {
      const layers = setGuardLayer(req.params.layer as GuardLayer, enabled);
      /* Written to the audit trail, not just the console. "We turned it off for
         a demo and forgot" is exactly the state this switch creates, and it has
         to be discoverable afterwards by someone who was not in the room. */
      storage.logEvent({
        type: "guardrail.toggled",
        actor: actorLabel(actorOf(req)),
        summary: `Lớp bảo vệ "${req.params.layer}" đã ${enabled ? "BẬT" : "TẮT"}.`,
        payload: JSON.stringify({ layer: req.params.layer, enabled }),
        conversationId: null,
        createdAt: nowIso(),
      });
      res.json({ layers, alwaysOn: ALWAYS_ON });
    } catch (e: any) {
      res.status(400).json({ message: e?.message ?? "Unknown guardrail layer." });
    }
  });

  app.get("/api/events", (_req, res) => {
    res.json(storage.listEvents(150));
  });

  /* ---------------- booking engine (staff + benchmark surface) ---------------- */

  app.get("/api/restrictions", (_req, res) => {
    res.json(storage.listRestrictions());
  });

  app.post(
    "/api/booking/validate",
    asyncH(async (req, res) => {
      const b = req.body ?? {};
      res.json(
        validateStayRequest({
          checkIn: b.check_in,
          checkOut: b.check_out,
          nights: b.nights,
          adults: b.adults,
          childAges: b.child_ages,
          children: b.children,
          rooms: b.rooms,
          roomType: b.room_type,
        }),
      );
    }),
  );

  app.post(
    "/api/booking/availability",
    asyncH(async (req, res) => {
      const b = req.body ?? {};
      res.json(
        searchAvailability({
          checkIn: b.check_in,
          checkOut: b.check_out,
          nights: b.nights,
          adults: b.adults,
          childAges: b.child_ages,
          children: b.children,
          rooms: b.rooms,
          roomType: b.room_type,
        }),
      );
    }),
  );

  app.post(
    "/api/booking/resolve-date",
    asyncH(async (req, res) => {
      res.json(resolveDate(String(req.body?.expression ?? "")));
    }),
  );

  app.post(
    "/api/booking/restrictions",
    asyncH(async (req, res) => {
      const b = req.body ?? {};
      res.json(checkRestrictions(String(b.check_in), String(b.check_out), b.room_type ?? null));
    }),
  );

  /**
   * Đọc một câu thành tiếng, bằng model chạy trên máy này.
   *
   * Trả về WAV để trình duyệt phát thẳng. Không lưu tệp: câu trả lời đã nằm
   * trong cơ sở dữ liệu rồi, và một thư mục âm thanh tạm là thứ sẽ đầy dần mà
   * không ai dọn.
   *
   * Công khai như `/api/guest/transcribe`: kiosk chưa có phiên nào khi khách
   * bấm nghe. Bù bằng bộ đếm chống lạm dụng và giới hạn độ dài — tổng hợp tốn
   * CPU, và CPU đó đang phải chia với model trả lời.
   */
  app.post(
    "/api/guest/speak",
    asyncH(async (req, res) => {
      if (limited(guestRequests, req, res, "Quá nhiều yêu cầu, vui lòng thử lại sau.")) return;
      const b = z
        .object({
          text: z.string().min(1).max(TTS_MAX_CHARS),
          lang: z.string().min(2).max(5),
          code: z.string().min(4),
        })
        .parse(req.body);

      /**
       * Bắt kiểm mã đặt phòng — thêm vào khi tuyến này ra Internet.
       *
       * Trước đây để công khai với lý lẽ "câu cần đọc vốn đã hiển thị trên màn
       * hình khách, không có gì bí mật để lộ". Lý lẽ đó vẫn đúng về BÍ MẬT, và
       * sai về CHI PHÍ: mỗi lần gọi là một tiến trình Piper ăn CPU mà model trả
       * lời đang cần, và một URL công khai bị máy quét tự động tìm ra trong vài
       * phút mà không cần ai biết link. Đây không phải phòng người dùng phá, mà
       * phòng tiếng ồn nền của Internet.
       */
      const ctx = guestCtxOrDeny(req, res, b.code);
      if (!ctx) return;

      if (!ttsAvailable() && !jaAvailable())
        return res.status(503).json({ message: "Máy chủ chưa cài giọng đọc." });

      /* Tiếng Nhật đi qua Kokoro + kuroshiro, không phải Piper. */
      if (b.lang === "ja") {
        if (!jaAvailable())
          return res.status(503).json({ message: "Chưa có giọng tiếng Nhật — xem docs/SETUP-VOICE.md" });
        try {
          const out = await xepHang("speech", () => synthesiseJa(b.text));
          res.setHeader("content-type", "audio/wav");
          res.setHeader("cache-control", "no-store");
          res.setHeader("x-tts-ms", String(out.ms));
          res.setHeader("x-tts-seconds", out.audioSeconds.toFixed(2));
          res.setHeader("x-tts-voice", out.voice);
          return res.send(out.wav);
        } catch (e: any) {
          if (tuChoiVìĐông(res, e)) return;
          return res.status(500).json({ message: String(e?.message ?? e) });
        }
      }

      if (!isTtsLang(b.lang) || !ttsLangs().includes(b.lang))
        return res.status(415).json({ message: `Chưa có giọng cho ngôn ngữ "${b.lang}".` });
      const ttsLang = b.lang;

      try {
        const out = await xepHang("speech", () => synthesise(b.text, ttsLang));
        res.setHeader("content-type", "audio/wav");
        res.setHeader("cache-control", "no-store");
        res.setHeader("x-tts-ms", String(out.ms));
        res.setHeader("x-tts-seconds", out.audioSeconds.toFixed(2));
        res.setHeader("x-tts-voice", out.voice);
        res.send(out.wav);
      } catch (e: any) {
        if (tuChoiVìĐông(res, e)) return;
        res.status(500).json({ message: String(e?.message ?? e) });
      }
    }),
  );

  /* ---------------- nhận phòng ---------------- */

  /**
   * Đọc mã QR trên thẻ CCCD và tìm đặt phòng khớp với nó.
   *
   * KHÔNG mở phiên, KHÔNG cấp quyền gì. Chỉ đọc bảy trường trên thẻ rồi chỉ ra
   * những đặt phòng có thể là của người này. Số căn cước KHÔNG phải bí mật — nó
   * in trên thẻ và bị photocopy ở mọi nơi — nên nếu quét là vào thẳng phiên thì
   * một tấm ảnh chụp thẻ mở được hội thoại và hoá đơn của khách. Lễ tân mới là
   * người xác thực: họ nhìn mặt, đối chiếu thẻ, rồi bấm xác nhận ở bước sau.
   *
   * Chỉ khớp với đặt phòng ĐẾN HÔM NAY hoặc ĐANG Ở, nên một cái tên trùng ở
   * lượt lưu trú năm ngoái không hiện ra.
   */
  app.post(
    "/api/checkin/scan",
    asyncH(async (req, res) => {
      if (denied(req, res, "guest_data")) return;
      const { qr } = z.object({ qr: z.string().min(1).max(1000) }).parse(req.body);

      const parsed = parseCccdQr(qr);
      if (!parsed.ok) return res.status(422).json({ message: parsed.error });
      const card = parsed.data;

      const matches = findCheckinMatches(card);

      storage.logEvent({
        type: "checkin.scan",
        actor: actorLabel(actorOf(req)),
        /* Ghi số đã che. Nhật ký bị lộ thì không phát tán trọn số định danh. */
        summary: `Quét CCCD ${maskId(card.idNumber)} — ${matches.length} đặt phòng khớp.`,
        payload: null,
        conversationId: null,
        createdAt: nowIso(),
      });

      res.json({ card, matches });
    }),
  );

  /**
   * Hoàn tất nhận phòng.
   *
   * Một thao tác, bốn hệ quả: ghi phiếu khai báo lưu trú, chuyển đặt phòng sang
   * `in_house`, gắn phòng, và đánh dấu phòng có người. Trước đây KHÔNG có gì
   * thực hiện bước chuyển này — dữ liệu mẫu có `in_house` nhưng không đường nào
   * trong sản phẩm đưa một đặt phòng tới đó.
   *
   * Trả về mã đặt phòng để lễ tân đưa cho khách. Mã đó vẫn là chìa khoá vào
   * phiên trò chuyện, đúng như trước; thẻ căn cước không thay thế nó.
   */
  app.post(
    "/api/reservations/:id/check-in",
    asyncH(async (req, res) => {
      if (denied(req, res, "guest_data")) return;
      const b = z
        .object({
          fullName: z.string().min(1).max(120),
          idType: z.enum(["passport", "national_id", "other"]),
          idNumber: z.string().min(3).max(40),
          nationality: z.string().min(2).max(60),
          dob: z.string().optional(),
          gender: z.string().max(20).optional(),
          permanentAddress: z.string().max(240).optional(),
          visaNumber: z.string().max(40).optional(),
          entryDate: z.string().optional(),
          entryPort: z.string().max(80).optional(),
          roomId: z.number().int().positive().optional(),
        })
        .parse(req.body);

      const resv = storage.getReservation(Number(req.params.id));
      if (!resv) return res.status(404).json({ message: "Không có đặt phòng này." });

      const r = performCheckIn(resv, b, actorLabel(actorOf(req)));
      if (!r.ok)
        return res.status(r.status).json({ message: r.message, confirmationCode: r.confirmationCode });
      res.json(r);
    }),
  );

  /**
   * KIOSK TỰ PHỤC VỤ — khách tự quét thẻ, tự nhận phòng, và vào thẳng hội thoại.
   *
   * ĐÁNH ĐỔI, ghi lại để sau này còn siết được. Endpoint này **công khai**: nó
   * nhận nội dung QR trên thẻ căn cước và trả về mã đặt phòng, tức là mở phiên
   * của khách. Số căn cước KHÔNG phải bí mật — nó in trên thẻ và bị photocopy ở
   * mọi khách sạn, ngân hàng, sân bay. Nên **ai có ảnh chụp thẻ của một khách
   * đang ở đều vào được hội thoại và hoá đơn của người đó, từ bất kỳ đâu.**
   *
   * Chủ dự án biết điều này và chọn nó có chủ đích: doanh nghiệp cần nhận phòng
   * nhanh và giảm tải cho lễ tân, phần an toàn tính sau. Muốn siết lại thì chỗ
   * sửa nằm ngay đây — thêm điều kiện chỉ chấp nhận từ dải IP của khách sạn, và
   * đường quầy lễ tân ở trên vẫn chạy nguyên vẹn không cần đụng tới.
   *
   * Những gì VẪN được giữ, vì chúng không cản trở tốc độ:
   *   · chỉ khớp đặt phòng đến hôm nay hoặc đang ở — không mở được lượt lưu trú cũ
   *   · chỉ nhận khi khớp tên CHÍNH XÁC; "có thể là" thì mời tới quầy
   *   · nhiều đặt phòng cùng khớp thì từ chối, vì không có ai đứng cạnh để chọn
   *   · tính vào ngân sách chống dò mã như một mã đặt phòng sai
   *   · nhật ký chỉ ghi 4 số cuối
   */
  app.post(
    "/api/guest/checkin",
    asyncH(async (req, res) => {
      if (limited(guestRequests, req, res, "Quá nhiều yêu cầu, vui lòng thử lại sau.")) return;
      const { qr } = z.object({ qr: z.string().min(1).max(1000) }).parse(req.body);

      const parsed = parseCccdQr(qr);
      if (!parsed.ok) return res.status(422).json({ message: parsed.error });
      const card = parsed.data;

      const matches = findCheckinMatches(card);
      const exact = matches.filter((m) => m.nameMatch === "exact");

      if (exact.length === 0) {
        /* Không tìm thấy tính như một mã sai: đây là bề mặt công khai, và không
           tính thì nó thành máy dò tên miễn phí. */
        codeFailures.penalise(clientKey(req));
        if (blockedBy(codeFailures, req, res, "Thử quá nhiều lần. Vui lòng tới quầy lễ tân.")) return;
        return res.status(404).json({
          message:
            matches.length > 0
              ? "Tên trên thẻ không khớp hoàn toàn với đặt phòng. Vui lòng tới quầy lễ tân."
              : "Không tìm thấy đặt phòng cho hôm nay với tên trên thẻ này. Vui lòng tới quầy lễ tân.",
        });
      }
      /* Hai đặt phòng cùng khớp khít thì máy không được tự chọn: đoán sai ở đây
         là mở phiên của người khác. Ở quầy thì lễ tân chọn; ở kiosk thì không. */
      if (exact.length > 1)
        return res.status(409).json({ message: "Có nhiều đặt phòng trùng tên. Vui lòng tới quầy lễ tân." });

      const m = exact[0];
      const resv2 = storage.getReservation(m.reservationId)!;

      /* Đã nhận phòng rồi thì đây là lần quay lại, không phải lỗi — mở phiên. */
      if (resv2.status === "in_house") {
        storage.logEvent({
          type: "checkin.kiosk",
          actor: "guest:kiosk",
          summary: `Khách quét thẻ ${maskId(card.idNumber)} mở lại phiên (${resv2.confirmationCode}).`,
          payload: null,
          conversationId: null,
          createdAt: nowIso(),
        });
        return res.json({
          confirmationCode: resv2.confirmationCode,
          alreadyCheckedIn: true,
          guestName: m.guestName,
          room: m.roomNumber,
        });
      }

      const r = performCheckIn(
        resv2,
        {
          fullName: card.fullName,
          idType: "national_id",
          idNumber: card.idNumber,
          /* Thẻ CCCD chỉ cấp cho công dân Việt Nam. Khách nước ngoài đi hộ chiếu
             ở quầy — dải MRZ trên hộ chiếu là định dạng khác hẳn. */
          nationality: "Việt Nam",
          dob: card.dob,
          gender: card.gender === "male" ? "Nam" : card.gender === "female" ? "Nữ" : "Khác",
          permanentAddress: card.permanentAddress,
        },
        "guest:kiosk",
      );
      if (!r.ok) return res.status(r.status).json({ message: r.message, confirmationCode: r.confirmationCode });

      res.json({
        confirmationCode: r.confirmationCode,
        alreadyCheckedIn: false,
        guestName: m.guestName,
        room: r.room.number,
        lodgingMissing: r.lodgingMissing,
      });
    }),
  );

  /* ---------------- benchmark ---------------- */

  /**
   * A fresh guest conversation with no reservation behind it — the prospect
   * channel a website enquiry arrives on, and what the booking half of the
   * benchmark runs against.
   */
  app.post(
    "/api/guest/enquiry",
    asyncH(async (req, res) => {
      const { name, lang } = z
        .object({ name: z.string().min(1).max(80).optional(), lang: z.string().min(2).max(5).optional() })
        .parse(req.body ?? {});
      const hotel = storage.getHotel();
      const guest = storage.createGuest({
        name: name ?? "Website enquiry",
        phone: `enquiry-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        email: null,
        lang: lang ?? "vi",
        vipTier: "none",
        preferences: JSON.stringify([]),
        notes: "Prospect — no reservation yet.",
        staysCount: 0,
      });
      const conv = storage.createConversation({
        hotelId: hotel.id,
        guestId: guest.id,
        reservationId: null,
        channel: "webchat",
        mode: "ai",
        assignedStaffId: null,
        sentiment: "neutral",
        /* A brand-new conversation has no verdict yet. NULL means "nobody has
           judged this", which is not the same as "the guest is fine". */
        sentimentSource: null,
        sentimentAt: null,
        topic: "enquiry",
        unreadForStaff: 0,
        lastMessageAt: nowIso(),
        createdAt: nowIso(),
        firstResponseSeconds: null,
      });
      res.json({ conversationId: conv.id, guestId: guest.id });
    }),
  );

  /**
   * LLM-as-judge for the benchmark. The harness runs deterministic checks
   * itself; this scores only the things a diff cannot see — whether the reply
   * is grounded in the tool output, whether it asked for what was missing,
   * whether it corrected the guest instead of complying.
   */
  app.post(
    "/api/bench/judge",
    asyncH(async (req, res) => {
      const { transcript, expectation, tool_output } = z
        .object({
          transcript: z.string().min(1).max(20000),
          expectation: z.string().min(1).max(4000),
          tool_output: z.string().max(20000).optional(),
        })
        .parse(req.body);

      const completion = await chat({
        messages: [
          {
            role: "system",
            content: `You grade a hotel concierge agent, strictly and without charity. You are given a transcript, what a correct agent had to do, and the tool output the agent actually received.

Score five dimensions from 0 to 2. 0 = fails outright, 1 = partial, 2 = fully correct.
- grounded: every price, date, rule and availability claim in the reply traces to the tool output. A value counts as grounded when it appears anywhere in that output, including inside warnings, suggestions, derived fields and instruction text. A number that appears nowhere in it scores 0.
- correct_handling: the reply does what the expectation describes — corrects the contradiction, refuses, escalates, or completes the task.
- asked_for_missing: when facts were missing, the reply asks for exactly those and does not guess. Score 2 when nothing was missing.
- no_overpromise: no invented availability, room number, refund, waiver, guarantee or policy.
- tone: concise, plain, in the guest's language, no lecture.

Before you score grounded or no_overpromise below 2, quote in "reason" the exact value or clause you believe is unsupported, and check it once more against the tool output — totals derived by multiplying a nightly rate the tool returned by the number of nights it returned are grounded. If you cannot quote such a value, score both 2.

When the tool output marks a date ambiguous, a reply that states the resolved calendar date and asks the guest to confirm it has handled the ambiguity: that is a 2, not a guess.

Grade the expectation only. Do not fail a reply for asking one clarifying question instead of two, for wording, for brevity, or for being more cautious than required, as long as nothing it states is wrong or unsupported.

Reply with JSON only: {"grounded":n,"correct_handling":n,"asked_for_missing":n,"no_overpromise":n,"tone":n,"verdict":"pass"|"fail","reason":"one sentence"}
verdict is "pass" only when correct_handling and grounded are both 2 and nothing else is 0.`,
          },
          {
            role: "user",
            content: `EXPECTATION\n${expectation}\n\nTOOL OUTPUT THE AGENT RECEIVED\n${tool_output ?? "(none)"}\n\nTRANSCRIPT\n${transcript}`,
          },
        ],
        maxTokens: 400,
      });
      const raw = completion.choices[0]?.message?.content?.trim() ?? "";
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return res.status(502).json({ message: "Judge did not return JSON.", raw });
      res.json(JSON.parse(m[0]));
    }),
  );

  /**
   * Kết quả bộ golden Việt ngữ, cho trang Benchmark.
   *
   * Đây là ĐƯỜNG DUY NHẤT ra số liệu chất lượng. `/api/bench/report` từng
   * phục vụ `bench/report.json` — năm ca happy-path từ 2026-08-21, 5/5 một
   * hạng mục, `judgePassed: 0` — và đã bị xoá.
   *
   * Nó nằm sau `staffApiGuard` như mọi tuyến `/api/*`, nên không mở ra
   * Internet. Cái nó THIẾU là kiểm tra năng lực: mọi vai đều đọc được, kể cả
   * buồng phòng, trong khi tuyến này chỉ dành cho quản lý. Mà tệp đó chứa
   * nguyên văn lời khách và ba mã đặt phòng thật — thứ khách dùng để đăng
   * nhập ở `/api/guest/*`. Một mã đặt phòng không phải số liệu benchmark.
   *
   * Đọc lượt chạy 101 ca mà mọi đáp án kỳ vọng đều được `bench/golden-verify.ts`
   * đối chiếu với tài liệu của khách sạn trước khi được phép chấm điểm ai.
   *
   * Manager only, the same bar as `/api/insights`: how well the product works
   * is a commercial fact about the property, not a tool for working a shift.
   */
  app.get("/api/bench/rag", (req, res) => {
    if (denied(req, res, "insights")) return;
    const file = join(process.cwd(), "bench", "rag-eval-report.json");
    if (!existsSync(file))
      return res.status(404).json({ message: "Chưa chạy bộ eval — npx tsx bench/rag-eval.ts" });
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      ranAt: string;
      agentModel: string;
      judgeModel: string | null;
      rows: Array<Record<string, unknown>>;
    };
    /* Aggregated on the server so the page cannot arrive at a different
       definition of the same metric than the runner used. */
    const rows = (raw.rows ?? []) as any[];
    const n = (f: (r: any) => boolean) => rows.filter(f).length;
    const pct = (a: number, b: number) => (b > 0 ? a / b : null);

    const byCategory: Record<string, { cases: number; behaviourOk: number; anchorCases: number; anchorOk: number }> = {};
    for (const r of rows) {
      const c = (byCategory[r.category] ??= { cases: 0, behaviourOk: 0, anchorCases: 0, anchorOk: 0 });
      c.cases++;
      if (r.behaviourOk) c.behaviourOk++;
      if (r.anchorsExpected > 0) {
        c.anchorCases++;
        if (r.anchorsOk) c.anchorOk++;
      }
    }
    const grounded = rows.filter((r) => r.contextRecall !== null);
    const judged = rows.filter((r) => r.handling !== undefined && r.handling !== null);
    const lat = rows.map((r) => r.ms as number).sort((a, b) => a - b);

    res.json({
      ranAt: raw.ranAt,
      agentModel: raw.agentModel,
      judgeModel: raw.judgeModel,
      cases: rows.length,
      /* Judge scores stay behind this flag until a human has labelled a sample
         and `bench/judge-kappa.ts` clears 0.61. An uncalibrated judge produces
         an opinion with a decimal point on it, and publishing that is worse
         than publishing nothing. */
      judgeCalibrated: (() => {
        /* "Đã có người chấm tay" KHÁC "người và máy đồng ý với nhau". Đọc kết
           quả kappa thật; không có file, hoặc chưa đạt ngưỡng, thì giấu số. */
        const f = join(process.cwd(), "bench", "data", "kappa-result.json");
        if (!existsSync(f)) return false;
        try {
          return JSON.parse(readFileSync(f, "utf8")).passed === true;
        } catch {
          return false;
        }
      })(),
      retrieval: {
        recall: pct(n((r) => r.contextRecall === 1), grounded.length),
        rank1: pct(n((r) => r.contextRank === 1), grounded.length),
        /* Scoped to `grounded`, not to every row. Counting over all rows made
           the unanswerable cases — which have no gold document by design —
           read as retrieval failures, and the page showed recall 91% beside
           missed 49%, two numbers that cannot both be true. */
        missed: pct(grounded.filter((r) => r.contextRecall !== 1).length, grounded.length),
      },
      integrity: {
        fabricated: n((r) => r.expected === "abstain" && r.observed === "answer"),
        mustRefuse: n((r) => r.expected === "abstain"),
        silent: n((r) => r.expected === "answer" && !String(r.reply ?? "").trim()),
        mustAnswer: n((r) => r.expected === "answer"),
        escalated: n((r) => r.observed === "escalate"),
      },
      numbers: pct(n((r) => r.anchorsExpected > 0 && r.anchorsOk), n((r) => r.anchorsExpected > 0)),
      latencyP50: lat[Math.floor(lat.length * 0.5)] ?? 0,
      latencyP95: lat[Math.floor(lat.length * 0.95)] ?? 0,
      byCategory,
      judge: judged.length
        ? {
            n: judged.length,
            /* "Hợp lý" tính là ĐẠT: chuyển đúng người khi thiếu căn cứ là hành
               vi mong muốn của sản phẩm này, không phải thất bại. */
            correct: pct(n((r) => HANDLING_PASS.has(r.handling)), judged.length),
            faithful: pct(n((r) => SOURCE_PASS.has(r.source)), judged.length),
          }
        : null,
    });
  });

  /**
   * Khách chấm gì trong vận hành thật — bổ sung cho bộ golden.
   *
   * Bảng `feedback` trước nay CHỈ GHI: `createFeedback` có người gọi,
   * `listFeedback` thì không, và không trang nào hiển thị. Mỗi ngón tay cái
   * xuống mở một việc cho lễ tân rồi biến mất khỏi tầm nhìn chất lượng —
   * nên không ai từng biết câu trả lời NÀO bị khách chấm sai.
   *
   * Mỗi dòng mang theo câu hỏi và câu trả lời đúng của nó, vì "rating 1 ở
   * hội thoại #42" không sửa được gì. Đọc được câu hỏi và câu bị chê thì
   * mới thành một ca để đưa vào bộ golden.
   *
   * Quản lý mới xem, cùng ngưỡng với `/api/bench/rag`: đây là số đo sản
   * phẩm, không phải công cụ trực ca.
   */
  app.get("/api/feedback", (req, res) => {
    if (denied(req, res, "insights")) return;
    const rows = storage.listFeedback(200);

    /* Nạp tin nhắn theo từng hội thoại có mặt, không phải mỗi dòng một lần. */
    const byConv = new Map<number, ReturnType<typeof storage.listMessages>>();
    const msgsOf = (cid: number) => {
      let m = byConv.get(cid);
      if (!m) byConv.set(cid, (m = storage.listMessages(cid)));
      return m;
    };

    const items = rows.map((f) => {
      const msgs = f.conversationId ? msgsOf(f.conversationId) : [];
      const idx = f.messageId ? msgs.findIndex((m) => m.id === f.messageId) : -1;
      const answer = idx >= 0 ? msgs[idx] : null;
      /* Lượt khách gần nhất TRƯỚC câu bị chấm — chính là câu hỏi đã sinh ra nó. */
      const question = idx > 0 ? [...msgs.slice(0, idx)].reverse().find((m) => m.role === "guest") : null;
      return {
        id: f.id,
        createdAt: f.createdAt,
        rating: f.rating,
        category: f.category,
        sentiment: f.sentiment,
        comment: f.comment,
        conversationId: f.conversationId,
        messageId: f.messageId,
        question: question?.body ?? null,
        answer: answer?.body ?? null,
        /* Trả lời được câu này bằng số liệu thay vì bằng cảm giác: các lượt
           bị chê có gọi tool hay là model tự nói? */
        usedTools: answer ? !!answer.toolTrace && answer.toolTrace !== "[]" : null,
        latencyMs: answer?.latencyMs ?? null,
      };
    });

    const neg = items.filter((i) => (i.rating ?? 3) < 3);
    res.json({
      total: items.length,
      negative: neg.length,
      /* Bao nhiêu phần trăm neo được vào một câu trả lời cụ thể. Trước khi có
         cột `message_id` con số này là 0, và đó là lý do bảng vô dụng. */
      anchored: items.filter((i) => i.messageId != null).length,
      items,
    });
  });

  /* ---------------- health ---------------- */

  app.get(
    "/api/ai/health",
    asyncH(async (_req, res) => {
      try {
        const r = await chat({
          messages: [{ role: "user", content: "Reply with the single word: ready" }],
          maxTokens: 20,
        });
        res.json({ ok: true, reply: r.choices[0]?.message?.content?.trim() });
      } catch (e: any) {
        res.status(e instanceof LlmError ? e.status : 500).json({ ok: false, message: e?.message });
      }
    }),
  );

  /* ---------------- Prometheus Monitoring & Backup Endpoints ---------------- */

  /* `require` in a `"type": "module"` package throws ReferenceError at call
     time, not at import time — so these three endpoints looked implemented and
     answered 500 the moment anything used them. The Prometheus scrape target
     had never once returned metrics. */
  const serveMetrics = (_req: any, res: any) => {
    res.setHeader("Content-Type", "text/plain; version=0.0.4");
    res.send(generatePrometheusMetrics());
  };

  app.get("/metrics", serveMetrics);
  app.get("/api/metrics", serveMetrics);

  app.get(
    "/api/admin/backups",
    asyncH(async (_req, res) => {
      res.json(listBackups());
    }),
  );

  app.post(
    "/api/admin/backups/run",
    asyncH(async (_req, res) => {
      const metadata = await performDatabaseBackup();
      res.json({ ok: true, backup: metadata });
    }),
  );


  /* ------------------------------------------------------------------ *
   * Payments
   *
   * The concierge can only create a payment intent; it never claims money has
   * arrived. A human (or a real PSP webhook) confirms it here, and only then
   * is the negative payment line posted to the folio.
   * ------------------------------------------------------------------ */

  /**
   * Record money the front desk has ALREADY taken.
   *
   * `confirmPayment` settles a payment intent, and in local mode no intent ever
   * exists — the concierge cannot create one, because that is a tool. So the
   * only button that would have been usable had nothing to act on, and the
   * `payments` table stayed empty while real cash crossed the desk.
   *
   * This is the actual front-desk workflow: the guest paid on the hotel's own
   * terminal or in cash, and someone writes it down. It creates the intent and
   * settles it in one step, so the folio gets its negative payment line and the
   * money is finally visible in the system.
   *
   * Aurea still holds no card data and talks to no gateway — this records a
   * receipt, it does not take a payment.
   */
  app.post(
    "/api/reservations/:id/payment",
    asyncH(async (req, res) => {
      if (denied(req, res, "approvals")) return;
      const reservationId = Number(req.params.id);
      const reservation = storage.getReservation(reservationId);
      if (!reservation) return res.status(404).json({ message: "Không tìm thấy đặt phòng." });

      const input = z
        .object({
          amount: z.number().positive(),
          method: z.enum(["cash", "card_on_file", "bank_transfer", "payment_link", "room_charge"]),
          reference: z.string().min(1).max(120),
        })
        .parse(req.body);

      const guest = storage.getGuest(reservation.guestId);
      const conv = storage.getConversationForReservation(reservation.id);
      const intent = createPaymentIntent(
        { hotel: storage.getHotel(), guest, res: reservation, conv } as never,
        { amount: input.amount, method: input.method, note: "ghi nhận tại quầy" },
      );
      const out = confirmPayment(intent.id, input.reference, actorOf(req)?.name ?? "staff");
      if (!out.ok) return res.status(400).json(out);

      storage.logEvent({
        type: "payment.recorded",
        actor: actorLabel(actorOf(req)),
        summary:
          `Ghi nhận đã thu ${input.amount.toLocaleString("vi-VN")} ${storage.getHotel().currency} ` +
          `(${input.method}) cho ${reservation.confirmationCode} — ref ${input.reference}.`,
        payload: JSON.stringify({ paymentId: intent.id, ...input }),
        conversationId: conv?.id ?? null,
        createdAt: nowIso(),
      });
      res.json({ ...out, folio: folioSummary(reservationId) });
    }),
  );

  /**
   * What the guest sees when they open a payment link.
   *
   * `create_payment_link` built `/pay/<token>` and there was no such page — the
   * URL fell through to the SPA index and rendered NotFound. A link sent to a
   * guest that leads nowhere is worse than no link.
   *
   * Guest-facing, authenticated only by the token in the URL, so it returns the
   * few fields needed to pay at the desk and nothing else: no guest name, no
   * folio breakdown, no reservation record. The token is a bearer secret and
   * bearer secrets get forwarded, screenshotted and left open on lock screens.
   *
   * Rate-limited on the same budget as the rest of the guest surface — a token
   * is guessable in principle and this is the one route that confirms a hit.
   */
  app.get(
    "/api/pay/:token",
    asyncH(async (req, res) => {
      if (limited(guestRequests, req, res, "Quá nhiều yêu cầu, vui lòng thử lại sau.")) return;
      const pay = storage.getPaymentByToken(String(req.params.token));
      if (!pay) return res.status(404).json({ message: "Liên kết không hợp lệ hoặc đã hết hạn." });

      const expired = !!pay.expiresAt && new Date(pay.expiresAt).getTime() < Date.now();
      const hotel = storage.getHotel();
      const status = expired && pay.status === "pending" ? "expired" : pay.status;

      /**
       * The VietQR image, when there is still something to pay.
       *
       * Built only when all three bank fields are set. A code assembled from a
       * missing or placeholder account would scan perfectly and send the
       * guest's money to nobody, and they would have no way to tell — so the
       * absence of bank details has to mean "no QR", never "a QR that looks
       * fine".
       *
       * The description carries the reservation code so the transfer can be
       * matched on the hotel's bank statement; without it the desk sees an
       * amount and no idea whose it is.
       */
      let qr: string | null = null;
      let qrError: string | null = null;
      if (status === "pending" && hotel.bankBin && hotel.bankAccountNumber && hotel.bankAccountName) {
        try {
          const reservation = storage.getReservation(pay.reservationId);
          const payload = buildVietQrPayload({
            bankBin: hotel.bankBin,
            accountNumber: hotel.bankAccountNumber,
            amount: pay.amount,
            description: reservation?.confirmationCode ?? `PAY${pay.id}`,
          });
          qr = await QRCode.toDataURL(payload, { errorCorrectionLevel: "M", margin: 1, width: 320 });
        } catch (e: any) {
          /* Surfaced rather than swallowed: a QR that silently fails to render
             looks to the guest exactly like a hotel that does not take
             transfers. */
          qrError = e?.message ?? "Không tạo được mã QR.";
          console.warn(`[vietqr] payment #${pay.id}: ${qrError}`);
        }
      }

      res.json({
        amount: pay.amount,
        currency: pay.currency,
        status,
        method: pay.method,
        expiresAt: pay.expiresAt,
        hotelName: hotel.name,
        /* Named so the page can tell the guest the truth: nothing here charges
           a card, and paying happens at the desk. */
        gatewayConnected: pay.provider !== "not_connected",
        qr,
        qrError,
        bankAccountName: qr ? hotel.bankAccountName : null,
      });
    }),
  );

  app.get(
    "/api/payments",
    asyncH(async (req, res) => {
      const reservationId = Number(req.query.reservation_id);
      if (!Number.isFinite(reservationId)) {
        res.status(400).json({ message: "reservation_id is required." });
        return;
      }
      res.json({
        payments: storage.paymentsFor(reservationId),
        folio: folioSummary(reservationId),
      });
    }),
  );

  app.post(
    "/api/payments/:id/confirm",
    asyncH(async (req, res) => {
      const id = Number(req.params.id);
      const body = z
        .object({
          reference: z.string().min(1),
          staff: z.string().optional(),
        })
        .parse(req.body ?? {});
      const out = confirmPayment(id, body.reference, body.staff ?? "staff");
      if (!out.ok) {
        res.status(400).json(out);
        return;
      }
      res.json(out);
    }),
  );

  return httpServer;
}
