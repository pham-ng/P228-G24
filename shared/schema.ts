import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import type * as z from "zod/mini";

/* ------------------------------------------------------------------ *
 * Property & people
 * ------------------------------------------------------------------ */

export const hotels = sqliteTable("hotels", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  city: text("city").notNull(),
  timezone: text("timezone").notNull(),
  currency: text("currency").notNull(),
  checkInTime: text("check_in_time").notNull(),
  checkOutTime: text("check_out_time").notNull(),
  brandVoice: text("brand_voice").notNull(),
  slaMinutes: integer("sla_minutes").notNull(),
  aiEnabled: integer("ai_enabled").notNull().default(1),
  /**
   * Where a VietQR transfer lands. Null until an operator fills them in, and the
   * QR is simply not offered until all three are present — showing a code built
   * from a placeholder account would send a guest's money to nobody.
   *
   * `bankBin` is the 6-digit NAPAS acquirer id (Vietcombank 970436, Techcombank
   * 970407, …), not the SWIFT code and not the bank's name.
   */
  bankBin: text("bank_bin"),
  bankAccountNumber: text("bank_account_number"),
  bankAccountName: text("bank_account_name"),
});

export const staff = sqliteTable("staff", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  role: text("role").notNull(), // manager | agent
  dept: text("dept").notNull(), // front_desk | housekeeping | fnb | engineering | spa
  pin: text("pin").notNull(),
  active: integer("active").notNull().default(1),
});

export const rooms = sqliteTable("rooms", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  number: text("number").notNull().unique(),
  type: text("type").notNull(), // Deluxe King | Junior Suite | ...
  floor: integer("floor").notNull(),
  status: text("status").notNull(), // clean | dirty | inspected | out_of_order
  housekeepingNote: text("housekeeping_note"),
  /** Published nightly rate for this category, in the hotel currency. */
  baseRate: real("base_rate").notNull().default(0),
});

export const guests = sqliteTable("guests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  phone: text("phone").notNull().unique(),
  email: text("email"),
  lang: text("lang").notNull().default("en"), // ISO code the guest writes in
  vipTier: text("vip_tier").notNull().default("none"), // none | silver | gold | platinum
  preferences: text("preferences").notNull().default("[]"), // JSON array of strings
  notes: text("notes"),
  staysCount: integer("stays_count").notNull().default(1),
  /* --- identity, needed for the statutory lodging declaration (Vietnam) --- */
  idType: text("id_type"), // passport | national_id | other
  idNumber: text("id_number"),
  nationality: text("nationality"),
  dob: text("dob"), // ISO date
  /* --- loyalty ledger --- */
  loyaltyPoints: integer("loyalty_points").notNull().default(0),
  loyaltyEnrolledAt: text("loyalty_enrolled_at"),
});

/* ------------------------------------------------------------------ *
 * Reservations & folio (the "PMS" layer)
 * ------------------------------------------------------------------ */

export const reservations = sqliteTable("reservations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hotelId: integer("hotel_id").notNull(),
  guestId: integer("guest_id").notNull(),
  roomId: integer("room_id"),
  confirmationCode: text("confirmation_code").notNull().unique(),
  checkIn: text("check_in").notNull(), // ISO date YYYY-MM-DD
  checkOut: text("check_out").notNull(),
  checkOutTime: text("check_out_time").notNull(), // HH:MM, can be extended
  adults: integer("adults").notNull().default(1),
  children: integer("children").notNull().default(0),
  ratePerNight: real("rate_per_night").notNull(),
  status: text("status").notNull(), // confirmed | in_house | checked_out | cancelled
  source: text("source").notNull().default("direct"), // direct | booking.com | ai_agent | ...
  /** HH:MM the guest is actually expected / was admitted. Set by early check-in. */
  checkInTime: text("check_in_time"),
  cancelledAt: text("cancelled_at"),
  cancellationFee: real("cancellation_fee"),
});

