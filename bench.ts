import "dotenv/config";

/**
 * Local-vs-API quality benchmark for the kiosk.

 *
 * The point of this harness is to make the trade-off measurable instead of
 * argued about. It reports FOUR numbers per provider, not one:
 *
 *   accuracy    — the expected figures actually appear in the reply
 *   refusal     — the agent handed off instead of answering
 *   fabrication — the numeric guard found figures with no source
 *   latency     — wall-clock per turn
 *
 * Accuracy alone is misleading here. A model that escalates every question
 * scores zero fabrication and looks "safe" while being useless, and that is
 * exactly the failure mode a small local model falls into. A model that answers
 * everything confidently can beat it on accuracy while inventing prices. Only
 * the four together describe whether the offline path is fit for guests.
 *
 * HOW TO RUN
 *
 *   Copy the database first — the harness writes conversations:
 *     cp data.db bench.db
 *
 *   One run per provider, each pinned by LLM_MODE so there is no failover to
 *   muddy the attribution:
 *     DB_FILE=bench.db LLM_MODE=openai npx tsx bench.ts --out bench-openai.json
 *     DB_FILE=bench.db LLM_MODE=local  npx tsx bench.ts --out bench-local.json
 *
 *   Then compare:
 *     npx tsx bench.ts --compare bench-openai.json bench-local.json
 *
 * The gold answers below were computed from the real database, not from a model.
 */

import { runAgent } from "./server/agent";
import { storage } from "./server/storage";
import { MODE, PRIMARY } from "./server/llm";
import { extractClaims } from "./server/numguard";
import { folioSummary } from "./server/pricing";
import { readFileSync, writeFileSync } from "node:fs";

type Gold = {
  id: string;
  lang: "vi" | "en" | "ko" | "zh";
  /** Reservation the question is asked from. */
  code: string;
  ask: string;
  /** Money amounts that must appear, canonical integers. */
  money?: number[];
  /** Instead of a hardcoded amount, take the expected figure from the app's own
   *  deterministic pricing code at run time. The benchmark's job is to measure
   *  whether the MODEL reports the tool's number faithfully; whether pricing.ts
   *  computes it correctly is a separate question with its own tests. Writing
   *  the balance in by hand would also silently rot the moment a charge is
   *  posted, and a stale gold answer teaches the wrong lesson. */
  moneyFrom?: (reservationId: number) => number[];
  /** Percentages that must appear. */
  percent?: number[];
  /** Substrings that must appear, case-insensitive — for non-numeric facts. */
  mustSay?: string[];
  /** Substrings that must NOT appear: the known-bad invented figures. */
  mustNotSay?: string[];
  /** A question the hotel genuinely cannot answer. Escalating is the RIGHT
   *  outcome, so refusal counts as correct here. */
  refusalIsCorrect?: boolean;
};

/**
 * Gold set. Small on purpose: every expected value is one I verified against the
 * database or the published policy, and an unverified gold answer is worse than
 * no benchmark at all because it teaches the wrong lesson.
 */
const GOLD: Gold[] = [
  {
    id: "folio-balance",
    lang: "vi",
    code: "VPNT-1D40TG",
    ask: "Cho tôi xem hoá đơn hiện tại của tôi, tổng cộng bao nhiêu?",
    moneyFrom: (id) => [Math.round(folioSummary(id).balance_due)],
  },
  {
    id: "folio-balance-en",
    lang: "en",
    code: "VPNT-6B44LN",
    ask: "What is my current bill total?",
    moneyFrom: (id) => [Math.round(folioSummary(id).balance_due)],
  },
  {
    id: "checkin-time",
    lang: "vi",
    code: "VPNT-9K52JH",
    ask: "Mấy giờ tôi được nhận phòng?",
    mustSay: ["14:00"],
  },
  {
    id: "early-checkin-price",
    lang: "en",
    code: "VPNT-4Q18ZM",
    ask: "I land at 8am. How much to check in early?",
    percent: [50],
  },
  {
    id: "cancellation",
    lang: "vi",
    code: "VPNT-5T09WB",
    /* The cancellation fee is one night's rate, which is on the reservation row,
       so it is read from there rather than typed in. */
    ask: "Tôi muốn huỷ phòng, phí huỷ là bao nhiêu?",
    moneyFrom: (id) => {
      const r = storage.listReservations().find((x) => x.id === id)!;
      return [Math.round(r.ratePerNight)];
    },
  },
  {
    id: "tax-gross-up",
    lang: "vi",
    code: "VPNT-2M77VD",
    ask: "Nếu dịch vụ là 12.000.000 đồng thì tôi phải trả tổng bao nhiêu sau thuế và phí?",
    money: [13608000],
  },
  {
    id: "spa-discount-trap",
    lang: "vi",
    code: "VPNT-7H23PC",
    /* The brand_voice column in the database asserts a Platinum spa discount
       unconditionally. This guest is not Platinum, so quoting 1.610.000 is the
       fabrication we are hunting. */
    ask: "Massage ở spa giá bao nhiêu, tôi có được giảm không?",
    mustNotSay: ["1.610.000", "1610000"],
  },
  {
    id: "occupancy-unknown",
    lang: "vi",
    code: "VPNT-1D40TG",
    /* This case originally asserted a refusal, because max_guests was NULL for
       every villa. The Phase A migration filled the column from the property's
       own rate sheet — this villa now holds 8 — so refusing became the WRONG
       answer and the case was silently rewarding a handoff the guest does not
       need. The label follows the data. */
    ask: "Villa của tôi tối đa được mấy người ở?",
    mustSay: ["8"],
  },
  {
    id: "housekeeping-ko",
    lang: "ko",
    code: "VPNT-5K18QA",
    ask: "수건이 부족하고 에어컨이 작동하지 않아요",
    mustSay: [],
  },
  {
    id: "dining-zh",
    lang: "zh",
    code: "VPNT-6B44LN",
    ask: "今晚想订餐厅，几点开始？",
    mustSay: [],
  },
];

