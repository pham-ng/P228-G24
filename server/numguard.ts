/**
 * Numeric fabrication guard.
 *
 * A concierge that invents a price is worse than one that says "let me check".
 * A small local model invents prices readily, but the hosted API does it too —
 * so this guard runs on both paths, unchanged. That is deliberate: if the guard
 * only protected the local path, the two modes would answer the same question
 * with different numbers, and the benchmark comparing them would be measuring
 * the guard instead of the models.
 *
 * The rule is narrow on purpose: every MONEY amount, PERCENTAGE and CLOCK TIME
 * in the reply must be traceable to something the system actually read this
 * turn. Counts ("2 adults", "3 nights") are not checked — they come from the
 * guest and reading them back is how confirmation works.
 *
 * WHAT COUNTS AS GROUNDING
 *
 * Tool results from this turn, plus the guest's own words, plus a short list of
 * house constants defined here in code.
 *
 * The system prompt is deliberately NOT a grounding source. It embeds
 * `hotels.brand_voice` from the database, and that column currently contains an
 * invented Platinum spa discount ("2.300.000 -> 1.610.000") and a "476-key"
 * claim. Grounding against the prompt would bless exactly the fabricated
 * figures we are trying to catch. Because it is excluded, this guard fires on
 * that bad row at runtime instead of laundering it.
 */

/** Verified house constants. Each one is checkable against the database or the
 *  law, and each has a tool that can also produce it. They live here so the
 *  guard does not have to trust the prompt. */
export const HOUSE_CONSTANTS = {
  /** Standard check-in / check-out, `hotels` table. */
  times: ["14:00", "12:00"],
  /** VAT 8% on accommodation for 2026 (Nghị quyết 204/2025/QH15), 5% service
   *  charge, the published tier discounts, the 50% early-check-in charge and the
   *  100% first-night cancellation fee. A rate being listed here means the
   *  hotel really uses it — not that this guest qualifies for it. */
  percents: [0, 5, 7, 8, 10, 20, 30, 33, 50, 100],
  /** Grounded resort room rates published in the knowledge base (VND). */
  money: [
    2200000, 2410000, 2640000, 2870000, 3190000, 3420000, 3620000,
    4097000, 4270000, 4370000, 4820000, 5270000, 7390900, 8610000,
    9420000, 10130000, 12690000, 14940000
  ],
} as const;

export type NumKind = "money" | "percent" | "time";

export type NumClaim = {
  kind: NumKind;
  /** Exactly as written in the reply, for reporting and for surgical removal. */
  raw: string;
  /** Canonical comparable form: minor-unit-free integer for money, the number
   *  for percent, "H:MM" for time. */
  value: string;
  index: number;
};

/**
 * Money in this codebase is VND: no decimals in practice, thousands separated
 * by "." or "," or a space, sometimes suffixed with đ/₫/VND, sometimes written
 * as "2,3 triệu". Anything with four or more digits is treated as money even
 * without a currency mark, because "2300000" on its own is still a price claim.
 */
const MONEY_RE =
  /(\d{1,3}(?:[.,\u00a0 ]\d{3})+|\d{4,})\s*(?:đ|₫|VND|vnd|dong|đồng)?|(\d+(?:[.,]\d+)?)\s*(?:triệu|tr\b|million)/gu;
const PERCENT_RE = /(\d{1,3}(?:[.,]\d+)?)\s*(?:%|phần trăm|percent)/gu;
const TIME_RE = /\b([01]?\d|2[0-3])[:h]([0-5]\d)\b/gu;
/**
 * Natural-language hour, the shape guests actually type instead of "16:00".
 *
 * Without this, a guest writing "4 giờ chiều" or "8 giờ tối" never produces a
 * TIME claim at all — TIME_RE only matches H:MM — so their own stated time
 * never enters the grounding set built from `guestText`. When the model
 * correctly converts it to 24-hour form in its reply ("16:00"), that figure has
 * nothing to match against and the guard reports it UNGROUNDED: the guest's own
 * words, quoted back to them, read as a fabrication. Measured directly — three
 * benchmark cases ("4 giờ chiều", "4 giờ sáng", "8 giờ tối") all failed this
 * way, and the model's arithmetic was correct every time; only the grounding
 * check was wrong.
 */