export const folioCharges = sqliteTable("folio_charges", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  reservationId: integer("reservation_id").notNull(),
  description: text("description").notNull(),
  amount: real("amount").notNull(),
  category: text("category").notNull(), // room | fnb | spa | minibar | fee | service_charge | vat | payment | adjustment
  createdAt: text("created_at").notNull(),
  /** 1 = service charge and VAT apply to this line. 0 = tax/fee/payment lines. */
  taxable: integer("taxable").notNull().default(1),
  /** What produced the line, so a cancellation can reverse exactly this charge. */
  refType: text("ref_type"), // service_booking | room_service | early_checkin | late_checkout | cancellation | payment
  refId: integer("ref_id"),
  /** Set when the line has been reversed; a reversal posts its own negative line. */
  voidedAt: text("voided_at"),
});

/* ------------------------------------------------------------------ *
 * Messaging
 * ------------------------------------------------------------------ */

export const conversations = sqliteTable("conversations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hotelId: integer("hotel_id").notNull(),
  guestId: integer("guest_id").notNull(),
  reservationId: integer("reservation_id"),
  channel: text("channel").notNull(), // sms | whatsapp | webchat | voice
  mode: text("mode").notNull().default("ai"), // ai | human | closed
  assignedStaffId: integer("assigned_staff_id"),
  sentiment: text("sentiment").notNull().default("neutral"), // positive | neutral | negative
  /**
   * WHERE the sentiment label came from. Null means nobody has judged this
   * conversation yet — which is NOT the same as "the guest is fine".
   *
   * Without this column the insights dashboard could not tell a real verdict
   * from a fixture, and it did not: `seed.ts` assigns both `sentiment` and
   * `topic` with rand() on ninety-five demo conversations, so a pie chart
   * captioned "classified per conversation by the model" was mostly dice.
   *
   *   seed           — generated by seed.ts, means nothing about a real guest
   *   model_realtime — the linear head on the guest's own message
   *   model_llm      — analyseConversation, a second generation call
   *   thumbs_down    — the guest pressed the button; the strongest signal here,
   *                    because it is the only one the guest chose to send
   */
  sentimentSource: text("sentiment_source"),
  /** When that label was assigned — a negative verdict from four days ago is
   *  history, not a guest currently waiting for an apology. */
  sentimentAt: text("sentiment_at"),
  topic: text("topic"),
  unreadForStaff: integer("unread_for_staff").notNull().default(0),
  lastMessageAt: text("last_message_at").notNull(),
  createdAt: text("created_at").notNull(),
  firstResponseSeconds: integer("first_response_seconds"),
});

export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  conversationId: integer("conversation_id").notNull(),
  role: text("role").notNull(), // guest | ai | staff | system
  authorName: text("author_name"),
  body: text("body").notNull(),
  toolTrace: text("tool_trace"), // JSON array of {name, args, result}
  latencyMs: integer("latency_ms"),
  createdAt: text("created_at").notNull(),
});

/* ------------------------------------------------------------------ *
 * Operations
 * ------------------------------------------------------------------ */

export const tasks = sqliteTable("tasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hotelId: integer("hotel_id").notNull(),
  reservationId: integer("reservation_id"),
  roomId: integer("room_id"),
  conversationId: integer("conversation_id"),
  dept: text("dept").notNull(),
  title: text("title").notNull(),
  detail: text("detail"),
  priority: text("priority").notNull().default("normal"), // low | normal | high | urgent
  status: text("status").notNull().default("open"), // open | in_progress | done | cancelled
  source: text("source").notNull().default("ai"), // ai | staff | guest
  assignedStaffId: integer("assigned_staff_id"),
  dueAt: text("due_at"),
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at"),
});

export const services = sqliteTable("services", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  category: text("category").notNull(), // dining | spa | experience | transport | roomservice
  description: text("description").notNull(),
  price: real("price").notNull(),
  unit: text("unit").notNull().default("per person"),
  dept: text("dept").notNull(),
  slots: text("slots").notNull().default("[]"), // JSON array of HH:MM strings
  capacityPerSlot: integer("capacity_per_slot").notNull().default(4),
  active: integer("active").notNull().default(1),
  /** JSON array of image URLs for this service. */
  images: text("images").notNull().default("[]"),
  /** JSON array of exact KB article titles this service is grounded in, e.g. ["Cáp treo Vinpearl ra đảo Hòn Tre"].
   *  Set only when a real, verified KB article exists for the service — never guessed. Empty means no detail card. */
  linkedKbTitles: text("linked_kb_titles").notNull().default("[]"),
  /** Groups near-duplicate rows (e.g. 7 Akoya Spa treatments) under one detail card, e.g. "Akoya Spa". Null = its own card. */
  serviceGroup: text("service_group"),
});

