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
});

export const folioCharges = sqliteTable("folio_charges", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  reservationId: integer("reservation_id").notNull(),
  description: text("description").notNull(),
  amount: real("amount").notNull(),
  category: text("category").notNull(), // room | fnb | spa | minibar | fee
  createdAt: text("created_at").notNull(),
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
});

export const kbArticles = sqliteTable("kb_articles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hotelId: integer("hotel_id").notNull(),
  category: text("category").notNull(), // property | policy | dining | neighborhood | wayfinding
  title: text("title").notNull(),
  body: text("body").notNull(),
  tags: text("tags").notNull().default("[]"), // JSON array
  updatedAt: text("updated_at").notNull(),
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
export type Offer = typeof offers.$inferSelect;
export type Campaign = typeof campaigns.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;

export type InsertTask = z.infer<typeof insertTaskSchema>;
export type InsertKb = z.infer<typeof insertKbSchema>;
export type InsertCampaign = z.infer<typeof insertCampaignSchema>;

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

export type DeptKey = "front_desk" | "housekeeping" | "fnb" | "engineering" | "spa";

export const DEPT_LABELS: Record<string, string> = {
  front_desk: "Front Desk",
  housekeeping: "Housekeeping",
  fnb: "Food & Beverage",
  engineering: "Engineering",
  spa: "Spa & Wellness",
};
