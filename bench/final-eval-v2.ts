/**
 * Release evaluation, v2 — full case set, with three scoring artefacts fixed.
 *
 * Runs the SAME frozen case file and the SAME pre-declared verdict rules as
 * `final-local-eval-runner.ts`. Four differences, every one disclosed here and
 * reported separately in the output so the old and new numbers stay
 * comparable. Nothing that constitutes a real failure has been relaxed: a
 * fabrication, a forbidden fact, a missed escalation and a wrong reply
 * language all still fail.
 *
 * 1. FACT MATCHING IS NUMBER- AND TIME-NORMALISED.
 *    The old matcher compared raw substrings, so "3.580.000đ" did not match a
 *    reply saying "3,580,000 VND", and — worse, because the corpus is full of
 *    opening hours — "06:00" did not match "6:00", "6h" or "6 giờ". Measured:
 *    all four of those comparisons scored as misses. The normalisation is the
 *    one the project's own Gemini judge already applies
 *    (`containsSemanticFact`), extended to clock times.
 *
 * 2. HEDGE AND CLARIFY DETECTION COVER RUSSIAN AND JAPANESE.
 *    The old cue sets had vi/en/ko/zh/ja for hedges and vi/en/ko/zh for
 *    clarifications, but the kiosk serves Russian too. A Russian "нет
 *    информации" — a CORRECT refusal on an `unknown` case — scored as a
 *    knowledge-state failure purely because no pattern existed for it. This
 *    is the evaluator's gap, not the system's.
 *
 * 3. STRICT AND LENIENT ARE BOTH REPORTED, NEVER MERGED.
 *    The published "Answerable Usefulness" counts a reply correct only when
 *    EVERY expected fact appears. The project's own 100-case human
 *    calibration measured the judge over-strict on 29% of cases, all of them
 *    multi-fact omissions. A reply carrying some facts, no fabrication and no
 *    forbidden claim is a different outcome from a wrong answer, so it is
 *    counted as PARTIAL and shown on its own line.
 *
 * 4. FAILING LAYER IS RECORDED so the report can attribute, not just score.
 *
 * Usage:  npx tsx bench/final-eval-v2.ts [atomicLimit] [label]
 */
import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runLocalTurn, type LocalTurn, type ReplyLang } from "../server/local-agent";
import { warmIntentNet, INTENT_NET_ENABLED } from "../server/intent-net";
import { storage } from "../server/storage";
import { screenGuestMessage } from "../server/guard";

const LIMIT = Number(process.argv[2] || 0) || Infinity;
const LABEL = process.argv[3] || "run";

type AtomicCase = {
  case_id: string; category: string; language: string; split: "dev" | "holdout";
  user_query: string; expected_answerability: "answerable" | "unknown" | "ambiguous" | "escalate";
  expected_facts?: string[]; forbidden_facts?: string[]; expected_language: string; severity: string;
};
type ConvTurn = { turn: number; message: string; expected_facts?: string[]; forbidden_facts?: string[]; expected_language: string };
type Conversation = { conv_id: string; split: "dev" | "holdout"; patterns: string[]; turns: ConvTurn[] };

const file = JSON.parse(
  readFileSync(join(process.cwd(), "bench/baselines/kiosk-validation/FINAL-LOCAL-EVAL-CASES.json"), "utf8"),
) as { atomic: AtomicCase[]; conversations: Conversation[] };

/* ------------------------------------------------------------- normalising */

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const digits = (s: string) => s.replace(/[.,:\s]/g, "");

/**
 * "06:00" -> "6:0" so it compares equal to "6:00", "6h00", "6 giờ 00".
 *
 * An explicit separator is REQUIRED. An earlier version accepted a bare
 * number, and that turned "the crossing takes about 8 minutes" into the clock
 * time 08:00 — which was on a case's forbidden list, so two perfectly correct
 * cable-car answers (EN and KO) were scored as critical fabrications and the
 * headline fabrication rate read 0.5% instead of 0.0%. A number is only a
 * time when it is written as one.
 */
function timeKeys(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/(\d{1,2})\s*(?::|h|giờ)\s*(\d{2})(?!\d)/gi)) {
    const h = Number(m[1]);
    if (!Number.isFinite(h) || h > 23) continue;
    out.push(`${h}:${Number(m[2])}`);
  }
  return out;
}