export const serviceBookings = sqliteTable("service_bookings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  serviceId: integer("service_id").notNull(),
  reservationId: integer("reservation_id").notNull(),
  date: text("date").notNull(),
  slot: text("slot").notNull(),
  partySize: integer("party_size").notNull().default(1),
  status: text("status").notNull().default("confirmed"), // confirmed | cancelled
  createdAt: text("created_at").notNull(),
  /** Amount actually posted to the folio (member price × party), so it can be reversed exactly. */
  amount: real("amount"),
  /** The folio line this booking created. */
  chargeId: integer("charge_id"),
  note: text("note"),
  /** ISO datetime after which cancellation incurs the published fee. */
  cancelDeadline: text("cancel_deadline"),
  cancelledAt: text("cancelled_at"),
});

export const kbArticles = sqliteTable("kb_articles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hotelId: integer("hotel_id").notNull(),
  category: text("category").notNull(), // property | policy | dining | neighborhood | wayfinding | vin_wonder | facilities
  title: text("title").notNull(),
  body: text("body").notNull(),
  tags: text("tags").notNull().default("[]"), // JSON array
  updatedAt: text("updated_at").notNull(),

  /* --- Phase A knowledge-hygiene metadata --- */
  /** curated (hand-written, trustworthy) | scraped (SEO/marketing dump) | placeholder (gap filler, no fact yet). */
  quality: text("quality").notNull().default("curated"),
  /** verified (checked against an official source) | unverified (plausible, not yet checked) | synthetic (demo data). */
  verified: text("verified").notNull().default("unverified"),
  /** static (rarely changes) | dynamic (price/hours/availability — prefer a live tool) | mixed. */
  contentClass: text("content_class").notNull().default("static"),
  /** Canonical entity this article is about, e.g. "wifi", "breakfast", "late_checkout". */
  entity: text("entity"),
  /** Coarse domain for metadata filtering, e.g. "facilities", "policy", "dining". */
  domain: text("domain"),
  /** Explicit source URL (previously only embedded in the body as "Source: …"). */
  sourceUrl: text("source_url"),
  /** When the fact became effective / was last confirmed against a source. ISO date. */
  effectiveDate: text("effective_date"),
  lastVerified: text("last_verified"),
  /** 0 quarantines the article from the retrieval index without deleting it. */
  retrievable: integer("retrievable").notNull().default(1),
});

/** Machine-readable house rules. `rules` holds the numeric bands the agent computes with. */
export const policies = sqliteTable("policies", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hotelId: integer("hotel_id").notNull(),
  code: text("code").notNull().unique(), // LATE_CHECKOUT | EARLY_CHECKIN | OCCUPANCY | DEPOSIT | ...
  topic: text("topic").notNull(), // checkout | checkin | occupancy | deposit | payment | conduct | privacy | dispute | booking
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  rules: text("rules").notNull().default("{}"), // JSON — the authority for every computed figure
  sourceUrl: text("source_url").notNull(),
  sourceTitle: text("source_title").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Rate-calendar restrictions, one row per date (optionally per room type).
 * These are the revenue-management controls a booking engine must obey before
 * it can sell a night: minimum and maximum length of stay, closed to arrival,
 * closed to departure, and stop-sell.
 */
export const restrictions = sqliteTable("restrictions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hotelId: integer("hotel_id").notNull(),
  date: text("date").notNull(), // ISO date the restriction applies to
  roomType: text("room_type"), // null = every category
  minLos: integer("min_los"),
  maxLos: integer("max_los"),
  closedToArrival: integer("closed_to_arrival").notNull().default(0),
  closedToDeparture: integer("closed_to_departure").notNull().default(0),
  stopSell: integer("stop_sell").notNull().default(0),
  label: text("label").notNull(),
  reason: text("reason").notNull(),
});

