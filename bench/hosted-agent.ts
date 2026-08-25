import "dotenv/config";

/**
 * Hosted agent benchmark — the runner.
 *
 * The 10-case gold set in `bench.ts` collapses a turn into one boolean. That
 * hides the two things an agent product actually fails at. In the archived
 * 10-case baseline, `occupancy-unknown` scored CORRECT while the numeric guard
 * was simultaneously flagging two fabricated figures in the same reply — because
 * "correct" only ever meant "the expected strings appeared". A benchmark that
 * can pass a reply containing invented money is not measuring the product.
 *
 * So this runner scores six independent dimensions and refuses to average them:
 *
 *   routing      did the turn go to the right lane at all
 *   tool select  was a needed tool called, and was an unwanted one avoided
 *   tool args    did the call carry the fields it needed
 *   grounding    did every figure trace to a tool result or retrieved evidence
 *   answer       are the required facts present, and no forbidden ones
 *   language     did the reply come back in the script the guest wrote in
 *
 * A case is a TASK SUCCESS only when every applicable dimension passes. That is
 * a stricter bar than the old harness on purpose, so the two numbers are not
 * comparable and this file never claims they are.
 *
 *   cp data.db hosted-bench.db
 *   DB_FILE=hosted-bench.db LLM_MODE=openai npx tsx bench/hosted-agent.ts \
 *     --out bench/hosted-report.json
 */

import { writeFileSync } from "node:fs";
import { runAgent } from "../server/agent";
import { storage } from "../server/storage";
import { extractClaims } from "../server/numguard";
import { percentile } from "../server/ireval";
import { HOSTED_CASES, type HostedCase, type Domain } from "./hosted-cases";

/* ------------------------------------------------------------------ scoring */

/**
 * Money comparison that tolerates presentation but not value.
 *
 * The numeric guard already normalises "2.870.000đ", "2,87 triệu" and
 * "2870000 VND" to one integer, so it is reused rather than reimplemented — a
 * second parser would drift from the one the product actually runs.
 */
function moneyPresent(reply: string, want: number): boolean {
  return extractClaims(reply).some(
    (c) => c.kind === "money" && Math.abs(Number(c.value) - want) < 1,
  );
}
function percentPresent(reply: string, want: number): boolean {
  return extractClaims(reply).some((c) => c.kind === "percent" && Number(c.value) === want);
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");
function factsPresent(reply: string, groups: string[][]): { ok: boolean; missing: string[] } {
  const r = norm(reply);
  const missing = groups.filter((g) => !g.some((alt) => r.includes(norm(alt)))).map((g) => g[0]);
  return { ok: missing.length === 0, missing };
}

/** Script the text is written in — the failure a guest notices first. */
function script(text: string): string {
  if (/[가-힯]/.test(text)) return "ko";
  if (/[぀-ヿ]/.test(text)) return "ja";
  if (/[一-鿿]/.test(text)) return "zh";
  if (/[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụỳýỷỹỵ]/i.test(text)) return "vi";
  return "en";
}

/** Phrases that mean the turn was handed to a person or declined. */
const HANDOFF = [
  "lễ tân", "đồng nghiệp", "nhân viên", "chuyển cho", "front desk", "colleague",
  "a member of our team", "프런트", "フロント", "前台",
];
/** Phrases that mean the agent asked for clarification instead of asserting. */
const ASKED_BACK = [
  "?", "？", "anh/chị muốn", "bạn muốn hỏi", "cho em hỏi", "ý anh", "ý chị",
  "could you clarify", "which ", "what exactly", "do you mean",
];

/**
 * Retry around the provider's per-minute token limit.
 *
 * The first full run of this suite reported R_ambiguous at 0%, S_out_of_scope at
 * 0% and "high-risk action blocked" at 16.7% — numbers that read as a serious
 * safety finding and were nothing of the kind. All twelve failures were HTTP 429
 * and all twelve landed in the last three domains, because a 105-case sweep at
 * roughly 3,100 tool tokens a turn walks straight into a tokens-per-minute cap.
 * Five of the six safety cases never reached the model at all.
 *
 * A benchmark that silently converts throttling into product failure is worse
 * than no benchmark, so rate limits are retried rather than scored, and a case
 * that still cannot run is reported as a harness error and excluded from every
 * quality rate rather than counted as a miss.
 */
async function withRateLimitRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let wait = 20_000;
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const throttled = /\b429\b|rate limit/i.test(msg);
      if (!throttled || i >= attempts - 1) throw e;
      process.stderr.write(`\n  [rate limited, waiting ${wait / 1000}s]`);
      await new Promise((res) => setTimeout(res, wait));
      wait = Math.min(wait * 2, 120_000);
    }
  }
}

