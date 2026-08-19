import { storage, nowIso, hotelToday, hotelClock } from "./storage";
import { chat, classify, LlmError, MODEL_AGENT } from "./openai";
import type { ChatMessage, ToolSpec } from "./openai";
import type { Conversation, ToolCallTrace } from "@shared/schema";

const LANG_NAMES: Record<string, string> = {
  en: "English",
  vi: "Vietnamese",
  fr: "French",
  ja: "Japanese",
  es: "Spanish",
  de: "German",
  ko: "Korean",
  zh: "Chinese",
  ru: "Russian",
};

const today = hotelToday;
const clock = hotelClock;

/* ------------------------------------------------------------------ *
 * Tool definitions exposed to the model
 * ------------------------------------------------------------------ */

export const TOOLS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "get_stay_details",
      description:
        "Read the guest's live reservation from the PMS: room number and type, arrival and departure dates, current departure time, rate, status and stored guest preferences. Call this before answering anything about their own stay.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "search_knowledge",
      description:
        "Search the hotel's knowledge base for facts about facilities, hours, policies, wayfinding and neighbourhood recommendations. Always use this instead of guessing. Returns the most relevant articles verbatim.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Keywords describing what the guest wants to know, in English.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_services",
      description:
        "List bookable services with live prices and available time slots. Categories: dining, spa, experience, transport, roomservice.",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: ["dining", "spa", "experience", "transport", "roomservice", "all"],
          },
          date: {
            type: "string",
            description: "YYYY-MM-DD to check remaining capacity for. Defaults to today.",
          },
        },
        required: ["category"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "book_service",
      description:
        "Actually reserve a service slot for this guest. Only call after the guest has confirmed the service, date, time and party size. This writes a booking, charges the folio and dispatches a task to the owning department.",
      parameters: {
        type: "object",
        properties: {
          service_id: { type: "integer" },
          date: { type: "string", description: "YYYY-MM-DD" },
          slot: { type: "string", description: "HH:MM, must be one of the service's slots" },
          party_size: { type: "integer" },
          note: { type: "string", description: "Any dietary or access note for the department." },
        },
        required: ["service_id", "date", "slot", "party_size"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "order_room_service",
      description:
        "Place an in-room dining order. Charges the folio and dispatches a preparation task to Food & Beverage. Only call after the guest confirms the items.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            description: "Room-service service_id values with quantities.",
            items: {
              type: "object",
              properties: {
                service_id: { type: "integer" },
                quantity: { type: "integer" },
              },
              required: ["service_id", "quantity"],
            },
          },
          note: { type: "string" },
        },
        required: ["items"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_late_checkout",
      description:
        "Check whether a later departure time is possible and, if it is, apply it to the reservation. The system verifies whether the room is resold that day and applies the correct fee for the guest's tier. Never promise a late check-out without calling this.",
      parameters: {
        type: "object",
        properties: {
          requested_time: { type: "string", description: "HH:MM, e.g. 14:00" },
        },
        required: ["requested_time"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_folio",
      description: "Read the guest's current bill: every charge and the running total.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "create_task",
      description:
        "Dispatch operational work to a department — housekeeping deliveries, maintenance faults, front-desk errands. Use this for anything physical the guest needs. Do not use it for bookings (use book_service) or for handing the chat to a human (use escalate_to_human).",
      parameters: {
        type: "object",
        properties: {
          dept: {
            type: "string",
            enum: ["front_desk", "housekeeping", "fnb", "engineering", "spa"],
          },
          title: { type: "string", description: "Short imperative summary, max 60 characters." },
          detail: { type: "string", description: "What exactly is needed, including the room." },
          priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
        },
        required: ["dept", "title", "detail", "priority"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_offers",
      description:
        "Retrieve the personalised upsell offers this guest is eligible for. Only mention an offer when it genuinely fits what the guest just said.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "escalate_to_human",
      description:
        "Hand the conversation to on-duty staff. Use when the guest is upset, asks for a human, raises a billing dispute, a safety or medical issue, or asks for something outside your tools. After calling this, tell the guest a colleague is joining.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string" },
          priority: { type: "string", enum: ["normal", "high", "urgent"] },
        },
        required: ["reason", "priority"],
      },
    },
  },
];