const VN_HOUR_WORD_RE = /\b([01]?\d|2[0-3])\s*(?:giờ|gio|h)\s*(sáng|trưa|chiều|toi|tối|khuya)?/gu;
const AMPM_HOUR_RE = /\b([01]?\d)\s*(am|pm)\b/gi;

/** "4" + "chiều" -> "16:00"; "8" + "tối" -> "20:00"; a bare hour or "sáng" is left as-is. */
function vnHourToClock(hour: number, marker: string | undefined): string {
  let h = hour % 24;
  if ((marker === "chiều" || marker === "tối" || marker === "toi") && h >= 1 && h <= 11) h += 12;
  else if (marker === "trưa") h = 12;
  return `${h}:00`;
}
function ampmToClock(hour: number, marker: string): string {
  let h = hour % 12;
  if (marker.toLowerCase() === "pm") h += 12;
  return `${h}:00`;
}

/** Strip grouping marks so "2.300.000", "2,300,000" and "2300000" compare equal. */
function canonMoney(s: string): string {
  const digits = s.replace(/[^\d]/g, "");
  return String(Number(digits));
}

function canonPercent(s: string): string {
  return String(Number(s.replace(",", ".")));
}

/**
 * Pull every checkable numeric claim out of a piece of text.
 *
 * Reservation codes, room numbers and phone numbers are removed first. They are
 * full of digits that would otherwise be read as prices — "VPNT-1D40TG" and a
 * ten-digit phone number both look like money to a regex.
 */
export function extractClaims(text: string): NumClaim[] {
  const masked = text
    // reservation codes: letters-digits mixes such as VPNT-1D40TG
    .replace(/\b[A-Z]{2,}[-–][A-Z0-9]{4,}\b/gu, (m) => " ".repeat(m.length))
    // room and villa identifiers: V03, A1204
    .replace(/\b[A-Z]\d{2,4}\b/gu, (m) => " ".repeat(m.length))
    /* Phone numbers, which must start with + or a trunk 0 and may not use "."
       as a separator. An earlier version matched any run of digits and
       punctuation, which silently swallowed every dotted VND amount —
       "2.300.000" was masked as a phone number and so was never checked at
       all, turning the whole guard into a no-op on real prices. */
    .replace(/(?:\+\d{1,3}[\s.-]?)?0\d[\d\s()-]{6,}\d/gu, (m) => " ".repeat(m.length))
    // dates: 2026-08-22, 22/08/2026, 22.08.2026
    .replace(/\b\d{4}-\d{2}-\d{2}\b/gu, (m) => " ".repeat(m.length))
    .replace(/\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/gu, (m) => " ".repeat(m.length))
    // 24/7 and similar ratios
    .replace(/\b24\s*\/\s*7\b/gu, (m) => " ".repeat(m.length))
    /* A bare calendar year ("2026", "trong năm 2026") is not a currency amount,
     * but MONEY_RE's four-digit branch has no currency-marker requirement, so
     * it read the model naming the current year as an invented four-digit
     * price. Caught directly: a benchmark case answering "how many nights are
     * left in your stay" mentioned the year and was escalated over it. Money in
     * this domain is never plausibly a bare four-digit figure without a
     * currency mark anyway — real VND prices are grouped ("2.300.000") or
     * explicitly suffixed — so this only removes false positives, and only in
     * the narrow 1900-2099 range where "a bare number is a year" is safe to
     * assume. A real currency-marked amount ("2026đ") is untouched: the
     * currency mark is checked for and the mask is skipped when present.
     */
    .replace(/\b(19\d{2}|20\d{2})\b(?!\s*(?:đ|₫|VND|vnd|dong|đồng))/gu, (m) => " ".repeat(m.length));

  const claims: NumClaim[] = [];

  for (const m of masked.matchAll(PERCENT_RE)) {
    claims.push({
      kind: "percent",
      raw: m[0].trim(),
      value: canonPercent(m[1]),
      index: m.index ?? 0,
    });
  }
  for (const m of masked.matchAll(TIME_RE)) {
    claims.push({
      kind: "time",
      raw: m[0].trim(),
      value: `${Number(m[1])}:${m[2]}`,
      index: m.index ?? 0,
    });
  }
  /* Natural-language hours, checked after H:MM so an exact "16:00" is not also
     read a second time by the looser word pattern (VN_HOUR_WORD_RE's trailing
     meridiem group is optional, so it could otherwise match the "16" in
     "16:00" on its own). Skip a span already claimed at this position. */
  const alreadyClaimed = (i: number) => claims.some((c) => c.index <= i && i < c.index + c.raw.length);
  for (const m of masked.matchAll(VN_HOUR_WORD_RE)) {
    const i = m.index ?? 0;
    if (alreadyClaimed(i)) continue;
    claims.push({ kind: "time", raw: m[0].trim(), value: vnHourToClock(Number(m[1]), m[2]), index: i });
  }
  for (const m of masked.matchAll(AMPM_HOUR_RE)) {
    const i = m.index ?? 0;
    if (alreadyClaimed(i)) continue;
    claims.push({ kind: "time", raw: m[0].trim(), value: ampmToClock(Number(m[1]), m[2]), index: i });
  }
  for (const m of masked.matchAll(MONEY_RE)) {
    // Skip a match that is really the number part of a percentage or a time we
    // already recorded at this position.
    if (claims.some((c) => c.index <= (m.index ?? 0) && (m.index ?? 0) < c.index + c.raw.length)) {
      continue;
    }
    if (m[2] !== undefined) {
      // "2,3 triệu" -> 2300000
      const scaled = Math.round(Number(m[2].replace(",", ".")) * 1_000_000);
      claims.push({ kind: "money", raw: m[0].trim(), value: String(scaled), index: m.index ?? 0 });
    } else if (m[1] !== undefined) {
      claims.push({ kind: "money", raw: m[0].trim(), value: canonMoney(m[1]), index: m.index ?? 0 });
    }
  }

  return claims.sort((a, b) => a.index - b.index);
}