/** The property's published room catalogue: one row per category, parsed from the
 *  hotel's own room pages. Every field here is something the property publishes —
 *  a field the page is silent about stays null so the agent can say "not published"
 *  instead of inventing it. */
export const roomTypes = sqliteTable("room_types", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hotelId: integer("hotel_id").notNull(),
  /** Inventory category name, matching rooms.type. */
  code: text("code").notNull().unique(),
  nameVi: text("name_vi").notNull(),
  areaSqm: real("area_sqm"),
  bedrooms: integer("bedrooms"),
  bed: text("bed"), // double | twin | null
  oceanView: integer("ocean_view").notNull().default(0),
  privatePool: integer("private_pool").notNull().default(0),
  /** Published maximum guests per unit, null when the page does not state it. */
  maxGuests: integer("max_guests"),
  /** JSON array of {adults, children} combinations the page spells out. */
  combinations: text("combinations").notNull().default("[]"),
  description: text("description").notNull(),
  /** JSON array of the amenity labels listed on the page, in page order. */
  amenities: text("amenities").notNull().default("[]"),
  /** JSON array of image URLs for this room type. */
  images: text("images").notNull().default("[]"),
  sourceFile: text("source_file").notNull(),
  sourceUrl: text("source_url").notNull(),
});

/**
 * Dining venues as published on the property's own outlet pages. Same rule as
 * room_types: a column is null when the page is silent, so the concierge can say
 * "not published" instead of estimating an opening hour or a price.
 */
export const diningVenues = sqliteTable("dining_venues", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hotelId: integer("hotel_id").notNull(),
  /** Outlet name as the property writes it, e.g. "Bach Giai Restaurant". */
  code: text("code").notNull().unique(),
  slug: text("slug").notNull(),
  kind: text("kind").notNull(), // restaurant | bar
  nameVi: text("name_vi").notNull(),
  location: text("location"),
  phone: text("phone"),
  /** JSON array of {open, close} windows exactly as published. */
  hours: text("hours").notNull().default("[]"),
  /** JSON array of {meal, open, close} when the page splits meal services. */
  mealWindows: text("meal_windows").notNull().default("[]"),
  lastOrder: text("last_order"),
  prepTime: text("prep_time"),
  capacity: integer("capacity"),
  priceRange: text("price_range"),
  priceMin: real("price_min"),
  priceMax: real("price_max"),
  priceNote: text("price_note"),
  /** JSON arrays of the labels printed on the page, in page order. */
  cuisine: text("cuisine").notNull().default("[]"),
  dishesServed: text("dishes_served").notNull().default("[]"),
  highlights: text("highlights").notNull().default("[]"),
  goodFor: text("good_for").notNull().default("[]"),
  amenities: text("amenities").notNull().default("[]"),
  /** JSON array of {group, items:[{name_vi, name_en, price}]}. */
  menuGroups: text("menu_groups").notNull().default("[]"),
  description: text("description"),
  /** JSON array of image URLs for this dining venue. */
  images: text("images").notNull().default("[]"),
  /** Path to the menu file (PDF or image) under client/public, if one has
   *  been placed there — null until the operator adds it. Never fetched or
   *  generated automatically; this only ever points at a local file. */
  menuFile: text("menu_file"),
  sourceFile: text("source_file").notNull(),
  sourceUrl: text("source_url"),
});

export type DiningVenue = typeof diningVenues.$inferSelect;
export type InsertDiningVenue = typeof diningVenues.$inferInsert;

/** Retrieval index: one row per chunk of a KB article or policy, with its embedding. */
export const docChunks = sqliteTable("doc_chunks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind").notNull(), // kb | policy
  refId: integer("ref_id").notNull(),
  ordinal: integer("ordinal").notNull().default(0),
  title: text("title").notNull(),
  category: text("category").notNull(),
  sourceUrl: text("source_url"),
  body: text("body").notNull(),
  tokens: integer("tokens").notNull().default(0),
  embedding: text("embedding"), // JSON array of floats, null until indexed
  embedModel: text("embed_model"),
  updatedAt: text("updated_at").notNull(),
  /* Provenance carried from the source document so a retrieved passage knows how
     much it can be trusted — the generator must flag an unverified/placeholder hit. */
  quality: text("quality").notNull().default("curated"),
  verified: text("verified").notNull().default("unverified"),
  contentClass: text("content_class").notNull().default("static"),
});

