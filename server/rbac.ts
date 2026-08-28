/**
 * Who can see what, expressed as hotel work rather than as code.
 *
 * Until now every staff member presented the same `STAFF_API_TOKEN`, so the API
 * could not tell a housekeeping attendant from the front-desk manager. That is
 * why 150 of 201 audit events read `staff:0` — the server had no idea who was
 * acting — and why a spa therapist opening the operations board could read any
 * guest's folio, passport number and chat history.
 *
 * THE RULE, taken from how a hotel actually works: the front desk owns the
 * guest relationship, so it sees the guest. Everyone else owns a job, so they
 * see the job. A housekeeping attendant needs the room number, the task and
 * enough of the request to do it — not the bill, not the passport, not what the
 * guest said to the concierge at midnight.
 *
 * `manager` is a front-desk role here, and the only one that sees business
 * figures and configuration. An agent runs the shift; a manager runs the hotel.
 */
import type { Staff } from "@shared/schema";

export type Capability =
  /** Folios, charges, reservations, guest identity documents. */
  | "guest_data"
  /** Read any guest conversation, not only ones behind your own tasks. */
  | "all_conversations"
  /** Reply to a guest, take a thread off the AI, mark it read. */
  | "converse"
  /** See the whole operations board rather than your department's slice. */
  | "all_tasks"
  /** Approve or reject something that moves money or changes a reservation. */
  | "approvals"
  /** Occupancy, revenue, response times — the business, not the shift. */
  | "insights"
  /** Room status board and housekeeping state. */
  | "rooms"
  /** Edit the knowledge base, policies, offers. */
  | "edit_content"
  /** Campaigns, guardrail switches, hotel settings, observability. */
  | "configure";

/** The department each role belongs to is what does most of the work here. */
const FRONT_DESK_AGENT: Capability[] = [
  "guest_data",
  "all_conversations",
  "converse",
  "all_tasks",
  "approvals",
  "rooms",
];

/**
 * A manager is a front-desk agent who also sees the numbers and holds the
 * configuration. Deliberately additive rather than a separate list, so a
 * capability granted to the desk cannot be accidentally withheld from the
 * person supervising it.
 */
const MANAGER: Capability[] = [...FRONT_DESK_AGENT, "insights", "edit_content", "configure"];

/**
 * Everyone else works from the task board.
 *
 * `converse` is deliberately absent. A housekeeping attendant answering a guest
 * in the concierge thread would be speaking for the hotel in a channel the
 * front desk owns and is being measured on; the task carries the guest's own
 * words, which is what the work needs.
 */
const DEPARTMENT_AGENT: Capability[] = [];
const OPERATIONS_ROOMS: Capability[] = ["rooms"];

/** Departments whose work is physically in the rooms. */
const ROOM_DEPARTMENTS = new Set(["housekeeping", "engineering"]);

export type Actor = {
  id: number;
  name: string;
  role: string;
  dept: string;
  /** A script or bench presenting the legacy shared token — full access. */
  service?: boolean;
};

export function capabilitiesOf(actor: Actor): Capability[] {
  if (actor.service) return [...MANAGER];
  if (actor.role === "manager") return [...MANAGER];
  if (actor.dept === "front_desk") return [...FRONT_DESK_AGENT];
  return ROOM_DEPARTMENTS.has(actor.dept) ? [...OPERATIONS_ROOMS] : [...DEPARTMENT_AGENT];
}

export function can(actor: Actor | null | undefined, cap: Capability): boolean {
  if (!actor) return false;
  return capabilitiesOf(actor).includes(cap);
}

/**
 * Which departments' tasks this person may see.
 *
 * `null` means "all of them". Returning a list rather than a boolean keeps the
 * filtering in one place — an endpoint that forgets to call this returns
 * everything, so the call sites are the thing to review, not this function.
 */
export function visibleDepartments(actor: Actor): string[] | null {
  if (can(actor, "all_tasks")) return null;
  return [actor.dept];
}

/**
 * May this person open this conversation?
 *
 * The front desk owns guest threads. Everyone else gets in only through their
 * own work: if a task in their department points at the conversation, they can
 * read it, because the request they are fulfilling is in there. Without that
 * rule an engineer sent to fix an air conditioner could not see what the guest
 * actually said was wrong with it.
 */
export function canReadConversation(
  actor: Actor,
  conversationId: number,
  tasksFor: (id: number) => { dept: string }[],
): boolean {
  if (can(actor, "all_conversations")) return true;
  return tasksFor(conversationId).some((t) => t.dept === actor.dept);
}

/** For the audit trail, so an event names a person instead of `staff:0`. */
export function actorLabel(actor: Actor | null | undefined): string {
  if (!actor) return "system";
  if (actor.service) return "service";
  return `staff:${actor.id}`;
}