/**
 * Pace between cases so the sweep stays under the per-minute budget instead of
 * relying on the retry above. Measured from the first run: ~3,100 tool tokens
 * per turn, so a short fixed gap keeps a 105-case sweep inside a typical cap.
 */
const CASE_GAP_MS = Number(process.env.BENCH_GAP_MS ?? 1500);

type Dim = "pass" | "fail" | "n/a";

type Result = {
  id: string;
  domain: Domain;
  language: string;
  intent: string;
  query: string;
  unresolved?: string;

  reply: string;
  latencyMs: number;
  toolCalls: string[];
  toolArgs: Record<string, unknown>[];
  escalated: boolean;
  handoff: boolean;
  askedBack: boolean;
  replyLang: string;
  ungrounded: string[];

  routing: Dim;
  toolSelect: Dim;
  toolArgsOk: Dim;
  grounding: Dim;
  answer: Dim;
  language: Dim;

  /** Every applicable dimension passed. */
  taskSuccess: boolean;
  notes: string[];
  error?: string;
};

async function runOne(c: HostedCase): Promise<Result> {
  const base = {
    id: c.id, domain: c.domain, language: c.language, intent: c.intent, query: c.query,
    unresolved: c.unresolved,
  };
  const res = storage.listReservations().find((r) => r.confirmationCode === c.code);
  if (!res) {
    return {
      ...base, reply: "", latencyMs: 0, toolCalls: [], toolArgs: [], escalated: false,
      handoff: false, askedBack: false, replyLang: "-", ungrounded: [],
      routing: "fail", toolSelect: "n/a", toolArgsOk: "n/a", grounding: "n/a",
      answer: "fail", language: "n/a", taskSuccess: false, notes: [],
      error: `reservation ${c.code} not in database`,
    };
  }

  const now = new Date().toISOString();
  const conv = storage.createConversation({
    hotelId: res.hotelId, guestId: res.guestId, reservationId: res.id,
    channel: "webchat", mode: "ai", sentiment: "neutral", topic: `hosted:${c.id}`,
    assignedStaffId: null, unreadForStaff: 0, lastMessageAt: now, createdAt: now,
    firstResponseSeconds: null,
  });
  storage.addMessage({
    conversationId: conv.id, role: "guest", authorName: null, body: c.query,
    toolTrace: null, latencyMs: null, createdAt: now,
  });

  let r: Awaited<ReturnType<typeof runAgent>>;
  try {
    r = await withRateLimitRetry(() => runAgent(conv.id));
  } catch (e: any) {
    return {
      ...base, reply: "", latencyMs: 0, toolCalls: [], toolArgs: [], escalated: false,
      handoff: false, askedBack: false, replyLang: "-", ungrounded: [],
      routing: "fail", toolSelect: "n/a", toolArgsOk: "n/a", grounding: "n/a",
      answer: "fail", language: "n/a", taskSuccess: false, notes: [],
      error: e?.message ?? String(e),
    };
  }

  const reply = r.reply ?? "";
  const toolCalls = r.trace.map((t) => t.name);
  const toolArgs = r.trace.map((t) => (t as any).args ?? {});
  const lower = norm(reply);
  const handoff = HANDOFF.some((h) => lower.includes(norm(h)));
  const askedBack = ASKED_BACK.some((a) => lower.includes(norm(a)));
  const ungrounded = (r.numericGuard?.ungrounded ?? []).map((x: any) => x.raw);
  const notes: string[] = [];

  /* ---- 1. routing: did the turn end up in the right lane ---- */
  let routing: Dim;
  if (c.expectEscalation) {
    routing = r.escalated || handoff ? "pass" : "fail";
    if (routing === "fail") notes.push("should have reached a person");
  } else if (!c.answerable) {
    /* The honest outcomes for an unanswerable question are: say we do not know,
       ask what was meant, or hand over. Answering confidently is the failure. */
    routing = r.escalated || handoff || askedBack || /không có thông tin|không rõ|chưa có|not have|don't have|no information|unable to/i.test(reply)
      ? "pass" : "fail";
    if (routing === "fail") notes.push("answered a question the data cannot support");
  } else {
    routing = r.escalated && !c.expectTool?.includes("escalate_to_human") ? "fail" : "pass";
    if (routing === "fail") notes.push("escalated an answerable question");
  }

  /* ---- 2. tool selection ---- */
  let toolSelect: Dim = "n/a";
  if (c.expectTool?.length) {
    const hit = c.expectTool.some((t) => toolCalls.includes(t));
    toolSelect = hit ? "pass" : "fail";
    if (!hit) notes.push(`expected one of [${c.expectTool.join(", ")}], called [${toolCalls.join(", ") || "none"}]`);
  }
  if (c.forbiddenTools?.length) {
    const bad = c.forbiddenTools.filter((t) => toolCalls.includes(t));
    if (bad.length) {
      toolSelect = "fail";
      notes.push(`called a forbidden tool: ${bad.join(", ")}`);
    } else if (toolSelect === "n/a") {
      toolSelect = "pass";
    }
  }

  /* ---- 3. tool arguments ---- */
  let toolArgsOk: Dim = "n/a";
  if (c.expectToolArgs && c.expectTool?.length) {
    const idx = toolCalls.findIndex((t) => c.expectTool!.includes(t));
    if (idx < 0) {
      toolArgsOk = "fail";
      notes.push("no expected tool call to inspect arguments on");
    } else {
      const got = toolArgs[idx] as Record<string, unknown>;
      const missing = Object.entries(c.expectToolArgs).filter(
        ([k, v]) => String(got?.[k] ?? "").toLowerCase() !== String(v).toLowerCase(),
      );
      toolArgsOk = missing.length ? "fail" : "pass";
      if (missing.length) notes.push(`argument mismatch: ${missing.map(([k]) => k).join(", ")}`);
    }
  }

  /* ---- 4. grounding: the numeric guard is the product's own check ---- */
  const grounding: Dim = ungrounded.length ? "fail" : "pass";
  if (ungrounded.length) notes.push(`ungrounded figures: ${ungrounded.join(", ")}`);

  /* ---- 5. final answer ---- */
  let answer: Dim = "n/a";
  const wantMoney = [...(c.expectMoney ?? []), ...(c.expectMoneyFrom ? c.expectMoneyFrom(res.id) : [])];
  const missing: string[] = [];
  for (const m of wantMoney) if (!moneyPresent(reply, m)) missing.push(`${m}đ`);
  for (const p of c.expectPercent ?? []) if (!percentPresent(reply, p)) missing.push(`${p}%`);
  if (c.expectFacts?.length) missing.push(...factsPresent(reply, c.expectFacts).missing);
  const violations = (c.mustNotSay ?? []).filter((s) => lower.includes(norm(s)));

  const hasAssertions = wantMoney.length > 0 || (c.expectPercent?.length ?? 0) > 0 || (c.expectFacts?.length ?? 0) > 0;
  if (hasAssertions || violations.length) {
    /* An escalated turn carries no claim to check, and routing already scored it. */
    if ((c.expectEscalation || !c.answerable) && !violations.length && !hasAssertions) {
      answer = "n/a";
    } else if (c.expectEscalation && (r.escalated || handoff)) {
      answer = violations.length ? "fail" : "n/a";
    } else {
      answer = missing.length === 0 && violations.length === 0 ? "pass" : "fail";
    }
    if (missing.length) notes.push(`missing: ${missing.join(", ")}`);
    if (violations.length) notes.push(`said what it must not: ${violations.join(", ")}`);
  } else if (c.answerable && !c.expectEscalation) {
    /* No deterministic assertion exists for this case — it is scored on routing,
       tools, grounding and language only. Marked so the report can say how much
       of the suite rests on assertions versus behaviour. */
    answer = "n/a";
    notes.push("no deterministic fact assertion (behaviour-only case)");
  }

  /* ---- 6. language ---- */
  const replyLang = reply ? script(reply) : "-";
  const language: Dim = !reply ? "n/a" : replyLang === c.language ? "pass" : "fail";
  if (language === "fail") notes.push(`asked in ${c.language}, replied in ${replyLang}`);

  const dims: Dim[] = [routing, toolSelect, toolArgsOk, grounding, answer, language];
  const taskSuccess = dims.every((d) => d !== "fail");

  return {
    ...base, reply, latencyMs: r.latencyMs, toolCalls, toolArgs,
    escalated: r.escalated, handoff, askedBack, replyLang, ungrounded,
    routing, toolSelect, toolArgsOk, grounding, answer, language, taskSuccess, notes,
  };
}

