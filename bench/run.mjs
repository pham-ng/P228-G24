#!/usr/bin/env node
/**
 * Aurea agent benchmark.
 *
 * Runs every case in cases.json against the live server: the real agent, the
 * real SQLite database, the real rate calendar. Scoring is deliberately in two
 * halves, because the two halves catch different failures:
 *
 *   Deterministic  — which tools were called, which validation codes came back,
 *                    what the reply must and must not contain, and the state of
 *                    the database afterwards (a τ-bench style end-state diff:
 *                    an agent that talks well but writes a bad row still fails).
 *   Judge          — grounding, handling, asking for what was missing, no
 *                    overpromising, tone. Graded by the model through
 *                    /api/bench/judge, which is where the API key lives.
 *
 * A case passes only when both halves pass.
 *
 * Usage: node bench/run.mjs [--base http://localhost:5000] [--only D1,G3] [--no-judge]
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const BASE = arg("base", "http://localhost:5000");
const ONLY = (arg("only", "") || "").split(",").filter(Boolean);
const NO_JUDGE = argv.includes("--no-judge");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GAP_MS = Number(arg("gap", "6000"));

/** Retry on rate limits and gateway hiccups so a 429 never scores as a failure. */
async function api(path, init = {}, attempt = 1) {
  try {
    return await apiOnce(path, init);
  } catch (e) {
    const msg = String(e.message ?? e);
    const retryable = /429|rate limit|502|503|504|ETIMEDOUT|ECONNRESET/i.test(msg);
    if (!retryable || attempt >= 4) throw e;
    const backoff = 15000 * attempt;
    console.log(`\n  … ${msg.slice(0, 80)} — retrying in ${backoff / 1000}s`);
    await sleep(backoff);
    return api(path, init, attempt + 1);
  }
}

async function apiOnce(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return body;
}

/* ------------------------------------------------------------------ *
 * Date templating — cases are written relative to the hotel's clock
 * ------------------------------------------------------------------ */

