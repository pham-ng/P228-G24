import type { Express, Request, Response } from "express";
import type { Server } from "node:http";
import { storage, nowIso, db, hotelToday } from "./storage";
import { seedIfEmpty } from "./seed";
import { runAgent, analyseConversation, personaliseCampaign } from "./agent";
import { chat, LlmError } from "./openai";
import { conversations, tasks as tasksTable } from "@shared/schema";
import { eq } from "drizzle-orm";
import * as z from "zod";

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

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  seedIfEmpty();

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
    res.json(safe);
  });

  /* ---------------- guest surface ---------------- */

  app.get("/api/guest/keys", (_req, res) => {
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
        if (conv.mode === "ai" && hotel.aiEnabled === 1) {
          try {
            await respondWithAi(id);
          } catch (e: any) {
            storage.addMessage({
              conversationId: id,
              role: "system",
              authorName: null,
              body: `The AI agent could not answer (${e?.message ?? e}). The conversation has been handed to the front desk.`,
              toolTrace: null,
              latencyMs: null,
              createdAt: nowIso(),
            });
            storage.updateConversation(id, { mode: "human", unreadForStaff: 1 });
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

  /* ---------------- rooms, reservations, catalogue ---------------- */

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
    res.json({ ...a, tags: JSON.parse(a.tags || "[]") });
  });

  app.delete("/api/kb/:id", (req, res) => {
    storage.deleteKb(Number(req.params.id));
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
          return ["gold", "platinum"].includes(g.vipTier);
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

  return httpServer;
}
