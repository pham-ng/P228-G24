export type Hotel = {
  id: number;
  name: string;
  city: string;
  timezone: string;
  currency: string;
  checkInTime: string;
  checkOutTime: string;
  brandVoice: string;
  slaMinutes: number;
  aiEnabled: number;
  /** VietQR beneficiary; all three null until an operator fills them in. */
  bankBin: string | null;
  bankAccountNumber: string | null;
  bankAccountName: string | null;
};

export type Capability =
  | "guest_data"
  | "all_conversations"
  | "converse"
  | "all_tasks"
  | "approvals"
  | "insights"
  | "rooms"
  | "edit_content"
  | "configure";

export type Staff = {
  id: number;
  name: string;
  role: string;
  dept: string;
  avatarInitials: string;
  /** Sent by /api/staff/login. Used only to hide what the server would refuse
   *  anyway — the enforcing check is server-side (server/rbac.ts). */
  capabilities?: Capability[];
};

export type ToolTrace = { name: string; args: Record<string, unknown>; result: unknown; ms: number };

export type Message = {
  id: number;
  conversationId: number;
  role: "guest" | "ai" | "staff" | "system";
  authorName: string | null;
  body: string;
  toolTrace: string | null;
  latencyMs: number | null;
  createdAt: string;
};

export type Conversation = {
  id: number;
  guestId: number;
  reservationId: number | null;
  channel: string;
  mode: "ai" | "human" | "closed";
  assignedStaffId: number | null;
  sentiment: string;
  topic: string | null;
  unreadForStaff: number;
  lastMessageAt: string;
  createdAt: string;
  firstResponseSeconds: number | null;
};

export type ConversationRow = Conversation & {
  guestName: string;
  vipTier: string;
  lang: string;
  roomNumber: string | null;
  lastMessage: string;
  lastMessageRole: string;
  messageCount: number;
  openTasks: number;
};

export type Guest = {
  id: number;
  name: string;
  email: string;
  phone: string;
  lang: string;
  country: string;
  vipTier: string;
  preferences: string[];
  notes: string | null;
  staysCount: number;
};

export type Reservation = {
  id: number;
  guestId: number;
  roomId: number | null;
  confirmationCode: string;
  checkIn: string;
  checkOut: string;
  checkOutTime: string;
  adults: number;
  children: number;
  ratePerNight: number;
  status: string;
  source: string;
};

export type Room = {
  id: number;
  number: string;
  floor: number;
  type: string;
  status: string;
  housekeepingNote: string | null;
};

export type Charge = {
  id: number;
  description: string;
  amount: number;
  category: string;
  createdAt: string;
};

export type Task = {
  id: number;
  roomId: number | null;
  conversationId: number | null;
  dept: string;
  title: string;
  detail: string | null;
  priority: "low" | "normal" | "high" | "urgent";
  status: "open" | "in_progress" | "done" | "cancelled";
  source: string;
  assignedStaffId: number | null;
  dueAt: string | null;
  createdAt: string;
  resolvedAt: string | null;
  roomNumber: string | null;
  assignee: string | null;
};

export type ServiceApproval = {
  id: number;
  reservationId: number | null;
  guestId: number | null;
  conversationId: number | null;
  taskId: number | null;
  kind:
    | "book_service"
    | "cancel_service_booking"
    | "order_room_service"
    | "cancel_reservation"
    | "request_late_checkout"
    | "request_early_checkin";
  summary: string;
  payload: string;
  amount: number | null;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  rejectionReason: string | null;
};

export type ConversationDetail = {
  conversation: Conversation;
  guest: Guest;
  reservation: Reservation | null;
  room: Room | null;
  folioTotal: number;
  charges: Charge[];
  messages: Message[];
  tasks: Task[];
  assignedStaff: Staff | null;
};

export type GuestKey = {
  confirmationCode: string;
  guestName: string;
  lang: string;
  vipTier: string;
  room: string | null;
  checkIn: string;
  checkOut: string;
  status: string;
};

export type RoomRow = Room & {
  guestName: string | null;
  vipTier: string | null;
  departure: string | null;
  arrivingToday: boolean;
  openTasks: number;
};

export type RoomTypeRow = {
  code: string;
  nameVi: string | null;
  areaSqm: number | null;
  bedrooms: number | null;
  bed: string | null;
  oceanView: boolean;
  privatePool: boolean;
  maxGuests: number | null;
  combinations: Array<{ adults: number; children: number }>;
  amenities: string[];
  description: string | null;
  sourceUrl: string | null;
  rate: number;
  rooms: number;
  published: boolean;
};

