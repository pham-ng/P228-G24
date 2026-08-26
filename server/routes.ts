import type { Express, Request, Response } from "express";
import type { Server } from "node:http";
import { storage, nowIso, db, hotelToday } from "./storage";
import { seedIfEmpty } from "./seed";
import { runAgent, analyseConversation, personaliseCampaign } from "./agent";
import { chat, LlmError } from "./openai";
import { reindex, indexStats, hybridSearch } from "./retrieval";
import { getPolicyByTopic } from "./policy";
import { confirmPayment, ensureOpsPolicies, finalizeApproval } from "./ops";
import { AgentTracer } from "./tracer";
import { aggregateSignals } from "./observability";
import { preArrivalTargets } from "./crosssell";
import { langfuseConfig, saveLangfuseSettings, clearLangfuseSettings } from "./langfuse";
import { ensurePricingPolicies, folioSummary } from "./pricing";
import { listVenues, dishesOf, hoursText } from "./dining";
import { fold } from "./catalogue";
import { searchAvailability, checkRestrictions, resolveDate, validateStayRequest } from "./booking";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { conversations, tasks as tasksTable } from "@shared/schema";
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
  storage.addMessage({
    conversationId,
    role: "ai",
    authorName: "Aurea Agent",
    body: result.reply,
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
  analyseConversation(conversationId).catch(() => undefined);
  return result;
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

function staffApiGuard(req: Request, res: Response, next: () => void) {
  if (
    !req.path.startsWith("/api/") ||
    isGuestRoute(req) ||
    (req.method === "GET" && PUBLIC_REFERENCE_ROUTES.has(req.path))
  )
    return next();

  const presented =
    (req.headers["x-staff-token"] as string | undefined) ||
    (typeof req.headers.authorization === "string" && req.headers.authorization.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : undefined);

  if (STAFF_API_TOKEN && presented === STAFF_API_TOKEN) return next();

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
    const schema = z.object({
      brandVoice: z.string().min(20).optional(),
      slaMinutes: z.number().int().min(1).max(240).optional(),
      aiEnabled: z.number().int().min(0).max(1).optional(),
      checkInTime: z.string().optional(),
      checkOutTime: z.string().optional(),
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
    /* Hands the client the one thing it needs to actually present on every
     * later request — see staffApiGuard above. Correct PIN is what earns it;
     * omitted entirely when no token is configured, so a dev deployment with
     * enforcement off behaves exactly as before. */
    res.json({ ...safe, ...(STAFF_API_TOKEN ? { staffApiToken: STAFF_API_TOKEN } : {}) });
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
      const { code } = z.object({ code: z.string().min(4) }).parse(req.body);
      const reservation = storage.getReservationByCode(code);
      if (!reservation) return res.status(404).json({ message: "No reservation with that code." });
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
          topic: null,
          unreadForStaff: 0,
          lastMessageAt: nowIso(),
          createdAt: nowIso(),
          firstResponseSeconds: null,
        });
      }
      res.json({ conversationId: conv.id, ...conversationDetail(conv.id) });
    }),
  );

  /* ---------------- conversations ---------------- */

  app.get("/api/conversations", (_req, res) => {
    res.json(storage.listConversations().filter((c) => c.mode !== "closed"));
  });

  app.get("/api/conversations/:id", (req, res) => {
    const detail = conversationDetail(Number(req.params.id));
    if (!detail) return res.status(404).json({ message: "Not found" });
    res.json(detail);
  });

  app.post(
    "/api/conversations/:id/messages",
    asyncH(async (req, res) => {
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
      res.json(conversationDetail(id));
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

    res.json({ ok: true, feedback: fb, conversation: conversationDetail(conversationId) });
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

  app.get("/api/tasks", (_req, res) => {
    const staffList = storage.listStaff();
    const rooms = storage.listRooms();
    res.json(
      storage.listTasks().map((t) => ({
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
      actor: "staff:0",
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
  app.get("/api/approvals", (_req, res) => {
    res.json(storage.listApprovals());
  });

  app.post("/api/approvals/:id/approve", (req, res) => {
    const id = Number(req.params.id);
    const staffName = typeof req.body?.staffName === "string" && req.body.staffName.trim() ? req.body.staffName.trim() : "Staff";
    const result = finalizeApproval(id, "approve", staffName);
    if (!result.ok) return res.status(400).json({ message: result.error });
    res.json(result.approval);
  });

  app.post("/api/approvals/:id/reject", (req, res) => {
    const id = Number(req.params.id);
    const staffName = typeof req.body?.staffName === "string" && req.body.staffName.trim() ? req.body.staffName.trim() : "Staff";
    const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
    const result = finalizeApproval(id, "reject", staffName, reason);
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

  app.get("/api/reservations", (_req, res) => {
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
    asyncH(async (_req, res) => {
      const r = await reindex();
      storage.logEvent({
        type: "retrieval.reindexed",
        actor: "staff:0",
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
      actor: "staff:0",
      summary: `Knowledge article added: ${a.title}`,
      payload: null,
      conversationId: null,
      createdAt: nowIso(),
    });
    void reindex().catch(() => {});
    res.json({ ...a, tags: input.tags });
  });

  app.patch("/api/kb/:id", (req, res) => {
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
        actor: "staff:0",
        summary: `Campaign "${camp.name}" delivered to ${sent} guest(s), localised per guest.`,
        payload: null,
        conversationId: null,
        createdAt: nowIso(),
      });
      res.json(updated);
    }),
  );

  /* ---------------- insights ---------------- */

  app.get("/api/insights", (_req, res) => {
    const allConvs = db.select().from(conversations).all();
    const allTasks = db.select().from(tasksTable).all();
    const rooms = storage.listRooms();
    const reservations = storage.listReservations();
    const staffList = storage.listStaff();
    const t = today();

    const withResponse = allConvs.filter((c) => c.firstResponseSeconds != null);
    const aiHandled = allConvs.filter((c) => c.assignedStaffId == null && c.mode !== "human");
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
    const series = days.map((d) => {
      const dayTasks = allTasks.filter((x) => x.createdAt.slice(0, 10) === d);
      const dayConvs = allConvs.filter((c) => c.createdAt.slice(0, 10) === d);
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
        slaBreaches: mins.filter((m) => m > sla * 6).length,
      };
    });

    const topics = Object.entries(
      allConvs.reduce<Record<string, number>>((acc, c) => {
        const key = c.topic ?? "other";
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
    )
      .map(([topic, count]) => ({ topic, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 7);

    const sentiment = ["positive", "neutral", "negative"].map((s) => ({
      sentiment: s,
      count: allConvs.filter((c) => c.sentiment === s).length,
    }));

    const inHouse = reservations.filter((r) => r.status === "in_house").length;

    res.json({
      kpis: {
        conversations: allConvs.length,
        aiDeflectionRate: allConvs.length
          ? Math.round((aiHandled.length / allConvs.length) * 100)
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
              .reduce((n, c) => n + c.amount, 0) * 100,
          ) / 100,
        slaMinutes: sla,
      },
      series,
      byDept,
      topics,
      sentiment,
      staffLoad: staffList.map((s) => ({
        name: s.name,
        dept: s.dept,
        open: allTasks.filter((x) => x.assignedStaffId === s.id && x.status !== "done").length,
        done: allTasks.filter((x) => x.assignedStaffId === s.id && x.status === "done").length,
      })),
    });
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

  /* ------------------------------------------------------------------ *
   * Payments
   *
   * The concierge can only create a payment intent; it never claims money has
   * arrived. A human (or a real PSP webhook) confirms it here, and only then
   * is the negative payment line posted to the folio.
   * ------------------------------------------------------------------ */

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