/**
 * Everything the reply is allowed to draw numbers from, as canonical values.
 *
 * Tool results are the main source. They are walked recursively rather than
 * matched as JSON text, because a price arrives as the number 2300000 while the
 * reply writes "2.300.000 ₫" — string matching would miss it.
 */
export function buildGrounding(input: {
  toolResults: unknown[];
  guestText?: string;
  passages?: unknown[];
}): { money: Set<string>; percent: Set<string>; time: Set<string>; moneyDerivable: Set<string> } {
  const money = new Set<string>();
  const percent = new Set<string>();
  const time = new Set<string>();
  const moneyDerivable = new Set<string>();

  for (const p of HOUSE_CONSTANTS.percents) percent.add(String(p));
  for (const m of HOUSE_CONSTANTS.money) money.add(String(m));
  for (const t of HOUSE_CONSTANTS.times) {
    const [h, mi] = t.split(":");
    time.add(`${Number(h)}:${mi}`);
  }

  const addMoney = (v: string) => {
    money.add(v);
    moneyDerivable.add(v);
  };

  const walk = (v: unknown): void => {
    if (v === null || v === undefined) return;
    if (typeof v === "number") {
      if (Number.isFinite(v)) {
        addMoney(String(Math.round(v)));
        percent.add(String(v));
      }
      return;
    }
    if (typeof v === "string") {
      for (const c of extractClaims(v)) {
        if (c.kind === "money") addMoney(c.value);
        else if (c.kind === "percent") percent.add(c.value);
        else time.add(c.value);
      }
      if (/^\d+(\.\d+)?$/.test(v.trim())) {
        addMoney(String(Math.round(Number(v))));
        percent.add(String(Number(v)));
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) walk(x);
    }
  };

  for (const r of input.toolResults) walk(r);
  if (input.passages && Array.isArray(input.passages)) {
    for (const p of input.passages) walk(p);
  }
  if (input.guestText) {
    for (const c of extractClaims(input.guestText)) {
      if (c.kind === "money") addMoney(c.value);
      else if (c.kind === "percent") percent.add(c.value);
      else time.add(c.value);
    }
  }

  return { money, percent, time, moneyDerivable };
}

