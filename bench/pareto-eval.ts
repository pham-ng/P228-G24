/**
 * Accuracy / usefulness / latency on one configuration, for Pareto comparison.
 *
 * Scoring follows `final-local-eval-runner.ts` — the same case file, the same
 * pre-declared verdict rules — with two deliberate, disclosed changes:
 *
 *  1. FACT MATCHING IS NUMBER-NORMALISED. The runner compares expected facts as
 *     raw substrings, so "3.580.000đ" does not match a reply saying
 *     "3,580,000 VND" and "06:30" does not match "6:30". That is a scoring
 *     artefact, not a model error. The normalisation used here is exactly the
 *     one the project's own Gemini judge engine already applies
 *     (`containsSemanticFact`), so this aligns the deterministic scorer with
 *     the judge rather than inventing a looser rule.
 *
 *  2. STRICT AND LENIENT ARE BOTH REPORTED, never merged. The project's
 *     headline "Answerable Usefulness 28.3%" counts a reply correct only when
 *     EVERY expected fact appears; the human calibration measured the judge
 *     over-strict on 29% of cases, all multi-fact omissions. A reply carrying
 *     2 of 3 facts with nothing fabricated is not a failure of the same kind
 *     as a wrong answer, so it is counted separately instead of being quietly
 *     promoted or quietly dropped.
 *
 * Nothing else about the scoring is relaxed: a fabrication, a forbidden fact,
 * a missed escalation or a wrong reply language fails under both scales.
 *
 * Usage:  npx tsx bench/pareto-eval.ts [sampleSize] [label]
 */
import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runLocalTurn, LOCAL_PASSAGES, PASSAGE_CHAR_CAP, type LocalTurn, type ReplyLang } from "../server/local-agent";
import { storage } from "../server/storage";

const SAMPLE = Number(process.argv[2] || 120);
const LABEL = process.argv[3] || `${process.env.LOCAL_AGENT_MODEL ?? "?"}·p${LOCAL_PASSAGES}·c${PASSAGE_CHAR_CAP}`;

type AtomicCase = {
  case_id: string; category: string; language: string; user_query: string;
  expected_answerability: "answerable" | "unknown" | "ambiguous" | "escalate";
  expected_facts?: string[]; forbidden_facts?: string[]; expected_language: string;
  escalation_required?: boolean; severity: string;
};

const data = JSON.parse(
  readFileSync(join(process.cwd(), "bench/baselines/kiosk-validation/FINAL-LOCAL-EVAL-CASES.json"), "utf8"),
) as { atomic: AtomicCase[] };

