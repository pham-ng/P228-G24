import type { Express, Request, Response } from "express";
import type { Server } from "node:http";
import { storage, nowIso, db, hotelToday } from "./storage";
import { seedIfEmpty } from "./seed";
import { runAgent, analyseConversation, personaliseCampaign } from "./agent";
import { readGuestSentiment } from "./sentiment-net";
import { chat, LlmError } from "./openai";
import { reindex, indexStats, hybridSearch } from "./retrieval";
import { getPolicyByTopic } from "./policy";
import { confirmPayment, createPaymentIntent, ensureOpsPolicies, finalizeApproval } from "./ops";
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
import { aggregateSignals } from "./observability";
import { preArrivalTargets } from "./crosssell";
import { langfuseConfig, saveLangfuseSettings, clearLangfuseSettings } from "./langfuse";
import { ensurePricingPolicies, folioSummary } from "./pricing";
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


const asyncH =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response) =>
    fn(req, res).catch((e: any) => {
      const status = e instanceof LlmError ? e.status : 500;
      console.error("[api]", e?.message ?? e);
      res.status(status).json({ message: e?.message ?? "Internal error" });
    });

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
    messages,
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
    /* This lists every guest's name, tier, room number and dates. It exists
     * for the demo's room-picker only, so it is off unless explicitly enabled
     * and never available in production. */
    if (process.env.NODE_ENV === "production" && process.env.EXPOSE_GUEST_KEYS !== "1") {
      res.status(404).json({ message: "Not found." });
      return;
    }
    if (process.env.EXPOSE_GUEST_KEYS === "0") {
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

  /* ---------------- conversations ---------------- */

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
            const res = await respondWithAi(id);
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

    const fb = storage.createFeedback({
      hotelId: conv.hotelId,
      reservationId: conv.reservationId ?? null,
      guestId: conv.guestId,
      conversationId,
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
        images: JSON.parse(items[0].images || "[]") as string[],
        items: items.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          price: s.price,
          unit: s.unit,
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

  app.post("/api/kb", (req, res) => {
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
    void reindex().catch(() => {});
    res.json({ ...a, tags: input.tags });
  });

  app.patch("/api/kb/:id", (req, res) => {
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
    void reindex().catch(() => {});
    res.json({ ...a, tags: JSON.parse(a.tags || "[]") });
  });

  app.delete("/api/kb/:id", (req, res) => {
    if (denied(req, res, "edit_content")) return;
    storage.deleteKb(Number(req.params.id));
    void reindex().catch(() => {});
    res.json({ ok: true });
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
        summary: `Campaign "${camp.name}" delivered to ${sent} guest(s), localised per guest.`,
        payload: null,
        conversationId: null,
        createdAt: nowIso(),
      });
      res.json(updated);
    }),
  );

  /* ---------------- insights ---------------- */

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

  /** The last benchmark run, as written to disk by bench/run.mjs. */
  app.get("/api/bench/report", (_req, res) => {
    const file = join(process.cwd(), "bench", "report.json");
    if (!existsSync(file)) return res.status(404).json({ message: "No benchmark has been run yet." });
    res.json(JSON.parse(readFileSync(file, "utf8")));
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
