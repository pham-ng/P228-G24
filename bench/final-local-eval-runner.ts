import "dotenv/config";
import { writeFileSync, readFileSync } from "node:fs";
import { runLocalTurn, type LocalTurn, type ReplyLang } from "../server/local-agent";
import { storage } from "../server/storage";

/**
 * FINAL-LOCAL-PRODUCT-EVALUATION runner. Evaluation only — this script must
 * not be edited to change scoring after seeing results (see the manifest's
 * anti-gaming section). It executes the frozen case set exactly as written
 * and applies deterministic, pre-declared scoring rules.
 *
 *   LLM_MODE=local npx tsx bench/final-local-eval-runner.ts
 */

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");
function containsAny(text: string, needles: string[]): string[] {
  const t = norm(text);
  return needles.filter((n) => t.includes(norm(n)));
}
function script(text: string): string {
  if (/[가-힯]/.test(text)) return "ko";
  if (/[぀-ヿ]/.test(text)) return "ja";
  if (/[一-鿿]/.test(text)) return "zh";
  if (/[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụỳýỷỹỵ]/i.test(text)) return "vi";
  return "en";
}
/* Same abstention/hedge-language cue set the production isAbstention() uses,
   duplicated here (not imported) so this evaluator's scoring logic does not
   depend on the exact strings the system under test uses — importing it
   would let a change to that list silently change what counts as a correct
   abstention here too. */
const HEDGE_CUES = [
  /kh[oô]ng c[oó] th[oô]ng tin/i, /kh[oô]ng (?:được )?(?:đề|de) c[aậ]p/i, /ch[uư]a (?:được )?(?:đề|de) c[aậ]p/i,
  /kh[oô]ng t[iì]m th[aấ]y/i, /h[oỏ]i l[eễ] t[aâ]n/i, /x[aá]c nh[aậ]n/i, /li[eê]n h[eệ]/i,
  /no information/i, /not mentioned/i, /ask (?:the )?front desk/i, /confirm/i, /check with/i,
  /front desk/i, /프런트|프론트|확인|문의/i, /前台|确认|咨询/i, /フロント|確認/i,
];
function looksLikeHedge(text: string): boolean {
  return HEDGE_CUES.some((re) => re.test(text));
}
function looksLikeClarifyingQuestion(text: string): boolean {
  return /\?$/.test(text.trim()) || /cụ thể|làm rõ|nào ạ|nào vậy|which one|what exactly|무엇을|어떤|什么|哪|どちら|何を/i.test(text);
}
function fabricatedNumbers(reply: string, turn: LocalTurn, basics: string): string[] {
  const flat = (s: string) => s.replace(/[.,\s]/g, "");
  const evidence = flat(turn.passages.map((p) => p.content).join(" ") + " " + basics);
  const out: string[] = [];
  for (const m of reply.matchAll(/\d[\d.,:]*\d|\d/g)) {
    const f = flat(m[0]);
    if (f.length <= 2) continue;
    if (!evidence.includes(f)) out.push(m[0]);
  }
  return [...new Set(out)];
}

type AtomicCase = {
  case_id: string; category: string; language: string; split: "dev" | "holdout";
  user_query: string; expected_answerability: "answerable" | "unknown" | "ambiguous" | "escalate";
  expected_facts?: string[]; forbidden_facts?: string[]; expected_language: string;
  escalation_required?: boolean; severity: string; note?: string;
};
type ConvTurn = { turn: number; message: string; expected_behavior: string; expected_facts?: string[]; forbidden_facts?: string[]; expected_language: string };
type Conversation = { conv_id: string; split: "dev" | "holdout"; patterns: string[]; turns: ConvTurn[] };

type AtomicResult = {
  case_id: string; category: string; language: string; split: string; severity: string;
  user_query: string; expected_answerability: string; route: string; escalated: boolean;
  reply: string; reply_lang: string; language_ok: boolean;
  facts_present: string[]; facts_missing: string[]; forbidden_present: string[];
  fabricated_numbers: string[]; verdict: "CORRECT" | "PARTIAL" | "WRONG" | "CRITICAL_FAIL";
  knowledge_state_correct: boolean; ms: number; failing_layer?: string;
};

const KNOWN_LAYERS = ["DATA","RETRIEVAL","RANKING","GATE","ROUTING","PROMPT","MODEL_REASONING","MODEL_LANGUAGE","GROUNDING","KNOWLEDGE_STATE","MULTI_TURN","TOOL","SAFETY","LATENCY","BENCHMARK_ERROR"];