export type GuardVerdict = {
  ok: boolean;
  /** Claims with no support in this turn's evidence. */
  ungrounded: NumClaim[];
  /** How many claims were checked, for the benchmark's grounding rate. */
  checked: number;
};

/**
 * Derived money is legitimate: a reply may add a 5% service charge and 8% VAT
 * to a grounded subtotal, or sum a folio, and the total will not appear in any
 * tool result. Recomputing every rule here would duplicate pricing.ts, so
 * instead a claim is accepted when it is reachable from grounded amounts by the
 * arithmetic the hotel actually uses.
 */
function isDerivable(target: number, base: Set<string>): boolean {
  /* Only real amounts take part. Tool results also carry small integers such as
     a night count or a VAT rate, and letting those in would make almost any
     number reachable by multiplication. */
  const amounts = [...base].map(Number).filter((n) => Number.isFinite(n) && n >= 1000);
  /* Tax and service-charge gross-up, and the published 50% early-check-in
     charge. Discount multipliers are deliberately absent: whether THIS guest is
     entitled to a tier discount is a policy question, and pricing.ts already
     returns the discounted amount, so a legitimate discounted price is grounded
     through the tool result. Allowing 0.7 here would have let the invented
     unconditional "Platinum spa 30%" line derive its own answer. */
  const rates = [1.05, 1.08, 1.05 * 1.08, 0.5];
  const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1, b * 0.005);

  for (const a of amounts) {
    for (const r of rates) if (near(target, a * r)) return true;
    // integer multiples: a nightly rate times the number of nights
    for (let n = 2; n <= 30; n++) if (near(target, a * n)) return true;
  }
  // pairwise sums, which is how a folio total or a two-item quote arises
  for (let i = 0; i < amounts.length; i++) {
    for (let j = i; j < amounts.length; j++) {
      if (near(target, amounts[i] + amounts[j])) return true;
      if (near(target, Math.abs(amounts[i] - amounts[j]))) return true;
    }
  }
  return false;
}

/** Check a drafted reply against the evidence gathered during the same turn. */
export function checkReply(
  reply: string,
  evidence: { toolResults: unknown[]; guestText?: string; passages?: unknown[] },
): GuardVerdict {
  const g = buildGrounding(evidence);
  const claims = extractClaims(reply);
  const ungrounded: NumClaim[] = [];

  for (const c of claims) {
    const pool = c.kind === "money" ? g.money : c.kind === "percent" ? g.percent : g.time;
    if (pool.has(c.value)) continue;
    // Derivation may only build on amounts seen this turn, never on the house
    // constants — otherwise a fabricated price is "derivable" from published rates.
    if (c.kind === "money" && isDerivable(Number(c.value), g.moneyDerivable)) continue;
    ungrounded.push(c);
  }

  return { ok: ungrounded.length === 0, ungrounded, checked: claims.length };
}

/**
 * What to do about an ungrounded number.
 *
 * Blanket refusal was rejected earlier in this project: it costs more coverage
 * than it buys in safety. So the reply is repaired rather than thrown away —
 * only the sentences carrying invented figures are dropped, and the guest is
 * told plainly that the number needs confirming. If nothing survives, the turn
 * escalates, which is the honest outcome when the entire answer was a made-up
 * price.
 */
export function repairReply(
  reply: string,
  verdict: GuardVerdict,
  lang: "vi" | "en" = "vi",
): { text: string; escalate: boolean; removed: string[] } {
  if (verdict.ok) return { text: reply, escalate: false, removed: [] };

  const bad = new Set(verdict.ungrounded.map((c) => c.raw));
  /* Split on sentence ends while keeping the delimiter, so the surviving text
     still reads as prose. */
  const parts = reply.split(/(?<=[.!?。！？\n])\s*/u);
  const kept: string[] = [];
  const removed: string[] = [];

  for (const p of parts) {
    const hit = [...bad].some((b) => p.includes(b));
    if (hit) removed.push(p.trim());
    else if (p.trim()) kept.push(p.trim());
  }

  const note =
    lang === "vi"
      ? "Về con số cụ thể, tôi cần xác nhận lại với lễ tân để tránh báo sai — tôi đang chuyển yêu cầu này ngay."
      : "For the exact figure I need the front desk to confirm it rather than risk quoting you wrongly — I am passing this on now.";

  if (kept.length === 0) return { text: note, escalate: true, removed };
  return { text: `${kept.join(" ")} ${note}`, escalate: true, removed };
}