function shiftIso(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function fillDates(value, hotelDate) {
  if (typeof value !== "string") return value;
  return value.replace(/\{\{([+-]\d+)(?::([a-z/]+))?\}\}/g, (_m, off, fmt) => {
    const iso = shiftIso(hotelDate, Number(off));
    const [y, m, d] = iso.split("-");
    if (fmt === "d/m") return `${Number(d)}/${Number(m)}`;
    if (fmt === "dd/mm") return `${d}/${m}`;
    if (fmt === "d") return String(Number(d));
    return iso;
  });
}

/* ------------------------------------------------------------------ *
 * Database snapshots — the end-state half of the score
 * ------------------------------------------------------------------ */

async function snapshot() {
  const rows = await api("/api/reservations");
  const list = Array.isArray(rows) ? rows : (rows.reservations ?? []);
  const byCode = {};
  for (const raw of list) {
    const r = raw.reservation ?? raw;
    byCode[r.confirmationCode] = { checkIn: r.checkIn, checkOut: r.checkOut, status: r.status };
  }
  return { count: list.length, byCode };
}

/* ------------------------------------------------------------------ *
 * Running one case
 * ------------------------------------------------------------------ */

async function openChannel(kase) {
  if (kase.channel === "enquiry") {
    const r = await api("/api/guest/enquiry", {
      method: "POST",
      // No name on purpose: a prospect channel starts anonymous, and the agent
      // must obtain the real name from the guest before it can book.
      body: JSON.stringify({ lang: kase.lang ?? "vi" }),
    });
    return r.conversationId;
  }
  const code = kase.channel.split(":")[1];
  const r = await api("/api/guest/session", { method: "POST", body: JSON.stringify({ code }) });
  return r.conversationId;
}

function collectTools(messages, afterId) {
  const tools = [];
  const traces = [];
  for (const m of messages) {
    if (m.id <= afterId || m.role !== "ai" || !m.toolTrace) continue;
    let parsed;
    try {
      parsed = typeof m.toolTrace === "string" ? JSON.parse(m.toolTrace) : m.toolTrace;
    } catch {
      continue;
    }
    for (const t of parsed) {
      tools.push(t.name);
      traces.push(t);
    }
  }
  return { tools, traces };
}

async function runCase(kase, hotelDate) {
  const before = await snapshot();
  const conversationId = await openChannel(kase);
  // The seed places stays relative to today, so an expectation must be written
  // relative to the reservation as it stands right now, never as a fixed date.
  const beforeSnap = await snapshot();
  const linkedCode = kase.channel.startsWith("reservation:") ? kase.channel.split(":")[1] : null;
  const linked = linkedCode ? beforeSnap.byCode[linkedCode] : null;
  const fillStay = (v) => {
    if (typeof v !== "string" || !linked) return v;
    return v.replace(/\{\{(arrive|depart)([+-]\d+)?(?::([a-z/]+))?\}\}/g, (_m, which, off, fmt) => {
      const base = which === "arrive" ? linked.checkIn : linked.checkOut;
      const iso = shiftIso(base, Number(off ?? 0));
      const [y, m, d] = iso.split("-");
      if (fmt === "d/m") return `${Number(d)}/${Number(m)}`;
      if (fmt === "dd/mm/yyyy") return `${d}/${m}/${y}`;
      if (fmt === "d") return String(Number(d));
      return iso;
    });
  };
  // A previous case may have handed this conversation to a human; the agent only
  // answers in AI mode, so every case starts from the same footing.
  await api(`/api/conversations/${conversationId}/mode`, {
    method: "POST",
    body: JSON.stringify({ mode: "ai" }),
  });
  const pre = await api(`/api/conversations/${conversationId}`);
  const baselineId = pre.messages.length ? Math.max(...pre.messages.map((m) => m.id)) : 0;

  const replies = [];
  for (const rawTurn of kase.turns) {
    const body = fillStay(fillDates(rawTurn, hotelDate));
    await api(`/api/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({ body, from: "guest" }),
    });
    await sleep(1200);
    const detail = await api(`/api/conversations/${conversationId}`);
    const ai = [...detail.messages].reverse().find((m) => m.role === "ai");
    replies.push({ guest: body, ai: ai?.body ?? "" });
  }

  const detail = await api(`/api/conversations/${conversationId}`);
  const { tools, traces } = collectTools(detail.messages, baselineId);
  const after = await snapshot();
  const finalReply = replies[replies.length - 1]?.ai ?? "";
  const allReplies = replies.map((r) => r.ai).join("\n");

  /* ---------- deterministic assertions ---------- */
  const checks = [];
  const add = (name, ok, detailText) => checks.push({ name, ok, detail: detailText });

  if (kase.expect_tools_any?.length) {
    const hit = kase.expect_tools_any.filter((t) => tools.includes(t));
    add(
      `calls one of ${kase.expect_tools_any.join(" / ")}`,
      hit.length > 0,
      tools.length ? `called: ${tools.join(", ")}` : "no tools called",
    );
  }

  for (const t of kase.expect_tools ?? [])
    add(`calls ${t}`, tools.includes(t), tools.length ? `called: ${tools.join(", ")}` : "no tools called");

  // A write tool the agent may probe but must never succeed at: the end state
  // is what matters, exactly as in tau-bench.
  for (const t of kase.forbid_tool_success ?? []) {
    const succeeded = traces.some(
      (tr) => tr.name === t && tr.result && (tr.result.created === true || tr.result.changed === true),
    );
    add(`${t} never succeeds`, !succeeded, succeeded ? "it went through" : "");
  }

  for (const t of kase.forbid_tools ?? [])
    add(`never calls ${t}`, !tools.includes(t), tools.includes(t) ? "it was called" : "");

  if (kase.expect_codes?.length) {
    const blob = JSON.stringify(traces);
    const hit = kase.expect_codes.filter((c) => blob.includes(c));
    add(
      `validation raises ${kase.expect_codes.join(" or ")}`,
      hit.length > 0,
      hit.length ? `raised ${hit.join(", ")}` : "no expected code in the tool output",
    );
  }

  for (const group of kase.expect_contains_any ?? []) {
    const alts = group.map((g) => fillStay(fillDates(g, hotelDate)));
    const ok = alts.some((a) => allReplies.toLowerCase().includes(a.toLowerCase()));
    add(`reply mentions ${alts.join(" | ")}`, ok, ok ? "" : "not found in the reply");
  }

  for (const bad of kase.forbid_contains ?? []) {
    const needle = fillStay(fillDates(bad, hotelDate)).toLowerCase();
    // "0 VND" must not fire inside "2,200,000 VND": a forbidden string that
    // starts with a digit only counts when no digit or separator precedes it.
    const hay = allReplies.toLowerCase();
    const ok = /^[\d]/.test(needle)
      ? !new RegExp(`(^|[^\\d.,])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(hay)
      : !hay.includes(needle);
    add(`reply avoids "${bad}"`, ok, ok ? "" : "it appeared in the reply");
  }

  if (kase.expect_question) {
    // Either a literal question, or an unmistakable request for the guest to
    // supply or confirm something — both are "handing the next step back".
    const asks =
      /[?？]/.test(finalReply) ||
      /(xác nhận|cho tôi biết|cho mình biết|anh\/chị cho|bạn cho|vui lòng cho|gửi (cho )?(tôi|em|mình)?\s*(họ tên|tên|số)|cung cấp|confirm|let me know|please provide|could you|send me)/i.test(
        finalReply,
      );
    add("asks the guest a question", asks, finalReply.slice(-120));
  }

  const exp = kase.expect_db ?? {};
  if (typeof exp.reservations_created === "number") {
    const created = after.count - before.count;
    add(
      `database gains ${exp.reservations_created} reservation(s)`,
      created === exp.reservations_created,
      `actual: ${created}`,
    );
  }
  if (exp.reservation_dates) {
    const want = {
      ...exp.reservation_dates,
      check_in: fillStay(exp.reservation_dates.check_in),
      check_out: fillStay(exp.reservation_dates.check_out),
    };
    const got = after.byCode[want.code];
    const okIn = !want.check_in || got?.checkIn === want.check_in;
    const okOut = !want.check_out || got?.checkOut === want.check_out;
    add(
      `${want.code} ends as ${want.check_in ?? got?.checkIn} → ${want.check_out ?? "?"}`,
      Boolean(got) && okIn && okOut,
      got ? `actual: ${got.checkIn} → ${got.checkOut}` : "reservation not found",
    );
  }

  const deterministicPass = checks.every((c) => c.ok);

  /* ---------- judge ---------- */
  // A single LLM verdict is noisy: the same reply can be graded pass and fail on
  // two runs. Three independent verdicts, majority wins — the way human rubric
  // grading is normally reconciled.
  let judge = null;
  let judgePanel = [];
  if (!NO_JUDGE) {
    await sleep(2000);
    const transcript = replies.map((r) => `GUEST: ${r.guest}\nAGENT: ${r.ai}`).join("\n\n");
    for (let i = 0; i < 3; i++) {
      try {
        const v = await api("/api/bench/judge", {
          method: "POST",
          body: JSON.stringify({
            transcript,
            expectation: fillDates(kase.expectation, hotelDate),
            tool_output: JSON.stringify(traces).slice(0, 18000),
          }),
        });
        judgePanel.push(v);
      } catch (e) {
        judgePanel.push({ verdict: "error", reason: String(e.message ?? e) });
      }
      if (i < 2) await sleep(1500);
    }
    const passes = judgePanel.filter((v) => v?.verdict === "pass").length;
    const majority = passes >= 2 ? "pass" : "fail";
    judge = {
      ...(judgePanel.find((v) => v?.verdict === majority) ?? judgePanel[0]),
      verdict: majority,
      votes: `${passes}/3 pass`,
      panel: judgePanel.map((v) => ({ verdict: v?.verdict, reason: v?.reason, scores: v?.scores })),
    };
  }

  return {
    id: kase.id,
    title: kase.title,
    category: kase.category,
    channel: kase.channel,
    conversationId,
    turns: replies,
    tools,
    checks,
    deterministicPass,
    judge,
    pass: deterministicPass && (NO_JUDGE || judge?.verdict === "pass"),
  };
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

function markdown(report) {
  const l = [];
  l.push(`# Aurea agent benchmark`);
  l.push("");
  l.push(`Run at ${report.ranAt} — hotel date ${report.hotelDate} (${report.timezone}).`);
  l.push("");
  l.push(
    `**${report.passed}/${report.total} cases passed** · deterministic ${report.deterministicPassed}/${report.total} · judge ${report.judgePassed}/${report.total}`,
  );
  l.push("");
  l.push(`| Category | Passed |`);
  l.push(`| --- | --- |`);
  for (const [cat, v] of Object.entries(report.byCategory)) l.push(`| ${cat} | ${v.passed}/${v.total} |`);
  l.push("");
  l.push(`| # | Case | Tools called | Deterministic | Judge | Result |`);
  l.push(`| --- | --- | --- | --- | --- | --- |`);
  for (const r of report.results) {
    const failed = r.checks.filter((c) => !c.ok).map((c) => c.name);
    l.push(
      `| ${r.id} | ${r.title} | ${[...new Set(r.tools)].join(", ") || "—"} | ${
        r.deterministicPass ? "pass" : "fail: " + failed.join("; ")
      } | ${r.judge?.verdict ?? "skipped"} | ${r.pass ? "✅" : "❌"} |`,
    );
  }
  l.push("");
  for (const r of report.results) {
    l.push(`## ${r.id} — ${r.title}`);
    l.push("");
    l.push(`Category: ${r.category} · channel: ${r.channel} · tools: ${[...new Set(r.tools)].join(", ") || "none"}`);
    l.push("");
    for (const t of r.turns) {
      l.push(`> **Guest:** ${t.guest}`);
      l.push(`>`);
      l.push(`> **Agent:** ${t.ai.replace(/\n/g, " ")}`);
      l.push("");
    }
    for (const c of r.checks) l.push(`- ${c.ok ? "✅" : "❌"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
    if (r.judge)
      l.push(
        `- ${r.judge.verdict === "pass" ? "✅" : "❌"} judge: ${r.judge.verdict} (${r.judge.votes ?? "1 vote"}) — ${r.judge.reason ?? ""} ${
          r.judge.grounded !== undefined
            ? `(grounded ${r.judge.grounded}, handling ${r.judge.correct_handling}, asked ${r.judge.asked_for_missing}, no-overpromise ${r.judge.no_overpromise}, tone ${r.judge.tone})`
            : ""
        }`,
      );
    l.push("");
  }
  return l.join("\n");
}

/* ------------------------------------------------------------------ */

const suite = JSON.parse(readFileSync(join(HERE, "cases.json"), "utf8"));
const clock = await api("/api/booking/resolve-date", {
  method: "POST",
  body: JSON.stringify({ expression: "today" }),
});
const hotelDate = clock.hotel_date;

const cases = suite.cases.filter((c) => !ONLY.length || ONLY.includes(c.id));
console.log(`Running ${cases.length} case(s) against ${BASE} — hotel date ${hotelDate}\n`);

const results = [];
for (const kase of cases) {
  if (results.length) await sleep(GAP_MS);
  process.stdout.write(`${kase.id} ${kase.title} … `);
  try {
    const r = await runCase(kase, hotelDate);
    results.push(r);
    const failed = r.checks.filter((c) => !c.ok).map((c) => c.name);
    console.log(
      r.pass
        ? "pass"
        : `FAIL${failed.length ? ` [${failed.join("; ")}]` : ""}${
            r.judge && r.judge.verdict !== "pass" ? ` [judge: ${r.judge.reason ?? r.judge.verdict}]` : ""
          }`,
    );
  } catch (e) {
    console.log(`ERROR ${e.message}`);
    results.push({
      id: kase.id,
      title: kase.title,
      category: kase.category,
      channel: kase.channel,
      turns: [],
      tools: [],
      checks: [{ name: "case ran", ok: false, detail: String(e.message ?? e) }],
      deterministicPass: false,
      judge: null,
      pass: false,
    });
  }
}

const byCategory = {};
for (const r of results) {
  byCategory[r.category] ??= { passed: 0, total: 0 };
  byCategory[r.category].total++;
  if (r.pass) byCategory[r.category].passed++;
}

const report = {
  ranAt: new Date().toISOString(),
  hotelDate,
  timezone: clock.hotel_timezone,
  base: BASE,
  total: results.length,
  passed: results.filter((r) => r.pass).length,
  deterministicPassed: results.filter((r) => r.deterministicPass).length,
  judgePassed: results.filter((r) => r.judge?.verdict === "pass").length,
  byCategory,
  results,
};

mkdirSync(HERE, { recursive: true });
writeFileSync(join(HERE, "report.json"), JSON.stringify(report, null, 2));
writeFileSync(join(HERE, "report.md"), markdown(report));

console.log(
  `\n${report.passed}/${report.total} passed · deterministic ${report.deterministicPassed}/${report.total} · judge ${report.judgePassed}/${report.total}`,
);
console.log(`Report written to bench/report.json and bench/report.md`);
process.exit(report.passed === report.total ? 0 : 1);