export const offers = sqliteTable("offers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hotelId: integer("hotel_id").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  segment: text("segment").notNull(), // all | in_house | arriving | departing | vip | repeat
  price: real("price"),
  active: integer("active").notNull().default(1),
});

export const campaigns = sqliteTable("campaigns", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hotelId: integer("hotel_id").notNull(),
  name: text("name").notNull(),
  segment: text("segment").notNull(),
  body: text("body").notNull(),
  recipients: integer("recipients").notNull().default(0),
  status: text("status").notNull().default("draft"), // draft | sent
  sentAt: text("sent_at"),
  createdAt: text("created_at").notNull(),
});

export const auditEvents = sqliteTable("audit_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(),
  actor: text("actor").notNull(), // ai | staff:<id> | guest:<id> | system
  summary: text("summary").notNull(),
  payload: text("payload"),
  conversationId: integer("conversation_id"),
  createdAt: text("created_at").notNull(),
});

/**
 * One node of an agent turn's execution tree. A turn is a root span (kind
 * "turn") whose children are the LLM calls, tool calls, retrieval, and guard
 * checks it fanned out to. Persisted so a trace survives a restart and can be
 * queried by conversation, by tool, or by which signal fired — the difference
 * between "the agent felt wrong" and "get_folio was called before the guest
 * gave a date, on turn 3, and that is why it asked again".
 *
 * `signals` is the observability payload: a JSON array of typed flags
 * ({code, severity, detail}) describing anything that went wrong or is worth
 * watching on this span. The taxonomy lives in server/observability.ts.
 */
export const traceSpans = sqliteTable("trace_spans", {
  /** Span id, e.g. "sp_a1b2c3". Text so it can be generated without a round-trip. */
  id: text("id").primaryKey(),
  /** All spans of one agent turn share this. */
  traceId: text("trace_id").notNull(),
  conversationId: integer("conversation_id").notNull(),
  /** Null for the root turn span; otherwise the enclosing span's id. */
  parentId: text("parent_id"),
  /** Human name: "agent.turn", "llm.chat", "tool.get_folio", "retrieval.hybrid". */
  name: text("name").notNull(),
  /** turn | llm | tool | retrieval | guard | wizard | router */
  kind: text("kind").notNull(),
  /** ok | warn | error — rolled up to the turn span so a listing is one read. */
  status: text("status").notNull().default("ok"),
  provider: text("provider"),
  model: text("model"),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
  durationMs: integer("duration_ms"),
  /** JSON: span-specific context (tool args/result summary, family selection…). */
  attributes: text("attributes"),
  /** JSON array of {code, severity, detail}. Empty array when clean. */
  signals: text("signals").notNull().default("[]"),
  error: text("error"),
  createdAt: text("created_at").notNull(),
});

/**
 * A tiny key-value store for runtime configuration a non-technical operator can
 * change from the UI without editing files or restarting — currently the
 * Langfuse keys. Secrets live here rather than only in .env so the "paste your
 * key" box on the Settings page has somewhere to save to; an env var of the same
 * name always wins, so ops can still lock it down.
 */
/**
 * Published rate packages per room category — the upsell ladder.
 *
 * One row per (room category × package): the same room is sold as breakfast-only,
 * with unlimited VinWonders admission, on full board, or with golf rounds. The
 * facet columns are denormalised deliberately so the agent can filter on what a
 * guest actually asks for ("we want the buffet", "somewhere I can golf", "under
 * 5 million") with a plain SQL predicate rather than an LLM reading prose.
 *
 * Prices are the property's published rate card. `conditions` holds date-bound
 * text (cancellation deadline, no-show) verbatim for display — the agent must
 * quote it, never compute a deadline from it.
 */
