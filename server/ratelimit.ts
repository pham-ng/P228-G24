/**
 * Rate limiting for the guest surface.
 *
 * A confirmation code is the only credential the kiosk has, and until now
 * nothing limited how many could be tried. `VPNT-5K18QA` is short enough that
 * an unthrottled attacker walks the space; each hit used to return the guest's
 * full record. The payload is cut down now (`guestSafeDetail`), but "fewer
 * fields per breach" is not the same as "cannot enumerate", so the attempts
 * themselves have to cost something.
 *
 * WHY NO DEPENDENCY. `express-rate-limit` is the usual answer and would be
 * fine, but this service is deliberately offline-capable and single-process on
 * one machine, so an in-memory counter is not a compromise here — it is the
 * whole correct implementation. What it CANNOT do is survive a restart or work
 * across replicas; if this is ever run behind more than one node, replace the
 * map with Redis and nothing else about the shape changes.
 *
 * TWO SEPARATE BUDGETS, because they defend different things:
 *
 *   - a request budget, so one client cannot flood any guest endpoint;
 *   - a FAILURE budget on code lookups, which is the one that actually stops
 *     enumeration. Someone typing their own code wrongly twice is normal;
 *     someone producing twenty misses in five minutes is not a guest.
 *
 * Trusting `x-forwarded-for` blindly would let an attacker mint a fresh
 * identity per request, so it is read only when TRUST_PROXY is set — which is
 * correct exactly when a real reverse proxy is in front and rewriting it.
 */
import type { Request, Response } from "express";

const TRUST_PROXY = process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true";

export function clientKey(req: Request): string {
  if (TRUST_PROXY) {
    const fwd = req.headers["x-forwarded-for"];
    const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(",")[0];
    if (first?.trim()) return first.trim();
  }
  return req.ip || req.socket.remoteAddress || "unknown";
}

type Bucket = { count: number; resetAt: number };

/** A fixed-window counter. Windows are cheap and, for this purpose, enough:
 *  the worst case is a burst of 2x the limit spanning a boundary, which still
 *  bounds enumeration to a rate no human typist approaches. */
class Limiter {
  private hits = new Map<string, Bucket>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** @returns seconds to wait, or 0 when the request may proceed. */
  check(key: string, now = Date.now()): number {
    const b = this.hits.get(key);
    if (!b || now >= b.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      this.sweep(now);
      return 0;
    }
    b.count++;
    return b.count > this.limit ? Math.ceil((b.resetAt - now) / 1000) : 0;
  }

  /**
   * Is this key already over budget? Read-only.
   *
   * The failure limiter must not be advanced by the act of checking it —
   * otherwise a guest who opens their thread ten times, correctly, locks
   * themselves out, which is the opposite of the intent. Gate with `over`,
   * charge with `penalise`.
   */
  over(key: string, now = Date.now()): number {
    const b = this.hits.get(key);
    if (!b || now >= b.resetAt || b.count <= this.limit) return 0;
    return Math.ceil((b.resetAt - now) / 1000);
  }

  /** Record an attempt without judging it — used to charge failures only. */
  penalise(key: string, now = Date.now()): void {
    const b = this.hits.get(key);
    if (!b || now >= b.resetAt) this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
    else b.count++;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  /* Expired buckets would otherwise accumulate one entry per address forever.
     Swept opportunistically rather than on a timer, so nothing keeps the
     process awake and there is no interval to clean up on shutdown. */
  private sweep(now: number): void {
    if (this.hits.size < 1000) return;
    for (const [k, v] of this.hits) if (now >= v.resetAt) this.hits.delete(k);
  }
}

/** Chat is the expensive one — a turn costs a model call on one GPU — but it is
 *  also what a real guest does most, so the window is generous. */
/**
 * Ngưỡng được XUẤT RA, không chỉ nằm trong lời gọi hàm dựng.
 *
 * Trước đây hai con số này viết thẳng vào `new Limiter(...)`, còn test thì
 * khẳng định `firstBlock === 61`. Khi siết giới hạn cho bản chạy công khai
 * (60 → 20), hai test đỏ ngay — không phải vì hành vi sai mà vì cùng một con số
 * được viết ở hai nơi. Xuất ra để test khẳng định **ranh giới**, không khẳng
 * định một con số nó không kiểm soát.
 */
export const GUEST_REQUEST_LIMIT = Number(process.env.RL_GUEST_REQUESTS ?? 60);

export const guestRequests = new Limiter(GUEST_REQUEST_LIMIT, 60_000);

/**
 * Failed confirmation codes — the enumeration budget.
 *
 * Charged on misses only, and a correct code is served even when the budget is
 * spent (see the handler). That matters because a HOTEL IS A NAT: every guest
 * on the wifi presents one address, so a tight per-address budget that also
 * blocks correct codes would let one person's typos lock out the building.
 * Thirty misses in five minutes is generous for humans sharing an address and
 * still leaves brute force needing days per code space.
 *
 * Set TRUST_PROXY=1 behind a real reverse proxy so per-client addresses are
 * seen instead of the proxy's. The durable fix is a second factor — surname or
 * room number alongside the code — which no rate limit substitutes for.
 */
export const CODE_FAILURE_LIMIT = Number(process.env.RL_CODE_FAILURES ?? 30);

export const codeFailures = new Limiter(CODE_FAILURE_LIMIT, 5 * 60_000);

function refuse(res: Response, retry: number, message: string): boolean {
  res.setHeader("Retry-After", String(retry));
  res.status(429).json({ message, retryAfterSeconds: retry });
  return true;
}

/** Consumes one unit of budget and answers 429 when it is spent.
 *  @returns true when the caller should stop. */
export function limited(limiter: Limiter, req: Request, res: Response, message: string): boolean {
  const retry = limiter.check(clientKey(req));
  return retry ? refuse(res, retry, message) : false;
}

/** Refuses when the key is ALREADY over budget, without spending any itself.
 *  For budgets charged selectively — see `Limiter.over`. */
export function blockedBy(limiter: Limiter, req: Request, res: Response, message: string): boolean {
  const retry = limiter.over(clientKey(req));
  return retry ? refuse(res, retry, message) : false;
}