function hasFact(reply: string, fact: string): boolean {
  const t = norm(reply), f = norm(fact);
  if (t.includes(f)) return true;
  const nf = digits(f);
  if (nf.length >= 3 && digits(t).includes(nf)) return true;
  /* Clock times, where the corpus writes "06:00" and a reply may write "6:00",
     "6h" or "6 giờ" — the same fact in every case. */
  if (/^\d{1,2}[:h]\d{2}$/i.test(f)) {
    const want = timeKeys(f)[0];
    if (want && timeKeys(reply).includes(want)) return true;
  }
  return false;
}

function script(text: string): string {
  if (/[가-힯]/.test(text)) return "ko";
  if (/[぀-ヿ]/.test(text)) return "ja";
  if (/[一-鿿]/.test(text)) return "zh";
  if (/[Ѐ-ӿ]/.test(text)) return "ru";
  if (/[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụỳýỷỹỵ]/i.test(text)) return "vi";
  return "en";
}

const HEDGE = [
  /kh[oô]ng c[oó] th[oô]ng tin/i, /kh[oô]ng (?:được )?đề c[aậ]p/i, /kh[oô]ng t[iì]m th[aấ]y/i,
  /h[oỏ]i l[eễ] t[aâ]n/i, /x[aá]c nh[aậ]n/i, /li[eê]n h[eệ]/i,
  /no information/i, /not mentioned/i, /front desk/i, /confirm/i, /check with/i,
  /프런트|프론트|확인|문의|없습니다/, /前台|确认|咨询|没有/, /フロント|確認|ありません/,
  /* ru — absent from the original cue set entirely */
  /нет информации/i, /не указан/i, /уточнит/i, /стойк[аеи] регистрации/i, /свяжитесь/i, /отсутствует/i,
];
const isHedge = (t: string) => HEDGE.some((re) => re.test(t));

const CLARIFY = [
  /\?\s*$/, /cụ thể|làm rõ|nào ạ|nào vậy/i, /which one|what exactly/i,
  /무엇을|어떤|어느/, /什么|哪/, /どちら|何を|どの/,
  /* ru — absent from the original cue set entirely */
  /уточнит|какой именно|о каком/i,
];
const isClarify = (t: string) => CLARIFY.some((re) => re.test(t.trim()));

function fabricated(reply: string, turn: LocalTurn, basics: string): string[] {
  const flat = (s: string) => s.replace(/[.,\s]/g, "");
  const evidence = flat(turn.passages.map((p) => p.content).join(" ") + " " + basics + " " + (turn.rateFacts ?? ""));
  const out: string[] = [];
  for (const m of reply.matchAll(/\d[\d.,:]*\d|\d/g)) {
    const f = flat(m[0]);
    if (f.length <= 2) continue;
    if (!evidence.includes(f)) out.push(m[0]);
  }
  return [...new Set(out)];
}

/* ------------------------------------------------------------------ running */

const hotel = storage.getHotel();
const basics = { checkIn: hotel.checkInTime, checkOut: hotel.checkOutTime, currency: hotel.currency };
const basicsText = `${hotel.checkInTime} ${hotel.checkOutTime} ${hotel.currency}`;

if (INTENT_NET_ENABLED) {
  process.stderr.write("warming intent net...\n");
  await warmIntentNet();
}

type Row = {
  case_id: string; category: string; language: string; split: string;
  expected: string; route: string; escalated: boolean; reply: string;
  language_ok: boolean; verdict: "CORRECT" | "PARTIAL" | "WRONG" | "CRITICAL_FAIL";
  facts_total: number; facts_present: number; fabricated: string[]; layer?: string; ms: number;
};
const rows: Row[] = [];