export const roomPackages = sqliteTable("room_packages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hotelId: integer("hotel_id").notNull(),
  /** room_types.code; kept as text so a package can exist before its room row does. */
  roomCode: text("room_code").notNull(),
  roomNameVi: text("room_name_vi").notNull(),
  name: text("name").notNull(),
  publicPrice: real("public_price").notNull(),
  memberPrice: real("member_price"),
  /** breakfast | full_board | none */
  mealPlan: text("meal_plan").notNull().default("none"),
  vinwonders: integer("vinwonders").notNull().default(0),
  golfRounds: integer("golf_rounds").notNull().default(0),
  hotelCredit: real("hotel_credit").notNull().default(0),
  aquafield: integer("aquafield").notNull().default(0),
  saunaJacuzzi: integer("sauna_jacuzzi").notNull().default(0),
  cableCar: integer("cable_car").notNull().default(0),
  spaDiscountPct: integer("spa_discount_pct").notNull().default(0),
  fnbDiscountPct: integer("fnb_discount_pct").notNull().default(0),
  golfDiscountPct: integer("golf_discount_pct").notNull().default(0),
  /** JSON array of inclusion bullets, verbatim. */
  inclusions: text("inclusions").notNull().default("[]"),
  /** JSON array of date-bound conditions, verbatim. */
  conditions: text("conditions").notNull().default("[]"),
  hasBlackout: integer("has_blackout").notNull().default(0),
  sourceFile: text("source_file"),
  updatedAt: text("updated_at").notNull(),
});

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/* ------------------------------------------------------------------ *
 * Insert schemas & types
 * ------------------------------------------------------------------ */

export const insertGuestSchema = createInsertSchema(guests).omit({ id: true });
export const insertReservationSchema = createInsertSchema(reservations).omit({ id: true });
export const insertMessageSchema = createInsertSchema(messages).omit({ id: true });
export const insertTaskSchema = createInsertSchema(tasks).omit({ id: true, createdAt: true });
export const insertKbSchema = createInsertSchema(kbArticles).omit({ id: true, updatedAt: true });
export const insertServiceSchema = createInsertSchema(services).omit({ id: true });
export const insertOfferSchema = createInsertSchema(offers).omit({ id: true });
export const insertCampaignSchema = createInsertSchema(campaigns).omit({
  id: true,
  createdAt: true,
  sentAt: true,
  recipients: true,
  status: true,
});

export type Hotel = typeof hotels.$inferSelect;
export type Staff = typeof staff.$inferSelect;
export type Room = typeof rooms.$inferSelect;
export type Guest = typeof guests.$inferSelect;
export type Reservation = typeof reservations.$inferSelect;
export type FolioCharge = typeof folioCharges.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type Service = typeof services.$inferSelect;
export type ServiceBooking = typeof serviceBookings.$inferSelect;
export type KbArticle = typeof kbArticles.$inferSelect;
export type Policy = typeof policies.$inferSelect;
export type Restriction = typeof restrictions.$inferSelect;
export type RoomType = typeof roomTypes.$inferSelect;
export type InsertRoomType = typeof roomTypes.$inferInsert;
export type DocChunk = typeof docChunks.$inferSelect;
export type Offer = typeof offers.$inferSelect;
export type Campaign = typeof campaigns.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type TraceSpan = typeof traceSpans.$inferSelect;
export type InsertTraceSpan = typeof traceSpans.$inferInsert;
export type AppSetting = typeof appSettings.$inferSelect;
export type RoomPackageRow = typeof roomPackages.$inferSelect;

/**
 * Identity of the vector index currently stored in the database.
 *
 * Hand-written rather than inferred from a Drizzle table, because it is read by
 * the startup compatibility check before any ORM model is needed, and keeping it
 * plain makes the check readable at the point where it refuses to start.
 */
export type IndexMeta = {
  provider: string;
  model: string;
  dimension: number;
  /** Bumped when text PREPARATION changes even though the model name has not. */
  embeddingVersion: string;
  chunkCount: number;
  vectorCount: number;
  createdAt: string;
};
export type InsertRoomPackage = typeof roomPackages.$inferInsert;
export type GuestRequest = typeof guestRequests.$inferSelect;
export type GuestRegistration = typeof guestRegistrations.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type InvoiceRequest = typeof invoiceRequests.$inferSelect;
export type FeedbackEntry = typeof feedbackEntries.$inferSelect;

