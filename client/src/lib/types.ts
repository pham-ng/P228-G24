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
};

export type Staff = {
  id: number;
  name: string;
  role: string;
  dept: string;
  avatarInitials: string;
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
  view: string;
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
  };
  series: {
    date: string;
    conversations: number;
    tasks: number;
    aiHandled: number;
    avgResolutionMinutes: number;
  }[];
  byDept: { dept: string; total: number; open: number; avgMinutes: number; slaBreaches: number }[];
  topics: { topic: string; count: number }[];
  sentiment: { sentiment: string; count: number }[];
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
};