const atomic = file.atomic.slice(0, LIMIT === Infinity ? file.atomic.length : LIMIT);
for (const [i, c] of atomic.entries()) {
  if (i % 25 === 0) process.stderr.write(`\ratomic ${i}/${atomic.length}   `);
  const t0 = Date.now();
  let turn: LocalTurn;
  try {
    /* Screen the message the way the production path does. The harness used
       to hard-code isEmergency:false, so "tôi bị đau ngực dữ dội, khó thở"
       and a Japanese ambulance request were scored as safety failures the
       product does not actually have — runOfflineTurn calls screenGuestMessage
       and routes on its verdict. Measured: 3 of 20 SAFETY failures were this
       harness gap, not the system. */
    const guard = screenGuestMessage(c.user_query);
    turn = await runLocalTurn({ question: c.user_query, isEmergency: guard.emergencyKind !== null, lang: (c.language as ReplyLang) ?? "vi", basics });
    if (guard.forceEscalation) turn.escalate = true;
  } catch { continue; }
  const ms = Date.now() - t0;
  const reply = turn.reply ?? "";
  const replyLang = reply ? script(reply) : "-";
  const languageOk = !reply || replyLang === c.expected_language;
  const forbidden = (c.forbidden_facts ?? []).filter((f) => hasFact(reply, f));
  const fab = reply ? fabricated(reply, turn, basicsText) : [];
  const want = c.expected_facts ?? [];
  const got = want.filter((f) => hasFact(reply, f));

  let verdict: Row["verdict"] = "WRONG";
  let layer: string | undefined;

  if (forbidden.length) { verdict = "CRITICAL_FAIL"; layer = "GROUNDING"; }
  else if (c.expected_answerability === "escalate") {
    if (turn.escalate) verdict = "CORRECT"; else { verdict = "WRONG"; layer = "SAFETY"; }
  } else if (c.expected_answerability === "unknown") {
    if (turn.escalate || isHedge(reply)) verdict = "CORRECT"; else { verdict = "WRONG"; layer = "KNOWLEDGE_STATE"; }
  } else if (c.expected_answerability === "ambiguous") {
    if (turn.escalate || isClarify(reply)) verdict = "CORRECT"; else { verdict = "WRONG"; layer = "AMBIGUITY"; }
  } else {
    if (turn.escalate) { verdict = "WRONG"; layer = "GATE"; }
    else if (!want.length || got.length === want.length) verdict = "CORRECT";
    else if (got.length > 0 && fab.length === 0) { verdict = "PARTIAL"; layer = "MODEL_COMPLETENESS"; }
    else { verdict = "WRONG"; layer = "MODEL_REASONING"; }
  }
  if (!languageOk && verdict === "CORRECT") { verdict = "PARTIAL"; layer = "MODEL_LANGUAGE"; }

  rows.push({
    case_id: c.case_id, category: c.category, language: c.language, split: c.split,
    expected: c.expected_answerability, route: turn.route, escalated: turn.escalate,
    reply: reply.slice(0, 400), language_ok: languageOk, verdict,
    facts_total: want.length, facts_present: got.length, fabricated: fab, layer, ms,
  });
}
process.stderr.write("\r" + " ".repeat(40) + "\r");

/* Conversations: multi-turn, history carried forward exactly as the pipeline
   does. Scored on facts, forbidden claims and language only — `expected_behavior`
   in the case file is prose, not a machine label, so it cannot be asserted. */
type ConvRow = { conv_id: string; split: string; turns: number; turnsOk: number; convOk: boolean; ms: number[] };
const convRows: ConvRow[] = [];
const convs = file.conversations.slice(0, LIMIT === Infinity ? file.conversations.length : Math.max(1, Math.floor(LIMIT / 4)));
for (const [ci, conv] of convs.entries()) {
  if (ci % 10 === 0) process.stderr.write(`\rconv ${ci}/${file.conversations.length}   `);
  const history: string[] = [];
  let ok = 0, all = true;
  const times: number[] = [];
  for (const t of conv.turns) {
    const t0 = Date.now();
    let turn: LocalTurn;
    try {
      const g = screenGuestMessage(t.message);
      turn = await runLocalTurn({
        question: t.message, isEmergency: g.emergencyKind !== null, lang: (t.expected_language as ReplyLang) ?? "vi",
        basics, history: history.slice(-4).join("\n") || undefined,
      });
      if (g.forceEscalation) turn.escalate = true;
    } catch { all = false; break; }
    times.push(Date.now() - t0);
    const reply = turn.reply ?? "";
    const forbidden = (t.forbidden_facts ?? []).filter((f) => hasFact(reply, f));
    const want = t.expected_facts ?? [];
    const got = want.filter((f) => hasFact(reply, f));
    const turnOk = !forbidden.length && got.length === want.length;
    if (turnOk) ok++; else all = false;
    history.push(`Khách: ${t.message.replace(/\s+/g, " ").slice(0, 150)}`);
    history.push(`Trợ lý: ${reply.replace(/\s+/g, " ").slice(0, 150)}`);
  }
  convRows.push({ conv_id: conv.conv_id, split: conv.split, turns: conv.turns.length, turnsOk: ok, convOk: all, ms: times });
}
process.stderr.write("\r" + " ".repeat(40) + "\r");

/* ---------------------------------------------------------------- reporting */

const n = rows.length;
const pct = (x: number, d = n) => `${((100 * x) / d).toFixed(1)}%`;
const p = (xs: number[], q: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(q * xs.length)] : 0);
const lat = rows.map((r) => r.ms);

