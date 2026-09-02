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
  upsellImpressions,
  kbArticles,
  policies,
  restrictions,
  roomTypes,
  diningVenues,
  docChunks,
  offers,
  campaigns,
  auditEvents,
  traceSpans,
  appSettings,
  roomPackages,
  guestRequests,
  serviceApprovals,
  guestRegistrations,
  payments,
  invoiceRequests,
  feedbackEntries,
  type IndexMeta,
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
  UpsellImpression,
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
  TraceSpan,
  InsertTraceSpan,
  RoomPackageRow,
  InsertRoomPackage,
  ConversationRow,
  GuestRequest,
  ServiceApproval,
  GuestRegistration,
  Payment,
  InvoiceRequest,
  FeedbackEntry,
} from "@shared/schema";
import { readdirSync, existsSync } from "fs";
import { join } from "path";
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
  -- Provenance of the sentiment column: seed, model_realtime, model_llm or
  -- thumbs_down. NULL means nobody has judged this conversation, which is not
  -- the same as the guest being fine. Without it the insights dashboard cannot
  -- tell a real verdict from a seed fixture, and for a long time it did not.
  sentiment_source TEXT, sentiment_at TEXT,
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
CREATE TABLE IF NOT EXISTS upsell_impressions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, reservation_id INTEGER NOT NULL,
  conversation_id INTEGER, service_id INTEGER NOT NULL, service_name TEXT NOT NULL,
  position INTEGER NOT NULL, score REAL NOT NULL, why TEXT NOT NULL DEFAULT '',
  day_part TEXT NOT NULL, stay_phase TEXT NOT NULL, wet INTEGER NOT NULL DEFAULT 0,
  price REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_upsell_res ON upsell_impressions(reservation_id, service_id);
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
  description TEXT, menu_file TEXT, source_file TEXT NOT NULL, source_url TEXT
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
CREATE TABLE IF NOT EXISTS guest_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, reservation_id INTEGER,
  guest_id INTEGER, conversation_id INTEGER, task_id INTEGER, kind TEXT NOT NULL,
  dept TEXT NOT NULL, summary TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
  scheduled_for TEXT, status TEXT NOT NULL DEFAULT 'open', amount REAL, charge_id INTEGER,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT, resolution_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_req_res ON guest_requests(reservation_id);
CREATE INDEX IF NOT EXISTS idx_req_status ON guest_requests(status);
CREATE TABLE IF NOT EXISTS service_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, reservation_id INTEGER,
  guest_id INTEGER, conversation_id INTEGER, task_id INTEGER, kind TEXT NOT NULL,
  summary TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', amount REAL,
  status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL,
  resolved_at TEXT, resolved_by TEXT, rejection_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_approval_status ON service_approvals(status);