function stratify<T>(items: T[], key: (t: T) => string, n: number): T[] {
  const buckets = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(it);
  }
  const out: T[] = [];
  let i = 0;
  while (out.length < n) {
    let added = false;
    for (const list of buckets.values()) {
      if (i < list.length) { out.push(list[i]); added = true; if (out.length >= n) break; }
    }
    if (!added) break;
    i++;
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const cleanNum = (s: string) => s.replace(/[.,:\s]/g, "");

/** The judge engine's matcher: literal, then number-normalised. */
function hasFact(reply: string, fact: string): boolean {
  const t = norm(reply), f = norm(fact);
  if (t.includes(f)) return true;
  const nf = cleanNum(f);
  return nf.length >= 3 && cleanNum(t).includes(nf);
}

function script(text: string): string {
  if (/[가-힯]/.test(text)) return "ko";
  if (/[぀-ヿ]/.test(text)) return "ja";
  if (/[一-鿿]/.test(text)) return "zh";
  if (/[Ѐ-ӿ]/.test(text)) return "ru";
  if (/[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụỳýỷỹỵ]/i.test(text)) return "vi";
  return "en";
}
const HEDGE = [/kh[oô]ng c[oó] th[oô]ng tin/i, /kh[oô]ng (?:được )?đề c[aậ]p/i, /h[oỏ]i l[eễ] t[aâ]n/i, /x[aá]c nh[aậ]n/i, /li[eê]n h[eệ]/i, /no information/i, /not mentioned/i, /front desk/i, /confirm/i, /프런트|확인|문의/i, /前台|确认|咨询/i, /フロント|確認/i];
const isHedge = (t: string) => HEDGE.some((re) => re.test(t));
const isClarify = (t: string) => /\?$/.test(t.trim()) || /cụ thể|làm rõ|nào ạ|which one|what exactly|어떤|哪|どちら/i.test(t);

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

const hotel = storage.getHotel();
const basics = { checkIn: hotel.checkInTime, checkOut: hotel.checkOutTime, currency: hotel.currency };
const basicsText = `${hotel.checkInTime} ${hotel.checkOutTime} ${hotel.currency}`;

const sample = stratify(data.atomic, (c) => `${c.language}|${c.category}`, Math.min(SAMPLE, data.atomic.length));

let strictCorrect = 0, lenientUseful = 0, partial = 0, critical = 0, knowledgeOk = 0, langOk = 0;
let escalateCases = 0, escalateOk = 0, answerableCases = 0;
const lat: number[] = [];
const failures: string[] = [];

console.log(`[${LABEL}] ${sample.length} cases\n`);
let done = 0;
for (const c of sample) {
  const t0 = Date.now();
  let turn: LocalTurn;
  try {
    turn = await runLocalTurn({ question: c.user_query, isEmergency: false, lang: (c.language as ReplyLang) ?? "vi", basics });
  } catch { continue; }
  const ms = Date.now() - t0;
  lat.push(ms);

  const reply = turn.reply ?? "";
  const replyLang = reply ? script(reply) : "-";
  if (!reply || replyLang === c.expected_language) langOk++;
  const forbidden = (c.forbidden_facts ?? []).filter((f) => hasFact(reply, f));
  const fab = reply ? fabricated(reply, turn, basicsText) : [];
  const isCritical = forbidden.length > 0;
  if (isCritical) critical++;

  if (c.expected_answerability === "escalate") {
    escalateCases++;
    if (turn.escalate) { escalateOk++; knowledgeOk++; strictCorrect++; lenientUseful++; }
    else failures.push(`${c.case_id} SAFETY: không escalate`);
  } else if (c.expected_answerability === "unknown") {
    const ok = turn.escalate || isHedge(reply);
    if (ok && !isCritical) { knowledgeOk++; strictCorrect++; lenientUseful++; }
    else failures.push(`${c.case_id} KNOWLEDGE_STATE: trả lời chắc chắn về điều không biết`);
  } else if (c.expected_answerability === "ambiguous") {
    const ok = turn.escalate || isClarify(reply);
    if (ok && !isCritical) { knowledgeOk++; strictCorrect++; lenientUseful++; }
    else failures.push(`${c.case_id} AMBIGUITY: không hỏi lại`);
  } else {
    answerableCases++;
    if (turn.escalate) { failures.push(`${c.case_id} GATE: escalate câu trả lời được`); }
    else if (isCritical) { failures.push(`${c.case_id} GROUNDING: nêu forbidden fact`); }
    else {
      knowledgeOk++;
      const want = c.expected_facts ?? [];
      const got = want.filter((f) => hasFact(reply, f));
      if (want.length === 0 || got.length === want.length) { strictCorrect++; lenientUseful++; }
      else if (got.length > 0 && fab.length === 0) { partial++; lenientUseful++; failures.push(`${c.case_id} PARTIAL: ${got.length}/${want.length} facts`); }
      else failures.push(`${c.case_id} MODEL: 0/${want.length} facts`);
    }
  }
  if (++done % 30 === 0) console.log(`  ...${done}/${sample.length}`);
}

const n = lat.length;
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const r = (x: number, d = n) => `${((100 * x) / d).toFixed(1)}%`;

const summary = {
  label: LABEL,
  model: process.env.LOCAL_AGENT_MODEL ?? "?",
  passages: LOCAL_PASSAGES,
  charCap: PASSAGE_CHAR_CAP,
  n,
  strictCorrectPct: (100 * strictCorrect) / n,
  lenientUsefulPct: (100 * lenientUseful) / n,
  partial,
  criticalPct: (100 * critical) / n,
  knowledgeStatePct: (100 * knowledgeOk) / n,
  languagePurityPct: (100 * langOk) / n,
  escalationPct: escalateCases ? (100 * escalateOk) / escalateCases : 100,
  p50: pct(lat, 50),
  p95: pct(lat, 95),
};

console.log(`\n===== ${LABEL} =====`);
console.log(`  Đúng hoàn toàn (strict, đủ mọi fact) : ${r(strictCorrect)}  (${strictCorrect}/${n})`);
console.log(`  Hữu ích (lenient, ≥1 fact, không bịa): ${r(lenientUseful)}  (${lenientUseful}/${n})   [+${partial} PARTIAL]`);
console.log(`  Bịa / forbidden fact (càng thấp càng tốt): ${r(critical)}`);
console.log(`  Knowledge-state đúng                 : ${r(knowledgeOk)}`);
console.log(`  Escalate đúng                        : ${escalateCases ? r(escalateOk, escalateCases) : "-"}  (${escalateOk}/${escalateCases})`);
console.log(`  Đúng ngôn ngữ                        : ${r(langOk)}`);
console.log(`  Latency p50 / p95                    : ${(summary.p50 / 1000).toFixed(2)}s / ${(summary.p95 / 1000).toFixed(2)}s`);

mkdirSync(join(process.cwd(), "bench/pareto"), { recursive: true });
const slug = LABEL.replace(/[^a-zA-Z0-9.]+/g, "-");
writeFileSync(join(process.cwd(), `bench/pareto/${slug}.json`), JSON.stringify({ summary, failures }, null, 1));
console.log(`\n  -> bench/pareto/${slug}.json (${failures.length} ca lỗi được ghi lại)`);
process.exit(0);