const REFUSAL_MARKERS = [
  "lễ tân",
  "front desk",
  "colleague",
  "đồng nghiệp",
  "chuyển",
  "xác nhận lại",
  "cannot",
  "không thể",
  "kiểm tra lại",
];

type CaseResult = {
  id: string;
  lang: string;
  ask: string;
  reply: string;
  servedBy?: string;
  model?: string;
  latencyMs: number;
  toolTokens?: number;
  toolFamilies?: string[];
  toolCalls: string[];
  escalated: boolean;
  refused: boolean;
  /** Expected figures that were present. */
  hit: string[];
  /** Expected figures that were missing. */
  miss: string[];
  /** Forbidden strings that appeared. */
  violations: string[];
  /** Figures the numeric guard could not source. */
  ungrounded: string[];
  correct: boolean;
  error?: string;
};

function moneyPresent(reply: string, want: number): boolean {
  return extractClaims(reply).some((c) => c.kind === "money" && Number(c.value) === want);
}
function percentPresent(reply: string, want: number): boolean {
  return extractClaims(reply).some((c) => c.kind === "percent" && Number(c.value) === want);
}

async function runOne(g: Gold): Promise<CaseResult> {
  const res = storage.listReservations().find((r) => r.confirmationCode === g.code);
  if (!res) {
    return {
      id: g.id, lang: g.lang, ask: g.ask, reply: "", latencyMs: 0, toolCalls: [],
      escalated: false, refused: false, hit: [], miss: [], violations: [], ungrounded: [],
      correct: false, error: `reservation ${g.code} not in database`,
    };
  }

  const now = new Date().toISOString();
  const conv = storage.createConversation({
    hotelId: res.hotelId,
    guestId: res.guestId,
    reservationId: res.id,
    channel: "webchat",
    mode: "ai",
    sentiment: "neutral",
    topic: `bench:${g.id}`,
    assignedStaffId: null,
    unreadForStaff: 0,
    lastMessageAt: now,
    createdAt: now,
    firstResponseSeconds: null,
  });
  storage.addMessage({
    conversationId: conv.id,
    role: "guest",
    authorName: null,
    body: g.ask,
    toolTrace: null,
    latencyMs: null,
    createdAt: now,
  });

  try {
    const r = await runAgent(conv.id);
    const hit: string[] = [];
    const miss: string[] = [];
    const wantMoney = [...(g.money ?? []), ...(g.moneyFrom ? g.moneyFrom(res.id) : [])];
    for (const m of wantMoney) (moneyPresent(r.reply, m) ? hit : miss).push(String(m));
    for (const p of g.percent ?? []) (percentPresent(r.reply, p) ? hit : miss).push(`${p}%`);
    for (const s of g.mustSay ?? [])
      (r.reply.toLowerCase().includes(s.toLowerCase()) ? hit : miss).push(s);

    const violations = (g.mustNotSay ?? []).filter((s) => r.reply.includes(s));
    const refused =
      r.escalated || REFUSAL_MARKERS.some((m) => r.reply.toLowerCase().includes(m.toLowerCase()));
    const ungrounded = (r.numericGuard?.ungrounded ?? []).map((c) => c.raw);

    /* For a question the hotel cannot answer, a handoff IS the right answer. */
    const correct = g.refusalIsCorrect
      ? refused && violations.length === 0
      : miss.length === 0 && violations.length === 0;

    return {
      id: g.id, lang: g.lang, ask: g.ask, reply: r.reply,
      servedBy: r.servedBy, model: r.model, latencyMs: r.latencyMs,
      toolTokens: r.toolTokens, toolFamilies: r.toolFamilies,
      toolCalls: r.trace.map((t) => t.name),
      escalated: r.escalated, refused, hit, miss, violations, ungrounded, correct,
    };
  } catch (e: any) {
    return {
      id: g.id, lang: g.lang, ask: g.ask, reply: "", latencyMs: 0, toolCalls: [],
      escalated: false, refused: false, hit: [], miss: [], violations: [], ungrounded: [],
      correct: false, error: e?.message ?? String(e),
    };
  }
}

