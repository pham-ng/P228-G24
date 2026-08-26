import { storage, nowIso, hotelToday, hotelClock, db } from "./storage";
import { serviceBookings } from "@shared/schema";
import { eq } from "drizzle-orm";
import { hybridSearch } from "./retrieval";
import { fitsPublishedCombination, findRoomType, roomTypeFacts } from "./catalogue";
import { venueFacts, detectReferencedVenues } from "./dining";
import { detectReferencedRoomTypes } from "./rooms";
import { detectReferencedServices } from "./services";
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
import {
  folioSummary,
  getEntitlements,
  postCharge,
  priceService,
  quoteReservationCancellation,
  quoteServiceCancellation,
  quoteTaxGrossUp,
  reverseCharge,
} from "./pricing";
import {
  OPS_TOOLS,
  OPS_TOOL_NAMES,
  bookCatalogueService,
  ensureOpsPolicies,
  fetchWeather,
  hotelIso,
  runOpsTool,
} from "./ops";
import type { OpsCtx } from "./ops";
import { DEPT_KEYS } from "@shared/schema";
import { agentModel, chat, classify, FALLBACK, LlmError, MODEL_AGENT, PRIMARY } from "./openai";
import {
  resolveFindCapability,
  selectTools,
  TOOL_BUDGET,
  type FamilyName,
} from "./toolrouter";
import { checkReply, repairReply, type GuardVerdict } from "./numguard";
import {
  Trace,
  deriveToolSignals,
  deriveRouterSignals,
  detectLanguageMismatch,
  toolSignature,
} from "./observability";
import { recommend, compareRooms, type RoomContext } from "./upsell";
import { runLocalTurn, type ReplyLang } from "./local-agent";
import { suggestInStay, type Weather } from "./crosssell";
import { detectPendingTransaction, processFormWizardTurn } from "./wizard";
import type { ChatMessage, ToolSpec } from "./openai";
import type { Conversation, ToolCallTrace, Message } from "@shared/schema";

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
        "Compute the early-arrival charge for this reservation at a given arrival time from the published bands. Read-only: it changes nothing. Always call this before quoting an early check-in price, or call request_early_checkin directly to apply/book early arrival.",
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
      name: "quote_tax_gross_up",
      description:
        "Compute what a guest actually pays on top of a NET price the guest names — applies the published service charge then VAT from TAX_AND_SERVICE. Use this for any 'if it costs X, what's the total after tax/fees' question that is not already an actual folio charge (get_folio is for real charges on this stay). Never compute service charge or VAT by hand.",
      parameters: {
        type: "object",
        properties: {
          net_amount: { type: "number", description: "The net price the guest quoted, before service charge and VAT, in the property's currency." },
        },
        required: ["net_amount"],
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
        "List bookable services with live prices and available time slots. Categories: dining, spa, experience, transport, roomservice. DO NOT use for hotel room prices or room types! Use search_knowledge or check_availability for room rates.",
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
        "Queue a service slot reservation for this guest to be reviewed by staff. Only call after the guest has confirmed the service, date, time and party size. This does NOT confirm the booking or charge the folio itself — it creates a pending request a staff member must approve before it takes effect. Tell the guest it is awaiting confirmation, never that it is booked.",
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
        "Queue an in-room dining order for Food & Beverage to review and approve. Only call after the guest confirms the items. This does NOT charge the folio or start preparation itself — a staff member must approve it first. Tell the guest it is awaiting confirmation, never that it is being prepared.",
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
        "Check whether a later departure time is possible and queue it for staff approval. The system verifies whether the room is resold that day and computes the correct fee for the guest's tier, but does NOT apply it or post the fee itself — a staff member must approve first. Tell the guest it is awaiting confirmation, never that it is applied.",
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
      description:
        "Read the guest's current bill: every charge and the running total. For a HYPOTHETICAL amount the guest names ('if a service costs X') that is not an actual charge on this stay, use quote_tax_gross_up instead — do not read the folio to answer a hypothetical.",
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
            enum: [...DEPT_KEYS],
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
      name: "recommend_room_packages",
      description:
        "Rate packages + upsell ladder. Use for any room price, which-room, or budget question. Returns the cheapest match to quote first, dearer ones with extra cost and what it adds, and clarify chips when the guest said too little.",
      parameters: {
        type: "object",
        properties: {
          room_type: { type: "string", description: "Guest's words; empty if unnamed." },
          max_price_per_night: { type: "number", description: "VND/night" },
          must_have: {
            type: "array",
            items: { type: "string" },
            description:
              "breakfast|full_board|vinwonders|golf|hotel_credit|spa|sauna|cable_car|pool|ocean_view|family_4",
          },
          guests: { type: "number" },
          traveller: {
            type: "string",
            enum: ["golf", "family", "couple", "wellness", "business", "honeymoon", "anniversary", "birthday"],
            description: "Who is travelling / what they are celebrating, if revealed. Ranks suggestions; never hides options.",
          },
          too_expensive: {
            type: "boolean",
            description: "Set when the guest says the price is too high — returns cheaper options and what they drop.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "suggest_experiences",
      description:
        "For a guest already staying: what to suggest right now, ranked by time of day, weather, how many nights are left and their tier. Use when they ask what to do, where to eat, or how to spend an evening. Each suggestion carries the reason to give them.",
      parameters: {
        type: "object",
        properties: {
          interest: { type: "string", description: "What they asked for, in their words, if anything." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compare_room_types",
      description:
        "Compare room categories side by side: size, capacity, view, private pool, and each one's starting price. Use when the guest asks how two categories differ or which to choose.",
      parameters: {
        type: "object",
        properties: {
          rooms: {
            type: "string",
            description: "Categories to compare in the guest's words, e.g. 'deluxe và grand deluxe'. Empty compares all.",
          },
        },
        required: [],
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
  {
    type: "function",
    function: {
      name: "cancel_reservation",
      description:
        "Queue cancellation of a confirmed room reservation for staff approval. Checks cancellation policies (e.g. free cancellation vs fee window) and computes the fee, but does NOT cancel it, reverse charges, or release the room itself — a staff member must approve first. Always ask for guest confirmation of the reservation code before calling. Tell the guest it is awaiting confirmation, never that it is cancelled.",
      parameters: {
        type: "object",
        properties: {
          confirmation_code: {
            type: "string",
            description: "Reservation confirmation code (e.g., VPNT-7H23PC). Defaults to the stay linked to this chat.",
          },
          reason: { type: "string", description: "Reason for cancellation given by guest." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_service_booking",
      description:
        "Queue a cancellation of an existing service booking, dining table reservation, or folio service charge, for staff to review. Use this whenever the guest asks to cancel any booked service, meal/dining reservation, spa treatment, or activity. This does NOT cancel it or reverse the charge itself — a staff member must approve the cancellation before it takes effect. Tell the guest it is awaiting confirmation, never that it is cancelled.",
      parameters: {
        type: "object",
        properties: {
          booking_id: {
            type: "integer",
            description: "Service booking ID if known.",
          },
          service_name: { type: "string", description: "Name or category of the service (e.g., 'bàn ăn', 'spa', 'dining', 'lotus')." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_guest_preferences",
      description:
        "Save or update dietary requirements, room preferences, allergies, or special requests directly into the guest's profile. Call whenever a guest states a persistent preference (e.g., 'Tôi bị dị ứng hải sản', 'Thích phòng tầng cao').",
      parameters: {
        type: "object",
        properties: {
          preferences: {
            type: "array",
            items: { type: "string" },
            description: "List of preference statements or tags to add (e.g. ['seafood allergy', 'high floor', 'quiet room']).",
          },
          notes: { type: "string", description: "Detailed note to append to guest profile." },
        },
        required: ["preferences"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_weather",
      description:
        "Get live weather forecasts for the resort location for today or an upcoming date. Use whenever guests ask about weather, rain, temperature, or outdoor conditions.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "YYYY-MM-DD date for forecast. Defaults to today." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_early_checkin",
      description:
        "Request an early arrival/check-in time for the reservation and queue it for staff approval. Call this tool when a guest requests to check in early (e.g. at 09:00). Computes fee/waiver from policy, but does NOT apply it or update PMS records itself — a staff member must approve first. Tell the guest it is awaiting confirmation, never that it is applied.",
      parameters: {
        type: "object",
        properties: {
          requested_time: { type: "string", description: "Desired arrival time, HH:MM 24-hour format (e.g., 09:00)." },
        },
        required: ["requested_time"],
      },
    },
  },

  /* Operational concierge tools — lodging declaration, folio settlement,
   * housekeeping and engineering dispatch, laundry, luggage, transport, lost
   * property, room moves, express checkout, invoices, loyalty, feedback and
   * live weather. Defined in ops.ts so this file stays the conversational
   * layer. */
  ...OPS_TOOLS,
];

/**
 * Tools reserved for the hosted API path.
 *
 * Personalised upselling is a judgement task: read what the guest revealed about
 * themselves, quote the cheapest honest option, then narrate one or two upgrades
 * in a way that helps rather than pushes. The 4B local model does not do that
 * well — it drops the qualifying conditions, mangles the arithmetic in prose, or
 * turns a suggestion into a hard sell. A clumsy upsell costs more trust than the
 * feature earns, so on the offline path the concierge simply does not offer it
 * and answers room questions from the catalogue instead.
 *
 * Withholding it locally also keeps the tool block inside the 8K context the
 * offline path has to live in — the capability and the budget point the same way.
 */
const OPENAI_ONLY_TOOLS = new Set(["recommend_room_packages", "compare_room_types", "suggest_experiences"]);

/** The tool set a given provider may see. */
export function toolsForProvider(provider: "local" | "openai"): ToolSpec[] {
  return provider === "openai" ? TOOLS : TOOLS.filter((t) => !OPENAI_ONLY_TOOLS.has(t.function.name));
}

/* ------------------------------------------------------------------ *
 * Tool implementations — every one of these touches the database
 * ------------------------------------------------------------------ */

type Ctx = { conversation: Conversation };

/**
 * Which language to render tool-facing labels in.
 *
 * The guest's stored profile is the wrong source on its own: a guest whose
 * profile says Chinese may still be typing Vietnamese, and rendering their
 * preference chips in the profile language hands them buttons they cannot read.
 * The most recent message wins, exactly as the system prompt requires; the
 * profile is only the fallback when the message gives no signal.
 */
function replyLang(conv: Conversation, profileLang: string): "vi" | "en" {
  const lastGuest = [...storage.listMessages(conv.id)].reverse().find((m) => m.role === "guest");
  const detected = detectMessageLang(lastGuest?.body ?? "");
  if (detected === "vi") return "vi";
  /* Any other identified script means the guest is not writing Vietnamese, so
     fall to English labels rather than guessing wrong. */
  if (detected) return "en";
  return profileLang === "vi" ? "vi" : "en";
}

/**
 * Same detection as `replyLang`, but for the offline pipeline's answer
 * prompt, which supports the full range `runLocalTurn` accepts (vi/en/zh/ja/
 * ko/ru) rather than the two-way vi/en collapse the hosted tool-label
 * renderers above are stuck with.
 *
 * `replyLang` cannot simply be widened: three call sites feed its result into
 * `compareRooms`, whose `lang` parameter is typed `"vi" | "en"` because its
 * comparison labels only exist in those two languages — passing it `"ko"`
 * would not translate anything, it would be a type error waiting to happen
 * the day someone removes the narrowing. A Korean guest's OWN reply, read
 * straight from a retrieved passage and phrased by the model, has no such
 * limitation; only the hard-coded tool-output labels do.
 *
 * Before this function existed, `runOfflineTurn` used `replyLang()` directly,
 * so every Korean, Japanese or Chinese guest on the offline path was told to
 * answer in English regardless of what `detectMessageLang` correctly found —
 * confirmed by reading this exact call site (`server/agent.ts`, the offline
 * turn), not inferred from a failing benchmark case: the benchmark calls
 * `runLocalTurn` directly and never exercises this function at all, which is
 * exactly why the bug went unnoticed while CJK retrieval numbers looked fine.
 */
export function offlineReplyLang(conv: Conversation, profileLang: string): ReplyLang {
  const lastGuest = [...storage.listMessages(conv.id)].reverse().find((m) => m.role === "guest");
  const detected = detectMessageLang(lastGuest?.body ?? "");
  if (detected === "vi" || detected === "ko" || detected === "ja" || detected === "zh" || detected === "ru") {
    return detected;
  }
  if (detected === "en") return "en";
  /* detectMessageLang found nothing (plain ASCII with no script signal, or an
     empty message) — same fallback order replyLang uses. */
  return profileLang === "vi" ? "vi" : profileLang === "en" ? "en" : "en";
}

/**
 * Identify the language of a single message by script.
 *
 * Only used to tell the model, in the prompt, which language it is replying to.
 * A stored profile is not good enough for that: a guest whose profile says
 * Chinese may be typing Vietnamese, and the model — seeing "Preferred language:
 * Chinese" next to a Chinese name — will answer in Chinese anyway. Stating the
 * detected language of the actual message removes that ambiguity.
 *
 * Script detection covers Korean, Japanese, Chinese, Russian and Vietnamese by
 * script or diacritic. English has neither, so it used to fall through to
 * null — and the caller's fallback for null is a vague "reply in the guest's
 * language" instruction, sitting right below a concrete "Preferred language: X"
 * line pulled from the guest's stored profile. Measured on a 105-case hosted
 * benchmark, the concrete line won: 9 of 13 English-language cases came back
 * in Vietnamese, including guests whose profile wasn't even Vietnamese. A vague
 * instruction next to a specific contradictory one is not neutral, it loses.
 *
 * So plain ASCII text with no accented character at all is now treated as
 * English — true for this resort's guest mix far more often than any other
 * language, and confirmed by the same benchmark's own English cases. Any text
 * carrying an accented Latin character (French, German, Spanish…) still falls
 * through to null exactly as before; that combination isn't in the benchmark
 * and this fix doesn't claim to have measured it.
 */
export function detectMessageLang(text: string): string | null {
  if (!text.trim()) return null;
  if (/[가-힯]/.test(text)) return "ko";
  if (/[぀-ヿ]/.test(text)) return "ja";
  if (/[一-鿿]/.test(text)) return "zh";
  if (/[Ѐ-ӿ]/.test(text)) return "ru";
  if (
    /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i.test(text)
  )
    return "vi";
  const isAsciiOnly = ![...text].some((ch) => ch.charCodeAt(0) > 127);
  if (isAsciiOnly && /[a-zA-Z]{2,}/.test(text)) return "en";
  return null;
}

/**
 * The sentence a guest reads when their turn is handed to a person.
 *
 * This used to be a two-way vi/en choice, so a Korean guest asking about towels
 * and a Chinese guest asking about dinner both got an ENGLISH handoff — and the
 * gold benchmark scored both as passes, because those cases carried no assertion
 * at all. Answering someone in a language they did not write in is the most
 * visible failure a concierge can have, and it happened on the one turn where we
 * are already admitting we could not help.
 *
 * The script detector covers ko/ja/zh/ru; Latin scripts other than Vietnamese
 * fall back to English, which is the same limit the detector itself documents.
 */
export function handoffLine(lang: string | null | undefined, kind: "confirm" | "failed"): string {
  const L = (lang ?? "vi").slice(0, 2).toLowerCase();
  const lines: Record<string, { confirm: string; failed: string }> = {
    vi: {
      confirm: "Dạ, câu này em cần lễ tân xác nhận để trả lời chính xác. Em đã chuyển cho đồng nghiệp hỗ trợ anh/chị ngay ạ.",
      failed: "Dạ, em xin lỗi — em chưa lấy được thông tin chính xác cho câu hỏi này. Em đã chuyển cho lễ tân để hỗ trợ anh/chị ngay ạ.",
    },
    ko: {
      confirm: "정확한 답변을 위해 프런트 데스크의 확인이 필요합니다. 담당 직원에게 전달해 드렸습니다.",
      failed: "죄송합니다 — 정확한 정보를 확인하지 못했습니다. 프런트 데스크로 전달해 드렸으니 곧 도와드리겠습니다.",
    },
    ja: {
      confirm: "正確にお答えするため、フロントに確認いたします。担当者にお繋ぎいたしました。",
      failed: "申し訳ございません — 正確な情報を確認できませんでした。フロントにお繋ぎいたしましたので、すぐに対応いたします。",
    },
    zh: {
      confirm: "为了给您准确的答复，需要前台确认。我已经转交同事为您处理了。",
      failed: "很抱歉 — 我未能查到准确的信息。已经转交前台，同事会马上为您处理。",
    },
    ru: {
      confirm: "Чтобы ответить точно, нужно подтверждение стойки регистрации. Я передал(а) ваш вопрос коллеге.",
      failed: "Извините — мне не удалось получить точную информацию. Я передал(а) вопрос на стойку регистрации, коллега поможет вам сейчас же.",
    },
    en: {
      confirm: "I'd like a colleague to confirm this so the answer is exact. I've passed it to the front desk for you.",
      failed: "I'm sorry — I couldn't retrieve a reliable answer for that. I've passed it to the front desk so a colleague can help you right away.",
    },
  };
  return (lines[L] ?? lines.en)[kind];
}

export async function runTool(name: string, args: any, ctx: Ctx): Promise<Record<string, unknown> | string> {
  const conv = storage.getConversation(ctx.conversation.id)!;
  const guest = storage.getGuest(conv.guestId)!;
  const res = storage.getReservation(conv.reservationId);
  const room = storage.getRoom(res?.roomId ?? null);
  const hotel = storage.getHotel();

  /* The context every operational tool needs. Built lazily so tools that do
   * not touch operations pay nothing for it. */
  const opsCtx = (): OpsCtx => ({ hotel, guest, res, room, conv });

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

    case "recommend_room_packages": {
      /* Every figure here is read from the rate-package rows, never computed by
         the model — the same rule the folio and quote tools follow. */
      const packages = storage.listRoomPackages();
      if (!packages.length)
        return {
          error: "No rate packages are loaded. Run server/migrations/005-rate-packages.ts.",
          instruction: "Tell the guest you will check rates with the front desk. Do NOT quote a price.",
        };
      const rooms: RoomContext[] = storage.listRoomTypes().map((r) => ({
        code: r.code,
        nameVi: r.nameVi,
        maxGuests: r.maxGuests,
        privatePool: !!r.privatePool,
        oceanView: !!r.oceanView,
        areaSqm: r.areaSqm,
      }));
      const rec = recommend(packages, rooms, {
        roomQuery: typeof args.room_type === "string" ? args.room_type : "",
        maxPrice: typeof args.max_price_per_night === "number" ? args.max_price_per_night : undefined,
        mustHave: Array.isArray(args.must_have) ? args.must_have.map(String) : [],
        guests: typeof args.guests === "number" ? args.guests : undefined,
        traveller: typeof args.traveller === "string" ? (args.traveller as any) : undefined,
        tooExpensive: args.too_expensive === true,
        lang: replyLang(conv, guest.lang),
      });
      return {
        ...rec,
        currency: hotel.currency,
        guest_vip_tier: guest.vipTier,
        instruction:
          rec.mode === "clarify"
            ? "Hỏi lại NGẮN, ẤM ÁP, như một nhân viên concierge thật: một câu hỏi tự nhiên về nhu cầu (đi mấy người, dịp gì, quan tâm điều gì). Liệt kê các lựa chọn trong 'clarify' để khách chọn. KHÔNG tự chọn phòng, KHÔNG báo giá."
            : rec.mode === "empty"
              ? "Nói thật là chưa có gói nào khớp, nêu đúng lý do trong 'note' bằng lời tự nhiên, rồi hỏi khách muốn linh động ở tiêu chí nào. KHÔNG tự bỏ tiêu chí của khách và KHÔNG báo giá gói không khớp."
              : "VIẾT NHƯ MỘT CONCIERGE THẬT, KHÔNG NHƯ MÁY:\n" +
                "1. Báo 'base' trước — đúng public_price (nêu member_price nếu khách là hội viên), kèm 1-2 điểm hay nhất của gói.\n" +
                "2. Gợi ý TỐI ĐA 2 gói trong 'upsells', ưu tiên gói có suits_traveller=true. Diễn đạt theo lợi ích, ví dụ: 'Chỉ thêm 600.000đ/đêm là cả nhà có trọn 3 bữa buffet và vé VinWonders không giới hạn ạ.'\n" +
                "3. Giọng tự nhiên, ấm áp, KHÔNG liệt kê khô khan, KHÔNG ép mua. Gợi ý xong thì để khách tự quyết.\n" +
                "4. Mọi con số phải lấy đúng từ kết quả này. Nếu có has_blackout hoặc conditions thì nói rõ điều kiện — KHÔNG tự tính hạn huỷ.",
      };
    }

    case "suggest_experiences": {
      if (!res) return { error: "No reservation is linked to this conversation, so there is no stay to suggest around." };
      /* Weather is a signal, not a requirement: when the forecast is unavailable
         the ranking simply loses the indoor/outdoor tilt rather than failing. */
      let weather: Weather | undefined;
      try {
        const w = (await fetchWeather(today(), hotel)) as Record<string, unknown>;
        weather = {
          condition: typeof w.condition === "string" ? w.condition : undefined,
          rainChance: typeof w.rain_chance_percent === "number" ? w.rain_chance_percent : undefined,
        };
      } catch {
        weather = undefined;
      }

      const out = suggestInStay({
        services: storage.listServices(),
        offers: storage.listOffers(),
        guest,
        reservation: res,
        today: today(),
        clock: clock(),
        weather,
        alreadyBooked: storage
          .bookingsForReservation(res.id)
          .filter((b) => b.status === "confirmed")
          .map((b) => b.serviceId),
        interest: typeof args.interest === "string" ? args.interest : undefined,
        lang: replyLang(conv, guest.lang),
      });
      return {
        ...out,
        currency: hotel.currency,
        guest_vip_tier: guest.vipTier,
        instruction:
          out.note +
          " Gọi list_services nếu cần giá chính xác, và book_service khi khách đồng ý. TUYỆT ĐỐI không tự tính giá hay giảm giá.",
      };
    }

    case "compare_room_types": {
      const packages = storage.listRoomPackages();
      const rooms: RoomContext[] = storage.listRoomTypes().map((r) => ({
        code: r.code,
        nameVi: r.nameVi,
        maxGuests: r.maxGuests,
        privatePool: !!r.privatePool,
        oceanView: !!r.oceanView,
        areaSqm: r.areaSqm,
      }));
      const cmp = compareRooms(packages, rooms, String(args.rooms ?? ""), replyLang(conv, guest.lang));
      return { ...cmp, currency: hotel.currency, instruction: cmp.note };
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
        vipTier: guest.vipTier,
      });
    }

    case "quote_tax_gross_up": {
      const amount = Number(args.net_amount);
      if (!Number.isFinite(amount) || amount < 0)
        return { error: "net_amount must be a non-negative number." };
      return quoteTaxGrossUp(amount);
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

          /* One pricing engine only. `priceService` decides the discount
           * bucket (spa / f&b / golf / other) and does the rounding, so the
           * figure quoted here is byte-for-byte the figure `book_service`
           * charges and `cancel_service_booking` refunds. */
          const priced = priceService(s, guest.vipTier, 1, hotel.currency);
          const memberDiscountPct = priced.discount_pct;
          const memberPrice = priced.member_unit_price;

          const images: string[] = JSON.parse(s.images || "[]");

          return {
            service_id: s.id,
            name: s.name,
            category: s.category,
            description: s.description,
            price: s.price,
            member_price: memberPrice,
            member_discount_percent: memberDiscountPct > 0 ? memberDiscountPct : undefined,
            price_calculation: priced.calculation,
            unit: s.unit,
            availability: slots.length ? remaining.filter((r) => r.seats_left > 0) : "always available",
            images,
          };
        }),
        instruction: "For each service you list, if it has images in its result, you MUST include the exact text [IMAGES: url1,url2...] right after mentioning its name or inside its bullet point. Never invent image URLs.",
      };
    }

    case "book_service": {
      /* All catalogue bookings — services, tours, meeting rooms — go through
       * one core in ops.ts. That core prices with `priceService`, posts the
       * folio line with `postCharge`, stores the amount and charge id on the
       * booking row and records the cancellation deadline, so the price
       * quoted, charged and later refunded cannot drift apart. */
      return bookCatalogueService(opsCtx(), {
        serviceId: Number(args.service_id),
        date: String(args.date),
        slot: String(args.slot),
        partySize: Math.max(1, Number(args.party_size ?? 1)),
        note: args.note ? String(args.note) : undefined,
      }) as Record<string, unknown>;
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
      /* HITL gate: no charge posted yet — only queued. Staff approval (see
       * finalizeApproval in ops.ts) is what actually posts it and starts
       * the kitchen clock. */
      const task = storage.createTask({
        hotelId: hotel.id,
        reservationId: res.id,
        roomId: res.roomId,
        conversationId: conv.id,
        dept: "fnb",
        title: `CẦN DUYỆT — In-room dining — room ${room?.number ?? "—"}`,
        detail: `${lines.join(", ")}.${args.note ? ` Note: ${args.note}` : ""} Guest: ${guest.name}. Đang chờ duyệt.`,
        priority: "high",
        status: "open",
        source: "ai",
        assignedStaffId: null,
        dueAt: new Date(Date.now() + 35 * 60_000).toISOString(),
        createdAt: nowIso(),
        resolvedAt: null,
      });
      const approval = storage.createApproval({
        hotelId: hotel.id,
        reservationId: res.id,
        guestId: guest.id,
        conversationId: conv.id,
        taskId: task.id,
        kind: "order_room_service",
        summary: `In-room dining — ${lines.join(", ")} — ${total.toLocaleString("vi-VN")} ${hotel.currency}`,
        payload: JSON.stringify({ reservationId: res.id, items: items.map((it: any, i: number) => ({ line: lines[i] })), total }),
        amount: total,
        status: "pending",
        createdAt: nowIso(),
        resolvedAt: null,
        resolvedBy: null,
        rejectionReason: null,
      });
      storage.logEvent({
        type: "order.queued_for_approval",
        actor: "ai",
        summary: `In-room dining order queued for ${guest.name}: ${lines.join(", ")}.`,
        payload: JSON.stringify({ taskId: task.id, approvalId: approval.id, total }),
        conversationId: conv.id,
        createdAt: nowIso(),
      });
      return {
        ordered: false,
        pending_approval: true,
        approval_id: approval.id,
        items: lines,
        pending_amount: total,
        currency: hotel.currency,
        eta_minutes: 35,
        dispatched_to: "fnb",
        instruction:
          "Yêu cầu đã được ghi nhận và chuyển bếp/FnB duyệt — nói với khách là ĐANG CHỜ XÁC NHẬN, TUYỆT ĐỐI KHÔNG nói là đã đặt món/đang chuẩn bị.",
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

      /* HITL gate: checkOutTime is not written and no fee is posted until
       * staff approve — the PMS/folio must not move on the AI's say-so alone. */
      const task = storage.createTask({
        hotelId: hotel.id,
        reservationId: res.id,
        roomId: res.roomId,
        conversationId: conv.id,
        dept: "housekeeping",
        title: `CẦN DUYỆT — Trả phòng muộn ${want} — phòng ${room?.number ?? "—"}`,
        detail: `${guest.name} muốn trả phòng muộn lúc ${want} ngày ${res.checkOut}. ${fee ? `Phí dự kiến ${fee.toLocaleString("vi-VN")} ${hotel.currency}.` : "Miễn phí theo chính sách/hạng thẻ."} Đang chờ duyệt.`,
        priority: "normal",
        status: "open",
        source: "ai",
        assignedStaffId: null,
        dueAt: `${res.checkOut}T${want}:00`,
        createdAt: nowIso(),
        resolvedAt: null,
      });
      const approval = storage.createApproval({
        hotelId: hotel.id,
        reservationId: res.id,
        guestId: guest.id,
        conversationId: conv.id,
        taskId: task.id,
        kind: "request_late_checkout",
        summary: `Trả phòng muộn ${want} — ${res.confirmationCode} — ${fee.toLocaleString("vi-VN")} ${hotel.currency}`,
        payload: JSON.stringify({ reservationId: res.id, want, fee }),
        amount: fee,
        status: "pending",
        createdAt: nowIso(),
        resolvedAt: null,
        resolvedBy: null,
        rejectionReason: null,
      });
      storage.logEvent({
        type: "reservation.late_checkout_queued",
        actor: "ai",
        summary: `Yêu cầu trả phòng muộn cho ${res.confirmationCode} lúc ${want} — chờ duyệt${fee ? ` (phí ${fee} ${hotel.currency})` : " (miễn phí)"}.`,
        payload: JSON.stringify({ approvalId: approval.id, taskId: task.id, fee }),
        conversationId: conv.id,
        createdAt: nowIso(),
      });
      return {
        approved: false,
        pending_approval: true,
        approval_id: approval.id,
        requested_departure_time: want,
        band: quote.band,
        percent_of_package_rate: quote.percent_of_package_rate,
        expected_fee: fee,
        currency: hotel.currency,
        calculation: quote.calculation,
        complimentary_reason: tierFree ? quote.waiver : null,
        policy: quote.policy,
        task_id: task.id,
        instruction:
          "Yêu cầu đã được ghi nhận và chuyển lễ tân duyệt — nêu đúng mức phí dự kiến, nói rõ ĐANG CHỜ XÁC NHẬN. TUYỆT ĐỐI KHÔNG nói là đã xác nhận/đã áp dụng.",
      };
    }

    case "get_folio": {
      if (!res) return { error: "No reservation linked." };
      /* A hotel bill is not the sum of its lines: service charge and VAT sit on
       * top, payments come off, and voided lines must not be counted twice.
       * `folioSummary` is the only place that arithmetic lives. */
      const summary = folioSummary(res.id);
      return {
        confirmation_code: res.confirmationCode,
        ...summary,
        instruction:
          "Chỉ đọc lại đúng các con số trong kết quả này: subtotal, phí phục vụ, VAT, đã thanh toán và balance_due. KHÔNG tự cộng lại các dòng và KHÔNG bỏ qua thuế.",
      };
    }

    case "create_task": {
      const task = storage.createTask({
        hotelId: hotel.id,
        reservationId: res?.id ?? null,
        roomId: res?.roomId ?? null,
        conversationId: conv.id,
        dept: DEPT_KEYS.includes(String(args.dept) as any) ? String(args.dept) : "front_desk",
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

    case "cancel_reservation": {
      const code = String(args.confirmation_code || res?.confirmationCode || "").trim().toUpperCase();
      if (!code) return { error: "No confirmation code supplied or linked to this conversation." };
      const targetRes = storage.getReservationByCode(code);
      if (!targetRes) return { error: `Reservation with code ${code} not found.` };

      /* A cancellation is a money event, not a status flip. The policy engine
       * decides whether it may be cancelled at all and what it costs; only
       * then is anything written. */
      const quote = quoteReservationCancellation(targetRes, today(), hotel.currency);
      if (!quote.cancellable) {
        return {
          cancelled: false,
          confirmation_code: code,
          status: targetRes.status,
          reason: quote.reason_not_cancellable,
          needs_staff: true,
          instruction:
            "KHÔNG được nói là đã hủy. Giải thích lý do cho khách và chuyển lễ tân xử lý bằng escalate_to_human nếu khách vẫn muốn.",
        };
      }

      const fee = quote.fee ?? 0;

      /* HITL gate: nothing is reversed, cancelled or flipped yet — staff
       * approval (finalizeApproval in ops.ts) performs this exact sequence
       * (fee charge, room-line reversal, linked-booking cancellation,
       * reservation status flip) only once approved. */
      const task = storage.createTask({
        hotelId: hotel.id,
        reservationId: targetRes.id,
        roomId: targetRes.roomId,
        conversationId: conv.id,
        dept: "front_desk",
        title: `CẦN DUYỆT — Hủy đặt phòng — ${code}`,
        detail: `Yêu cầu hủy đặt phòng ${code} (${guest.name}). Lý do: ${args.reason || "khách yêu cầu"
          }. Phí hủy dự kiến: ${fee ? `${fee.toLocaleString("vi-VN")} ${hotel.currency}` : "miễn phí"} (${quote.band}). Đang chờ duyệt.`,
        priority: "high",
        status: "open",
        source: "ai",
        assignedStaffId: null,
        dueAt: nowIso(),
        createdAt: nowIso(),
        resolvedAt: null,
      });

      const approval = storage.createApproval({
        hotelId: hotel.id,
        reservationId: targetRes.id,
        guestId: guest.id,
        conversationId: conv.id,
        taskId: task.id,
        kind: "cancel_reservation",
        summary: `Hủy đặt phòng ${code} — phí ${fee.toLocaleString("vi-VN")} ${hotel.currency} (${quote.band})`,
        payload: JSON.stringify({ reservationId: targetRes.id, code, fee, band: quote.band, reason: args.reason ?? null }),
        amount: fee,
        status: "pending",
        createdAt: nowIso(),
        resolvedAt: null,
        resolvedBy: null,
        rejectionReason: null,
      });

      storage.logEvent({
        type: "reservation.cancel_queued",
        actor: "ai",
        summary: `Yêu cầu hủy đặt phòng ${code} — chờ duyệt, phí dự kiến ${fee.toLocaleString("vi-VN")} ${hotel.currency}.`,
        payload: JSON.stringify({ reservationId: targetRes.id, approvalId: approval.id, fee, taskId: task.id }),
        conversationId: conv.id,
        createdAt: nowIso(),
      });

      return {
        cancelled: false,
        pending_approval: true,
        approval_id: approval.id,
        confirmation_code: code,
        status: targetRes.status,
        days_before_arrival: quote.days_before_arrival,
        band: quote.band,
        fee_pct: quote.fee_pct,
        expected_cancellation_fee: fee,
        currency: hotel.currency,
        calculation: quote.calculation,
        policy: quote.policy,
        task_id: task.id,
        instruction:
          "Yêu cầu hủy đã được ghi nhận và chuyển lễ tân duyệt — nêu ĐÚNG mức phí hủy dự kiến, nói rõ là ĐANG CHỜ XÁC NHẬN. TUYỆT ĐỐI KHÔNG nói là đã hủy thành công.",
      };
    }

    case "cancel_service_booking": {
      if (!res) return { error: "No reservation linked — cannot find service bookings." };

      const active = storage
        .bookingsForReservation(res.id)
        .filter((b) => b.status === "confirmed");

      const listing = active.map((b) => {
        const s2 = storage.getService(b.serviceId);
        return {
          booking_id: b.id,
          service: s2?.name ?? `#${b.serviceId}`,
          date: b.date,
          slot: b.slot,
          party_size: b.partySize,
          amount: b.amount ?? null,
        };
      });

      /* Guessing which booking the guest meant is how the wrong spa slot gets
       * cancelled. An id is required, or an unambiguous name match. */
      let target = active.find((b) => b.id === Number(args.booking_id));

      if (!target && args.service_name) {
        const needle = String(args.service_name).toLowerCase().trim();
        const matches = active.filter((b) => {
          const s2 = storage.getService(b.serviceId);
          if (!s2) return false;
          const name = s2.name.toLowerCase();
          return name === needle || name.includes(needle) || needle.includes(name);
        });
        if (matches.length === 1) target = matches[0];
        else if (matches.length > 1) {
          return {
            cancelled: false,
            ambiguous: true,
            candidates: listing.filter((l) => matches.some((m) => m.id === l.booking_id)),
            instruction:
              "Có nhiều đặt chỗ khớp — hỏi khách muốn hủy cái nào (nêu tên, ngày, giờ) rồi gọi lại tool với booking_id.",
          };
        }
      }

      if (!target) {
        return {
          cancelled: false,
          needs_staff: active.length === 0,
          active_bookings: listing,
          instruction: active.length
            ? "Chưa xác định được đặt chỗ nào — đọc danh sách active_bookings cho khách và hỏi khách chọn. TUYỆT ĐỐI KHÔNG nói là đã hủy."
            : "Không có đặt chỗ dịch vụ nào đang hoạt động. Nếu khách khẳng định có, hãy chuyển lễ tân bằng escalate_to_human — KHÔNG nói là đã hủy.",
        };
      }

      const svc = storage.getService(target.serviceId);
      const quote = quoteServiceCancellation(target, new Date(), hotel.currency);

      /* HITL gate: nothing is cancelled or refunded yet — that only happens
       * once staff approve (see finalizeApproval in ops.ts). The booking
       * stays exactly as it is until then. */
      const task = storage.createTask({
        hotelId: hotel.id,
        reservationId: res.id,
        roomId: res.roomId,
        conversationId: conv.id,
        dept: svc?.dept ?? "front_desk",
        title: `CẦN DUYỆT — Hủy ${svc?.name ?? "dịch vụ"} — ${target.date} ${target.slot}`,
        detail: `Yêu cầu hủy đặt chỗ #${target.id} của ${guest.name}${room ? ` (phòng ${room.number})` : ""
          }: ${svc?.name ?? "dịch vụ"} ${target.date} ${target.slot} × ${target.partySize}. ${quote.calculation
          } Đang chờ duyệt.`,
        priority: "normal",
        status: "open",
        source: "ai",
        assignedStaffId: null,
        dueAt: nowIso(),
        createdAt: nowIso(),
        resolvedAt: null,
      });

      const approval = storage.createApproval({
        hotelId: hotel.id,
        reservationId: res.id,
        guestId: guest.id,
        conversationId: conv.id,
        taskId: task.id,
        kind: "cancel_service_booking",
        summary: `Hủy ${svc?.name ?? "dịch vụ"} — ${target.date} ${target.slot} — phí ${(quote.fee ?? 0).toLocaleString("vi-VN")} ${hotel.currency}`,
        payload: JSON.stringify({
          bookingId: target.id,
          svcName: svc?.name ?? "dịch vụ",
          fee: quote.fee,
          band: quote.band,
        }),
        amount: quote.fee ?? null,
        status: "pending",
        createdAt: nowIso(),
        resolvedAt: null,
        resolvedBy: null,
        rejectionReason: null,
      });

      storage.logEvent({
        type: "service_booking.cancel_queued",
        actor: "ai",
        summary: `Yêu cầu hủy đặt chỗ #${target.id} (${svc?.name ?? "dịch vụ"}) — chờ duyệt, phí dự kiến ${(quote.fee ?? 0).toLocaleString("vi-VN")
          } ${hotel.currency}.`,
        payload: JSON.stringify({ bookingId: target.id, approvalId: approval.id, fee: quote.fee, taskId: task.id }),
        conversationId: conv.id,
        createdAt: nowIso(),
      });

      return {
        cancelled: false,
        pending_approval: true,
        approval_id: approval.id,
        booking_id: target.id,
        service: svc?.name ?? "Service",
        date: target.date,
        slot: target.slot,
        party_size: target.partySize,
        booked_amount: quote.booked_amount,
        hours_before_start: quote.hours_before_start,
        band: quote.band,
        expected_cancellation_fee: quote.fee,
        expected_refund: quote.refund,
        currency: hotel.currency,
        calculation: quote.calculation,
        policy: quote.policy,
        dispatched_to: svc?.dept ?? "front_desk",
        task_id: task.id,
        instruction:
          "Yêu cầu hủy đã được ghi nhận và chuyển lễ tân duyệt — nói với khách là ĐANG CHỜ XÁC NHẬN, nêu phí hủy dự kiến, TUYỆT ĐỐI KHÔNG nói là đã hủy thành công.",
      };
    }

    case "update_guest_preferences": {
      const newPrefs: string[] = Array.isArray(args.preferences) ? args.preferences.map(String) : [];
      let currentPrefs: string[] = [];
      try {
        currentPrefs = JSON.parse(guest.preferences || "[]");
      } catch {
        currentPrefs = [];
      }

      const merged = Array.from(new Set([...currentPrefs, ...newPrefs]));
      let newNotes = guest.notes || "";
      if (args.notes) {
        newNotes = newNotes ? `${newNotes}\n[${hotelToday()}]: ${args.notes}` : `[${hotelToday()}]: ${args.notes}`;
      }

      const updated = storage.updateGuest(guest.id, {
        preferences: JSON.stringify(merged),
        notes: newNotes,
      });

      storage.logEvent({
        type: "guest.preferences_updated",
        actor: "ai",
        summary: `Updated preferences for ${guest.name}: ${merged.join(", ")}`,
        payload: JSON.stringify({ preferences: merged, notes: newNotes }),
        conversationId: conv.id,
        createdAt: nowIso(),
      });

      return {
        updated: true,
        guest_name: guest.name,
        current_preferences: merged,
        notes: updated.notes,
        message: "Guest profile preferences successfully updated in PMS.",
      };
    }

    case "get_weather": {
      /* Live data only. The previous implementation rotated three invented
       * forecasts, which is worse than no answer: a guest planning an island
       * trip was told a fabricated rain chance. `fetchWeather` calls a real
       * forecast API and, when it cannot, says so. */
      return (await fetchWeather(String(args.date || today()), hotel)) as Record<string, unknown>;
    }

    case "request_early_checkin": {
      if (!res) return { error: "No reservation linked to this conversation." };
      const want = String(args.requested_time);
      if (!/^\d{2}:\d{2}$/.test(want)) return { error: "requested_time must be HH:MM 24-hour format." };

      /* The tier matters: a Diamond member's free early-arrival window must be
       * applied here, not left for the model to remember. */
      const quote = quoteEarlyCheckin({
        requestedTime: want,
        ratePerNight: res.ratePerNight,
        currency: hotel.currency,
        standardCheckinTime: hotel.checkInTime,
        vipTier: guest.vipTier,
      });

      if (!quote.quoted) return { approved: false, reason: quote.error };

      const fee = quote.fee ?? 0;

      /* HITL gate: checkInTime is not written and no fee is posted until
       * staff approve — same reasoning as request_late_checkout above. */
      const task = storage.createTask({
        hotelId: hotel.id,
        reservationId: res.id,
        roomId: res.roomId,
        conversationId: conv.id,
        dept: "housekeeping",
        title: `CẦN DUYỆT — Nhận phòng sớm ${want} — phòng ${room?.number ?? "chưa xếp"}`,
        detail: `${guest.name}${guest.vipTier !== "none" ? ` (hạng ${guest.vipTier})` : ""} muốn nhận phòng sớm lúc ${want}. ${fee > 0 ? `Phí dự kiến ${fee.toLocaleString("vi-VN")} ${hotel.currency}.` : "Miễn phí theo chính sách/hạng thẻ."} Đang chờ duyệt.`,
        priority: "high",
        status: "open",
        source: "ai",
        assignedStaffId: null,
        dueAt: hotelIso(res.checkIn, want),
        createdAt: nowIso(),
        resolvedAt: null,
      });

      const approval = storage.createApproval({
        hotelId: hotel.id,
        reservationId: res.id,
        guestId: guest.id,
        conversationId: conv.id,
        taskId: task.id,
        kind: "request_early_checkin",
        summary: `Nhận phòng sớm ${want} — ${res.confirmationCode} — ${fee.toLocaleString("vi-VN")} ${hotel.currency}`,
        payload: JSON.stringify({ reservationId: res.id, want, fee }),
        amount: fee,
        status: "pending",
        createdAt: nowIso(),
        resolvedAt: null,
        resolvedBy: null,
        rejectionReason: null,
      });

      storage.logEvent({
        type: "reservation.early_checkin_queued",
        actor: "ai",
        summary: `Yêu cầu nhận phòng sớm cho ${res.confirmationCode} lúc ${want} — chờ duyệt${fee ? ` (phí ${fee} ${hotel.currency})` : " (miễn phí)"}.`,
        payload: JSON.stringify({ approvalId: approval.id, taskId: task.id, fee }),
        conversationId: conv.id,
        createdAt: nowIso(),
      });

      return {
        approved: false,
        pending_approval: true,
        approval_id: approval.id,
        requested_arrival_time: want,
        standard_checkin_time: hotel.checkInTime,
        expected_fee: fee,
        currency: hotel.currency,
        calculation: quote.calculation,
        vip_tier: quote.vip_tier ?? guest.vipTier,
        tier_free_hours: quote.tier_free_hours ?? null,
        complimentary_reason: quote.waiver ?? null,
        policy: quote.policy,
        room_ready_guaranteed: false,
        task_id: task.id,
        instruction:
          "Yêu cầu đã được ghi nhận và chuyển lễ tân duyệt — nêu đúng mức phí dự kiến (hoặc lý do miễn phí), nói rõ ĐANG CHỜ XÁC NHẬN. TUYỆT ĐỐI KHÔNG nói là đã xác nhận/đã áp dụng.",
      };
    }

    default: {
      /* Operational tools live in ops.ts. It returns null for a name it does
       * not own, so a genuinely unknown tool still reports an error. */
      if (OPS_TOOL_NAMES.has(name)) {
        const out = await runOpsTool(name, args, opsCtx());
        if (out) return out;
      }
      return { error: `Unknown tool ${name}` };
    }
  }
}

/* ------------------------------------------------------------------ *
 * System prompt
 * ------------------------------------------------------------------ */

/**
 * Kept as a thin alias so existing call sites read the same, but the numbers
 * now come from the single tier table in pricing.ts. Two copies of a benefit
 * table is two different answers to "how much is my discount?".
 */
function getGuestEntitlements(vipTier: string) {
  return getEntitlements(vipTier);
}

function buildSystemPrompt(conv: Conversation, guardNotes: string[] = []) {
  const hotel = storage.getHotel();
  const guest = storage.getGuest(conv.guestId)!;
  const res = storage.getReservation(conv.reservationId);
  const room = storage.getRoom(res?.roomId ?? null);
  const langName = LANG_NAMES[guest.lang] ?? guest.lang;
  const entitlements = getGuestEntitlements(guest.vipTier);
  /* What the guest actually just wrote in, which outranks their stored profile. */
  const lastGuestMsg = [...storage.listMessages(conv.id)].reverse().find((m) => m.role === "guest");
  const detectedLang = detectMessageLang(lastGuestMsg?.body ?? "");
  const detectedLangName = detectedLang ? (LANG_NAMES[detectedLang] ?? detectedLang) : null;

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
${entitlements.notes.length > 0 ? entitlements.notes.map((n) => '- ${n}').join("\n") : "No specific tier benefits."}
PRICES: YOU DO NO ARITHMETIC
The guest's tier gives ${entitlements.fnbDiscountPct}% off F&B, ${entitlements.spaDiscountPct}% off spa and ${entitlements.golfDiscountPct}% off golf, but you must NEVER apply those percentages yourself.
- Quote ONLY figures a tool returned in this conversation: 'member_price' and 'price_calculation' from list_services, 'pending_amount' from book_service/order_room_service, the totals from get_folio, the fee from a quote_* tool.
- book_service, cancel_service_booking and order_room_service NEVER complete immediately — they queue a request for staff approval (see each tool's 'instruction' field) and return 'pending_approval: true'. NEVER tell the guest something is booked, cancelled, ordered or confirmed based on these three tools alone — always say it is awaiting staff confirmation.
- If you want to tell the guest their member price for something, call list_services (or the relevant quote tool) and read the number back verbatim.
- If no tool has returned a figure, say you will check rather than inventing one. A price you worked out in your head is a wrong price, even when the percentage is right.
- Never multiply a price by a party size, never subtract a discount, never add tax or service charge yourself - get_folio already includes them.

DINING & SERVICE BOOKING FLOW REQUIREMENTS:
1. When a guest asks about or wants to book a dining menu/venue, call list_services and quote the rack price and the 'member_price' exactly as returned - do not compute either one.
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
   - If the guest names a hypothetical amount and asks what it costs after tax/fees ("if a service costs X..."), that is a job for quote_tax_gross_up — never add the service charge or VAT percentage to the number yourself. A benchmark caught this exact mistake: 12,000,000 + 5% + 8% by hand came out 13,560,000; the tool's compounded figure is 13,608,000.
   - If the guest gives a specific late check-out or early check-in TIME and asks about a fee, that is a job for quote_late_checkout / quote_early_checkin — call it with that exact time before you say anything about a percentage, an amount, or whether a waiver applies. A tier note like "up to 2h free" is a summary, not the answer: the tool is what actually checks whether the guest's specific time clears the waiver cutoff. A benchmark caught this failure too: a Diamond/Platinum guest asked about a 16:00 departure was told checkout is free "up to 14:00" and never given the percentage they asked for — true as a general fact, not an answer, because 16:00 is two hours past that cutoff. Call the tool, then state its band, its percentage and its amount.

4. HANDLING GIBBERISH / NONSENSE / VAGUE MESSAGES:
   - If the guest sends meaningless typos, single-character tests (e.g. "Gi", "asdf", "???"), or unrecognizable input, do NOT treat it as a continuation of previous tool calls unless clearly related.
   - Respond in ONE friendly, polite sentence clarifying how you can help (e.g., "Dạ, anh/chị cần em hỗ trợ thêm thông tin gì về dịch vụ, nhà hàng hay trả phòng không ạ?"). Never repeat instructions mechanically.

LANGUAGE
${detectedLangName ? `The guest's latest message is written in ${detectedLangName}. REPLY IN ${detectedLangName.toUpperCase()}.` : `Reply in the language of the guest's latest message.`}
The language of the message you are answering always wins over the stored profile (${langName}) — guests switch language freely, and answering a Vietnamese message in Chinese because the profile says Chinese is a serious error.
Match their register. Never mix languages in one reply unless quoting a proper name.

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
- Whenever you mention or list a venue, restaurant, service or dish that has images in tool outputs, you MUST include its exact image tag [IMAGES: url1,url2...] inside its bullet point so images are automatically rendered for the guest without them having to ask!
- Keep item titles in **Bold**, followed by details (e.g., **Balinese Massage 90'** · 2.300.000 ₫ — **1.610.000 ₫** cho Platinum).
- Group items logically with a short bold label when appropriate.
- Keep explanations clear and concise. Never hardcode or fake data. Sign nothing.

FINAL CHECK BEFORE YOU REPLY
If your reply is about to state a fee, a percentage, a waiver, or a total for check-in/check-out timing or for a tax/service-charge amount, stop: did you actually call quote_late_checkout, quote_early_checkin or quote_tax_gross_up in this turn? If not, call it now before you write anything — do not describe what a tier benefit "usually" covers instead of running the number.
${detectedLangName ? `Write your reply in ${detectedLangName.toUpperCase()}. That is the language the guest just wrote in — it overrides everything above, including the stored profile line.` : `Write your reply in the same language as the guest's latest message.`}${guardNotes.length ? `

SCREENING NOTES FOR THIS MESSAGE — these override the style rules above if they conflict.
${guardNotes.join("\n")}` : ""}`;
}

/* ------------------------------------------------------------------ *
 * Deterministic tool routing — forced calls for a narrow, proven set
 * ------------------------------------------------------------------ */

/**
 * Force one specific tool call on round 1 instead of trusting prompt
 * instructions, for the exact intents a benchmark caught failing.
 *
 * A 105-case hosted benchmark measured this directly: with only a prompt rule
 * naming the tool and describing the failure mode in detail, the model still
 * answered a late-checkout fee question by reciting a tier-benefit summary in
 * prose instead of calling quote_late_checkout — three separate rewrites of
 * the rule (including placing it at the very end of the prompt, which fixed a
 * *different* instruction-following gap for reply language) did not make the
 * call reliable. OpenAI's `tool_choice` forces the call at the API layer,
 * which prompt text cannot do no matter how it is worded.
 *
 * This is deliberately narrow. Forcing every turn through a tool call adds
 * latency and unnecessary calls for the ~85% of turns that do not need one —
 * the router below only fires when the message both names the INTENT (a
 * checkout/check-in time, or an amount plus a tax question) and supplies the
 * SPECIFIC VALUE the tool needs (a time, or a money figure). Wanting to know
 * the *policy* in general ("chính sách trả phòng muộn thế nào?") still goes
 * through the model's own judgment — there is no proven failure there, and
 * forcing a tool call with no real argument to extract would be worse than
 * the problem this exists to fix.
 */
const HHMM_TIME = /\b([01]?\d|2[0-3])\s*[:h]\s*([0-5]\d)?\b/i;
/* "giờ" ends in ờ (U+1EDD), which \w does not cover — \b never fires between it
   and a following space, so a trailing \b silently kills the match. Same bug
   documented in local-agent.ts's fold()/anyWord(); Unicode lookarounds fix it
   the same way here. An English "8am"/"8pm" form is also accepted since the
   F1 benchmark case is phrased that way. */
const VN_HOUR_WORD = /(?<![\p{L}\p{N}])([01]?\d|2[0-3])\s*(giờ|gio)(?![\p{L}\p{N}])/iu;
const AMPM_TIME = /\b([01]?\d)\s*(am|pm)\b/i;
const CHECKOUT_WORDS = /trả phòng|tra phong|check[-\s]?out|checkout|departure|depart\b/i;
const CHECKIN_WORDS = /nhận phòng|nhan phong|check[-\s]?in|checkin|arriv(e|al)/i;
const TAX_WORDS = /thuế|thue|vat\b|phí phục vụ|phi phuc vu|service charge|after tax|gross.?up|sau thuế/i;
const MONEY_AMOUNT = /\d[\d.,]*\s*(đ|₫|vnd|triệu|trieu|nghìn|nghin|k\b)/i;

function hasTimeMention(text: string): boolean {
  return HHMM_TIME.test(text) || VN_HOUR_WORD.test(text) || AMPM_TIME.test(text);
}

/**
 * Returns the one tool that must be called this round, or null when no forced
 * intent is detected — the ordinary tool loop runs unchanged in that case.
 */
function requiredToolFor(text: string): string | null {
  if (TAX_WORDS.test(text) && MONEY_AMOUNT.test(text)) return "quote_tax_gross_up";
  if (CHECKOUT_WORDS.test(text) && hasTimeMention(text)) return "quote_late_checkout";
  if (CHECKIN_WORDS.test(text) && hasTimeMention(text)) return "quote_early_checkin";
  return null;
}

/* ------------------------------------------------------------------ *
 * Agent loop
 * ------------------------------------------------------------------ */

/** How many times the model may come back for more tools before we force an answer. */
const MAX_TOOL_ROUNDS = 10;

/** Opt-in code-driven confirmation flow for the offline path. See the comment at
 *  its call site for why this defaults off. */
const WIZARD_ENABLED = process.env.WIZARD_ENABLED === "1" || process.env.WIZARD_ENABLED === "true";

/** Route offline turns through the RAG-first pipeline instead of the tool loop. */
const LOCAL_RAG_FIRST = process.env.LOCAL_RAG_FIRST !== "0" && process.env.LOCAL_RAG_FIRST !== "false";

export type AgentResult = {
  reply: string;
  trace: ToolCallTrace[];
  escalated: boolean;
  latencyMs: number;
  model: string;
  /** Which provider actually answered. "local" means the offline path served this turn. */
  servedBy?: "local" | "openai";
  /** True when the hosted API failed and the local model took over mid-turn. */
  failedOver?: boolean;
  /** Tool families exposed to the model, and the token cost of that block. */
  toolFamilies?: string[];
  toolTokens?: number;
  /** Result of the numeric fabrication check on the drafted reply. */
  numericGuard?: GuardVerdict;
  /** Id of the persisted execution trace for this turn (see observability.ts). */
  traceId?: string;
};

/**
 * The tool budget a turn must respect.
 *
 * When failover is possible the tighter local budget applies even while the
 * hosted API is serving. Sizing the tool block for the API and then failing over
 * would hand the local model a prompt larger than its context window, so the
 * outage the fallback exists for is exactly when it would break.
 */
function toolBudgetForRoute(): number {
  const canServeLocal = PRIMARY === "local" || FALLBACK === "local";
  return canServeLocal ? TOOL_BUDGET.local : TOOL_BUDGET.openai;
}

/**
 * One offline turn, end to end.
 *
 * Wraps the RAG-first pipeline with the same guarantees the hosted path gets:
 * an emergency escalates before anything else runs, every generated sentence
 * passes the numeric guard, and a turn that cannot be answered becomes a task
 * for a person rather than a guess.
 *
 * The reply is not stored here — routes.ts persists whatever runAgent returns —
 * and no message is written twice.
 */
/**
 * A short "Khách: ... / Trợ lý: ..." transcript of the turns immediately
 * before the current question — the offline path's only source of working
 * memory for a follow-up, since it otherwise sees just the latest message.
 *
 * Bounded to the last 2 exchanges (4 messages) and each line truncated,
 * because this text is prepended to BOTH the retrieval query and the model
 * prompt: too much of it dilutes BM25's keyword match on the current
 * question and burns context budget for no benefit — a guest's actual
 * follow-ups reference the immediately preceding turn, not five turns back.
 * Returns "" for a conversation's first turn, which is what makes every
 * already-measured single-turn benchmark case unaffected by this function.
 */
function recentOfflineHistory(history: Message[], excludingLast: boolean): string {
  const prior = excludingLast ? history.slice(0, -1) : history;
  const lines = prior
    .slice(-4)
    .filter((m) => m.role === "guest" || m.role === "ai")
    .map((m) => `${m.role === "guest" ? "Khách" : "Trợ lý"}: ${m.body.replace(/\s+/g, " ").slice(0, 150)}`);
  return lines.join("\n");
}

async function runOfflineTurn(ctx: {
  conv: Conversation;
  guest: { lang: string };
  question: string;
  guard: ReturnType<typeof screenGuestMessage>;
  trace: ToolCallTrace[];
  tr: Trace;
  started: number;
  history?: string;
}): Promise<AgentResult> {
  const { conv, guest, question, guard, trace, tr, started, history } = ctx;
  const lang = offlineReplyLang(conv, guest.lang);
  const span = tr.startSpan("local.rag_first", "wizard", { question_chars: question.length });

  const hotel = storage.getHotel();
  const turn = await runLocalTurn({
    question,
    isEmergency: guard.forceEscalation,
    lang,
    basics: { checkIn: hotel.checkInTime, checkOut: hotel.checkOutTime, currency: hotel.currency },
    history,
  });
  span.setAttributes({
    route: turn.route,
    top_score: turn.topScore,
    llm_calls: turn.llmCalls,
    passages: turn.passages.length,
  });

  let reply = turn.reply ?? "";
  let escalated = false;
  let numericGuard: GuardVerdict | undefined;

  /* The guard runs on the offline path too, unchanged. A small model is MORE
     likely to invent a figure, not less, so this is the path that needs it most. */
  if (reply) {
    /* guestText now includes the recent-history block too: a figure the guest
       stated two turns ago and the model correctly echoes back while
       resolving a follow-up must not be flagged as an ungrounded number just
       because it is not present in the LATEST message alone. */
    numericGuard = checkReply(reply, {
      toolResults: turn.passages.map((p) => p.content),
      guestText: history ? `${history}\n${question}` : question,
    });
    if (!numericGuard.ok) {
      span.addSignal("numeric_fabrication", numericGuard.ungrounded.map((c) => c.raw).join(", "));
      /* repairReply's removal-notice template is a guard-owned "vi"|"en" contract,
         out of scope for this fix (the guard itself is untouched) — the ANSWER
         above is already generated in the guest's real language; only this rare
         fallback notice (shown when a figure had to be trimmed) collapses,
         exactly like the hosted tool-label renderers already did before this
         change. */
      const repaired = repairReply(reply, numericGuard, lang === "vi" ? "vi" : "en");
      reply = repaired.text;
      if (repaired.removed.length) span.addSignal("reply_repaired", `${repaired.removed.length} câu bị cắt`);
      if (repaired.escalate) turn.escalate = true;
    }
  }

  if (turn.escalate || !reply.trim()) {
    span.addSignal("forced_escalation", turn.escalateReason ?? "offline path could not answer");
    const t0 = Date.now();
    const result = await runTool(
      "escalate_to_human",
      { reason: turn.escalateReason ?? "Offline path could not answer.", priority: guard.forceEscalation ? "urgent" : "high" },
      { conversation: conv },
    );
    trace.push({ name: "escalate_to_human", args: { route: turn.route }, result, ms: Date.now() - t0 });
    escalated = true;
    if (!reply.trim()) {
      reply = handoffLine(lang, "confirm");
    }
  }

  const langSig = detectLanguageMismatch(guest.lang, reply);
  if (langSig) span.addSignals([langSig]);
  span.end();

  /* Which dining venues the reply is actually grounded in, from the real
     retrieved evidence — not a guess from the reply text. Skipped on
     escalation: nothing was answered, so nothing to offer "xem chi tiết /
     xem menu" for. Recorded as a trace entry (not a new column) so it rides
     the same persisted, JSON toolTrace every other turn already writes. */
  if (!escalated && reply) {
    const venues = detectReferencedVenues(turn.passages);
    if (venues.length) trace.push({ name: "dining_venues_referenced", args: {}, result: { venues }, ms: 0 });
    const roomTypes = detectReferencedRoomTypes(turn.passages);
    if (roomTypes.length) trace.push({ name: "room_types_referenced", args: {}, result: { roomTypes }, ms: 0 });
    const serviceGroups = detectReferencedServices(turn.passages);
    if (serviceGroups.length) trace.push({ name: "services_referenced", args: {}, result: { serviceGroups }, ms: 0 });
  }

  tr.setServedBy("local", MODEL_AGENT);
  const latencyMs = Date.now() - started;
  const traceId = tr.flush({ path: "local_rag_first", route: turn.route, latency_ms: latencyMs, escalated });

  return {
    reply,
    trace,
    escalated,
    latencyMs,
    model: MODEL_AGENT,
    servedBy: "local",
    failedOver: false,
    numericGuard,
    traceId,
  };
}

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

  /* Structured execution trace for this turn. Every LLM call, tool call and
     guard check below opens a child span on it; it is flushed once at the end,
     from a try/catch, so observability never fails a guest's answer. */
  const tr = new Trace(conversationId, { provider: PRIMARY, model: MODEL_AGENT });
  /* Repeat detection: a tool called twice with identical arguments in one turn
     is almost always the model looping, which is worth surfacing. */
  const seenSignatures = new Set<string>();

  /**
   * Tool families unlocked for this turn. Seeded from the guest's message and
   * grown by `find_capability`; never shrunk, so a capability the model had to
   * go looking for stays available for the rest of the exchange.
   */
  const activeFamilies = new Set<FamilyName>();
  const budget = toolBudgetForRoute();
  let servedBy: "local" | "openai" | undefined;
  let failedOver = false;
  /* Which provider will serve this turn decides which tools may be offered.
     In `auto` mode a failover can move a turn to the local model mid-flight, so
     the narrower local set is used whenever local can serve — offering a tool the
     fallback cannot use well is worse than never offering it. */
  /* ---------------------------------------------------------------- *
   * Offline path.
   *
   * When the local model is the one serving, the agentic tool loop below is the
   * wrong shape for it (see local-agent.ts for the measurements). The whole turn
   * is delegated to a RAG-first pipeline instead, and the loop below is never
   * entered — which is also why the hosted path is untouched by any of this: the
   * two share only the leaf building blocks (retrieval, the numeric guard, the
   * tool implementations), never the control flow.
   *
   * Opt-in while the offline path is still being calibrated; PRIMARY must also
   * actually be local, so enabling the flag on a hosted deployment does nothing.
   * ---------------------------------------------------------------- */
  if (LOCAL_RAG_FIRST && PRIMARY === "local") {
    return await runOfflineTurn({
      conv,
      guest: storage.getGuest(conv.guestId)!,
      question: lastGuest?.body ?? "",
      history: recentOfflineHistory(history, true),
      guard,
      trace,
      tr,
      started,
    });
  }

  const toolProvider: "local" | "openai" = PRIMARY === "local" || FALLBACK === "local" ? "local" : "openai";
  const availableTools = toolsForProvider(toolProvider);
  const reselect = () => {
    const sel = selectTools({ text: lastGuest?.body ?? "", all: availableTools, active: [...activeFamilies], budget });
    tr.addTurnSignals(deriveRouterSignals(sel));
    return sel;
  };

  let lastSelection = reselect();
  let familyCount = activeFamilies.size;

  /* The form wizard is opt-in and OFF by default.
   *
   * Its first implementation matched confirmation with a bare substring regex
   * that listed "hủy" (cancel) as an AFFIRMATIVE word, so "tôi không muốn hủy
   * nữa", "đừng hủy" and even "phí hủy là bao nhiêu?" all executed the
   * cancellation — an irreversible, chargeable action — and "book" matched
   * because it contains "ok". It also returned before the numeric guard and
   * before the emergency escalation check, which are the two protections this
   * whole system is built around.
   *
   * It is rewritten now, but it stays behind a flag until the offline path has
   * actually been measured: a wizard that mis-parses one word costs a guest
   * their room, and the ordinary agent loop already handles these flows with
   * every guard intact. */
  /* An emergency outranks any pending paperwork. The previous version returned
     from the wizard before this check, so a guest reporting chest pain during an
     unfinished cancellation was answered with "reply Yes or No". */
  const pending =
    WIZARD_ENABLED && !guard.forceEscalation ? detectPendingTransaction(history) : null;
  if (pending && (PRIMARY === "local" || process.env.LLM_MODE === "local")) {
    const wizardSpan = tr.startSpan("wizard.form", "wizard", { pending: pending.type });
    const wizardRes = await processFormWizardTurn(pending, lastGuest?.body ?? "", conv, runTool);
    for (const t of wizardRes.toolTrace) {
      trace.push(t);
      wizardSpan.addSignals(deriveToolSignals({ name: t.name, args: t.args, result: t.result }));
    }

    /* The wizard only takes the turn when the guest actually answered the
       question it asked. Anything else — a new request, an unrelated question —
       falls through to the normal agent loop below, which is what keeps a stale
       quote from swallowing the rest of the conversation. */
    if (wizardRes.handled) {
      reply = wizardRes.reply;
      if (!reply.trim()) wizardSpan.addSignal("empty_reply");
      wizardSpan.setAttributes({ completed: wizardRes.completed }).end();
      tr.setServedBy("local", MODEL_AGENT);
      const latencyMs = Date.now() - started;
      /* The reply is NOT stored here: routes.ts persists whatever runAgent
         returns, and doing it in both places posted every wizard answer twice. */
      const traceId = tr.flush({ path: "wizard", latency_ms: latencyMs, completed: wizardRes.completed });
      return {
        reply,
        trace,
        escalated,
        latencyMs,
        model: MODEL_AGENT,
        servedBy: "local",
        /* Only a real provider failover sets this; local as the configured
           primary is not a failure. */
        failedOver: FALLBACK === "local" && PRIMARY !== "local",
        traceId,
      };
    }
    wizardSpan.setAttributes({ declined: true }).end();
  }

  for (let turn = 0; turn < MAX_TOOL_ROUNDS; turn++) {
    /* Only rebuild the tool block when find_capability actually unlocked
       something; otherwise the selection is identical to the previous round. */
    if (activeFamilies.size !== familyCount) {
      lastSelection = reselect();
      familyCount = activeFamilies.size;
    }

    const maxTokens = PRIMARY === "local" ? 400 : 1100;

    /* Forced tool call, round 1 only — see requiredToolFor's comment. Only
       forces when the tool is actually in this round's selection; if
       find_capability has not unlocked it yet, the ordinary loop runs and the
       forced call is attempted again once activeFamilies picks it up (a
       required tool absent from every family it belongs to would be a real bug
       elsewhere, not something to paper over here). */
    const forced =
      turn === 0
        ? requiredToolFor(lastGuest?.body ?? "")
        : null;
    /* Guarantee the forced tool is actually offered this round rather than
       hoping the family keyword-scorer (an independently maintained lexicon)
       happens to agree with requiredToolFor's own trigger words. A forced
       tool_choice naming a function absent from `tools` is an API error, not a
       graceful fallback, so this cannot be left to chance. */
    let toolsThisRound = lastSelection.tools;
    if (forced && !toolsThisRound.some((t) => t.function.name === forced)) {
      const def = availableTools.find((t) => t.function.name === forced);
      if (def) toolsThisRound = [...toolsThisRound, def];
    }
    const forcedAvailable = !!forced && toolsThisRound.some((t) => t.function.name === forced);

    const llmSpan = tr.startSpan(`llm.chat.round${turn}`, "llm", {
      round: turn,
      tool_families: lastSelection.families,
      tool_tokens: lastSelection.tokens,
      forced_tool: forcedAvailable ? forced : undefined,
    });
    let completion;
    try {
      completion = await chat({
        messages: msgs,
        tools: toolsThisRound,
        maxTokens,
        ...(forcedAvailable ? { toolChoice: { name: forced! } } : {}),
      });
    } catch (e: any) {
      llmSpan.addSignal("provider_error", e?.message ?? String(e)).end({ error: e?.message ?? String(e) });
      tr.flush({ path: "agent", latency_ms: Date.now() - started, aborted: true });
      throw e;
    }

    const choice = completion.choices[0]?.message;
    llmSpan.setAttributes({ served_by: completion.servedBy, model: completion.model });
    if (!choice) {
      llmSpan.addSignal("empty_reply", "no choices in completion").end({ error: "empty completion" });
      throw new LlmError("Empty response from the model.");
    }
    if (completion.servedBy) {
      servedBy = completion.servedBy;
      tr.setServedBy(completion.servedBy, completion.model);
    }
    if (completion.failedOver) {
      failedOver = true;
      llmSpan.addSignal("failover", `answered by ${completion.servedBy} after primary failed`);
    }
    llmSpan.setAttributes({ tool_calls_requested: choice.tool_calls?.length ?? 0 });
    llmSpan.end();

    if (choice.tool_calls?.length) {
      msgs.push({ role: "assistant", content: choice.content ?? "", tool_calls: choice.tool_calls });
      for (const call of choice.tool_calls) {
        let args: any = {};
        let badArgs = false;
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          args = {};
          badArgs = true;
        }
        const t0 = Date.now();
        let result: Record<string, unknown> | string;

        /* find_capability is the router's own tool, not a hotel operation, so it
           is answered here rather than in runTool. It unlocks families for the
           following rounds, which is how a routing miss costs one round instead
           of becoming "the hotel cannot do that". */
        if (call.function.name === "find_capability") {
          const capSpan = tr.startSpan("router.find_capability", "router", { need: args?.need });
          // Search only what this provider is allowed to use, or the escape
          // hatch would hand the local model the very tool it was denied.
          const found = resolveFindCapability(String(args?.need ?? ""), availableTools);
          for (const f of found.families) activeFamilies.add(f);
          if (!found.matched) capSpan.addSignal("capability_miss", String(args?.need ?? ""));
          if (badArgs) capSpan.addSignal("bad_arguments", call.function.arguments?.slice(0, 120));
          result = {
            available_tools: found.tools,
            note: "These tools are now available to you. Call the one you need on your next step.",
          };
          capSpan.setAttributes({ unlocked_families: found.families }).end();
          trace.push({ name: call.function.name, args, result, ms: Date.now() - t0 });
          msgs.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
          continue;
        }

        const sig = toolSignature(call.function.name, args);
        const isRepeat = seenSignatures.has(sig);
        seenSignatures.add(sig);
        const toolSpan = tr.startSpan(`tool.${call.function.name}`, "tool", { args });

        try {
          result = await runTool(call.function.name, args, { conversation: conv });
        } catch (e: any) {
          result = { error: e?.message ?? String(e) };
        }
        if (call.function.name === "escalate_to_human") escalated = true;

        if (badArgs) toolSpan.addSignal("bad_arguments", call.function.arguments?.slice(0, 120));
        toolSpan.addSignals(deriveToolSignals({ name: call.function.name, args, result, isRepeat }));
        toolSpan
          .setAttributes({ result_keys: typeof result === "object" ? Object.keys(result) : undefined })
          .end();

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

  /* Numeric fabrication guard. Runs on whatever the model wrote, from either
     provider, before the guest ever sees it. Prices, rates and times have to be
     traceable to a tool result from this same turn; see numguard.ts for why the
     system prompt is not accepted as evidence. */
  let numericGuard: GuardVerdict | undefined;
  if (reply) {
    const guardSpan = tr.startSpan("guard.numeric", "guard");
    const evidence = {
      toolResults: trace.map((t) => t.result),
      guestText: lastGuest?.body ?? "",
    };
    if (process.env.AGENT_DEBUG) console.log("[AGENT_DIAGNOSTIC] Generated raw reply before guard:\n", reply);
    numericGuard = checkReply(reply, evidence);
    guardSpan.setAttributes({ checked: numericGuard.checked, ok: numericGuard.ok });
    if (process.env.AGENT_DEBUG) console.log("[AGENT_DIAGNOSTIC] NumericGuard ok?:", numericGuard.ok, "Ungrounded:", numericGuard.ungrounded);
    if (!numericGuard.ok) {
      guardSpan.addSignal(
        "numeric_fabrication",
        numericGuard.ungrounded.map((c) => c.raw).join(", "),
      );
      const guestLang = storage.getGuest(conv.guestId)?.lang;
      const repaired = repairReply(reply, numericGuard, guestLang === "vi" ? "vi" : "en");
      if (process.env.AGENT_DEBUG) console.log("[AGENT_DIAGNOSTIC] Repaired reply text:\n", repaired.text);
      reply = repaired.text;
      if (repaired.removed.length) guardSpan.addSignal("reply_repaired", `${repaired.removed.length} sentence(s) stripped`);
      trace.push({
        name: "numeric_guard",
        args: { ungrounded: numericGuard.ungrounded.map((c) => c.raw) },
        result: { removed_sentences: repaired.removed, checked: numericGuard.checked },
        ms: 0,
      });
      if (repaired.escalate && !escalated) {
        await runTool(
          "escalate_to_human",
          {
            reason: `Reply contained figures with no source in this turn's tool results: ${numericGuard.ungrounded
              .map((c) => c.raw)
              .join(", ")}`,
            priority: "high",
          },
          { conversation: conv },
        );
        guardSpan.addSignal("forced_escalation", "numeric guard could not salvage the reply");
        escalated = true;
      }
    }
    guardSpan.end();
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
    tr.addTurnSignals([{ code: "forced_escalation", severity: "warn", detail: `guard: ${guard.emergencyKind ?? "emergency"}` }]);
    escalated = true;
  }

  if (!reply) {
    tr.root.addSignal("empty_reply", "model produced no answer; served fallback");
    /* This used to answer with a hard-coded Deluxe rate card. That meant any
       failed turn — a question about wifi, a broken tool, a timeout — was
       answered with specific prices the guest never asked for, in a system where
       every other figure must trace back to a tool result. A failure has to
       sound like a failure. */
    /* The language the guest actually WROTE in outranks the language on their
       profile: a Korean guest may have booked with an English profile. */
    const askedIn =
      detectMessageLang(lastGuest?.body ?? "") ?? storage.getGuest(conv.guestId)?.lang ?? "vi";
    reply = handoffLine(askedIn, "failed");
    if (!escalated) {
      await runTool(
        "escalate_to_human",
        { reason: "Agent could not produce a grounded answer.", priority: "high" },
        { conversation: conv },
      );
      escalated = true;
    }
  }

  /* Language check on the final reply, and flush the whole trace. Both are in a
     try/catch-free tail only because flush() itself never throws; a mismatch
     signal is cheap and conservative (see detectLanguageMismatch). */
  const guestLang = storage.getGuest(conv.guestId)?.lang ?? "vi";
  const langSig = detectLanguageMismatch(guestLang, reply);
  if (langSig) tr.root.addSignals([langSig]);

  const latencyMs = Date.now() - started;
  const traceId = tr.flush({
    path: "agent",
    latency_ms: latencyMs,
    served_by: servedBy,
    escalated,
    reply_chars: reply.length,
  });

  return {
    reply,
    trace,
    escalated,
    latencyMs,
    model: servedBy ? agentModel(servedBy) : MODEL_AGENT,
    servedBy,
    failedOver,
    toolFamilies: lastSelection.families,
    toolTokens: lastSelection.tokens,
    numericGuard,
    traceId,
  };
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