/**
 * A guard for the two NON-numeric fabrications the numeric guard cannot see,
 * both caught by the golden set as confident answers to adversarial traps:
 *
 *   1. A loyalty TIER derived from a quantity the corpus has no threshold table
 *      for. "25.000 điểm thì lên hạng gì?" — the passages name the tiers
 *      (Member/Gold/Platinum/Diamond) and their perks, but nowhere map a points
 *      amount to a tier, so any tier the model names is invented. Confirmed
 *      against the corpus: no points→tier mapping exists.
 *
 *   2. A mandatory DOCUMENT the passages never mention. "Trẻ em cần mang giấy
 *      khai sinh không?" → "Có, phải mang" for a requirement that appears
 *      nowhere in doc_chunks.
 *
 * Both are checked against the SAME evidence the answer was grounded on, so the
 * guard turns itself off the moment the corpus actually gains the fact — it
 * fires only where the answer is unsupported today. Vietnamese + English forms;
 * conservative by design (fires only on a clear derive-from-quantity question
 * or a clear "must bring X" affirmation), because a guard that abstains on a
 * good answer is worse than one that misses.
 */
/* Diacritic-fold to ASCII, so a pattern matches whatever Unicode form the text
   arrives in. The local model emits Vietnamese in NFD (combining marks) while
   the golden questions are NFC \u2014 an accented regex literal matched the question
   but silently missed the model's reply, which is why the first cut of this
   guard fired on the tier trap (question-matched) but not the document trap
   (reply-matched). Folding both sides removes the whole class of bug. */
function foldVi(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u0111\u0110]/g, "d")
    .toLowerCase();
}

const TIER_NAMES_F = /\b(member|silver|gold|platinum|diamond)\b|kim cuong|bach kim/;

export function checkCategoricalTraps(
  question: string,
  reply: string,
  evidenceText: string,
): { abstain: boolean; reason?: string } {
  const q = foldVi(question);
  const r = foldVi(reply);
  const ev = foldVi(evidenceText);

  // 1) Tier derived from points / spend / nights, with no threshold in evidence.
  const asksTierFromQuantity =
    /(diem|chi tieu|dem|point|spend|night)/.test(q) && /(hang|len hang|\bthe\b|tier|rank)/.test(q);
  const replyNamesTier = TIER_NAMES_F.test(r);
  /* A real threshold row puts the points amount and the tier CLOSE together
     ("Gold: 25.000 diem"). Requiring proximity, not mere co-occurrence anywhere
     in the passage blob, stops a stray points figure in one passage and a tier
     name in another from falsely reading as a threshold and disabling the guard
     \u2014 which is exactly what happened once the passage cap grew to 1200. */
  const tier = "(?:member|silver|gold|platinum|diamond|kim cuong|bach kim)";
  const pts = "\\d[\\d.,]{2,}\\s*(?:diem|point)";
  const evidenceHasThreshold = new RegExp(`${pts}[^.\\n]{0,60}${tier}|${tier}[^.\\n]{0,60}${pts}`).test(ev);
  if (asksTierFromQuantity && replyNamesTier && !evidenceHasThreshold) {
    return { abstain: true, reason: "tier-from-quantity: khong co nguong diem->hang trong tai lieu" };
  }

  /* A document guard was tried here (birth-certificate "must bring") and dropped:
     the corpus DOES carry the fact — "when there is no birth certificate, height
     decides age" (kb/16, policy/3) — so the birth certificate is OPTIONAL proof,
     not a missing fact. The model's "must bring one" is a polarity misread of
     present content, not a fabrication of absent content, so a presence-based
     guard cannot see it and would only fire where the fact is genuinely gone.
     Left to the model-comprehension lever, not guarded here. */

  return { abstain: false };
}