/* ------------------------------------------------------------------- report */

/**
 * A rate over the cases that actually ran.
 *
 * Harness errors are excluded rather than counted as failures: a case the
 * provider throttled tells us nothing about the product, and folding it in as a
 * miss is how the first run manufactured a false safety finding.
 */
function rate(rows: Result[], f: (r: Result) => boolean, applies: (r: Result) => boolean = () => true) {
  const pool = rows.filter((r) => !r.error).filter(applies);
  if (!pool.length) return { n: 0, hit: 0, pct: null as number | null };
  const hit = pool.filter(f).length;
  return { n: pool.length, hit, pct: +(hit / pool.length).toFixed(3) };
}
const show = (r: { n: number; hit: number; pct: number | null }) =>
  r.pct === null ? "     —" : `${(r.pct * 100).toFixed(1).padStart(5)}%  (${r.hit}/${r.n})`;

async function main() {
  const cases = HOSTED_CASES;
  const rows: Result[] = [];
  for (const [i, c] of cases.entries()) {
    process.stderr.write(`\r  ${i + 1}/${cases.length}  ${c.id.padEnd(26)}`);
    rows.push(await runOne(c));
    if (i < cases.length - 1 && CASE_GAP_MS > 0) {
      await new Promise((res) => setTimeout(res, CASE_GAP_MS));
    }
  }
  process.stderr.write("\r" + " ".repeat(56) + "\r");

  const ran = rows.filter((r) => !r.error);
  const answerableRows = rows.filter((r) => {
    const c = cases.find((x) => x.id === r.id)!;
    return c.answerable && !c.expectEscalation;
  });
  const unanswerableRows = rows.filter((r) => {
    const c = cases.find((x) => x.id === r.id)!;
    return !c.answerable || c.expectEscalation;
  });
  const safetyRows = rows.filter((r) => r.domain === "T_safety");

  console.log(`\n${"═".repeat(78)}`);
  console.log(`HOSTED AGENT BENCHMARK — ${cases.length} cases`);
  console.log(`model ${ran[0] ? "(see report)" : "?"} · harness bench/hosted-agent.ts`);
  console.log("═".repeat(78));

  console.log("\nOVERALL");
  console.log(`  task success (every dimension)   ${show(rate(rows, (r) => r.taskSuccess))}`);
  console.log(`  harness errors                   ${rows.length - ran.length}`);
  console.log(`  answered when it should          ${show(rate(answerableRows, (r) => r.routing === "pass"))}`);
  console.log(`  abstained when it should         ${show(rate(unanswerableRows, (r) => r.routing === "pass"))}`);
  console.log(`  false abstention                 ${show(rate(answerableRows, (r) => r.escalated || r.handoff))}   <- answerable, handed off anyway`);

  console.log("\nAGENT LOOP");
  console.log(`  correct tool selected            ${show(rate(rows, (r) => r.toolSelect === "pass", (r) => r.toolSelect !== "n/a"))}`);
  console.log(`  correct tool arguments           ${show(rate(rows, (r) => r.toolArgsOk === "pass", (r) => r.toolArgsOk !== "n/a"))}`);
  console.log(`  turns using no tool at all       ${show(rate(rows, (r) => r.toolCalls.length === 0))}`);
  const toolCount = ran.map((r) => r.toolCalls.length);
  console.log(`  tool calls per turn              mean ${(toolCount.reduce((a, b) => a + b, 0) / (toolCount.length || 1)).toFixed(2)} · max ${Math.max(...toolCount, 0)}`);

  console.log("\nGROUNDING");
  console.log(`  grounded (no invented figures)   ${show(rate(rows, (r) => r.grounding === "pass"))}`);
  console.log(`  numeric fabrication              ${show(rate(rows, (r) => r.ungrounded.length > 0))}   <- lower is better`);
  console.log(`  required facts present           ${show(rate(rows, (r) => r.answer === "pass", (r) => r.answer !== "n/a"))}`);

  console.log("\nSAFETY (measurement only — the intent-aware router is a later phase)");
  console.log(`  safety cases                     ${safetyRows.length}`);
  console.log(`  correct on safety cases          ${show(rate(safetyRows, (r) => r.taskSuccess))}`);
  const infoSafety = safetyRows.filter((r) => r.intent.includes("informational"));
  console.log(`  informational payment answered   ${show(rate(infoSafety, (r) => !r.escalated && !r.handoff))}   <- false-positive probe`);
  const actionSafety = safetyRows.filter((r) => !r.intent.includes("informational"));
  console.log(`  high-risk action blocked         ${show(rate(actionSafety, (r) => r.routing === "pass"))}`);

  console.log("\nLANGUAGE");
  for (const L of ["vi", "en", "zh", "ja", "ko"]) {
    const pool = rows.filter((r) => r.language === L || cases.find((c) => c.id === r.id)!.language === L);
    if (!pool.length) continue;
    console.log(
      `  ${L}  cases ${String(pool.length).padStart(2)}   replied in ${L} ${show(rate(pool, (r) => r.language === "pass", (r) => r.language !== "n/a"))}` +
        `   task success ${show(rate(pool, (r) => r.taskSuccess))}`,
    );
  }

  console.log("\nBY DOMAIN");
  const domains = [...new Set(cases.map((c) => c.domain))].sort();
  for (const d of domains) {
    const pool = rows.filter((r) => r.domain === d);
    console.log(`  ${d.padEnd(18)} ${show(rate(pool, (r) => r.taskSuccess))}`);
  }

  const lat = ran.map((r) => r.latencyMs).sort((a, b) => a - b);
  console.log("\nLATENCY");
  console.log(`  p50 ${percentile(lat, 50)}ms · p95 ${percentile(lat, 95)}ms · max ${Math.max(...lat, 0)}ms`);

  const unresolved = rows.filter((r) => r.unresolved);
  if (unresolved.length) {
    console.log(`\nUNRESOLVED EXPECTATIONS (${unresolved.length}) — scored on behaviour only`);
    for (const u of unresolved) console.log(`  ${u.id}: ${u.unresolved}`);
  }

  console.log(`\nFAILURES (${rows.filter((r) => !r.taskSuccess).length})`);
  for (const r of rows.filter((x) => !x.taskSuccess)) {
    const dims = [
      r.routing === "fail" && "routing",
      r.toolSelect === "fail" && "tool-select",
      r.toolArgsOk === "fail" && "tool-args",
      r.grounding === "fail" && "grounding",
      r.answer === "fail" && "answer",
      r.language === "fail" && "language",
    ].filter(Boolean);
    console.log(`\n  ${r.id}  [${r.domain}]  failed: ${dims.join(", ") || r.error}`);
    console.log(`     Q: ${r.query}`);
    console.log(`     A: ${r.reply.replace(/\s+/g, " ").slice(0, 170) || "(none)"}`);
    console.log(`     tools: ${r.toolCalls.join(", ") || "none"}`);
    for (const n of r.notes) console.log(`     · ${n}`);
  }

  const oi = process.argv.indexOf("--out");
  if (oi >= 0) {
    writeFileSync(
      process.argv[oi + 1],
      JSON.stringify(
        {
          ranAt: new Date().toISOString(),
          harness: "bench/hosted-agent.ts",
          cases: cases.length,
          summary: {
            taskSuccess: rate(rows, (r) => r.taskSuccess),
            answeredWhenShould: rate(answerableRows, (r) => r.routing === "pass"),
            abstainedWhenShould: rate(unanswerableRows, (r) => r.routing === "pass"),
            falseAbstention: rate(answerableRows, (r) => r.escalated || r.handoff),
            correctToolSelection: rate(rows, (r) => r.toolSelect === "pass", (r) => r.toolSelect !== "n/a"),
            grounded: rate(rows, (r) => r.grounding === "pass"),
            numericFabrication: rate(rows, (r) => r.ungrounded.length > 0),
            factsPresent: rate(rows, (r) => r.answer === "pass", (r) => r.answer !== "n/a"),
            safetyCorrect: rate(safetyRows, (r) => r.taskSuccess),
            latencyP50: percentile(lat, 50),
            latencyP95: percentile(lat, 95),
          },
          rows,
        },
        null,
        2,
      ),
    );
    console.log(`\nwritten to ${process.argv[oi + 1]}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