function scoreAtomic(c: AtomicCase, turn: LocalTurn, ms: number, basicsText: string): AtomicResult {
  const reply = turn.reply ?? "";
  const replyLang = reply ? script(reply) : "-";
  const languageOk = !reply || replyLang === c.expected_language;
  const forbidden = c.forbidden_facts ?? [];
  const forbiddenPresent = reply ? containsAny(reply, forbidden) : [];
  const fabricated = reply ? fabricatedNumbers(reply, turn, basicsText) : [];

  let knowledgeStateCorrect = false;
  let verdict: AtomicResult["verdict"] = "WRONG";
  let factsPresent: string[] = [];
  let factsMissing: string[] = [...(c.expected_facts ?? [])];
  let failingLayer: string | undefined;

  const wasEscalated = turn.escalate;

  if (c.expected_answerability === "escalate") {
    knowledgeStateCorrect = wasEscalated;
    verdict = wasEscalated ? "CORRECT" : "WRONG";
    if (!wasEscalated) failingLayer = "SAFETY";
  } else if (c.expected_answerability === "unknown") {
    // Correct: escalated, OR answered with hedge language and no forbidden claim.
    const hedged = !wasEscalated && looksLikeHedge(reply);
    knowledgeStateCorrect = wasEscalated || hedged;
    if (forbiddenPresent.length) {
      verdict = "CRITICAL_FAIL";
      failingLayer = "GROUNDING";
    } else if (knowledgeStateCorrect) {
      verdict = "CORRECT";
    } else {
      verdict = "WRONG"; // answered confidently without hedge language and without a caught forbidden fact — still a knowledge-state miss
      failingLayer = "KNOWLEDGE_STATE";
    }
  } else if (c.expected_answerability === "ambiguous") {
    const clarified = !wasEscalated && looksLikeClarifyingQuestion(reply);
    knowledgeStateCorrect = wasEscalated || clarified;
    if (forbiddenPresent.length) {
      verdict = "CRITICAL_FAIL";
      failingLayer = "GROUNDING";
    } else if (knowledgeStateCorrect) {
      verdict = "CORRECT";
    } else {
      verdict = "WRONG";
      failingLayer = "KNOWLEDGE_STATE";
    }
  } else {
    // answerable
    knowledgeStateCorrect = !wasEscalated;
    if (wasEscalated) {
      verdict = "WRONG";
      failingLayer = "GATE";
    } else if (forbiddenPresent.length) {
      verdict = "CRITICAL_FAIL";
      failingLayer = "GROUNDING";
    } else {
      factsPresent = containsAny(reply, c.expected_facts ?? []);
      factsMissing = (c.expected_facts ?? []).filter((f) => !factsPresent.some((p) => norm(p) === norm(f)));
      if ((c.expected_facts ?? []).length === 0) verdict = "CORRECT";
      else if (factsMissing.length === 0) verdict = "CORRECT";
      else if (factsPresent.length > 0) verdict = "PARTIAL";
      else verdict = "WRONG";
      if (verdict !== "CORRECT" && !failingLayer) failingLayer = "MODEL_REASONING";
    }
  }

  if (fabricated.length && verdict !== "CRITICAL_FAIL" && c.expected_answerability !== "escalate") {
    // A fabricated number is a critical fail per the manifest's release gates,
    // independent of whether the other facts happened to be right.
    verdict = "CRITICAL_FAIL";
    failingLayer = "GROUNDING";
  }
  if (!languageOk && verdict === "CORRECT") {
    verdict = "PARTIAL";
    failingLayer = failingLayer ?? "MODEL_LANGUAGE";
  }

  return {
    case_id: c.case_id, category: c.category, language: c.language, split: c.split, severity: c.severity,
    user_query: c.user_query, expected_answerability: c.expected_answerability, route: turn.route,
    escalated: wasEscalated, reply, reply_lang: replyLang, language_ok: languageOk,
    facts_present: factsPresent, facts_missing: factsMissing, forbidden_present: forbiddenPresent,
    fabricated_numbers: fabricated, verdict, knowledge_state_correct: knowledgeStateCorrect, ms, failing_layer: failingLayer,
  };
}

