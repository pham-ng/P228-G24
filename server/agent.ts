import { storage, nowIso, hotelToday, hotelClock } from "./storage";
import { hybridSearch } from "./retrieval";
import { fitsPublishedCombination, findRoomType, roomTypeFacts } from "./catalogue";
import { venueFacts } from "./dining";
import {
  quoteLateCheckout,
  quoteEarlyCheckin,
  checkOccupancy,
  getPolicyByTopic,
  POLICY_TOPICS,
} from "./policy";
import {
  resolveDate,
  validateStayRequest,
  searchAvailability,
  createReservation,
  changeReservationDates,
  checkRestrictions,
  isIsoDate,
  MAX_NIGHTS,
  BOOKING_HORIZON_DAYS,
  extractBudget,
} from "./booking";
import { screenGuestMessage, redactCards } from "./guard";
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
      name: "get_room_type_facts",
      description:
        "Read the property's published room page for a category: area in m², bed, view, private pool, the published maximum party and its allowed adult/child combinations, the nightly rate, and the COMPLETE list of published amenities. Use it for every question about what a room has, how big it is, or how many people it takes — including questions about a category the guest is only considering. Pass anything the guest asked about in amenity_questions and answer from the returned amenity_answers instead of from memory.",
      parameters: {
        type: "object",
        properties: {
          room_type: {
            type: "string",
            description:
              "Category as the guest described it, in Vietnamese or English — e.g. 'Deluxe Hướng Biển Giường Đôi', 'grand deluxe twin', 'villa 3 phòng ngủ'. Leave empty to use the category on this reservation.",
          },
          amenity_questions: {
            type: "array",
            items: { type: "string" },
            description:
              "One entry per thing the guest asked about, e.g. ['bồn tắm', 'bàn là', 'hồ bơi riêng']. Always fill this in when the guest names a facility.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_dining_facts",
      description:
        "Read the property's published page for a restaurant or bar: opening hours and meal services, location, phone, seating capacity, price range, the sample menu with prices, and the cuisine and dish categories the page lists. Use it for EVERY question about where to eat, what a venue serves, what something costs there, when it opens, and before proposing or booking a table time. Pass whatever the guest asked about in dish_questions and answer from dish_answers rather than from memory.",
      parameters: {
        type: "object",
        properties: {
          venue: {
            type: "string",
            description:
              "Venue as the guest named it — e.g. 'Bách Giai', 'Jasmine', 'bar bên hồ bơi', 'Lotus'. If they only said 'nhà hàng' or 'bar', pass that and use the returned list to ask which one.",
          },
          dish_questions: {
            type: "array",
            items: { type: "string" },
            description:
              "One entry per dish, drink or dietary need the guest asked about, e.g. ['vịt quay Bắc Kinh', 'món chay', 'halal', 'tôm hùm'].",
          },
          at_time: {
            type: "string",
            description:
              "24h time the guest wants to go, 'HH:MM'. Always pass it when a time was mentioned so the tool can check it against published hours.",
          },
        },
        required: [],
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
      name: "resolve_date",
      description:
        "Turn any date the guest expresses in words — today, tonight, tomorrow, next Friday, this weekend, mai, thứ 6 tuần sau, 12/9, in 3 days — into a calendar date in the hotel's own timezone. You are forbidden from working out a date yourself: always call this, and always echo the resolved date back to the guest. The result tells you when the phrase is ambiguous and must be confirmed.",
      parameters: {
        type: "object",
        properties: {
          expression: {
            type: "string",
            description:
              "The guest's own words for the date. A range they wrote as one phrase — \"22/09 đến 24/09\", \"1/10 - 5/10\" — can be passed whole; the result then carries both ends.",
          },
        },
        required: ["expression"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_availability",
      description:
        "Validate a stay request and price the categories that are genuinely free for it. Always call this before discussing a new booking. It returns three things you must act on: missing facts you have to ask for, problems that make the request impossible as stated (reversed dates, a date in the past, a party too large, minimum-stay and closed-to-arrival restrictions), and the real availability and totals per category. Never invent availability or a total; never book past a problem.",
      parameters: {
        type: "object",
        properties: {
          check_in: { type: "string", description: "Arrival date, YYYY-MM-DD. Resolve words with resolve_date first." },
          check_out: { type: "string", description: "Departure date, YYYY-MM-DD." },
          nights: { type: "number", description: "Use instead of check_out when the guest gave a number of nights." },
          adults: { type: "number" },
          child_ages: {
            type: "array",
            items: { type: "number" },
            description: "One age per child. Never guess an age — ask.",
          },
          children: { type: "number", description: "Only when the guest gave a count but no ages." },
          rooms: { type: "number", description: "Defaults to 1." },
          room_type: { type: "string", description: "Only when the guest named a category." },
          max_rate_per_night: {
            type: "number",
            description:
              "The guest's stated nightly budget. Pass it whenever a ceiling has been mentioned anywhere in this conversation, so the tool can flag categories above it.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_reservation",
      description:
        "Actually create a booking in the PMS. Only call this after check_availability came back clean, after you have told the guest the exact total and they have explicitly agreed, and after you have their full name as printed on their ID and a contact number. It re-runs every validation and refuses rather than creating something invalid.",
      parameters: {
        type: "object",
        properties: {
          check_in: { type: "string" },
          check_out: { type: "string" },
          nights: { type: "number" },
          adults: { type: "number" },
          child_ages: { type: "array", items: { type: "number" } },
          rooms: { type: "number" },
          room_type: { type: "string" },
          guest_name: { type: "string", description: "Full name as printed on the passport or ID card." },
          guest_phone: { type: "string" },
        },
        required: ["check_in", "adults", "room_type", "guest_name", "guest_phone"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "change_reservation_dates",
      description:
        "Move the arrival or departure date of an existing reservation. Only for the reservation linked to this conversation. Re-validates the new window, checks the room is still free and returns the exact difference on the folio. Use this rather than promising that a booking will simply shift.",
      parameters: {
        type: "object",
        properties: {
          check_in: { type: "string", description: "New arrival date. Omit to keep the current one." },
          check_out: { type: "string", description: "New departure date." },
          nights: { type: "number", description: "Use instead of check_out." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_restrictions",
      description:
        "Read the rate calendar for a window: minimum and maximum length of stay, closed to arrival, closed to departure and stop sell, per date and category. Use it to explain why a requested window cannot be sold and what the guest can do instead.",
      parameters: {
        type: "object",
        properties: {
          check_in: { type: "string" },
          check_out: { type: "string" },
          room_type: { type: "string" },
        },
        required: ["check_in", "check_out"],
      },
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
    case "resolve_date": {
      const r = resolveDate(String(args.expression ?? ""));
      return {
        ...r,
        standard_check_in: hotel.checkInTime,
        standard_check_out: hotel.checkOutTime,
        instruction: r.ambiguous
          ? "This phrase is ambiguous. In your very next reply, name the calendar date you have taken it to mean and ask the guest to confirm it, in the same breath as anything else you say. You may still quote what is free, but the confirmation question is not optional."
          : r.resolved
            ? "Echo the resolved date back as day/month/year so the guest can correct you."
            : "Could not resolve. Re-read the note before you ask the guest anything.",
      };
    }

    case "check_availability": {
      const out = searchAvailability({
        checkIn: args.check_in,
        checkOut: args.check_out,
        nights: args.nights,
        adults: args.adults,
        childAges: args.child_ages,
        children: args.children,
        rooms: args.rooms,
        roomType: args.room_type,
        // A ceiling the guest stated earlier still binds even when the model
        // forgets to pass it, so it is recovered from their own words.
        maxRatePerNight:
          args.max_rate_per_night ??
          storage
            .listMessages(conv.id)
            .filter((m) => m.role === "guest")
            .map((m) => extractBudget(m.body))
            .filter((n): n is number => n != null)
            .slice(-1)[0],
      });
      if (!out.ok) {
        const v = out.validation;
        return {
          bookable: false,
          hotel_date: v.hotel_date,
          must_ask_the_guest_for: v.missing,
          problems_to_explain: v.problems,
          warnings: v.warnings,
          instruction:
            v.problems.length > 0
              ? "Explain the problem in the guest's own terms and offer the suggested way out. Do not quote a price and do not book anything."
              : "Ask for the missing facts in one short sentence. Do not guess any of them.",
        };
      }
      return out;
    }

    case "create_reservation": {
      // The name and the number must have been typed by the guest in this
      // conversation. Borrowing them from a chat profile, or inventing them,
      // is how a booking ends up under the wrong identity at the desk.
      const spoken = storage
        .listMessages(conv.id)
        .filter((m) => m.role === "guest")
        .map((m) => m.body.toLowerCase())
        .join(" \n ");
      const spokenDigits = spoken.replace(/\D/g, "");
      const nameGiven =
        typeof args.guest_name === "string" &&
        args.guest_name.trim().length > 3 &&
        spoken.includes(args.guest_name.trim().toLowerCase());
      const phoneDigits = String(args.guest_phone ?? "").replace(/\D/g, "");
      const phoneGiven = phoneDigits.length >= 8 && spokenDigits.includes(phoneDigits);
      if (!nameGiven || !phoneGiven) {
        const need: string[] = [];
        if (!nameGiven) need.push("the guest's full name exactly as printed on their passport or ID card");
        if (!phoneGiven) need.push("a contact phone number the guest can be reached on");
        return {
          created: false,
          must_ask_the_guest_for: need,
          instruction:
            "Nothing was created. The guest has not typed these details in this conversation, and you may not take them from a profile or infer them. Ask for all of them in one short message and call this tool again only after the guest has answered.",
        };
      }

      const out = createReservation({
        checkIn: args.check_in,
        checkOut: args.check_out,
        nights: args.nights,
        adults: args.adults,
        childAges: args.child_ages,
        rooms: args.rooms,
        roomType: args.room_type,
        guestName: args.guest_name,
        guestPhone: args.guest_phone,
        guestLang: guest.lang,
      });
      if (!out.ok)
        return {
          created: false,
          must_ask_the_guest_for: out.missing ?? [],
          problems_to_explain: out.problems ?? [],
          instruction:
            "Nothing was created. Tell the guest exactly what is missing or impossible, and do not claim a booking exists.",
        };
      storage.logEvent({
        type: "reservation.created.chat",
        actor: "ai",
        summary: `Booking ${out.confirmation_code} taken in conversation #${conv.id}.`,
        payload: JSON.stringify(out),
        conversationId: conv.id,
        createdAt: nowIso(),
      });
      return { created: true, ...out };
    }

    case "change_reservation_dates": {
      if (!res) return { error: "No reservation is linked to this conversation, so there is nothing to move." };
      const out = changeReservationDates({
        confirmationCode: res.confirmationCode,
        checkIn: args.check_in,
        checkOut: args.check_out,
        nights: args.nights,
      });
      if (!out.ok)
        return {
          changed: false,
          must_ask_the_guest_for: out.missing ?? [],
          problems_to_explain: out.problems,
          instruction:
            "The reservation was not touched. Explain the problem and offer the alternative. Never say the dates were changed.",
        };
      return { changed: true, ...out };
    }

    case "get_restrictions": {
      const from = String(args.check_in ?? "");
      const to = String(args.check_out ?? "");
      if (!isIsoDate(from) || !isIsoDate(to))
        return { error: "Both dates must be YYYY-MM-DD. Use resolve_date first." };
      const hits = checkRestrictions(from, to, args.room_type ?? null);
      return {
        window: { check_in: from, check_out: to },
        room_type: args.room_type ?? "all categories",
        restrictions: hits,
        clear: hits.length === 0,
        max_nights_bookable_online: MAX_NIGHTS,
        booking_horizon_days: BOOKING_HORIZON_DAYS,
      };
    }

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

    case "get_room_type_facts": {
      const asked = Array.isArray(args.amenity_questions) ? args.amenity_questions.map(String) : [];
      const q = String(args.room_type ?? "").trim() || room?.type || "";
      if (!q)
        return {
          error: "No category given and no reservation is linked to this conversation.",
          known_categories: storage.listRoomTypes().map((r) => ({ code: r.code, name_vi: r.nameVi })),
        };
      return roomTypeFacts(q, asked);
    }

    case "get_dining_facts": {
      const asked = Array.isArray(args.dish_questions) ? args.dish_questions.map(String) : [];
      const at = String(args.at_time ?? "").trim() || undefined;
      const facts = venueFacts(String(args.venue ?? "").trim(), asked, at);
      const ent = getGuestEntitlements(guest.vipTier);
      return {
        ...facts,
        guest_vip_tier: guest.vipTier,
        fnb_member_discount_percent: ent.fnbDiscountPct,
        guest_entitlements_note: `${ent.fnbDiscountPct}% off F&B (excl. alcohol) for ${guest.vipTier.toUpperCase()} member ${guest.name}`,
      };
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
        published_for_category: fitsPublishedCombination(
          typeof args.room_type === "string" && args.room_type ? findRoomType(String(args.room_type))?.row.code : room?.type,
          Number(args.adults ?? res?.adults ?? 2),
          ages.length,
        ),
        reservation_on_file: res
          ? { adults: res.adults, children: res.children, unit_type: room?.type ?? null }
          : null,
      };
    }

    case "list_services": {
      const cat = String(args.category ?? "all");
      const date = String(args.date ?? today());
      const list = storage.listServices().filter((s) => cat === "all" || s.category === cat);
      const ent = getGuestEntitlements(guest.vipTier);
      
      return {
        date,
        currency: hotel.currency,
        guest_vip_tier: guest.vipTier,
        guest_entitlements: ent,
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

          let memberDiscountPct = 0;
          if (s.category === "spa") memberDiscountPct = ent.spaDiscountPct;
          else if (s.category === "dining") memberDiscountPct = ent.fnbDiscountPct;
          else if (s.category === "golf") memberDiscountPct = ent.golfDiscountPct;

          const memberPrice = s.price > 0 && memberDiscountPct > 0 
            ? Math.round(s.price * (1 - memberDiscountPct / 100))
            : s.price;

          const images: string[] = JSON.parse(s.images || "[]");

          return {
            service_id: s.id,
            name: s.name,
            category: s.category,
            description: s.description,
            price: s.price,
            member_price: memberPrice,
            member_discount_percent: memberDiscountPct > 0 ? memberDiscountPct : undefined,
            unit: s.unit,
            availability: slots.length ? remaining.filter((r) => r.seats_left > 0) : "always available",
            images,
          };
        }),
        instruction: "For each service you list, if it has images in its result, you MUST include the exact text [IMAGES: url1,url2...] right after mentioning its name or inside its bullet point. Never invent image URLs.",
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

function getGuestEntitlements(vipTier: string) {
  const tier = (vipTier || "none").toLowerCase();
  switch (tier) {
    case "diamond":
      return {
        roomDiscountPct: 10,
        spaDiscountPct: 30,
        golfDiscountPct: 33,
        fnbDiscountPct: 20,
        earlyCheckinFreeHours: 2,
        lateCheckoutFreeHours: 2,
        notes: ["10% off room rate", "30% off Akoya Spa", "33% off Vinpearl Golf", "20% off F&B (excl. alcohol)", "Complimentary Aquafield ticket", "Up to 2h early check-in & late checkout (subject to availability)"],
      };
    case "platinum":
      return {
        roomDiscountPct: 7,
        spaDiscountPct: 30,
        golfDiscountPct: 33,
        fnbDiscountPct: 20,
        earlyCheckinFreeHours: 2,
        lateCheckoutFreeHours: 2,
        notes: ["7% off room rate", "30% off Akoya Spa", "33% off Vinpearl Golf", "20% off F&B (excl. alcohol)", "Complimentary Aquafield ticket", "Up to 2h early check-in & late checkout (subject to availability)"],
      };
    case "gold":
      return {
        roomDiscountPct: 5,
        spaDiscountPct: 30,
        golfDiscountPct: 33,
        fnbDiscountPct: 20,
        earlyCheckinFreeHours: 2,
        lateCheckoutFreeHours: 2,
        notes: ["5% off room rate", "30% off Akoya Spa", "33% off Vinpearl Golf", "20% off F&B (excl. alcohol)", "Complimentary Aquafield ticket"],
      };
    case "silver":
    case "member":
      return {
        roomDiscountPct: 5,
        spaDiscountPct: 30,
        golfDiscountPct: 33,
        fnbDiscountPct: 20,
        earlyCheckinFreeHours: 0,
        lateCheckoutFreeHours: 0,
        notes: ["5% off room rate", "30% off Akoya Spa", "33% off Vinpearl Golf", "20% off F&B (excl. alcohol)"],
      };
    default:
      return {
        roomDiscountPct: 0,
        spaDiscountPct: 0,
        golfDiscountPct: 0,
        fnbDiscountPct: 0,
        earlyCheckinFreeHours: 0,
        lateCheckoutFreeHours: 0,
        notes: [],
      };
  }
}

function buildSystemPrompt(conv: Conversation, guardNotes: string[] = []) {
  const hotel = storage.getHotel();
  const guest = storage.getGuest(conv.guestId)!;
  const res = storage.getReservation(conv.reservationId);
  const room = storage.getRoom(res?.roomId ?? null);
  const langName = LANG_NAMES[guest.lang] ?? guest.lang;
  const entitlements = getGuestEntitlements(guest.vipTier);

  return `You are the Aurea guest agent — the always-on concierge for ${hotel.name}, a property in ${hotel.city}.

BRAND VOICE
${hotel.brandVoice}

RIGHT NOW
Local date ${today()}, local time ${clock()} (${hotel.timezone}). Standard check-in ${hotel.checkInTime}, standard check-out ${hotel.checkOutTime}. Currency ${hotel.currency}.

WHO YOU ARE TALKING TO
${guest.name} — ${guest.vipTier === "none" ? "no loyalty tier" : `${guest.vipTier.toUpperCase()} Pearl Club member`}, ${guest.staysCount} stay(s) with us. Channel: ${conv.channel}. Preferred language: ${langName}.
${res ? `Reservation ${res.confirmationCode}: room ${room?.number ?? "unassigned"} (${room?.type ?? "—"}), ${res.checkIn} → ${res.checkOut}, departure time ${res.checkOutTime}, status ${res.status}.` : "No reservation is linked to this conversation."}
${guest.preferences ? `Guest Preferences: ${guest.preferences}` : ""}

AUTOMATIC GUEST ENTITLEMENTS & BENEFITS (PEARL CLUB)
${entitlements.notes.length > 0 ? entitlements.notes.map((n) => `- ${n}`).join("\n") : "No specific tier benefits."}
CRITICAL PERSONALIZATION PRINCIPLE:
Whenever quoting prices for ANY service, buffet, or dining menu item (whether from list_services or get_dining_facts), ALWAYS explicitly calculate and present their member discounted price!
- F&B Dining / Buffet: ${entitlements.fnbDiscountPct}% off for ${guest.vipTier.toUpperCase()} (e.g. Lotus Buffet 650.000 ₫ → 520.000 ₫ cho Platinum)
- Spa: ${entitlements.spaDiscountPct}% off for ${guest.vipTier.toUpperCase()}
- Golf: ${entitlements.golfDiscountPct}% off for ${guest.vipTier.toUpperCase()}

DINING & SERVICE BOOKING FLOW REQUIREMENTS:
1. When a guest asks about or wants to book a dining menu/venue, quote the prices AND their member discounted price (e.g., "Lotus Buffet: 650.000 ₫/người lớn — chỉ còn 520.000 ₫ cho hội viên Platinum").
2. Ask for the missing required booking details in ONE sentence at the end:
   - Preferred time slot
   - Number of guests (adults & children)

CORE CONCIERGE OPERATING PRINCIPLES
1. MULTI-SOURCE GATHERING (DO NOT STOP AT 1 TOOL):
   When answering service, facility, room, or venue queries, ALWAYS query ALL relevant sources in parallel (e.g., call both list_services AND search_knowledge to get full menus, opening hours, locations, and policies). Never stop at a partial list from a single tool.

2. PROACTIVE CONCIERGE SELF-CHECK:
   Before sending any response, ask yourself:
   - Have I included operating hours / opening times if applicable?
   - Have I applied the guest's member discounts/entitlements (F&B 20%, Spa 30%) if applicable?
   - Does this answer align with their stay details or preferences?
   - Is there an obvious next step (asking for time slot & party size to reserve)?

3. GROUNDING & ACCURACY:
   - State facts strictly returned by tools. Never invent prices, times, or policies.
   - If information is missing from tool outputs, state that it will be confirmed with the team and offer to check.

4. HANDLING GIBBERISH / NONSENSE / VAGUE MESSAGES:
   - If the guest sends meaningless typos, single-character tests (e.g. "Gi", "asdf", "???"), or unrecognizable input, do NOT treat it as a continuation of previous tool calls unless clearly related.
   - Respond in ONE friendly, polite sentence clarifying how you can help (e.g., "Dạ, anh/chị cần em hỗ trợ thêm thông tin gì về dịch vụ, nhà hàng hay trả phòng không ạ?"). Never repeat instructions mechanically.

LANGUAGE
Always answer in the language the guest just wrote in. If they write in ${langName}, answer in ${langName}. Match their register. Never mix languages in one reply unless quoting a proper name.

HOW YOU THINK
Work the request out before you answer. Silently, in this order, every time:
1. DECOMPOSE. Break the message into the separate things that have to be true for your answer to be right.
2. GROUND. Resolve each part with a tool. Call multiple independent tools in parallel when needed (e.g. list_services + search_knowledge + get_stay_details).
3. COMPUTE & PERSONALIZE. Calculate fees via tools. Apply member entitlements (discounts/benefits) to every quoted rate.
4. VERIFY. Re-read the tool output against what the guest asked. Ensure completeness (hours, prices, member rates, booking options).
5. RESOLVE THE WHOLE REQUEST. Answer implied questions (timing, discounts, next steps) in the same reply.

HOW YOU WORK
1. You are not a chatbot that only chats — you complete the work. When a guest wants something done, use the tools to actually do it.
2. Never state a fact about the property, prices, hours or policy from your own knowledge. Facts come only from tools.
3. Quote before you commit. State prices and member rates, get explicit confirmation before booking/requesting.
4. Escalate rather than improvise: anger, billing disputes, safety, medical, security.

STYLE
Format your response cleanly using standard markdown so it is effortless to scan on mobile:
- When listing items (venues, treatments, amenities, rates), put each item on its own bullet point line.
- Keep item titles in **Bold**, followed by details (e.g., **Balinese Massage 90'** · 2.300.000 ₫ — **1.610.000 ₫** cho Platinum).
- Group items logically with a short bold label when appropriate.
- Keep explanations clear and concise. Never hardcode or fake data. Sign nothing.${guardNotes.length ? `\n\nSCREENING NOTES FOR THIS MESSAGE — these override the style rules above if they conflict.\n${guardNotes.join("\n")}` : ""}`;
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

  const lastGuest = [...history].reverse().find((m) => m.role === "guest");
  const guard = screenGuestMessage(lastGuest?.body ?? "");

  const msgs: ChatMessage[] = [{ role: "system", content: buildSystemPrompt(conv, guard.notes) }];
  for (const m of history.slice(-24)) {
    if (m.role === "guest") msgs.push({ role: "user", content: redactCards(m.body).text });
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

  // An emergency escalates whatever the model decided to write.
  if (guard.forceEscalation && !escalated) {
    const t0 = Date.now();
    const result = await runTool(
      "escalate_to_human",
      {
        reason:
          guard.emergencyKind === "medical"
            ? "Guest reported a possible medical emergency in chat — screened by the message guard."
            : "Guest reported a safety or security emergency in chat — screened by the message guard.",
        priority: "urgent",
      },
      { conversation: conv },
    );
    trace.push({ name: "escalate_to_human", args: { forced_by: "guard" }, result, ms: Date.now() - t0 });
    escalated = true;
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