export type InsertTask = z.infer<typeof insertTaskSchema>;
export type InsertKb = z.infer<typeof insertKbSchema>;
export type InsertCampaign = z.infer<typeof insertCampaignSchema>;

/* ------------------------------------------------------------------ *
 * Operational guest requests
 *
 * One table for every "please do X in my room / for my stay" request the
 * concierge can raise — housekeeping, wake-up call, laundry, luggage,
 * transport, lost property, amenities, babysitting, medical help. Each row
 * carries the dispatched task id so `get_request_status` can answer with the
 * real department status instead of a promise.
 * ------------------------------------------------------------------ */

export const guestRequests = sqliteTable("guest_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hotelId: integer("hotel_id").notNull(),
  reservationId: integer("reservation_id"),
  guestId: integer("guest_id"),
  conversationId: integer("conversation_id"),
  taskId: integer("task_id"),
  /** housekeeping | wake_up | laundry | luggage | transport | lost_item | amenity | room_move | maintenance | babysitting | medical | meeting_room | tour | feedback */
  kind: text("kind").notNull(),
  dept: text("dept").notNull(),
  summary: text("summary").notNull(),
  /** JSON blob with the kind-specific fields, so no new table per request type. */
  payload: text("payload").notNull().default("{}"),
  /** ISO datetime the guest asked it to happen (wake-up time, pickup time…). */
  scheduledFor: text("scheduled_for"),
  status: text("status").notNull().default("open"), // open | in_progress | done | cancelled
  /** Money posted to the folio for this request, if any. */
  amount: real("amount"),
  chargeId: integer("charge_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  resolvedAt: text("resolved_at"),
  resolutionNote: text("resolution_note"),
});

/**
 * Human-in-the-loop gate for every AI-initiated service request (book,
 * cancel, room-service order). The AI's tool call stops at "queued" — it
 * never posts a charge or flips a booking to confirmed itself. A staff
 * member approving or rejecting here is what actually commits the write
 * (see `finalizeApproval` in server/ops.ts). `payload` carries exactly the
 * arguments needed to perform that deferred write, so the executor has no
 * other source of truth to drift from.
 */
export const serviceApprovals = sqliteTable("service_approvals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hotelId: integer("hotel_id").notNull(),
  reservationId: integer("reservation_id"),
  guestId: integer("guest_id"),
  conversationId: integer("conversation_id"),
  taskId: integer("task_id"),
  /** book_service | cancel_service_booking | order_room_service */
  kind: text("kind").notNull(),
  summary: text("summary").notNull(),
  payload: text("payload").notNull().default("{}"),
  amount: real("amount"),
  status: text("status").notNull().default("pending"), // pending | approved | rejected
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at"),
  resolvedBy: text("resolved_by"),
  rejectionReason: text("rejection_reason"),
});
export type ServiceApproval = typeof serviceApprovals.$inferSelect;

/**
 * Statutory lodging declaration (khai báo lưu trú) — Thông tư 55/2021/TT-BCA as
 * amended by 66/2023/TT-BCA. Aurea collects and queues it; a human submits it
 * through the police portal or VNeID, and that submission is recorded here.
 */
export const guestRegistrations = sqliteTable("guest_registrations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hotelId: integer("hotel_id").notNull(),
  reservationId: integer("reservation_id").notNull(),
  guestId: integer("guest_id"),
  fullName: text("full_name").notNull(),
  idType: text("id_type").notNull(), // passport | national_id | other
  idNumber: text("id_number").notNull(),
  nationality: text("nationality").notNull(),
  dob: text("dob"),
  gender: text("gender"),
  /** Foreign guests: visa / entry details required by the declaration form. */
  visaNumber: text("visa_number"),
  entryDate: text("entry_date"),
  entryPort: text("entry_port"),
  permanentAddress: text("permanent_address"),
  arrivalAt: text("arrival_at").notNull(),
  departureAt: text("departure_at"),
  isForeigner: integer("is_foreigner").notNull().default(0),
  /** collected = fields captured, queued = task raised, submitted = a human filed it, rejected */
  status: text("status").notNull().default("collected"),
  channel: text("channel"), // police_portal | vneid | ward_office
  submittedAt: text("submitted_at"),
  submittedBy: integer("submitted_by"),
  receiptRef: text("receipt_ref"),
  taskId: integer("task_id"),
  note: text("note"),
  createdAt: text("created_at").notNull(),
});

