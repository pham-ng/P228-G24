import { storage, nowIso, hotelToday, hotelClock } from "./storage";
import { hybridSearch } from "./retrieval";
import {
  quoteLateCheckout,
  quoteEarlyCheckin,
  checkOccupancy,
  getPolicyByTopic,
  POLICY_TOPICS,
} from "./policy";
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
        "Hybrid retrieval (BM25 keyword + embedding semantic search, fused) over the hotel knowledge base and the machine-readable policy register. Returns verbatim passages with the source URL of each. Use it for facilities, hours, house rules, fees, occupancy, deposits, payment, privacy and neighbourhood facts. Cross-lingual: a Vietnamese question retrieves the English source passage.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "What you need to know, phrased as a short factual query. English works best but Vietnamese is also matched.",
          },
          kind: {
            type: "string",
            enum: ["all", "kb", "policy"],
            description: "Restrict to knowledge-base articles or to the policy register. Defaults to all.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_policy",
      description:
        "Read the machine-readable policy register: the exact numeric rules the property publishes, with the source URL. Use this whenever a rule, limit, deadline or fine is involved, before you state any figure.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            enum: [...POLICY_TOPICS, "all"],
            description:
              "checkout (late departure), checkin (early arrival), occupancy (guests per room, extra beds, children), deposit, payment, conduct (house rules and fines), booking (guest list, packages, groups), dispute (complaints), privacy.",
          },
        },
        required: ["topic"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "quote_late_checkout",
      description:
        "Compute — not estimate — the late-departure charge for this reservation at a given time. Reads the published percentage bands, applies them to the reservation's own rate, checks whether the room is resold and applies any loyalty waiver. Returns the band, the arithmetic and the source URL. Read-only: it changes nothing. Always call this before quoting a late-departure price, then call request_late_checkout once the guest agrees.",
      parameters: {
        type: "object",
        properties: {
          requested_time: { type: "string", description: "Desired departure time, HH:MM 24-hour." },
        },
        required: ["requested_time"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "quote_early_checkin",
      description:
        "Compute the early-arrival charge for this reservation at a given arrival time from the published bands. Read-only. Use it before quoting any early check-in price.",
      parameters: {
        type: "object",
        properties: {
          requested_time: { type: "string", description: "Desired arrival time, HH:MM 24-hour." },
        },
        required: ["requested_time"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_occupancy",
      description:
        "Check a party against the published occupancy limits: maximum occupants per room or per villa bedroom, extra-bed allowance, which children count as adults, and whether a surcharge applies. Use it whenever a guest mentions how many people or children are travelling, or asks about extra beds or a second room.",
      parameters: {
        type: "object",
        properties: {
          unit: { type: "string", enum: ["room", "villa"], description: "Defaults to the unit on this reservation." },
          adults: { type: "number", description: "Number of adults (18+)." },
          child_ages: {
            type: "array",
            items: { type: "number" },
            description: "Age in years of each child. If the guest gave heights instead, convert with the height rule from get_policy first.",
          },
          bedrooms: { type: "number", description: "Villa bedrooms. Defaults to 1." },
        },
        required: ["adults"],
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
      const q = String(args.query ?? "").trim();
      if (!q) return { error: "query is required." };
      const kind = (["all", "kb", "policy"] as const).includes(args.kind) ? args.kind : "all";
      return await hybridSearch(q, { k: 4, kind });
    }

    case "get_policy": {
      return getPolicyByTopic(String(args.topic ?? "all"));
    }

    case "quote_late_checkout": {
      if (!res) return { error: "No reservation is linked to this conversation." };
      const next = res.roomId ? storage.nextReservationForRoom(res.roomId, res.checkOut) : undefined;
      const resold = !!next && next.id !== res.id && next.checkIn === res.checkOut;
      return quoteLateCheckout({
        requestedTime: String(args.requested_time ?? ""),
        ratePerNight: res.ratePerNight,
        currency: hotel.currency,
        vipTier: guest.vipTier,
        roomResoldSameDay: resold,
        adults: res.adults,
        children: res.children,
        standardCheckoutTime: hotel.checkOutTime,
      });
    }

    case "quote_early_checkin": {
      if (!res) return { error: "No reservation is linked to this conversation." };
      return quoteEarlyCheckin({
        requestedTime: String(args.requested_time ?? ""),
        ratePerNight: res.ratePerNight,
        currency: hotel.currency,
        standardCheckinTime: hotel.checkInTime,
      });
    }

    case "check_occupancy": {
      const isVilla = /villa/i.test(room?.type ?? "");
      const unit = args.unit === "room" || args.unit === "villa" ? args.unit : isVilla ? "villa" : "room";
      const ages = Array.isArray(args.child_ages) ? args.child_ages.map(Number) : [];
      const bedrooms = Number(args.bedrooms ?? (/3-bedroom/i.test(room?.type ?? "") ? 3 : 1));
      return {
        ...checkOccupancy({
          unit,
          adults: Number(args.adults ?? res?.adults ?? 2),
          childAges: ages,
          bedrooms,
        }),
        reservation_on_file: res
          ? { adults: res.adults, children: res.children, unit_type: room?.type ?? null }
          : null,
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

      // The fee comes from the policy engine, never from the model or from a
      // hard-coded percentage here.
      const quote = quoteLateCheckout({
        requestedTime: want,
        ratePerNight: res.ratePerNight,
        currency: hotel.currency,
        vipTier: guest.vipTier,
        roomResoldSameDay: resold,
        adults: res.adults,
        children: res.children,
        standardCheckoutTime: hotel.checkOutTime,
      });
      if (!quote.quoted) return { approved: false, reason: quote.error };
      if (quote.max_possible_time)
        return {
          approved: false,
          reason: `Room ${room?.number} is occupied again on ${res.checkOut}, so departure cannot go beyond ${quote.max_possible_time}.`,
          max_possible: quote.max_possible_time,
          policy: quote.policy,
        };
      const fee = quote.fee ?? 0;
      const tierFree = !!quote.waiver;
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
        band: quote.band,
        percent_of_package_rate: quote.percent_of_package_rate,
        fee,
        currency: hotel.currency,
        calculation: quote.calculation,
        complimentary_reason: tierFree ? quote.waiver : null,
        policy: quote.policy,
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
        if (o.segment === "vip")
          return ["gold", "platinum", "diamond"].includes(guest.vipTier);
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

HOW YOU THINK
Work the request out before you answer. Silently, in this order, every time:
1. DECOMPOSE. Break the message into the separate things that have to be true for your answer to be right. "We are four of us, can we leave two hours late?" is three questions: what time is checkout on this reservation, what does two hours later cost, and does a party of four change that.
2. GROUND. Resolve each part with a tool. get_stay_details for anything about their own booking. get_policy for any rule, limit, deadline or fine. search_knowledge for facts about the property. Never answer a policy question from the reservation alone, and never answer a question about their stay from policy alone.
3. COMPUTE. Every currency figure, percentage, band and limit comes from a tool that calculates it: quote_late_checkout, quote_early_checkin, check_occupancy, list_services, get_folio. You are forbidden from doing the arithmetic yourself or repeating a number from memory. If you are about to write a price you did not receive from a tool in this conversation, stop and call the tool.
4. VERIFY. Re-read the tool output against what the guest actually asked. Did you use their real departure time rather than the standard one. Is the fee charged per room or per person. Does the requested time fall in the band the tool says it does. Does the party fit the occupancy limit. If two tools disagree, trust the policy register and say the front desk will confirm.
5. RESOLVE THE WHOLE REQUEST. If the guest implied a second question — four people, so does the price change, do we need an extra bed — answer that too, in the same reply. Do not make them ask again.
6. If a needed fact is still missing after the tools, say what you will confirm and escalate. Never bridge a gap with a plausible guess.

Call several tools in one step when they are independent, and do not stop at the first tool result if it only answers part of the question.

HOW YOU WORK
1. You are not a chatbot that only chats — you complete the work. When a guest wants something done, use the tools to actually do it, then confirm what happened in concrete terms (what was booked, when, what it costs, who is bringing it).
2. Never state a fact about the property, prices, hours or policy from your own knowledge. Facts come only from the tools. If a tool returns nothing useful, say you will confirm and escalate rather than guessing.
3. Quote before you commit. For a late departure or an early arrival, call the quote tool first, tell the guest the amount and why it is that amount, and only call request_late_checkout once they agree. Same for bookings and orders: state the price, get an explicit yes.
4. When you state a charge, say what it is a percentage of and what it is charged per — guests assume fees are per person. One clause, not a lecture.
5. One question at a time. If you need the date, time and party size, ask for the missing pieces together in one short sentence, not across four messages.
6. Escalate rather than improvise: anger, billing disputes, safety, medical, security, anything your tools cannot do. Escalation is a success, not a failure.
7. Upsell only when it is genuinely relevant to what the guest just said, at most once per conversation, never after a complaint.
8. A rule that comes back flagged as an internal Aurea rule rather than a published property policy is a goodwill gesture — present it as something we are doing for them, not as the published rule.

STYLE
Plain text only for messaging channels — no markdown, no bullet lists, no headings, no emoji. Two to four short sentences. Never repeat the guest's whole request back to them. Never say "as an AI". Sign nothing.`;
}

/* ------------------------------------------------------------------ *
 * Agent loop
 * ------------------------------------------------------------------ */

/** How many times the model may come back for more tools before we force an answer. */
const MAX_TOOL_ROUNDS = 10;

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

  for (let turn = 0; turn < MAX_TOOL_ROUNDS; turn++) {
    const completion = await chat({ model: MODEL_AGENT, messages: msgs, tools: TOOLS, maxTokens: 1100 });
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