/* ------------------------------------------------------------------ *
 * Tool implementations — every one of these touches the database
 * ------------------------------------------------------------------ */

type Ctx = { conversation: Conversation };

function scoreArticle(q: string, title: string, body: string, tags: string[]) {
  const terms = q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
  let score = 0;
  const t = title.toLowerCase();
  const b = body.toLowerCase();
  const tg = tags.join(" ").toLowerCase();
  for (const term of terms) {
    if (tg.includes(term)) score += 5;
    if (t.includes(term)) score += 4;
    if (b.includes(term)) score += 1;
  }
  return score;
}

async function runTool(name: string, args: any, ctx: Ctx): Promise<Record<string, unknown> | string> {
  const conv = storage.getConversation(ctx.conversation.id)!;
  const guest = storage.getGuest(conv.guestId)!;
  const res = storage.getReservation(conv.reservationId);
  const room = storage.getRoom(res?.roomId ?? null);
  const hotel = storage.getHotel();

  switch (name) {
    case "get_stay_details": {
      if (!res) return { error: "No reservation is linked to this conversation." };
      return {
        guest_name: guest.name,
        vip_tier: guest.vipTier,
        stays_to_date: guest.staysCount,
        preferences: JSON.parse(guest.preferences || "[]"),
        confirmation_code: res.confirmationCode,
        room: room ? { number: room.number, type: room.type, floor: room.floor } : null,
        arrival: res.checkIn,
        departure: res.checkOut,
        departure_time: res.checkOutTime,
        adults: res.adults,
        children: res.children,
        rate_per_night: res.ratePerNight,
        currency: hotel.currency,
        status: res.status,
        booking_source: res.source,
      };
    }

    case "search_knowledge": {
      const q = String(args.query ?? "");
      const ranked = storage
        .listKb()
        .map((a) => ({ a, s: scoreArticle(q, a.title, a.body, JSON.parse(a.tags || "[]")) }))
        .filter((x) => x.s > 0)
        .sort((x, y) => y.s - x.s)
        .slice(0, 3);
      if (!ranked.length)
        return {
          results: [],
          note: "Nothing in the knowledge base matches. Do not invent an answer — escalate or offer to check with a colleague.",
        };
      return {
        results: ranked.map((x) => ({
          title: x.a.title,
          category: x.a.category,
          content: x.a.body,
        })),
      };
    }

    case "list_services": {
      const cat = String(args.category ?? "all");
      const date = String(args.date ?? today());
      const list = storage.listServices().filter((s) => cat === "all" || s.category === cat);
      return {
        date,
        currency: hotel.currency,
        services: list.map((s) => {
          const slots: string[] = JSON.parse(s.slots || "[]");
          const booked = storage.bookingsFor(s.id, date);
          const remaining = slots.map((slot) => ({
            slot,
            seats_left: Math.max(
              0,
              s.capacityPerSlot -
                booked.filter((b) => b.slot === slot).reduce((n, b) => n + b.partySize, 0),
            ),
          }));
          return {
            service_id: s.id,
            name: s.name,
            category: s.category,
            description: s.description,
            price: s.price,
            unit: s.unit,
            availability: slots.length ? remaining.filter((r) => r.seats_left > 0) : "always available",
          };
        }),
      };
    }

    case "book_service": {
      if (!res) return { error: "No reservation linked — cannot book." };
      const svc = storage.getService(Number(args.service_id));
      if (!svc) return { error: `No service with id ${args.service_id}.` };
      const date = String(args.date);
      const slot = String(args.slot);
      const party = Math.max(1, Number(args.party_size ?? 1));
      const slots: string[] = JSON.parse(svc.slots || "[]");
      if (slots.length && !slots.includes(slot))
        return { error: `${svc.name} does not run at ${slot}. Available: ${slots.join(", ")}` };
      if (date < today()) return { error: "That date is in the past." };
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
      const booking = storage.createBooking({
        serviceId: svc.id,
        reservationId: res.id,
        date,
        slot,
        partySize: party,
        status: "confirmed",
        createdAt: nowIso(),
      });
      const amount = svc.unit === "per person" ? svc.price * party : svc.price;
      storage.addCharge({
        reservationId: res.id,
        description: `${svc.name} — ${date} ${slot} × ${party}`,
        amount,
        category: svc.category === "spa" ? "spa" : svc.category === "dining" ? "fnb" : "fee",
        createdAt: nowIso(),
      });
      const task = storage.createTask({
        hotelId: hotel.id,
        reservationId: res.id,
        roomId: res.roomId,
        conversationId: conv.id,
        dept: svc.dept,
        title: `${svc.name} — ${date} ${slot}`,
        detail: `${guest.name} (room ${room?.number ?? "—"}), party of ${party}.${
          args.note ? ` Note: ${args.note}` : ""
        }`,
        priority: "normal",
        status: "open",
        source: "ai",
        assignedStaffId: null,
        dueAt: `${date}T${slot}:00`,
        createdAt: nowIso(),
        resolvedAt: null,
      });
      storage.logEvent({
        type: "booking.created",
        actor: "ai",
        summary: `Booked ${svc.name} for ${guest.name} on ${date} at ${slot} (party ${party}).`,
        payload: JSON.stringify({ bookingId: booking.id, taskId: task.id, amount }),
        conversationId: conv.id,
        createdAt: nowIso(),
      });
      return {
        booked: true,
        booking_id: booking.id,
        service: svc.name,
        date,
        slot,
        party_size: party,
        charged: amount,
        currency: hotel.currency,
        dispatched_to: svc.dept,
      };
    }

    case "order_room_service": {
      if (!res) return { error: "No reservation linked — cannot order." };
      const items = Array.isArray(args.items) ? args.items : [];
      if (!items.length) return { error: "No items supplied." };
      const lines: string[] = [];
      let total = 0;
      for (const it of items) {
        const svc = storage.getService(Number(it.service_id));
        if (!svc || svc.category !== "roomservice")
          return {
            error: `Service ${it.service_id} is not on the in-room dining menu. Call list_services with category "roomservice" and use a service_id from the result.`,
            menu: storage
              .listServices()
              .filter((x) => x.category === "roomservice")
              .map((x) => ({ service_id: x.id, name: x.name, price: x.price })),
          };
        const qty = Math.max(1, Number(it.quantity ?? 1));
        total += svc.price * qty;
        lines.push(`${qty} × ${svc.name}`);
      }
      storage.addCharge({
        reservationId: res.id,
        description: `In-room dining — ${lines.join(", ")}`,
        amount: total,
        category: "fnb",
        createdAt: nowIso(),
      });
      const task = storage.createTask({
        hotelId: hotel.id,
        reservationId: res.id,
        roomId: res.roomId,
        conversationId: conv.id,
        dept: "fnb",
        title: `In-room dining — room ${room?.number ?? "—"}`,
        detail: `${lines.join(", ")}.${args.note ? ` Note: ${args.note}` : ""} Guest: ${guest.name}.`,
        priority: "high",
        status: "open",
        source: "ai",
        assignedStaffId: null,
        dueAt: new Date(Date.now() + 35 * 60_000).toISOString(),
        createdAt: nowIso(),
        resolvedAt: null,
      });
      storage.logEvent({
        type: "order.created",
        actor: "ai",
        summary: `In-room dining order for ${guest.name}: ${lines.join(", ")}.`,
        payload: JSON.stringify({ taskId: task.id, total }),
        conversationId: conv.id,
        createdAt: nowIso(),
      });
      return {
        ordered: true,
        items: lines,
        charged: total,
        currency: hotel.currency,
        eta_minutes: 35,
        dispatched_to: "fnb",
      };
    }

    case "request_late_checkout": {
      if (!res) return { error: "No reservation linked." };
      const want = String(args.requested_time);
      if (!/^\d{2}:\d{2}$/.test(want)) return { error: "requested_time must be HH:MM." };
      if (want <= res.checkOutTime)
        return { error: `Departure is already set to ${res.checkOutTime}.` };
      const next = res.roomId ? storage.nextReservationForRoom(res.roomId, res.checkOut) : undefined;
      const resold = !!next && next.id !== res.id && next.checkIn === res.checkOut;
      if (resold && want > "14:00")
        return {
          approved: false,
          reason: `Room ${room?.number} is occupied again on ${res.checkOut}, so departure cannot go beyond 14:00.`,
          max_possible: "14:00",
        };
      const tierFree = ["gold", "platinum"].includes(guest.vipTier) && want <= "14:00";
      let fee = 0;
      if (!tierFree) fee = want <= "14:00" ? 40 : Math.round(res.ratePerNight / 2);
      storage.updateReservation(res.id, { checkOutTime: want });
      if (fee > 0) {
        storage.addCharge({
          reservationId: res.id,
          description: `Late departure until ${want}`,
          amount: fee,
          category: "fee",
          createdAt: nowIso(),
        });
      }
      const task = storage.createTask({
        hotelId: hotel.id,
        reservationId: res.id,
        roomId: res.roomId,
        conversationId: conv.id,
        dept: "housekeeping",
        title: `Late departure ${want} — room ${room?.number ?? "—"}`,
        detail: `Reschedule cleaning for room ${room?.number}. ${guest.name} departs ${res.checkOut} at ${want}.`,
        priority: "normal",
        status: "open",
        source: "ai",
        assignedStaffId: null,
        dueAt: `${res.checkOut}T${want}:00`,
        createdAt: nowIso(),
        resolvedAt: null,
      });
      storage.logEvent({
        type: "reservation.late_checkout",
        actor: "ai",
        summary: `Departure for ${res.confirmationCode} moved to ${want}${
          fee ? ` (fee ${fee} ${hotel.currency})` : " (complimentary)"
        }.`,
        payload: JSON.stringify({ taskId: task.id, fee }),
        conversationId: conv.id,
        createdAt: nowIso(),
      });
      return {
        approved: true,
        new_departure_time: want,
        fee,
        currency: hotel.currency,
        complimentary_reason: tierFree ? `${guest.vipTier} tier benefit` : null,
        pms_updated: true,
      };
    }

    case "get_folio": {
      if (!res) return { error: "No reservation linked." };
      const charges = storage.listCharges(res.id);
      return {
        confirmation_code: res.confirmationCode,
        currency: hotel.currency,
        charges: charges.map((c) => ({
          description: c.description,
          amount: c.amount,
          category: c.category,
        })),
        total: Math.round(charges.reduce((n, c) => n + c.amount, 0) * 100) / 100,
      };
    }

    case "create_task": {
      const task = storage.createTask({
        hotelId: hotel.id,
        reservationId: res?.id ?? null,
        roomId: res?.roomId ?? null,
        conversationId: conv.id,
        dept: String(args.dept),
        title: String(args.title).slice(0, 80),
        detail: String(args.detail ?? ""),
        priority: String(args.priority ?? "normal"),
        status: "open",
        source: "ai",
        assignedStaffId: null,
        dueAt: new Date(
          Date.now() + (args.priority === "urgent" ? 15 : args.priority === "high" ? 30 : 60) * 60_000,
        ).toISOString(),
        createdAt: nowIso(),
        resolvedAt: null,
      });
      storage.logEvent({
        type: "task.created",
        actor: "ai",
        summary: `Task #${task.id} → ${task.dept}: ${task.title}`,
        payload: JSON.stringify({ taskId: task.id }),
        conversationId: conv.id,
        createdAt: nowIso(),
      });
      return {
        created: true,
        task_id: task.id,
        dept: task.dept,
        due_at: task.dueAt,
        sla_minutes: hotel.slaMinutes,
      };
    }

    case "get_offers": {
      const stayingNow = res?.status === "in_house";
      const departingToday = res?.checkOut === today();
      const eligible = storage.listOffers().filter((o) => {
        if (o.segment === "all") return true;
        if (o.segment === "in_house") return stayingNow;
        if (o.segment === "departing") return departingToday;
        if (o.segment === "vip") return ["gold", "platinum"].includes(guest.vipTier);
        if (o.segment === "repeat") return guest.staysCount > 1;
        return false;
      });
      return {
        currency: hotel.currency,
        offers: eligible.map((o) => ({ title: o.title, detail: o.body, price: o.price })),
      };
    }

    case "escalate_to_human": {
      storage.updateConversation(conv.id, { mode: "human", unreadForStaff: 1 });
      const task = storage.createTask({
        hotelId: hotel.id,
        reservationId: res?.id ?? null,
        roomId: res?.roomId ?? null,
        conversationId: conv.id,
        dept: "front_desk",
        title: `Human handoff — ${guest.name}`,
        detail: String(args.reason ?? "Guest requested a colleague."),
        priority: String(args.priority ?? "high"),
        status: "open",
        source: "ai",
        assignedStaffId: null,
        dueAt: new Date(Date.now() + hotel.slaMinutes * 60_000).toISOString(),
        createdAt: nowIso(),
        resolvedAt: null,
      });
      storage.logEvent({
        type: "conversation.escalated",
        actor: "ai",
        summary: `Handed conversation #${conv.id} to staff: ${args.reason}`,
        payload: JSON.stringify({ taskId: task.id }),
        conversationId: conv.id,
        createdAt: nowIso(),
      });
      return { escalated: true, mode: "human", task_id: task.id, sla_minutes: hotel.slaMinutes };
    }

    default:
      return { error: `Unknown tool ${name}` };
  }
}

