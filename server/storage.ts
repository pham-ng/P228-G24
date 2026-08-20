import {
  hotels,
  staff,
  rooms,
  guests,
  reservations,
  folioCharges,
  conversations,
  messages,
  tasks,
  services,
  serviceBookings,
  kbArticles,
  policies,
  restrictions,
  roomTypes,
  diningVenues,
  docChunks,
  offers,
  campaigns,
  auditEvents,
} from "@shared/schema";
import type {
  Hotel,
  Staff,
  Room,
  Guest,
  Reservation,
  FolioCharge,
  Conversation,
  Message,
  Task,
  Service,
  ServiceBooking,
  KbArticle,
  Policy,
  Restriction,
  RoomType,
  InsertRoomType,
  DiningVenue,
  InsertDiningVenue,
  DocChunk,
  Offer,
  Campaign,
  AuditEvent,
  ConversationRow,
} from "@shared/schema";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";

const sqlite = new Database(process.env.DB_FILE || "data.db");
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite);

/* ------------------------------------------------------------------ *
 * Schema bootstrap (kept in code so the app is runnable from scratch)
 * ------------------------------------------------------------------ */

function addColumnIfMissing(table: string, column: string, ddl: string) {
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

export function migrate() {
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS hotels (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, city TEXT NOT NULL,
  timezone TEXT NOT NULL, currency TEXT NOT NULL, check_in_time TEXT NOT NULL,
  check_out_time TEXT NOT NULL, brand_voice TEXT NOT NULL, sla_minutes INTEGER NOT NULL,
  ai_enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, role TEXT NOT NULL,
  dept TEXT NOT NULL, pin TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT, number TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
  floor INTEGER NOT NULL, status TEXT NOT NULL, housekeeping_note TEXT,
  base_rate REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS guests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE,
  email TEXT, lang TEXT NOT NULL DEFAULT 'en', vip_tier TEXT NOT NULL DEFAULT 'none',
  preferences TEXT NOT NULL DEFAULT '[]', notes TEXT, stays_count INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, guest_id INTEGER NOT NULL,
  room_id INTEGER, confirmation_code TEXT NOT NULL UNIQUE, check_in TEXT NOT NULL,
  check_out TEXT NOT NULL, check_out_time TEXT NOT NULL, adults INTEGER NOT NULL DEFAULT 1,
  children INTEGER NOT NULL DEFAULT 0, rate_per_night REAL NOT NULL, status TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'direct'
);
CREATE TABLE IF NOT EXISTS folio_charges (
  id INTEGER PRIMARY KEY AUTOINCREMENT, reservation_id INTEGER NOT NULL, description TEXT NOT NULL,
  amount REAL NOT NULL, category TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, guest_id INTEGER NOT NULL,
  reservation_id INTEGER, channel TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'ai',
  assigned_staff_id INTEGER, sentiment TEXT NOT NULL DEFAULT 'neutral', topic TEXT,
  unread_for_staff INTEGER NOT NULL DEFAULT 0, last_message_at TEXT NOT NULL,
  created_at TEXT NOT NULL, first_response_seconds INTEGER
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER NOT NULL, role TEXT NOT NULL,
  author_name TEXT, body TEXT NOT NULL, tool_trace TEXT, latency_ms INTEGER, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, reservation_id INTEGER,
  room_id INTEGER, conversation_id INTEGER, dept TEXT NOT NULL, title TEXT NOT NULL, detail TEXT,
  priority TEXT NOT NULL DEFAULT 'normal', status TEXT NOT NULL DEFAULT 'open',
  source TEXT NOT NULL DEFAULT 'ai', assigned_staff_id INTEGER, due_at TEXT,
  created_at TEXT NOT NULL, resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, category TEXT NOT NULL,
  description TEXT NOT NULL, price REAL NOT NULL, unit TEXT NOT NULL DEFAULT 'per person',
  dept TEXT NOT NULL, slots TEXT NOT NULL DEFAULT '[]', capacity_per_slot INTEGER NOT NULL DEFAULT 4,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS service_bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT, service_id INTEGER NOT NULL, reservation_id INTEGER NOT NULL,
  date TEXT NOT NULL, slot TEXT NOT NULL, party_size INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'confirmed', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kb_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, category TEXT NOT NULL,
  title TEXT NOT NULL, body TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, code TEXT NOT NULL UNIQUE,
  topic TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL,
  rules TEXT NOT NULL DEFAULT '{}', source_url TEXT NOT NULL, source_title TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS restrictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, date TEXT NOT NULL,
  room_type TEXT, min_los INTEGER, max_los INTEGER,
  closed_to_arrival INTEGER NOT NULL DEFAULT 0, closed_to_departure INTEGER NOT NULL DEFAULT 0,
  stop_sell INTEGER NOT NULL DEFAULT 0, label TEXT NOT NULL, reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS restrictions_date ON restrictions (date);
CREATE TABLE IF NOT EXISTS room_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, code TEXT NOT NULL UNIQUE,
  name_vi TEXT NOT NULL, area_sqm REAL, bedrooms INTEGER, bed TEXT,
  ocean_view INTEGER NOT NULL DEFAULT 0, private_pool INTEGER NOT NULL DEFAULT 0,
  max_guests INTEGER, combinations TEXT NOT NULL DEFAULT '[]', description TEXT NOT NULL,
  amenities TEXT NOT NULL DEFAULT '[]', source_file TEXT NOT NULL, source_url TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dining_venues (
  id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, code TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL, kind TEXT NOT NULL, name_vi TEXT NOT NULL, location TEXT, phone TEXT,
  hours TEXT NOT NULL DEFAULT '[]', meal_windows TEXT NOT NULL DEFAULT '[]',
  last_order TEXT, prep_time TEXT, capacity INTEGER, price_range TEXT,
  price_min REAL, price_max REAL, price_note TEXT,
  cuisine TEXT NOT NULL DEFAULT '[]', dishes_served TEXT NOT NULL DEFAULT '[]',
  highlights TEXT NOT NULL DEFAULT '[]', good_for TEXT NOT NULL DEFAULT '[]',
  amenities TEXT NOT NULL DEFAULT '[]', menu_groups TEXT NOT NULL DEFAULT '[]',
  description TEXT, source_file TEXT NOT NULL, source_url TEXT
);
CREATE TABLE IF NOT EXISTS doc_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ref_id INTEGER NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, category TEXT NOT NULL,
  source_url TEXT, body TEXT NOT NULL, tokens INTEGER NOT NULL DEFAULT 0,
  embedding TEXT, embed_model TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS doc_chunks_ref ON doc_chunks (kind, ref_id);
CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, title TEXT NOT NULL,
  body TEXT NOT NULL, segment TEXT NOT NULL, price REAL, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, name TEXT NOT NULL,
  segment TEXT NOT NULL, body TEXT NOT NULL, recipients INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft', sent_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, actor TEXT NOT NULL,
  summary TEXT NOT NULL, payload TEXT, conversation_id INTEGER, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_task_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_conv_last ON conversations(last_message_at);
`);
  addColumnIfMissing("rooms", "base_rate", "base_rate REAL NOT NULL DEFAULT 0");
}

export const nowIso = () => new Date().toISOString();

/* ------------------------------------------------------------------ *
 * Storage interface
 * ------------------------------------------------------------------ */

export const storage = {
  /* --- property --- */
  getHotel(): Hotel {
    return db.select().from(hotels).limit(1).get()!;
  },
  updateHotel(patch: Partial<Hotel>) {
    const h = storage.getHotel();
    db.update(hotels).set(patch).where(eq(hotels.id, h.id)).run();
    return storage.getHotel();
  },

  listStaff(): Staff[] {
    return db.select().from(staff).where(eq(staff.active, 1)).all();
  },
  getStaff(id: number): Staff | undefined {
    return db.select().from(staff).where(eq(staff.id, id)).get();
  },
  authStaff(name: string, pin: string): Staff | undefined {
    return db.select().from(staff).where(and(eq(staff.name, name), eq(staff.pin, pin))).get();
  },

  listRooms(): Room[] {
    return db.select().from(rooms).orderBy(asc(rooms.number)).all();
  },
  getRoom(id: number | null): Room | undefined {
    if (!id) return undefined;
    return db.select().from(rooms).where(eq(rooms.id, id)).get();
  },
  updateRoom(id: number, patch: Partial<Room>): Room {
    db.update(rooms).set(patch).where(eq(rooms.id, id)).run();
    return db.select().from(rooms).where(eq(rooms.id, id)).get()!;
  },

  /* --- guests & reservations --- */
  listGuests(): Guest[] {
    return db.select().from(guests).all();
  },
  getGuest(id: number): Guest | undefined {
    return db.select().from(guests).where(eq(guests.id, id)).get();
  },
  createGuest(v: Omit<Guest, "id">): Guest {
    const r = db.insert(guests).values(v).returning().get();
    return r;
  },
  updateGuest(id: number, patch: Partial<Guest>): Guest {
    db.update(guests).set(patch).where(eq(guests.id, id)).run();
    return db.select().from(guests).where(eq(guests.id, id)).get()!;
  },

  listReservations(): Reservation[] {
    return db.select().from(reservations).orderBy(asc(reservations.checkIn)).all();
  },
  createReservation(v: Omit<Reservation, "id">): Reservation {
    return db.insert(reservations).values(v).returning().get();
  },
  getReservation(id: number | null): Reservation | undefined {
    if (!id) return undefined;
    return db.select().from(reservations).where(eq(reservations.id, id)).get();
  },
  getReservationByCode(code: string): Reservation | undefined {
    return db
      .select()
      .from(reservations)
      .where(eq(reservations.confirmationCode, code.toUpperCase().trim()))
      .get();
  },
  updateReservation(id: number, patch: Partial<Reservation>): Reservation {
    db.update(reservations).set(patch).where(eq(reservations.id, id)).run();
    return db.select().from(reservations).where(eq(reservations.id, id)).get()!;
  },
  /** Next reservation occupying the same room after the given checkout date. */
  nextReservationForRoom(roomId: number, afterDate: string): Reservation | undefined {
    return db
      .select()
      .from(reservations)
      .where(
        and(
          eq(reservations.roomId, roomId),
          sql`${reservations.checkIn} >= ${afterDate}`,
          ne(reservations.status, "cancelled"),
        ),
      )
      .orderBy(asc(reservations.checkIn))
      .get();
  },

  listCharges(reservationId: number): FolioCharge[] {
    return db
      .select()
      .from(folioCharges)
      .where(eq(folioCharges.reservationId, reservationId))
      .orderBy(asc(folioCharges.id))
      .all();
  },
  addCharge(c: Omit<FolioCharge, "id">): FolioCharge {
    return db.insert(folioCharges).values(c).returning().get();
  },

  /* --- conversations --- */
  listConversations(): ConversationRow[] {
    const convs = db
      .select()
      .from(conversations)
      .orderBy(desc(conversations.lastMessageAt))
      .all();
    return convs.map((c) => {
      const g = storage.getGuest(c.guestId);
      const r = storage.getReservation(c.reservationId);
      const room = storage.getRoom(r?.roomId ?? null);
      const last = db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, c.id))
        .orderBy(desc(messages.id))
        .limit(1)
        .get();
      const open = db
        .select({ n: sql<number>`count(*)` })
        .from(tasks)
        .where(and(eq(tasks.conversationId, c.id), inArray(tasks.status, ["open", "in_progress"])))
        .get();
      return {
        ...c,
        guestName: g?.name ?? "Unknown",
        guestLang: g?.lang ?? "en",
        vipTier: g?.vipTier ?? "none",
        roomNumber: room?.number ?? null,
        confirmationCode: r?.confirmationCode ?? null,
        lastMessageBody: last?.body ?? "",
        openTasks: open?.n ?? 0,
      };
    });
  },
  getConversation(id: number): Conversation | undefined {
    return db.select().from(conversations).where(eq(conversations.id, id)).get();
  },
  getConversationForReservation(reservationId: number): Conversation | undefined {
    return db
      .select()
      .from(conversations)
      .where(eq(conversations.reservationId, reservationId))
      .get();
  },
  createConversation(v: Omit<Conversation, "id">): Conversation {
    return db.insert(conversations).values(v).returning().get();
  },
  updateConversation(id: number, patch: Partial<Conversation>): Conversation {
    db.update(conversations).set(patch).where(eq(conversations.id, id)).run();
    return db.select().from(conversations).where(eq(conversations.id, id)).get()!;
  },

  listMessages(conversationId: number): Message[] {
    return db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.id))
      .all();
  },
  addMessage(v: Omit<Message, "id">): Message {
    const m = db.insert(messages).values(v).returning().get();
    db.update(conversations)
      .set({ lastMessageAt: v.createdAt })
      .where(eq(conversations.id, v.conversationId))
      .run();
    return m;
  },

  /* --- tasks --- */
  listTasks(): Task[] {
    return db.select().from(tasks).orderBy(desc(tasks.id)).all();
  },
  createTask(v: Omit<Task, "id">): Task {
    return db.insert(tasks).values(v).returning().get();
  },
  updateTask(id: number, patch: Partial<Task>): Task {
    db.update(tasks).set(patch).where(eq(tasks.id, id)).run();
    return db.select().from(tasks).where(eq(tasks.id, id)).get()!;
  },

  /* --- catalogue --- */
  listServices(): Service[] {
    return db.select().from(services).where(eq(services.active, 1)).all();
  },
  getService(id: number): Service | undefined {
    return db.select().from(services).where(eq(services.id, id)).get();
  },
  listBookings(): ServiceBooking[] {
    return db.select().from(serviceBookings).orderBy(desc(serviceBookings.id)).all();
  },
  bookingsFor(serviceId: number, date: string): ServiceBooking[] {
    return db
      .select()
      .from(serviceBookings)
      .where(
        and(
          eq(serviceBookings.serviceId, serviceId),
          eq(serviceBookings.date, date),
          eq(serviceBookings.status, "confirmed"),
        ),
      )
      .all();
  },
  createBooking(v: Omit<ServiceBooking, "id">): ServiceBooking {
    return db.insert(serviceBookings).values(v).returning().get();
  },

  /* ---------------- room catalogue ---------------- */
  listRoomTypes(): RoomType[] {
    return db.select().from(roomTypes).orderBy(asc(roomTypes.areaSqm)).all();
  },

  createRoomType(v: InsertRoomType): RoomType {
    return db.insert(roomTypes).values(v).returning().get();
  },

  /* ---------------- dining venues ---------------- */
  listDiningVenues(): DiningVenue[] {
    return db.select().from(diningVenues).orderBy(asc(diningVenues.kind), asc(diningVenues.code)).all();
  },

  createDiningVenue(v: InsertDiningVenue): DiningVenue {
    return db.insert(diningVenues).values(v).returning().get();
  },

  /* ---------------- rate restrictions ---------------- */
  listRestrictions(): Restriction[] {
    return db.select().from(restrictions).orderBy(asc(restrictions.date)).all();
  },
  /** Every restriction row touching the half-open window [from, to). */
  restrictionsBetween(from: string, to: string): Restriction[] {
    return db
      .select()
      .from(restrictions)
      .where(and(sql`${restrictions.date} >= ${from}`, sql`${restrictions.date} <= ${to}`))
      .orderBy(asc(restrictions.date))
      .all();
  },
  createRestriction(v: Omit<Restriction, "id">): Restriction {
    return db.insert(restrictions).values(v).returning().get();
  },

  /* ---------------- policies ---------------- */
  listPolicies(): Policy[] {
    return db.select().from(policies).orderBy(asc(policies.topic)).all();
  },
  getPolicy(code: string): Policy | undefined {
    return db.select().from(policies).where(eq(policies.code, code)).get();
  },
  policiesByTopic(topic: string): Policy[] {
    return db.select().from(policies).where(eq(policies.topic, topic)).all();
  },
  createPolicy(v: Omit<Policy, "id">): Policy {
    return db.insert(policies).values(v).returning().get();
  },

  /* ---------------- retrieval index ---------------- */
  listChunks(): DocChunk[] {
    return db.select().from(docChunks).all();
  },
  clearChunks() {
    db.delete(docChunks).run();
  },
  createChunk(v: Omit<DocChunk, "id">): DocChunk {
    return db.insert(docChunks).values(v).returning().get();
  },
  setChunkEmbedding(id: number, embedding: string, model: string) {
    db.update(docChunks).set({ embedding, embedModel: model }).where(eq(docChunks.id, id)).run();
  },
  chunksWithoutEmbedding(): DocChunk[] {
    return db.select().from(docChunks).where(isNull(docChunks.embedding)).all();
  },

  listKb(): KbArticle[] {
    return db.select().from(kbArticles).orderBy(asc(kbArticles.category)).all();
  },
  createKb(v: Omit<KbArticle, "id">): KbArticle {
    return db.insert(kbArticles).values(v).returning().get();
  },
  updateKb(id: number, patch: Partial<KbArticle>): KbArticle {
    db.update(kbArticles).set(patch).where(eq(kbArticles.id, id)).run();
    return db.select().from(kbArticles).where(eq(kbArticles.id, id)).get()!;
  },
  deleteKb(id: number) {
    db.delete(kbArticles).where(eq(kbArticles.id, id)).run();
  },

  listOffers(): Offer[] {
    return db.select().from(offers).where(eq(offers.active, 1)).all();
  },

  listCampaigns(): Campaign[] {
    return db.select().from(campaigns).orderBy(desc(campaigns.id)).all();
  },
  createCampaign(v: Omit<Campaign, "id">): Campaign {
    return db.insert(campaigns).values(v).returning().get();
  },
  updateCampaign(id: number, patch: Partial<Campaign>): Campaign {
    db.update(campaigns).set(patch).where(eq(campaigns.id, id)).run();
    return db.select().from(campaigns).where(eq(campaigns.id, id)).get()!;
  },

  /* --- audit --- */
  logEvent(v: Omit<AuditEvent, "id">): AuditEvent {
    return db.insert(auditEvents).values(v).returning().get();
  },
  listEvents(limit = 120): AuditEvent[] {
    return db.select().from(auditEvents).orderBy(desc(auditEvents.id)).limit(limit).all();
  },
};

export { sqlite };

/**
 * The property's operating timezone. Every "today" in the product is the
 * hotel's calendar day, not the server's UTC day — a guest asking about
 * "tonight" at 00:30 local time must not be answered with yesterday's date.
 */
export const HOTEL_TZ = "Asia/Ho_Chi_Minh";
export const hotelToday = () => new Date().toLocaleDateString("en-CA", { timeZone: HOTEL_TZ });
export const hotelClock = () =>
  new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: HOTEL_TZ });
