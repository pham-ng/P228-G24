/**
 * A staff token that says WHO, not just "somebody with the password".
 *
 * `STAFF_API_TOKEN` is one string shared by every account, so the API could
 * authenticate a request and still have no idea whose it was. Roles cannot be
 * enforced against an anonymous caller, and the audit trail recorded `staff:0`
 * for three quarters of everything that happened.
 *
 * Sessions live in memory. That is honest for this deployment — one process, no
 * replicas — and it means a restart signs everyone out, which is the safe
 * direction. Swap the Map for Redis if this is ever run behind more than one
 * node; nothing else here changes.
 *
 * WHAT THIS IS NOT. The PIN is still `1234` for every account, so this does not
 * stop one member of staff signing in as another — that needs real per-person
 * credentials and is a separate piece of work. What it does fix is the layer
 * above: once signed in as housekeeping, the API enforces housekeeping's scope,
 * and every action carries a name.
 */
import { randomBytes } from "node:crypto";
import type { Actor } from "./rbac";

type Session = { actor: Actor; issuedAt: number; lastSeen: number };

const sessions = new Map<string, Session>();

/** Eight hours — longer than a shift, shorter than a week of forgotten tabs. */
const TTL_MS = 8 * 60 * 60 * 1000;

export function issueSession(staff: { id: number; name: string; role: string; dept: string }): string {
  const token = randomBytes(24).toString("hex");
  const now = Date.now();
  sessions.set(token, {
    actor: { id: staff.id, name: staff.name, role: staff.role, dept: staff.dept },
    issuedAt: now,
    lastSeen: now,
  });
  sweep(now);
  return token;
}

export function actorForToken(token: string | undefined): Actor | null {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  const now = Date.now();
  if (now - s.issuedAt > TTL_MS) {
    sessions.delete(token);
    return null;
  }
  s.lastSeen = now;
  return s.actor;
}

export function endSession(token: string | undefined): void {
  if (token) sessions.delete(token);
}

/* Expired rows would otherwise accumulate one entry per sign-in for the life of
   the process. Swept on issue rather than on a timer, so there is no interval
   keeping the process awake and nothing to clean up on shutdown. */
function sweep(now: number): void {
  if (sessions.size < 200) return;
  for (const [k, v] of sessions) if (now - v.issuedAt > TTL_MS) sessions.delete(k);
}

/** For tests and for an operator asking who is currently signed in. */
export function activeSessions(): { name: string; role: string; dept: string; issuedAt: number }[] {
  const now = Date.now();
  return [...sessions.values()]
    .filter((s) => now - s.issuedAt <= TTL_MS)
    .map((s) => ({ name: s.actor.name, role: s.actor.role, dept: s.actor.dept, issuedAt: s.issuedAt }));
}