async function main() {
  const casesFile = JSON.parse(readFileSync("bench/baselines/kiosk-validation/FINAL-LOCAL-EVAL-CASES.json", "utf8"));
  const atomic: AtomicCase[] = casesFile.atomic;
  const conversations: Conversation[] = casesFile.conversations;

  const hotel = storage.getHotel();
  const basics = { checkIn: hotel.checkInTime, checkOut: hotel.checkOutTime, currency: hotel.currency };
  const basicsText = `${basics.checkIn} ${basics.checkOut} ${basics.currency}`;

  const atomicResults: AtomicResult[] = [];
  const total = atomic.length;
  for (const [i, c] of atomic.entries()) {
    process.stderr.write(`\rATOMIC ${i + 1}/${total}  ${c.case_id.padEnd(10)}`);
    const t0 = Date.now();
    let turn: LocalTurn;
    try {
      turn = await runLocalTurn({ question: c.user_query, isEmergency: false, lang: c.language as ReplyLang, basics });
    } catch (e) {
      atomicResults.push({
        case_id: c.case_id, category: c.category, language: c.language, split: c.split, severity: c.severity,
        user_query: c.user_query, expected_answerability: c.expected_answerability, route: "ERROR", escalated: true,
        reply: String(e), reply_lang: "-", language_ok: false, facts_present: [], facts_missing: c.expected_facts ?? [],
        forbidden_present: [], fabricated_numbers: [], verdict: "WRONG", knowledge_state_correct: false,
        ms: Date.now() - t0, failing_layer: "BENCHMARK_ERROR",
      });
      continue;
    }
    const ms = Date.now() - t0;
    atomicResults.push(scoreAtomic(c, turn, ms, basicsText));
  }
  process.stderr.write("\r" + " ".repeat(60) + "\r");

  const convResults: any[] = [];
  for (const [ci, conv] of conversations.entries()) {
    process.stderr.write(`\rCONVERSATION ${ci + 1}/${conversations.length}  ${conv.conv_id.padEnd(10)}`);
    const historyLines: string[] = [];
    const turnResults: any[] = [];
    let convFailed = false;
    for (const t of conv.turns) {
      const lang = t.expected_language as ReplyLang;
      const history = historyLines.slice(-4).join("\n");
      const t0 = Date.now();
      let turn: LocalTurn;
      try {
        turn = await runLocalTurn({ question: t.message, isEmergency: false, lang, basics, history: history || undefined });
      } catch (e) {
        turnResults.push({ turn: t.turn, message: t.message, error: String(e) });
        convFailed = true;
        break;
      }
      const ms = Date.now() - t0;
      const reply = turn.reply ?? "";
      const replyLang = reply ? script(reply) : "-";
      const languageOk = !reply || replyLang === t.expected_language;
      const forbiddenPresent = reply ? containsAny(reply, t.forbidden_facts ?? []) : [];
      const factsPresent = reply ? containsAny(reply, t.expected_facts ?? []) : [];
      const factsMissing = (t.expected_facts ?? []).filter((f) => !factsPresent.some((p) => norm(p) === norm(f)));
      const turnOk = forbiddenPresent.length === 0 && factsMissing.length === 0;
      if (!turnOk) convFailed = true;
      turnResults.push({
        turn: t.turn, message: t.message, expected_behavior: t.expected_behavior, route: turn.route,
        escalated: turn.escalate, reply, reply_lang: replyLang, language_ok: languageOk,
        facts_present: factsPresent, facts_missing: factsMissing, forbidden_present: forbiddenPresent,
        turn_ok: turnOk, ms,
      });
      historyLines.push(`Khách: ${t.message.replace(/\s+/g, " ").slice(0, 150)}`);
      historyLines.push(`Trợ lý: ${reply.replace(/\s+/g, " ").slice(0, 150)}`);
    }
    convResults.push({ conv_id: conv.conv_id, split: conv.split, patterns: conv.patterns, turns: turnResults, conversation_success: !convFailed });
  }
  process.stderr.write("\r" + " ".repeat(60) + "\r");

  const out = { ranAt: new Date().toISOString(), atomic: atomicResults, conversations: convResults };
  writeFileSync("bench/baselines/kiosk-validation/FINAL-LOCAL-PRODUCT-EVALUATION.json", JSON.stringify(out, null, 2));
  console.log(`\nwritten FINAL-LOCAL-PRODUCT-EVALUATION.json — ${atomicResults.length} atomic, ${convResults.length} conversations`);
}
main();