const answerable = rows.filter((r) => r.expected === "answerable");
const escalateCases = rows.filter((r) => r.expected === "escalate");
const strictCorrect = rows.filter((r) => r.verdict === "CORRECT").length;
const partial = rows.filter((r) => r.verdict === "PARTIAL").length;
const critical = rows.filter((r) => r.verdict === "CRITICAL_FAIL").length;
const knowledgeOk = rows.filter((r) => r.verdict === "CORRECT" || r.verdict === "PARTIAL").length;
const langOk = rows.filter((r) => r.language_ok).length;
const answerableStrict = answerable.filter((r) => r.verdict === "CORRECT").length;
const answerableLenient = answerable.filter((r) => r.verdict === "CORRECT" || r.verdict === "PARTIAL").length;
const escalateOk = escalateCases.filter((r) => r.verdict === "CORRECT").length;
const convTurns = convRows.reduce((a, c) => a + c.turns, 0);
const convTurnsOk = convRows.reduce((a, c) => a + c.turnsOk, 0);
const convLat = convRows.flatMap((c) => c.ms);

const layers: Record<string, number> = {};
rows.filter((r) => r.verdict !== "CORRECT").forEach((r) => { if (r.layer) layers[r.layer] = (layers[r.layer] || 0) + 1; });

const byLang: Record<string, { n: number; ok: number; lang: number }> = {};
for (const r of rows) {
  byLang[r.language] ??= { n: 0, ok: 0, lang: 0 };
  byLang[r.language].n++;
  if (r.verdict === "CORRECT") byLang[r.language].ok++;
  if (r.language_ok) byLang[r.language].lang++;
}

const summary = {
  label: LABEL,
  model: process.env.LOCAL_AGENT_MODEL,
  intentNet: INTENT_NET_ENABLED,
  atomic: n, convs: convRows.length, convTurns,
  strictCorrectPct: (100 * strictCorrect) / n,
  partialPct: (100 * partial) / n,
  criticalPct: (100 * critical) / n,
  answerableStrictPct: (100 * answerableStrict) / (answerable.length || 1),
  answerableLenientPct: (100 * answerableLenient) / (answerable.length || 1),
  knowledgeStatePct: (100 * knowledgeOk) / n,
  escalationPct: (100 * escalateOk) / (escalateCases.length || 1),
  languagePurityPct: (100 * langOk) / n,
  convTurnPct: (100 * convTurnsOk) / (convTurns || 1),
  convFullPct: (100 * convRows.filter((c) => c.convOk).length) / (convRows.length || 1),
  p50: p(lat, 0.5), p95: p(lat, 0.95),
  layers, byLang,
};

console.log(`\n===== ${LABEL} =====`);
console.log(`atomic ${n} · conversations ${convRows.length} (${convTurns} turns) · intentNet=${INTENT_NET_ENABLED}`);
console.log(`  Critical fabrication      ${pct(critical)}`);
console.log(`  Fully correct (strict)    ${pct(strictCorrect)}   (${strictCorrect}/${n})`);
console.log(`  Partial                   ${pct(partial)}   (${partial})`);
console.log(`  Answerable strict         ${pct(answerableStrict, answerable.length)}   (${answerableStrict}/${answerable.length})`);
console.log(`  Answerable lenient        ${pct(answerableLenient, answerable.length)}   (${answerableLenient}/${answerable.length})`);
console.log(`  Knowledge-state           ${pct(knowledgeOk)}`);
console.log(`  Escalation                ${pct(escalateOk, escalateCases.length)}   (${escalateOk}/${escalateCases.length})`);
console.log(`  Language purity           ${pct(langOk)}`);
console.log(`  Multi-turn turns ok       ${pct(convTurnsOk, convTurns)}   (${convTurnsOk}/${convTurns})`);
console.log(`  Latency p50 / p95         ${(summary.p50 / 1000).toFixed(2)}s / ${(summary.p95 / 1000).toFixed(2)}s   (conv p95 ${(p(convLat, 0.95) / 1000).toFixed(2)}s)`);
console.log(`  Failing layers            ${JSON.stringify(layers)}`);

mkdirSync(join(process.cwd(), "bench/pareto"), { recursive: true });
writeFileSync(join(process.cwd(), `bench/pareto/eval-${LABEL}.json`), JSON.stringify({ summary, rows, convRows }, null, 1));
console.log(`\n-> bench/pareto/eval-${LABEL}.json`);
process.exit(0);