CREATE TABLE IF NOT EXISTS guest_registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, reservation_id INTEGER NOT NULL,
  guest_id INTEGER, full_name TEXT NOT NULL, id_type TEXT NOT NULL, id_number TEXT NOT NULL,
  nationality TEXT NOT NULL, dob TEXT, gender TEXT, visa_number TEXT, entry_date TEXT,
  entry_port TEXT, permanent_address TEXT, arrival_at TEXT NOT NULL, departure_at TEXT,
  is_foreigner INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'collected',
  channel TEXT, submitted_at TEXT, submitted_by INTEGER, receipt_ref TEXT, task_id INTEGER,
  note TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reg_res ON guest_registrations(reservation_id);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, reservation_id INTEGER NOT NULL,
  amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'VND', method TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', provider TEXT NOT NULL DEFAULT 'not_connected',
  token TEXT UNIQUE, link TEXT, reference TEXT, charge_id INTEGER, task_id INTEGER,
  expires_at TEXT, paid_at TEXT, created_at TEXT NOT NULL, note TEXT
);
CREATE INDEX IF NOT EXISTS idx_pay_res ON payments(reservation_id);
CREATE TABLE IF NOT EXISTS invoice_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, reservation_id INTEGER NOT NULL,
  buyer_name TEXT NOT NULL, tax_code TEXT, buyer_address TEXT, email TEXT NOT NULL,
  buyer_type TEXT NOT NULL DEFAULT 'personal', net_amount REAL NOT NULL,
  service_charge REAL NOT NULL DEFAULT 0, vat_amount REAL NOT NULL DEFAULT 0,
  gross_amount REAL NOT NULL, status TEXT NOT NULL DEFAULT 'requested', invoice_no TEXT,
  issued_at TEXT, task_id INTEGER, note TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, reservation_id INTEGER,
  guest_id INTEGER, conversation_id INTEGER, rating INTEGER,
  category TEXT NOT NULL DEFAULT 'general', comment TEXT NOT NULL,
  sentiment TEXT NOT NULL DEFAULT 'neutral', task_id INTEGER, message_id INTEGER,
  status TEXT NOT NULL DEFAULT 'new', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trace_spans (
  id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, conversation_id INTEGER NOT NULL,
  parent_id TEXT, name TEXT NOT NULL, kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok', provider TEXT, model TEXT,
  started_at TEXT NOT NULL, ended_at TEXT, duration_ms INTEGER,
  attributes TEXT, signals TEXT NOT NULL DEFAULT '[]', error TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS room_packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL,
  room_code TEXT NOT NULL, room_name_vi TEXT NOT NULL, name TEXT NOT NULL,
  public_price REAL NOT NULL, member_price REAL,
  meal_plan TEXT NOT NULL DEFAULT 'none', vinwonders INTEGER NOT NULL DEFAULT 0,
  golf_rounds INTEGER NOT NULL DEFAULT 0, hotel_credit REAL NOT NULL DEFAULT 0,
  aquafield INTEGER NOT NULL DEFAULT 0, sauna_jacuzzi INTEGER NOT NULL DEFAULT 0,
  cable_car INTEGER NOT NULL DEFAULT 0, spa_discount_pct INTEGER NOT NULL DEFAULT 0,
  fnb_discount_pct INTEGER NOT NULL DEFAULT 0, golf_discount_pct INTEGER NOT NULL DEFAULT 0,
  inclusions TEXT NOT NULL DEFAULT '[]', conditions TEXT NOT NULL DEFAULT '[]',
  has_blackout INTEGER NOT NULL DEFAULT 0, source_file TEXT, updated_at TEXT NOT NULL
);
-- Identity of the vector index: what built it, and what shape it is.
--
-- Before this table, the only record of which embedder produced a vector was the
-- per-chunk embed_model string, and nothing compared it to the model the runtime
-- was configured with. A deployment ran with 139 vectors from
-- text-embedding-3-small (1536-d) while the runtime resolved to a 384-d local
-- model: the dimensions could not be compared, the vector leg silently switched
-- itself off, and the strategy string was the only place that said so. Retrieval
-- looked like hybrid and was BM25-only, which on the multilingual set means zero
-- results for Korean, Chinese and Japanese.
--
-- embedding_version is bumped by hand when the way text is prepared for the
-- embedder changes (prefixes, chunking, normalisation) even though the model
-- name has not: a same-model, different-preparation index is just as
-- incomparable as a different-model one, and nothing else would catch it.
CREATE TABLE IF NOT EXISTS index_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  provider TEXT NOT NULL, model TEXT NOT NULL, dimension INTEGER NOT NULL,
  embedding_version TEXT NOT NULL, chunk_count INTEGER NOT NULL,
  vector_count INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pkg_room ON room_packages(room_code);