/* ------------------------------------------------------------------ *
 * System prompt
 * ------------------------------------------------------------------ */

function buildSystemPrompt(conv: Conversation) {
  const hotel = storage.getHotel();
  const guest = storage.getGuest(conv.guestId)!;
  const res = storage.getReservation(conv.reservationId);
  const room = storage.getRoom(res?.roomId ?? null);
  const langName = LANG_NAMES[guest.lang] ?? guest.lang;

  return `You are the Aurea guest agent — the always-on concierge for ${hotel.name}, a property in ${hotel.city}.

BRAND VOICE
${hotel.brandVoice}

RIGHT NOW
Local date ${today()}, local time ${clock()} (${hotel.timezone}). Standard check-in ${hotel.checkInTime}, standard check-out ${hotel.checkOutTime}. Currency ${hotel.currency}.

WHO YOU ARE TALKING TO
${guest.name} — ${guest.vipTier === "none" ? "no loyalty tier" : `${guest.vipTier} member`}, ${guest.staysCount} stay(s) with us. Channel: ${conv.channel}. Preferred language: ${langName}.
${res ? `Reservation ${res.confirmationCode}: room ${room?.number ?? "unassigned"} (${room?.type ?? "—"}), ${res.checkIn} → ${res.checkOut}, departure time ${res.checkOutTime}, status ${res.status}.` : "No reservation is linked to this conversation."}

LANGUAGE
Always answer in the language the guest just wrote in. If they write in ${langName}, answer in ${langName}. Match their register. Never mix languages in one reply unless quoting a proper name.

HOW YOU WORK
1. You are not a chatbot that only chats — you complete the work. When a guest wants something done, use the tools to actually do it, then confirm what happened in concrete terms (what was booked, when, what it costs, who is bringing it).
2. Never state a fact about the property, prices, hours or policy from your own knowledge. Facts come only from search_knowledge, get_stay_details, list_services or get_folio. If a tool returns nothing useful, say you will confirm and escalate rather than guessing.
3. Confirm before you commit. Bookings, orders and anything that costs money need an explicit yes from the guest first — and you must state the price before asking for that yes.
4. One question at a time. If you need the date, time and party size, ask for the missing pieces together in one short sentence, not across four messages.
5. Escalate rather than improvise: anger, billing disputes, safety, medical, security, anything your tools cannot do. Escalation is a success, not a failure.
6. Upsell only when it is genuinely relevant to what the guest just said, at most once per conversation, never after a complaint.

STYLE
Plain text only for messaging channels — no markdown, no bullet lists, no headings, no emoji. Two to four short sentences. Never repeat the guest's whole request back to them. Never say "as an AI". Sign nothing.`;
}