function summarise(rows: CaseResult[]) {
  const n = rows.length;
  const ok = rows.filter((r) => r.correct).length;
  const ran = rows.filter((r) => !r.error);
  const refused = rows.filter((r) => r.refused).length;
  const fabricated = rows.filter((r) => r.ungrounded.length > 0).length;
  const violated = rows.filter((r) => r.violations.length > 0).length;
  const lat = ran.map((r) => r.latencyMs).sort((a, b) => a - b);
  return {
    cases: n,
    errors: n - ran.length,
    accuracy: n ? +(ok / n).toFixed(3) : 0,
    refusalRate: n ? +(refused / n).toFixed(3) : 0,
    fabricationRate: n ? +(fabricated / n).toFixed(3) : 0,
    knownBadQuoted: violated,
    latencyMedianMs: lat.length ? lat[Math.floor(lat.length / 2)] : 0,
    latencyMaxMs: lat.length ? lat[lat.length - 1] : 0,
    meanToolTokens: ran.length
      ? Math.round(ran.reduce((s, r) => s + (r.toolTokens ?? 0), 0) / ran.length)
      : 0,
  };
}

/* ---------------------------- compare mode ------------------------------- */

function compare(aPath: string, bPath: string) {
  const A = JSON.parse(readFileSync(aPath, "utf8"));
  const B = JSON.parse(readFileSync(bPath, "utf8"));
  const pad = (s: string, w: number) => s.padEnd(w);
  const num = (v: number, w: number) => String(v).padStart(w);

  console.log(`\n${pad("metric", 20)}${pad(A.provider, 14)}${pad(B.provider, 14)}`);
  console.log("-".repeat(48));
  for (const k of [
    "accuracy", "refusalRate", "fabricationRate", "knownBadQuoted",
    "latencyMedianMs", "latencyMaxMs", "meanToolTokens", "errors",
  ] as const) {
    console.log(`${pad(k, 20)}${pad(String(A.summary[k]), 14)}${pad(String(B.summary[k]), 14)}`);
  }

  console.log(`\nper case (\u2713 correct, \u2717 wrong, R refused, F fabricated)\n`);
  const byId = new Map<string, any>(B.rows.map((r: CaseResult) => [r.id, r]));
  for (const a of A.rows as CaseResult[]) {
    const b = byId.get(a.id);
    const mark = (r?: CaseResult) =>
      !r ? "  -" : `${r.correct ? "\u2713" : "\u2717"}${r.refused ? "R" : " "}${r.ungrounded.length ? "F" : " "}`;
    console.log(`  ${pad(a.id, 22)}${pad(mark(a), 8)}${pad(mark(b), 8)}${num(a.latencyMs, 7)}ms ${num(b?.latencyMs ?? 0, 7)}ms`);
  }

  /* The regressions that matter are cases the API answers and the local model
     does not. Listing them turns "local is worse" into a work list. */
  const lost = (A.rows as CaseResult[]).filter((a) => a.correct && !byId.get(a.id)?.correct);
  if (lost.length) {
    console.log(`\n${B.provider} loses ${lost.length} case(s) that ${A.provider} gets right:`);
    for (const a of lost) {
      const b = byId.get(a.id);
      console.log(`  - ${a.id}: ${b?.refused ? "refused" : b?.miss?.length ? `missed ${b.miss.join(", ")}` : b?.error ?? "wrong"}`);
    }
  }
  const gainedFab = (B.rows as CaseResult[]).filter((b) => b.ungrounded.length > 0);
  if (gainedFab.length) {
    console.log(`\nfigures the guard had to strip on ${B.provider}:`);
    for (const b of gainedFab) console.log(`  - ${b.id}: ${b.ungrounded.join(", ")}`);
  }
}

/* -------------------------------- main ----------------------------------- */

const argv = process.argv.slice(2);
const ci = argv.indexOf("--compare");
if (ci >= 0) {
  compare(argv[ci + 1], argv[ci + 2]);
} else {
  const oi = argv.indexOf("--out");
  const out = oi >= 0 ? argv[oi + 1] : `bench-${PRIMARY}.json`;

  if (MODE.startsWith("auto")) {
    console.error(
      `LLM_MODE=${MODE} lets a turn fail over to the other provider, so the results ` +
        `could not be attributed. Run with LLM_MODE=openai or LLM_MODE=local.`,
    );
    process.exit(2);
  }
  if (!process.env.DB_FILE) {
    console.error("Set DB_FILE to a copy of the database — this harness writes conversations.");
    process.exit(2);
  }

  const rows: CaseResult[] = [];
  for (const g of GOLD) {
    const r = await runOne(g);
    rows.push(r);
    const mark = r.error ? "ERR " : r.correct ? " ok " : "FAIL";
    console.log(
      `  ${mark} ${r.id.padEnd(22)} ${String(r.latencyMs).padStart(6)}ms ` +
        `${r.refused ? "refused " : ""}${r.ungrounded.length ? `fabricated:${r.ungrounded.join("|")} ` : ""}` +
        `${r.error ?? ""}`,
    );
  }

  const summary = summarise(rows);
  writeFileSync(out, JSON.stringify({ provider: PRIMARY, mode: MODE, summary, rows }, null, 2));
  console.log(`\n${PRIMARY}:`, summary);
  console.log(`written to ${out}`);
}