/** Folio settlement. No card is ever charged by Aurea itself. */
export const payments = sqliteTable("payments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hotelId: integer("hotel_id").notNull(),
  reservationId: integer("reservation_id").notNull(),
  amount: real("amount").notNull(),
  currency: text("currency").notNull().default("VND"),
  /** card_on_file | payment_link | cash | bank_transfer | room_charge */
  method: text("method").notNull(),
  /** pending | authorised | paid | failed | refunded | cancelled */
  status: text("status").notNull().default("pending"),
  /** Which gateway actually holds the money. "not_connected" = staff must collect. */
  provider: text("provider").notNull().default("not_connected"),
  token: text("token").unique(),
  link: text("link"),
  reference: text("reference"),
  chargeId: integer("charge_id"),
  taskId: integer("task_id"),
  expiresAt: text("expires_at"),
  paidAt: text("paid_at"),
  createdAt: text("created_at").notNull(),
  note: text("note"),
});

/** VAT invoice request (hóa đơn GTGT) with the buyer's tax details. */
export const invoiceRequests = sqliteTable("invoice_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hotelId: integer("hotel_id").notNull(),
  reservationId: integer("reservation_id").notNull(),
  buyerName: text("buyer_name").notNull(),
  taxCode: text("tax_code"),
  buyerAddress: text("buyer_address"),
  email: text("email").notNull(),
  /** personal | company */
  buyerType: text("buyer_type").notNull().default("personal"),
  netAmount: real("net_amount").notNull(),
  serviceCharge: real("service_charge").notNull().default(0),
  vatAmount: real("vat_amount").notNull().default(0),
  grossAmount: real("gross_amount").notNull(),
  status: text("status").notNull().default("requested"), // requested | issued | rejected
  invoiceNo: text("invoice_no"),
  issuedAt: text("issued_at"),
  taskId: integer("task_id"),
  note: text("note"),
  createdAt: text("created_at").notNull(),
});

/** Post-stay / in-stay guest feedback. */
export const feedbackEntries = sqliteTable("feedback", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hotelId: integer("hotel_id").notNull(),
  reservationId: integer("reservation_id"),
  guestId: integer("guest_id"),
  conversationId: integer("conversation_id"),
  rating: integer("rating"), // 1..5
  category: text("category").notNull().default("general"),
  comment: text("comment").notNull(),
  sentiment: text("sentiment").notNull().default("neutral"),
  taskId: integer("task_id"),
  status: text("status").notNull().default("new"), // new | acknowledged | resolved
  createdAt: text("created_at").notNull(),
});

/* Convenience view types shared with the client */

export type ToolCallTrace = {
  name: string;
  args: Record<string, unknown>;
  result: Record<string, unknown> | string;
  ms: number;
};

export type ConversationRow = Conversation & {
  guestName: string;
  guestLang: string;
  vipTier: string;
  roomNumber: string | null;
  confirmationCode: string | null;
  lastMessageBody: string;
  openTasks: number;
};

export type DeptKey =
  | "front_desk"
  | "housekeeping"
  | "fnb"
  | "engineering"
  | "spa"
  | "security"
  | "it"
  | "bell"
  | "transport"
  | "laundry";

export const DEPT_LABELS: Record<string, string> = {
  front_desk: "Front Desk",
  housekeeping: "Housekeeping",
  fnb: "Food & Beverage",
  engineering: "Engineering",
  spa: "Spa & Wellness",
  security: "Security",
  it: "IT",
  bell: "Bell & Concierge",
  transport: "Transport",
  laundry: "Laundry",
};

export const DEPT_KEYS = Object.keys(DEPT_LABELS) as DeptKey[];