/* ------------------------------------------------------------------ *
 * Agent loop
 * ------------------------------------------------------------------ */

export type AgentResult = {
  reply: string;
  trace: ToolCallTrace[];
  escalated: boolean;
  latencyMs: number;
  model: string;
};

export async function runAgent(conversationId: number): Promise<AgentResult> {
  const started = Date.now();
  const conv = storage.getConversation(conversationId)!;
  const history = storage.listMessages(conversationId);

  const msgs: ChatMessage[] = [{ role: "system", content: buildSystemPrompt(conv) }];
  for (const m of history.slice(-24)) {
    if (m.role === "guest") msgs.push({ role: "user", content: m.body });
    else if (m.role === "ai") msgs.push({ role: "assistant", content: m.body });
    else if (m.role === "staff")
      msgs.push({ role: "assistant", content: `[${m.authorName} — hotel staff] ${m.body}` });
    else msgs.push({ role: "system", content: m.body });
  }

  const trace: ToolCallTrace[] = [];
  let escalated = false;
  let reply = "";

  for (let turn = 0; turn < 6; turn++) {
    const completion = await chat({ model: MODEL_AGENT, messages: msgs, tools: TOOLS, maxTokens: 900 });
    const choice = completion.choices[0]?.message;
    if (!choice) throw new LlmError("Empty response from the model.");

    if (choice.tool_calls?.length) {
      msgs.push({ role: "assistant", content: choice.content ?? "", tool_calls: choice.tool_calls });
      for (const call of choice.tool_calls) {
        let args: any = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          args = {};
        }
        const t0 = Date.now();
        let result: Record<string, unknown> | string;
        try {
          result = await runTool(call.function.name, args, { conversation: conv });
        } catch (e: any) {
          result = { error: e?.message ?? String(e) };
        }
        if (call.function.name === "escalate_to_human") escalated = true;
        trace.push({ name: call.function.name, args, result, ms: Date.now() - t0 });
        msgs.push({
          role: "tool",
          tool_call_id: call.id,
          content: typeof result === "string" ? result : JSON.stringify(result),
        });
      }
      continue;
    }

    reply = (choice.content ?? "").trim();
    break;
  }

  if (!reply) {
    reply =
      "I want to get this exactly right, so I am bringing a colleague from the front desk into this conversation now.";
    if (!escalated) {
      await runTool(
        "escalate_to_human",
        { reason: "Agent could not produce a grounded answer.", priority: "high" },
        { conversation: conv },
      );
      escalated = true;
    }
  }

  return { reply, trace, escalated, latencyMs: Date.now() - started, model: MODEL_AGENT };
}