CREATE INDEX IF NOT EXISTS idx_pkg_price ON room_packages(public_price);
CREATE INDEX IF NOT EXISTS idx_span_trace ON trace_spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_span_conv ON trace_spans(conversation_id);
CREATE INDEX IF NOT EXISTS idx_span_turn ON trace_spans(kind, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_task_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_conv_last ON conversations(last_message_at);
`);
  addColumnIfMissing("rooms", "base_rate", "base_rate REAL NOT NULL DEFAULT 0");

  /* services.images was declared in the schema but missing from the bootstrap DDL. */
  addColumnIfMissing("services", "images", "images TEXT NOT NULL DEFAULT '[]'");
  /* room_types.images and dining_venues.images have the same gap — found
   * rebuilding data.db from a clean state, which this codebase evidently
   * had not done in a while (nothing else exercises the bootstrap DDL path
   * once a dev DB already exists). */
  addColumnIfMissing("room_types", "images", "images TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing("dining_venues", "images", "images TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing("services", "linked_kb_titles", "linked_kb_titles TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing("services", "service_group", "service_group TEXT");

  /* hotels: where a VietQR transfer lands. Null until an operator fills them
     in — the QR is not offered until all three are present. */
  addColumnIfMissing("hotels", "bank_bin", "bank_bin TEXT");
  addColumnIfMissing("hotels", "bank_account_number", "bank_account_number TEXT");
  addColumnIfMissing("hotels", "bank_account_name", "bank_account_name TEXT");

  /* conversations: WHERE the sentiment label came from. Added because the
     insights dashboard was captioned "classified per conversation by the model"
     while counting seed fixtures whose mood is a rand() call — with one column
     for provenance there is no way to tell them apart, and nobody could. */
  /* Cơ sở dữ liệu đang chạy đã có bảng feedback không có cột này. */
  addColumnIfMissing("feedback", "message_id", "message_id INTEGER");
  addColumnIfMissing("conversations", "sentiment_source", "sentiment_source TEXT");
  addColumnIfMissing("conversations", "sentiment_at", "sentiment_at TEXT");

  /* guests: identity fields for the statutory lodging declaration + loyalty ledger */
  addColumnIfMissing("guests", "id_type", "id_type TEXT");
  addColumnIfMissing("guests", "id_number", "id_number TEXT");
  addColumnIfMissing("guests", "nationality", "nationality TEXT");
  addColumnIfMissing("guests", "dob", "dob TEXT");
  addColumnIfMissing("guests", "loyalty_points", "loyalty_points INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("guests", "loyalty_enrolled_at", "loyalty_enrolled_at TEXT");

  /* reservations: a real arrival time, and an auditable cancellation */
  addColumnIfMissing("reservations", "check_in_time", "check_in_time TEXT");
  addColumnIfMissing("reservations", "cancelled_at", "cancelled_at TEXT");
  addColumnIfMissing("reservations", "cancellation_fee", "cancellation_fee REAL");

  /* folio_charges: tax base flag + provenance so a reversal can be exact */
  addColumnIfMissing("folio_charges", "taxable", "taxable INTEGER NOT NULL DEFAULT 1");
  addColumnIfMissing("folio_charges", "ref_type", "ref_type TEXT");
  addColumnIfMissing("folio_charges", "ref_id", "ref_id INTEGER");
  addColumnIfMissing("folio_charges", "voided_at", "voided_at TEXT");

  /* kb_articles: Phase A knowledge-hygiene metadata (quality, freshness, provenance) */
  addColumnIfMissing("kb_articles", "quality", "quality TEXT NOT NULL DEFAULT 'curated'");
  addColumnIfMissing("kb_articles", "verified", "verified TEXT NOT NULL DEFAULT 'unverified'");
  addColumnIfMissing("kb_articles", "content_class", "content_class TEXT NOT NULL DEFAULT 'static'");
  addColumnIfMissing("kb_articles", "entity", "entity TEXT");
  addColumnIfMissing("kb_articles", "domain", "domain TEXT");
  addColumnIfMissing("kb_articles", "source_url", "source_url TEXT");
  addColumnIfMissing("kb_articles", "effective_date", "effective_date TEXT");
  addColumnIfMissing("kb_articles", "last_verified", "last_verified TEXT");
  addColumnIfMissing("kb_articles", "retrievable", "retrievable INTEGER NOT NULL DEFAULT 1");

  /* doc_chunks: provenance carried from the source article for the generator */
  addColumnIfMissing("doc_chunks", "quality", "quality TEXT NOT NULL DEFAULT 'curated'");
  addColumnIfMissing("doc_chunks", "verified", "verified TEXT NOT NULL DEFAULT 'unverified'");
  addColumnIfMissing("doc_chunks", "content_class", "content_class TEXT NOT NULL DEFAULT 'static'");

  /* service_bookings: what was actually charged, and the cancellation deadline */
  addColumnIfMissing("service_bookings", "amount", "amount REAL");
  addColumnIfMissing("service_bookings", "charge_id", "charge_id INTEGER");
  addColumnIfMissing("service_bookings", "note", "note TEXT");
  addColumnIfMissing("service_bookings", "cancel_deadline", "cancel_deadline TEXT");
  addColumnIfMissing("service_bookings", "cancelled_at", "cancelled_at TEXT");
  addColumnIfMissing("dining_venues", "menu_file", "menu_file TEXT");

  autoSyncAllMediaImages();
}

function autoSyncAllMediaImages() {
  try {
    const toSlug = (str: string) =>
      str
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/đ/gi, "d")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");

    // 1. Room Types
    const rooms = sqlite.prepare("SELECT id, code, name_vi FROM room_types").all() as Array<{ id: number; code: string; name_vi: string }>;
    const updateRoom = sqlite.prepare("UPDATE room_types SET images = ? WHERE id = ?");

    for (const r of rooms) {
      const candidates = [
        toSlug(r.name_vi),
        toSlug(r.code),
        toSlug(r.name_vi).replace(/^nha-hang-/, ""),
      ];
      let images: string[] = [];

      for (const s of candidates) {
        const folder = join(process.cwd(), "client/public/rooms", s);
        if (existsSync(folder)) {
          try {
            const files = readdirSync(folder)
              .filter((f) => /\.(webp|jpg|jpeg|png)$/i.test(f) && !f.endsWith(".pdf"))
              .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
            if (files.length > 0) {
              images = files.map((f) => `/rooms/${s}/${f}`);
              break;
            }
          } catch {}
        }
      }

      if (images.length === 0) {
        const slug = toSlug(r.name_vi);
        if (slug.includes("deluxe")) images = ["/rooms/deluxe.jpg", "/rooms/deluxe-1.jpg", "/rooms/deluxe-2.jpg"];
        else if (slug.includes("grand")) images = ["/rooms/grand-deluxe.jpg", "/rooms/grand-deluxe-ocean.jpg"];
        else if (slug.includes("biet-thu") || slug.includes("villa")) images = ["/rooms/villa.jpg"];
      }

      updateRoom.run(JSON.stringify(images), r.id);
    }

    // 2. Dining Venues
    const dining = sqlite.prepare("SELECT id, code, name_vi, slug FROM dining_venues").all() as Array<{ id: number; code: string; name_vi: string; slug: string }>;
    const updateDining = sqlite.prepare("UPDATE dining_venues SET images = ? WHERE id = ?");

    for (const d of dining) {
      const candidates = [
        d.slug,
        toSlug(d.name_vi),
        toSlug(d.code),
        toSlug(d.name_vi).replace(/^nha-hang-/, ""),
        d.slug.replace(/-bar$/, "").replace(/-restaurant$/, "").replace(/-/g, ""),
        d.slug === "beach-comber-bar" ? "beachcomber" : "",
        d.slug === "seaview-bar" ? "seaview-lounge" : "",
      ].filter(Boolean);

      let images: string[] = [];
      for (const s of candidates) {
        const folder = join(process.cwd(), "client/public/dining", s);
        if (existsSync(folder)) {
          const files = readdirSync(folder)
            .filter((f) => /\.(webp|jpg|jpeg|png)$/i.test(f))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
          if (files.length > 0) {
            images = files.map((f) => `/dining/${s}/${f}`);
            break;
          }
        }
      }

      updateDining.run(JSON.stringify(images), d.id);
    }

    // 3. Services
    const services = sqlite.prepare("SELECT id, name, category FROM services").all() as Array<{ id: number; name: string; category: string }>;
    const updateService = sqlite.prepare("UPDATE services SET images = ? WHERE id = ?");

    for (const s of services) {
      const nameSlug = toSlug(s.name);
      let images: string[] = [];

      if (s.category === "spa" || nameSlug.includes("spa") || nameSlug.includes("massage")) {
        const folder = join(process.cwd(), "client/public/services/spa");
        if (existsSync(folder)) {
          const files = readdirSync(folder).filter((f) => /\.(webp|jpg|jpeg|png)$/i.test(f)).sort();
          images = files.map((f) => `/services/spa/${f}`);
        }
      } else if (nameSlug.includes("cap-treo") || nameSlug.includes("cable-car")) {
        const folder = join(process.cwd(), "client/public/transport/cable-car");
        if (existsSync(folder)) {
          const files = readdirSync(folder).filter((f) => /\.(webp|jpg|jpeg|png)$/i.test(f)).sort();
          images = files.map((f) => `/transport/cable-car/${f}`);
        }
      } else if (nameSlug.includes("vinwonders")) {
        const folder = join(process.cwd(), "client/public/services/vinwonder");
        if (existsSync(folder)) {
          const files = readdirSync(folder).filter((f) => /\.(webp|jpg|jpeg|png)$/i.test(f)).sort();
          images = files.map((f) => `/services/vinwonder/${f}`);
        }
      } else if (s.category === "dining") {
        if (nameSlug.includes("bach-giai")) images = ["/dining/bach-giai/1.webp", "/dining/bach-giai/2.jpg"];
        else if (nameSlug.includes("lotus")) images = ["/dining/lotus/1.jpg", "/dining/lotus/2.jpg", "/dining/lotus/3.jpg"];
        else if (nameSlug.includes("jasmine")) images = ["/dining/jasmine/1.jpg", "/dining/jasmine/2.jpg"];
      }

      if (images.length > 0) {
        updateService.run(JSON.stringify(images), s.id);
      }
    }
  } catch (err) {
    console.error("[autoSyncAllMediaImages] error:", err);
  }
}

export const nowIso = () => new Date().toISOString();

/* ------------------------------------------------------------------ *
 * Storage interface
 * ------------------------------------------------------------------ */

/**
 * Give a new task an owner.
 *
 * Every task the AI raises was created with `assignedStaffId: null` — the
 * escalation paths, the sentiment handoff, the ops flows, all of them. The
 * board therefore filled with unowned work: measured before this existed, 34
 * open tasks had no assignee, including URGENT ones on a ten-minute SLA, and
 * the "Team load" panel showed nothing but seed fixtures because no real task
 * had ever reached a person.
 *
 * Routing is least-loaded-first within the task's own department, so the queue
 * levels out instead of always landing on whoever sorts first. A task that
 * already names an owner is left alone, and so is one for a department with
 * nobody active — an unowned task is bad, but inventing an owner who cannot do
 * the work is worse, and the tasks board still shows it as unassigned.
 *
 * Set LOCAL_TASK_AUTOROUTE=0 to go back to leaving everything unassigned.
 */
function autoRoute<T extends { dept: string; assignedStaffId: number | null; status: string }>(v: T): T {
  if (process.env.LOCAL_TASK_AUTOROUTE === "0") return v;
  if (v.assignedStaffId != null || !v.dept) return v;
  const candidates = db.select().from(staff).where(eq(staff.dept, v.dept)).all().filter((s) => s.active === 1);
  if (!candidates.length) return v;
  const openCounts = new Map<number, number>();
  for (const t of db.select().from(tasks).all()) {
    if (t.assignedStaffId == null || t.status === "done" || t.status === "cancelled") continue;
    openCounts.set(t.assignedStaffId, (openCounts.get(t.assignedStaffId) ?? 0) + 1);
  }
  const owner = candidates.reduce((best, s) =>
    (openCounts.get(s.id) ?? 0) < (openCounts.get(best.id) ?? 0) ? s : best,
  );
  return { ...v, assignedStaffId: owner.id };
}

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
  /* The identity / loyalty columns were added later; existing callers (seed,
   * walk-in booking, staff create) must keep compiling without them. */
  createGuest(
    v: Omit<Guest, "id" | "idType" | "idNumber" | "nationality" | "dob" | "loyaltyPoints" | "loyaltyEnrolledAt"> &
      Partial<Pick<Guest, "idType" | "idNumber" | "nationality" | "dob" | "loyaltyPoints" | "loyaltyEnrolledAt">>,
  ): Guest {
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
  createReservation(
    v: Omit<Reservation, "id" | "checkInTime" | "cancelledAt" | "cancellationFee"> &
      Partial<Pick<Reservation, "checkInTime" | "cancelledAt" | "cancellationFee">>,
  ): Reservation {
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
  /* taxable/refType/refId/voidedAt were added with the pricing engine. Older
   * callers omit them; default to a taxable, unlinked, live charge. */
  addCharge(
    c: Omit<FolioCharge, "id" | "taxable" | "refType" | "refId" | "voidedAt"> &
      Partial<Pick<FolioCharge, "taxable" | "refType" | "refId" | "voidedAt">>,
  ): FolioCharge {
    return db
      .insert(folioCharges)
      .values({
        taxable: 1,
        refType: null,
        refId: null,
        voidedAt: null,
        ...c,
      })
      .returning()
      .get();
  },
  getCharge(id: number | null): FolioCharge | undefined {
    if (!id) return undefined;
    return db.select().from(folioCharges).where(eq(folioCharges.id, id)).get();
  },
  updateCharge(id: number, patch: Partial<FolioCharge>): FolioCharge {
    db.update(folioCharges).set(patch).where(eq(folioCharges.id, id)).run();
    return db.select().from(folioCharges).where(eq(folioCharges.id, id)).get()!;
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
  getTask(id: number): Task | undefined {
    return db.select().from(tasks).where(eq(tasks.id, id)).get();
  },
  createTask(v: Omit<Task, "id">): Task {
    return db.insert(tasks).values(autoRoute(v)).returning().get();
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
  updateService(id: number, patch: Partial<Service>): Service {
    db.update(services).set(patch).where(eq(services.id, id)).run();
    return db.select().from(services).where(eq(services.id, id)).get()!;
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
  recordUpsellImpressions(rows: Omit<UpsellImpression, 'id'>[]): void {
    if (!rows.length) return;
    db.insert(upsellImpressions).values(rows).run();
  },
  listUpsellImpressions(): UpsellImpression[] {
    return db.select().from(upsellImpressions).orderBy(desc(upsellImpressions.id)).all();
  },
  /**
   * When this conversation was last shown a suggestion, or null if never.
   * Feeds the cooldown in `upsellAllowed` — asking again on the next turn is
   * the fastest way for a concierge to start reading as a salesman.
   */
  lastUpsellAt(conversationId: number): string | null {
    const row = db
      .select()
      .from(upsellImpressions)
      .where(eq(upsellImpressions.conversationId, conversationId))
      .orderBy(desc(upsellImpressions.id))
      .limit(1)
      .get();
    return row?.createdAt ?? null;
  },

  createBooking(v: Omit<ServiceBooking, "id">): ServiceBooking {
    return db.insert(serviceBookings).values(v).returning().get();
  },
  getBooking(id: number): ServiceBooking | undefined {
    return db.select().from(serviceBookings).where(eq(serviceBookings.id, id)).get();
  },
  updateBooking(id: number, patch: Partial<ServiceBooking>): ServiceBooking {
    db.update(serviceBookings).set(patch).where(eq(serviceBookings.id, id)).run();
    return db.select().from(serviceBookings).where(eq(serviceBookings.id, id)).get()!;
  },
  bookingsForReservation(reservationId: number): ServiceBooking[] {
    return db
      .select()
      .from(serviceBookings)
      .where(eq(serviceBookings.reservationId, reservationId))
      .orderBy(desc(serviceBookings.id))
      .all();
  },

  /* ---------------- room catalogue ---------------- */
  listRoomTypes(): RoomType[] {
    autoSyncAllMediaImages();
    return db.select().from(roomTypes).orderBy(asc(roomTypes.areaSqm)).all();
  },

  createRoomType(v: InsertRoomType): RoomType {
    return db.insert(roomTypes).values(v).returning().get();
  },

  /* ---------------- dining venues ---------------- */
  listDiningVenues(): DiningVenue[] {
    autoSyncAllMediaImages();
    return db.select().from(diningVenues).orderBy(asc(diningVenues.kind), asc(diningVenues.code)).all();
  },

  createDiningVenue(v: InsertDiningVenue): DiningVenue {
    return db.insert(diningVenues).values(v).returning().get();
  },

  updateDiningVenue(id: number, patch: Partial<DiningVenue>): DiningVenue {
    return db.update(diningVenues).set(patch).where(eq(diningVenues.id, id)).returning().get();
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
  /** Replace one policy's rule payload. Used by corrective migrations. */
  updatePolicyRules(code: string, rules: string): void {
    db.update(policies).set({ rules }).where(eq(policies.code, code)).run();
  },
  /** Replace one policy's guest-facing summary. Used by corrective migrations to
   *  strip internal QA placeholders that were leaking into guest answers. */
  updatePolicySummary(code: string, summary: string): void {
    db.update(policies).set({ summary }).where(eq(policies.code, code)).run();
  },

  /* ---------------- vector index identity ---------------- */

  getIndexMeta(): IndexMeta | null {
    /* A database written before this table existed is the normal case on an
       upgrade, and it is exactly the state the health check wants to report as
       "identity unverified" rather than crash on. Missing table and missing row
       mean the same thing to the caller. */
    let r: Record<string, unknown> | undefined;
    try {
      r = sqlite.prepare(`SELECT * FROM index_meta WHERE id = 1`).get() as
        | Record<string, unknown>
        | undefined;
    } catch {
      return null;
    }
    if (!r) return null;
    return {
      provider: String(r.provider),
      model: String(r.model),
      dimension: Number(r.dimension),
      embeddingVersion: String(r.embedding_version),
      chunkCount: Number(r.chunk_count),
      vectorCount: Number(r.vector_count),
      createdAt: String(r.created_at),
    };
  },

  /** Drop the stamp. Used by tests to simulate a database indexed before it existed. */
  clearIndexMeta(): void {
    try { sqlite.prepare(`DELETE FROM index_meta`).run(); } catch { /* table may not exist */ }
  },

  /** Called by reindex once the whole corpus has been embedded, never before. */
  setIndexMeta(m: Omit<IndexMeta, "createdAt">): void {
    sqlite
      .prepare(
        `INSERT INTO index_meta (id, provider, model, dimension, embedding_version, chunk_count, vector_count, created_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           provider=excluded.provider, model=excluded.model, dimension=excluded.dimension,
           embedding_version=excluded.embedding_version, chunk_count=excluded.chunk_count,
           vector_count=excluded.vector_count, created_at=excluded.created_at`,
      )
      .run(m.provider, m.model, m.dimension, m.embeddingVersion, m.chunkCount, m.vectorCount, new Date().toISOString());
  },

  /* ---------------- retrieval index ---------------- */
  listChunks(): DocChunk[] {
    return db.select().from(docChunks).all();
  },
  clearChunks() {
    db.delete(docChunks).run();
  },
  /* Provenance (quality/verified/content_class) is optional at the call site:
     structured chunks fall back to the safe defaults, kb chunks pass the values
     classified in Phase A. */
  createChunk(
    v: Omit<DocChunk, "id" | "quality" | "verified" | "contentClass"> &
      Partial<Pick<DocChunk, "quality" | "verified" | "contentClass">>,
  ): DocChunk {
    return db
      .insert(docChunks)
      .values({
        quality: "curated",
        verified: "unverified",
        contentClass: "static",
        ...v,
      })
      .returning()
      .get();
  },
  /**
   * Ghi đè nội dung một chunk ĐANG CÓ và **xoá vector của nó**.
   *
   * Xoá vector là bắt buộc, không phải tuỳ chọn: một chunk có nội dung mới mà
   * giữ vector cũ sẽ được tìm thấy bằng nghĩa của văn bản đã bị thay thế. Đó là
   * kiểu sai tệ nhất — không lỗi, không cảnh báo, chỉ là câu trả lời sai.
   */
  replaceChunk(id: number, v: Partial<DocChunk>) {
    db.update(docChunks)
      .set({ ...v, embedding: null, embedModel: null })
      .where(eq(docChunks.id, id))
      .run();
  },
  deleteChunks(ids: number[]) {
    if (!ids.length) return;
    db.delete(docChunks).where(inArray(docChunks.id, ids)).run();
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
  /* The Phase A metadata columns are optional at the call site (they carry DB
     defaults); existing callers that only know title/body/category keep working. */
  createKb(
    v: Omit<
      KbArticle,
      | "id"
      | "quality"
      | "verified"
      | "contentClass"
      | "entity"
      | "domain"
      | "sourceUrl"
      | "effectiveDate"
      | "lastVerified"
      | "retrievable"
    > &
      Partial<
        Pick<
          KbArticle,
          | "quality"
          | "verified"
          | "contentClass"
          | "entity"
          | "domain"
          | "sourceUrl"
          | "effectiveDate"
          | "lastVerified"
          | "retrievable"
        >
      >,
  ): KbArticle {
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

  /* ---------------- operational guest requests ---------------- */
  createRequest(v: Omit<GuestRequest, "id">): GuestRequest {
    return db.insert(guestRequests).values(v).returning().get();
  },
  getRequest(id: number): GuestRequest | undefined {
    return db.select().from(guestRequests).where(eq(guestRequests.id, id)).get();
  },
  updateRequest(id: number, patch: Partial<GuestRequest>): GuestRequest {
    db.update(guestRequests).set(patch).where(eq(guestRequests.id, id)).run();
    return db.select().from(guestRequests).where(eq(guestRequests.id, id)).get()!;
  },
  listRequests(limit = 200): GuestRequest[] {
    return db.select().from(guestRequests).orderBy(desc(guestRequests.id)).limit(limit).all();
  },
  requestsFor(reservationId: number): GuestRequest[] {
    return db
      .select()
      .from(guestRequests)
      .where(eq(guestRequests.reservationId, reservationId))
      .orderBy(desc(guestRequests.id))
      .all();
  },

  /* ---------------- HITL service approvals ---------------- */
  createApproval(v: Omit<ServiceApproval, "id">): ServiceApproval {
    return db.insert(serviceApprovals).values(v).returning().get();
  },
  getApproval(id: number): ServiceApproval | undefined {
    return db.select().from(serviceApprovals).where(eq(serviceApprovals.id, id)).get();
  },
  updateApproval(id: number, patch: Partial<ServiceApproval>): ServiceApproval {
    db.update(serviceApprovals).set(patch).where(eq(serviceApprovals.id, id)).run();
    return db.select().from(serviceApprovals).where(eq(serviceApprovals.id, id)).get()!;
  },
  listApprovals(limit = 200): ServiceApproval[] {
    return db.select().from(serviceApprovals).orderBy(desc(serviceApprovals.id)).limit(limit).all();
  },

  /* ---------------- lodging declaration ---------------- */
  createRegistration(v: Omit<GuestRegistration, "id">): GuestRegistration {
    return db.insert(guestRegistrations).values(v).returning().get();
  },
  updateRegistration(id: number, patch: Partial<GuestRegistration>): GuestRegistration {
    db.update(guestRegistrations).set(patch).where(eq(guestRegistrations.id, id)).run();
    return db.select().from(guestRegistrations).where(eq(guestRegistrations.id, id)).get()!;
  },
  registrationsFor(reservationId: number): GuestRegistration[] {
    return db
      .select()
      .from(guestRegistrations)
      .where(eq(guestRegistrations.reservationId, reservationId))
      .orderBy(asc(guestRegistrations.id))
      .all();
  },
  listRegistrations(limit = 200): GuestRegistration[] {
    return db
      .select()
      .from(guestRegistrations)
      .orderBy(desc(guestRegistrations.id))
      .limit(limit)
      .all();
  },

  /* ---------------- payments ---------------- */
  createPayment(v: Omit<Payment, "id">): Payment {
    return db.insert(payments).values(v).returning().get();
  },
  getPayment(id: number): Payment | undefined {
    return db.select().from(payments).where(eq(payments.id, id)).get();
  },
  getPaymentByToken(token: string): Payment | undefined {
    return db.select().from(payments).where(eq(payments.token, token)).get();
  },
  updatePayment(id: number, patch: Partial<Payment>): Payment {
    db.update(payments).set(patch).where(eq(payments.id, id)).run();
    return db.select().from(payments).where(eq(payments.id, id)).get()!;
  },
  paymentsFor(reservationId: number): Payment[] {
    return db
      .select()
      .from(payments)
      .where(eq(payments.reservationId, reservationId))
      .orderBy(asc(payments.id))
      .all();
  },

  /* ---------------- VAT invoices ---------------- */
  createInvoiceRequest(v: Omit<InvoiceRequest, "id">): InvoiceRequest {
    return db.insert(invoiceRequests).values(v).returning().get();
  },
  updateInvoiceRequest(id: number, patch: Partial<InvoiceRequest>): InvoiceRequest {
    db.update(invoiceRequests).set(patch).where(eq(invoiceRequests.id, id)).run();
    return db.select().from(invoiceRequests).where(eq(invoiceRequests.id, id)).get()!;
  },
  invoiceRequestsFor(reservationId: number): InvoiceRequest[] {
    return db
      .select()
      .from(invoiceRequests)
      .where(eq(invoiceRequests.reservationId, reservationId))
      .orderBy(desc(invoiceRequests.id))
      .all();
  },
  listInvoiceRequests(limit = 200): InvoiceRequest[] {
    return db.select().from(invoiceRequests).orderBy(desc(invoiceRequests.id)).limit(limit).all();
  },

  /* ---------------- feedback ---------------- */
  createFeedback(v: Omit<FeedbackEntry, "id">): FeedbackEntry {
    return db.insert(feedbackEntries).values(v).returning().get();
  },
  listFeedback(limit = 200): FeedbackEntry[] {
    return db.select().from(feedbackEntries).orderBy(desc(feedbackEntries.id)).limit(limit).all();
  },

  /* --- audit --- */
  logEvent(v: Omit<AuditEvent, "id">): AuditEvent {
    return db.insert(auditEvents).values(v).returning().get();
  },
  listEvents(limit = 120): AuditEvent[] {
    return db.select().from(auditEvents).orderBy(desc(auditEvents.id)).limit(limit).all();
  },

  /* --- observability: agent execution traces --- */

  /**
   * Persist every span of one agent turn in a single transaction. Tracing must
   * never take a turn down with it, so the caller wraps this — but the write is
   * still atomic so a listing never shows half a trace.
   */
  insertSpans(rows: InsertTraceSpan[]): void {
    if (!rows.length) return;
    const tx = sqlite.transaction((batch: InsertTraceSpan[]) => {
      for (const r of batch) db.insert(traceSpans).values(r).run();
    });
    tx(rows);
  },

  /** Recent turns, newest first. One row per agent turn (the root span). */
  listRecentTurns(limit = 50): TraceSpan[] {
    return db
      .select()
      .from(traceSpans)
      .where(eq(traceSpans.kind, "turn"))
      .orderBy(desc(traceSpans.createdAt))
      .limit(limit)
      .all();
  },

  /** Every span of one trace, in execution order — the full tree for a turn. */
  getTraceSpans(traceId: string): TraceSpan[] {
    return db
      .select()
      .from(traceSpans)
      .where(eq(traceSpans.traceId, traceId))
      .orderBy(asc(traceSpans.startedAt))
      .all();
  },

  /** Turns for one conversation, newest first — the "what happened here" view. */
  listTurnsForConversation(conversationId: number, limit = 50): TraceSpan[] {
    return db
      .select()
      .from(traceSpans)
      .where(and(eq(traceSpans.conversationId, conversationId), eq(traceSpans.kind, "turn")))
      .orderBy(desc(traceSpans.createdAt))
      .limit(limit)
      .all();
  },

  /** All spans created at or after `sinceIso`, for signal aggregation. */
  spansSince(sinceIso: string, limit = 5000): TraceSpan[] {
    return db
      .select()
      .from(traceSpans)
      .where(sql`${traceSpans.createdAt} >= ${sinceIso}`)
      .orderBy(desc(traceSpans.createdAt))
      .limit(limit)
      .all();
  },

  /** Drop spans older than `beforeIso`. Called opportunistically to cap growth. */
  pruneSpansBefore(beforeIso: string): number {
    const r = sqlite.prepare(`DELETE FROM trace_spans WHERE created_at < ?`).run(beforeIso);
    return r.changes;
  },

  /* --- published rate packages (the upsell ladder) --- */

  replaceRoomPackages(rows: InsertRoomPackage[]): number {
    const tx = sqlite.transaction((batch: InsertRoomPackage[]) => {
      sqlite.prepare(`DELETE FROM room_packages`).run();
      for (const r of batch) db.insert(roomPackages).values(r).run();
    });
    tx(rows);
    return rows.length;
  },

  listRoomPackages(): RoomPackageRow[] {
    return db.select().from(roomPackages).orderBy(asc(roomPackages.publicPrice)).all();
  },

  /**
   * Packages for one room category, cheapest first — the shape an upsell needs:
   * quote [0], offer the rest as "what more money buys".
   */
  packagesForRoom(roomCode: string): RoomPackageRow[] {
    return db
      .select()
      .from(roomPackages)
      .where(eq(roomPackages.roomCode, roomCode))
      .orderBy(asc(roomPackages.publicPrice))
      .all();
  },

  /** Distinct room codes that actually have packages published. */
  packagedRoomCodes(): string[] {
    return (
      sqlite.prepare(`SELECT DISTINCT room_code FROM room_packages ORDER BY room_code`).all() as {
        room_code: string;
      }[]
    ).map((r) => r.room_code);
  },

  /* --- runtime key-value settings (e.g. Langfuse keys entered from the UI) --- */
  getSetting(key: string): string | null {
    const row = db.select().from(appSettings).where(eq(appSettings.key, key)).get();
    return row?.value ?? null;
  },
  setSetting(key: string, value: string): void {
    sqlite
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, nowIso());
  },
  deleteSetting(key: string): void {
    sqlite.prepare(`DELETE FROM app_settings WHERE key = ?`).run(key);
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