/** One published restaurant or bar page, as /api/dining-venues returns it. */
export type DiningVenueRow = {
  code: string;
  nameVi: string;
  kind: string;
  hoursText: string;
  hours: Array<{ open: string; close: string }>;
  mealWindows: Array<{ meal: string; open: string; close: string }>;
  lastOrder: string | null;
  location: string | null;
  phone: string | null;
  capacity: number | null;
  priceRange: string | null;
  priceNote: string | null;
  cuisine: string[];
  dishCategories: string[];
  menu: Array<{ group: string | null; items: Array<{ name_vi: string; name_en: string | null; price: number | null }> }>;
  menuSampleSize: number;
  sourceUrl: string | null;
  bookable: Array<{ name: string; slots: string[] }>;
};

export type ReservationRow = Reservation & {
  guestName: string;
  vipTier: string;
  roomNumber: string | null;
  folioTotal: number;
};

export type KbArticle = {
  id: number;
  category: string;
  title: string;
  body: string;
  tags: string[];
  updatedAt: string;
};

export type Campaign = {
  id: number;
  name: string;
  segment: string;
  body: string;
  recipients: number;
  status: string;
  sentAt: string | null;
  createdAt: string;
};

export type AuditEvent = {
  id: number;
  type: string;
  actor: string;
  summary: string;
  conversationId: number | null;
  createdAt: string;
};

export type ServiceRow = {
  id: number;
  name: string;
  category: string;
  description: string;
  price: number;
  unit: string;
  capacityPerSlot: number;
  slotList: string[];
  availability: { slot: string; seatsLeft: number }[];
};

export type Insights = {
  kpis: {
    conversations: number;
    /** Threads a guest actually wrote in — the denominator for deflection. */
    conversationsEngaged: number;
    aiDeflectionRate: number;
    avgFirstResponseSeconds: number;
    aiFirstResponseSeconds: number;
    humanFirstResponseSeconds: number;
    tasksTotal: number;
    tasksOpen: number;
    resolutionRate: number;
    avgResolutionMinutes: number;
    occupancy: number;
    roomsOutOfOrder: number;
    arrivalsToday: number;
    departuresToday: number;
    ancillaryRevenue: number;
    slaMinutes: number;
    /** Grading line for created-to-resolved. `slaMinutes` is time-to-acknowledge;
     *  nothing records acknowledgement, so that one is displayed, not graded. */
    resolutionTargetMinutes: number;
  };
  series: {
    date: string;
    /** Threads ACTIVE that day (had messages), not threads created that day. */
    conversations: number;
    tasks: number;
    aiHandled: number;
    avgResolutionMinutes: number;
  }[];
  byDept: { dept: string; total: number; open: number; avgMinutes: number; slaBreaches: number }[];
  topics: { topic: string; count: number }[];
  /** How many topic labels came from threads a guest actually wrote in. */
  topicsRealTotal: number;
  topicsTotal: number;
  staffLoadAssigned: number;
  staffLoadAssignedReal: number;
  tasksUnassigned: number;
  sentiment: { sentiment: string; count: number }[];
  /* Only conversations the model actually labelled — `sentiment` above still
     counts the seeded fixtures, whose mood was assigned by rand() in seed.ts. */
  sentimentClassified: { sentiment: string; count: number }[];
  sentimentClassifiedTotal: number;
  sentimentSeededTotal: number;
  /* Named guests behind the negative slice, newest first. Seeded conversations
     are excluded — they have no transcript to have been unhappy in. */
  unhappyGuests: {
    conversationId: number;
    guestName: string;
    lang: string | null;
    vipTier: string | null;
    room: string | null;
    message: string;
    at: string;
    /** model_realtime | model_llm | thumbs_down | unknown */
    source: string;
    mode: string;
    taskId: number | null;
    taskStatus: string | null;
  }[];
  staffLoad: { name: string; dept: string; open: number; done: number }[];
};

export const DEPT_LABELS: Record<string, string> = {
  front_desk: "Front Desk",
  housekeeping: "Housekeeping",
  fnb: "Food & Beverage",
  engineering: "Engineering",
  spa: "Spa & Wellness",
};

export const LANG_LABELS: Record<string, string> = {
  en: "English",
  vi: "Tiếng Việt",
  fr: "Français",
  ja: "日本語",
  es: "Español",
  de: "Deutsch",
  ko: "한국어",
  zh: "中文",
  ru: "Русский",
};

export type Policy = {
  id: number;
  code: string;
  topic: string;
  title: string;
  summary: string;
  rules: Record<string, unknown>;
  sourceUrl: string;
  sourceTitle: string;
  updatedAt: string;
};

export type RetrievalStats = {
  chunks: number;
  embedded: number;
  kb_chunks: number;
  policy_chunks: number;
  model: string;
};

export type RetrievalHit = {
  title: string;
  category: string;
  source_url: string | null;
  content: string;
  relevance: number;
  matched_by: string;
};

export type RetrievalResult = {
  results: RetrievalHit[];
  strategy: string;
  note?: string;
};