/* ------------------------------------------------------------------ *
 * Conversation metadata (sentiment / topic) — a real second model call
 * ------------------------------------------------------------------ */

export async function analyseConversation(conversationId: number) {
  const msgs = storage
    .listMessages(conversationId)
    .filter((m) => m.role === "guest" || m.role === "ai" || m.role === "staff")
    .slice(-10)
    .map((m) => `${m.role}: ${m.body}`)
    .join("\n");
  if (!msgs) return;
  const out = (await classify(
    `Transcript between a hotel guest and the hotel.\n\n${msgs}\n\nReturn {"sentiment":"positive|neutral|negative","topic":"one of amenities, dining, housekeeping, billing, transport, maintenance, booking, other"}`,
    { sentiment: "neutral", topic: "other" },
  )) as { sentiment: string; topic: string };
  const sentiment = ["positive", "neutral", "negative"].includes(out.sentiment)
    ? out.sentiment
    : "neutral";
  storage.updateConversation(conversationId, { sentiment, topic: out.topic ?? "other" });
}

/** Rewrites a campaign body per guest, in that guest's language. */
export async function personaliseCampaign(body: string, guestName: string, lang: string) {
  const langName = LANG_NAMES[lang] ?? lang;
  try {
    const r = await chat({
      messages: [
        {
          role: "system",
          content: `You localise hotel broadcast messages. Rewrite the message for one named guest, in ${langName}, keeping every fact and time exactly as given. Plain text, max 3 sentences, no markdown, no emoji. Return only the message.`,
        },
        { role: "user", content: `Guest name: ${guestName}\n\nMessage:\n${body}` },
      ],
      maxTokens: 400,
    });
    return (r.choices[0]?.message?.content ?? body).trim();
  } catch {
    return body;
  }
}
