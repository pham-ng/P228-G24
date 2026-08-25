/**
 * Offline concierge — a RAG-first pipeline for the local small model.
 *
 * The hosted path runs an agentic tool loop: the model picks among ~18 tool
 * schemas, up to ten rounds. Published measurements say that is the wrong shape
 * for a 4B model — tool-calling accuracy for 4B–14B models collapses to 0–49%
 * once more than about fifteen schemas are in the prompt, and models under 7B
 * degrade at context lengths as low as 2,000–4,000 tokens. This deployment sent
 * 2,217 tokens of tool descriptions plus a 1,049-token system prompt: 3,266
 * tokens consumed before the guest's question was even considered.
 *
 * So the offline path does not ask the model to orchestrate anything. Control
 * flow is ordinary TypeScript; the model gets one narrow job it is good at —
 * read three retrieved passages and answer from them, or say it cannot.
 *
 *     question
 *       → deterministic classification   (0 LLM calls — reuses the tool router)
 *       → retrieval gate                 (0 LLM calls — BM25, ~50ms, 98.1% hit@5)
 *       → answer or abstain              (1 LLM call, ~1,000 tokens)
 *       → numeric guard                  (shared with the hosted path)
 *       → escalate on abstain
 *
 * THREE RULES THAT MAKE THIS SAFE
 *
 * 1. RETRIEVAL IS GATED BEFORE THE MODEL IS ASKED. If the best passage scores
 *    below a floor, or the only matches are unverified placeholders, the model
 *    never sees the question — the turn escalates. A weak retrieval handed to a
 *    small model is how confident nonsense gets written.
 * 2. ABSTAINING IS A FIRST-CLASS ANSWER. The model is told to emit a fixed token
 *    when the passages do not contain the answer, and that token escalates.
 *    Early-abstention cascades trade a few percent more deferrals for measurably
 *    fewer wrong answers, which is the right trade for a hotel.
 * 3. TRANSACTIONS ARE NEVER IMPROVISED. Anything that moves money or changes a
 *    booking is either handled by deterministic code or handed to a human. The
 *    model's only role there is phrasing a sentence someone else decided.
 *
 * The thresholds below are STARTING POINTS, not settled values. Confidence
 * signals are famously miscalibrated across workloads, so they have to be tuned
 * against this property's own traffic — see LOCAL_MIN_SCORE.
 */

import { hybridSearch, type Retrieved } from "./retrieval";
import { chat } from "./llm";
import { scoreFamilies, type FamilyName } from "./toolrouter";

/* ------------------------------------------------------------------ config */

/**
 * Minimum retrieval relevance before the model is allowed to answer.
 *
 * Reciprocal-rank-fusion scores are small by construction (roughly 1/(60+rank)),
 * so this is a floor on "did anything actually match", not a probability.
 *
 * 0.012 was set before this deployment ran bge-m3. That number is a structural
 * ceiling for any Korean/Japanese/Chinese query: BM25 cannot tokenise those
 * scripts, so a CJK query's score comes ENTIRELY from the vector leg, whose
 * maximum possible contribution is vecWeight/(RRF_K+1) = 0.5/61 ≈ 0.0082 — below
 * 0.012 by construction, regardless of how correct the match is. A threshold
 * sweep over the real 63-case offline set (bench/threshold-sweep.ts) confirmed
 * this directly: at 0.012 the gate wrongly rejects 6 CJK questions where bge-m3
 * had already ranked the correct document first, while the genuine retrieval
 * errors in the same sweep (an English "dog" phrasing, an ID-document miss, a
 * room-count miss) score well ABOVE both 0.012 and 0.005 — they are wrong
 * because of what was retrieved, not because of a low score, so lowering the
 * floor does not let any of them through. In the measured range 0-0.008 the
 * "passed but wrong" count never moved; only the wrongly-blocked count did.
 *
 * 0.005 sits with margin below the 0.0082 CJK ceiling while still refusing a
 * true zero/near-zero match (an empty or wildly off-topic result set). Re-run
 * the sweep after any embedding or corpus change — this number is a
 * consequence of the RRF_K/vecWeight arithmetic above, not a constant.
 */
export const LOCAL_MIN_SCORE = Number(process.env.LOCAL_MIN_SCORE ?? 0.005);

/**
 * Minimum share of the guest's content words that must appear in the best
 * passage before the model is allowed to answer.
 *
 * This is the threshold `LOCAL_MIN_SCORE` was believed to be. Like it, the value
 * is a STARTING POINT to be tuned against this property's own traffic — raise it
 * and more questions go to a person, lower it and the model answers from weaker
 * evidence. Measure with bench/offline-answers.ts, which reports both sides.
 */
export const MIN_COVERAGE = Number(process.env.LOCAL_MIN_COVERAGE ?? 0.34);

/**
 * How many passages the model reads.
 *
 * Started at three on the general argument that models under 7B lose the middle
 * of a long context. Measured on this corpus with qwen3.5:4b, five is better:
 * usefulness 68.9% → 75.6% and precision-when-answering 81.6% → 89.5% over the
 * 45-question answer lane, with no new fabrications and no safety leaks. The
 * cost is real and is latency, not accuracy — p50 rose from 9.6s to 13.1s.
 *
 * Five is where the trade still favours the guest on this hardware. Re-measure
 * before changing it (bench/offline-answers.ts reports both sides), and drop
 * back toward three if a faster reply matters more than the extra 7 points.
 */
export const LOCAL_PASSAGES = Number(process.env.LOCAL_PASSAGES ?? 5);

/** The exact string the model emits when the passages do not answer the question. */
export const ABSTAIN = "KHONG_DU_THONG_TIN";

/* -------------------------------------------------------------- routing */

export type LocalRoute = "knowledge" | "transaction" | "complex" | "emergency";

/**
 * Families that involve money, irreversible writes, or multi-step reasoning.
 * A 4B model does not attempt these offline; they go to a person.
 *
 * Phase 9: "billing" is removed. It fired on the bare word "thanh toán"
 * (payment) alone — e.g. "Resort nhận thanh toán bằng hình thức nào?" (which
 * payment methods do you accept?), a static published fact — and added
 * nothing the hardMoney/personal-or-sum check below does not already cover
 * more precisely for a genuinely personal or dynamic money question.
 * "room_shopping" stays, but only above a score floor (see the score gate at
 * the call site): a strong multi-keyword hit like "gói nào" + "rẻ nhất"
 * (recommend the cheapest package) is a real multi-constraint reasoning task;
 * a single weak hit like "bảng giá" (price table) on "Mã BB trong bảng giá
 * nghĩa là gì?" — a guest asking what a package CODE means — is not.
 */
const COMPLEX_FAMILIES: FamilyName[] = ["room_shopping"];
/** Below this family-match score, "room_shopping" is a definition/lookup
 *  mention, not a recommendation request — see the comment above. Set above
 *  "Gói HB giá bao nhiêu?" (score 3, a package-price lookup) and at
 *  "Gói nào rẻ nhất cho 4 người?" (score 5, a genuine multi-constraint ask). */
const ROOM_SHOPPING_COMPLEX_SCORE_FLOOR = 4;
/**
 * The score floor alone isn't reliable: found live, "Cá tầm giá bao nhiêu?"
 * (how much is the sturgeon — a plain menu-price lookup) scored 4 and forced
 * an escalation, because toolrouter's room_shopping lexicon contains the
 * budget phrase "tầm giá" (price range), and "Cá tầm" (sturgeon) ending in
 * "tầm" right before "giá" makes it appear as an adjacent match — a genuine
 * phrase collision, not a word-boundary bug (anyWord's boundaries are
 * already correct here; the two words really are adjacent). So a real
 * recommendation cue is required too — checked independently and precisely
 * with anyWord — not just the family score, which "tầm giá" can inflate on
 * its own regardless of what the guest actually meant. */
const RECOMMENDATION_CUES = ["rẻ nhất", "gói nào", "nên đặt phòng nào", "ngân sách", "so sánh giúp", "khoảng giá"];

/** Families whose flows are driven by deterministic code plus a confirmation. */
const TRANSACTION_FAMILIES: FamilyName[] = ["stay_changes", "housekeeping", "transport_tours"];

/**
 * Word-boundary matching that works for Vietnamese.
 *
 * JavaScript's  is defined over [A-Za-z0-9_], so a pattern like /đặt/ never
 * matches: "đ" is not a word character, so there is no boundary before it. The
 * bug hid behind the family router, which caught "huỷ phòng" by another route —
 * but "đặt bàn tối nay" fell through to the knowledge path and would have been
 * answered instead of handed to a person. Unicode lookarounds are the fix, and
 * the same trick the tool router already uses for its cue lexicon.
 */
function anyWord(text: string, words: string[]): boolean {
  return words.some((w) => {
    /* Korean, Chinese and Japanese are written without spaces, so a word
       boundary never occurs around a cue: "얼마" inside "얼마인가요" is followed
       by another letter and the lookahead rejects it. Those scripts match as
       substrings — the same split the tool router's lexicon already makes. */
    if (/[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(w)) {
      return text.includes(w);
    }
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "iu").test(text);
  });
}

/**
 * Cues that a request writes something, even inside a knowledge-shaped family.
 *
 * Phase 9: added "hoàn tiền"/"refund". Before the routing fix, ANY refund
 * request escalated purely because "tiền" (money) is a HARD_MONEY_WORDS hit —
 * a blanket rule with no notion of intent. Once that blanket rule was
 * narrowed to distinguish informational lookups from real actions, a refund
 * request needed its own explicit entry here like every other write verb, or
 * it silently fell through to "knowledge". Caught by the unit test written
 * for this fix, not assumed safe.
 */
const WRITE_WORDS = [
  "đặt", "huỷ", "hủy", "thay đổi", "đổi", "gia hạn", "thanh toán", "chuyển khoản", "hoàn tiền",
  "book", "cancel", "change", "pay", "reserve", "refund",
];

/** Money shape, and words that ask for a sum — arithmetic a 4B model must not attempt. */
const MONEY_AMOUNT = /\d[\d.,]*\s*(đ|₫|vnd|triệu|nghìn|k)(?![\p{L}\p{N}])/iu;
/**
 * Money and arithmetic cues in every language the kiosk serves.
 *
 * The Vietnamese list alone let "How much to check in early?" through to the
 * model, which answered and invented a time; the numeric guard caught the
 * fabrication, but the turn should never have reached the model at all. A price
 * question is a price question in any language.
 */
const ARITHMETIC_WORDS = [
  // vi
  "tổng", "bao nhiêu tiền", "bao nhiêu", "cộng", "tính", "chi phí", "hết bao nhiêu", "giá", "phí", "mất bao nhiêu",
  // en
  "how much", "how many", "cost", "price", "fee", "charge", "total", "rate", "bill",
  // ko / zh / ja
  "얼마", "요금", "가격", "多少钱", "多少", "价格", "费用", "いくら", "料金",
];

/**
 * Decide what the offline path does with a message — using rules, not a model.
 *
 * Reuses the tool router's keyword families, which are already tested across
 * Vietnamese, English, Korean and Chinese, rather than introducing a second
 * classifier that would drift from the first.
 */
/**
 * Units that make a quantity question NOT a money question.
 *
 * "bao nhiêu" and "how many" are the same words whether a guest is asking about
 * a bill or about a beach, and the first version of this router could not tell
 * the difference. It escalated "bãi biển dài bao nhiêu km", "how many people fit
 * in the ballroom", "danh sách khách gửi trước bao nhiêu ngày" and "resort có
 * mấy phòng hội nghị" — four ordinary lookups handed to a human because they
 * contained a number word.
 *
 * Over-escalation is the cheap failure and answering a price wrong is the
 * expensive one, so the asymmetry is deliberate: a counting NOUN near the cue
 * releases the question back to the knowledge lane, but any explicit money word
 * (giá, phí, tiền, cost, fee…) or a money AMOUNT still escalates regardless.
 */
const COUNTING_UNITS = [
  "km", "mét", "met", "m2", "m²", "phút", "giờ", "ngày", "đêm", "tuần", "tháng", "tuổi",
  "người", "khách", "phòng", "giường", "tầng", "bước", "lần", "chỗ",
  "people", "guests", "rooms", "beds", "minutes", "hours", "days", "nights", "steps", "floors",
];

/** Words that mean money no matter what else is in the sentence. */
const HARD_MONEY_WORDS = [
  "tiền", "giá", "phí", "phụ thu", "hoá đơn", "hóa đơn", "thanh toán", "cọc", "chi phí",
  "price", "cost", "fee", "charge", "bill", "deposit", "surcharge", "rate",
  "얼마", "요금", "가격", "多少钱", "价格", "费用", "いくら", "料金",
];

/**
 * Phase 9: signals that a money question needs the guest's OWN account state
 * or a computed sum, not a published rate. A bare money word ("giá", "phí",
 * "thanh toán") only means the SENTENCE IS ABOUT money — it says nothing about
 * whether the answer is a static fact sitting in the verified KB (a room
 * rate, a deposit amount, a fee band, what payment methods exist) or a
 * personalised total that only a live folio or a human can produce. The
 * pre-Phase-9 router conflated the two and escalated both identically,
 * discarding 48% of a 102-case benchmark before retrieval ever ran — including
 * "Thuế VAT áp dụng bao nhiêu phần trăm?" and "Resort nhận thanh toán bằng
 * hình thức nào?", neither of which needs a person or a calculator.
 *
 * These two signals are what actually distinguish the unsafe case:
 *  - a personal-possession phrase ("của tôi", "hoá đơn của", "my bill") — the
 *    guest is asking about THEIR account, which the KB cannot contain;
 *  - a summation word ("tổng", "cộng", "total") — the guest wants figures
 *    added together, which a small model must not attempt.
 * Neither is present in a published-rate lookup ("Deluxe giá bao nhiêu?"),
 * both are present in the cases that must keep escalating ("Tổng hoá đơn của
 * tôi bao nhiêu tiền?").
 */
const PERSONAL_ACCOUNT_WORDS = [
  "của tôi", "của em", "của mình", "hoá đơn của", "hóa đơn của",
  "my bill", "my total", "my account", "my folio", "my invoice", "my charges",
];
const SUM_WORDS = ["tổng", "cộng lại", "cộng thêm", "tính tổng", "total", "altogether", "add up", "sum up"];
/**
 * A clock time the GUEST supplied ("I land at 8am", "lúc 8 giờ sáng") turns a
 * fee question from a published-band lookup into a request to compute THEIR
 * specific fee — exactly the case a earlier remediation this project already
 * fixed once: "I land at 8am. How much to check in early?" reached the model
 * and it invented a time, caught only by numguard after the fact, when the
 * turn should never have reached the model at all. Still true after this
 * phase's fix: a personalised time-band lookup keeps escalating even though a
 * general "what are the early check-in charges?" now does not.
 */
const CLOCK_TIME_SUPPLIED = /\b\d{1,2}(:\d{2})?\s?(am|pm)\b|\d{1,2}\s?(giờ|h)\s?(sáng|chiều|tối|đêm)|\b\d{1,2}:\d{2}\b/iu;

/**
 * Whether the current message actually depends on the turns before it, or is
 * a complete, self-contained question that only happens to be asked inside a
 * long-running conversation.
 *
 * Found live, not in a benchmark: a real guest asked about Lotus's menu, then
 * ten messages later asked "Spa mở cửa mấy giờ?" — a complete question that
 * names its own subject. Enriching it with the Lotus/breakfast turns still
 * sitting in `history` flooded the retrieval query with restaurant terms and
 * the spa document lost the gate. Every benchmark conversation this feature
 * was tested against was hand-written as a coherent follow-up chain
 * (spa -> pool, room -> price -> breakfast); a real conversation is mostly
 * topic changes, not follow-ups, and this is the more common shape by far.
 *
 * Deliberately conservative: missing a genuine follow-up here just falls back
 * to the pre-this-feature behavior (no worse than before), while wrongly
 * enriching a self-contained question is what caused the incident above — so
 * the cue list only fires on an explicit continuation or correction marker,
 * never on message length or topic alone.
 */
const CONTEXT_DEPENDENT_CUES = [
  // vi — continuation ("what about X", "so X then") and correction ("I meant X, not Y").
  // Bare "còn" is deliberately excluded: it is also the ordinary word for
  // "still/remaining" ("Phòng còn trống không?" — is the room still
  // available?), which has nothing to do with conversation history and would
  // false-positive on it. "vậy còn"/"thế còn"/"...thì sao" are the actual
  // continuation shapes and don't collide with that everyday sense.
  "vậy còn", "thế còn", "thì sao", "cái đó", "cái này", "vậy đó", "nó",
  "ý tôi là", "ý em là", "ý mình là", "không phải", "tôi muốn nói",
  // en
  "what about", "and that", "i mean", "i meant", "not that",
];
export function needsConversationContext(question: string): boolean {
  const trimmed = question.trim();
  /* "it" only counts leading ("It has an ocean view?") — mid-sentence it is
     too common in ordinary self-contained English questions ("Is it far from
     the airport?") to use as a whole-message cue without the same kind of
     false positive "còn" had. */
  return anyWord(trimmed, CONTEXT_DEPENDENT_CUES) || /^it\b/i.test(trimmed);
}

export function classifyLocal(text: string, isEmergency: boolean): LocalRoute {
  if (isEmergency) return "emergency";
  const scored = scoreFamilies(text);
  const top = scored[0]?.family;

  const hardMoney = anyWord(text, HARD_MONEY_WORDS);
  /* An amount the GUEST typed ("tôi có 5 triệu") signals they want reasoning
     over a number they supplied, not a lookup — always escalates. */
  const guestSuppliedAmount = MONEY_AMOUNT.test(text);
  const needsPersonalOrSum = anyWord(text, PERSONAL_ACCOUNT_WORDS) || anyWord(text, SUM_WORDS) || CLOCK_TIME_SUPPLIED.test(text);
  const quantityCue = anyWord(text, ARITHMETIC_WORDS);

  if (guestSuppliedAmount) return "complex";
  if (hardMoney && needsPersonalOrSum) return "complex";
  /* A bare quantity cue next to a counting unit is a lookup, not arithmetic —
     but only when nothing in the sentence names money. Bare hardMoney with no
     personal/sum signal is now a published-rate lookup, not an auto-escalate:
     it falls through to family scoring and, ultimately, retrieval — where the
     gate and numguard are the real protection against a wrong or invented
     figure, exactly as they already are for every other KB fact. */
  /* Phase 9: this branch used to escalate on the bare quantity phrasing alone
     ("how much is..."), which is why "How much is the breakfast buffet?"
     (informational, a published rate) and its Vietnamese equivalent "Buffet
     sáng giá bao nhiêu một người?" (correctly informational once hardMoney
     was fixed above) disagreed with each other. Same personal-or-sum gate for
     the same reason — a bare "how much" is a lookup unless it is also about
     the guest's own account or a total. */
  if (!hardMoney && quantityCue && needsPersonalOrSum && !anyWord(text, COUNTING_UNITS)) return "complex";
  if (
    top &&
    COMPLEX_FAMILIES.includes(top) &&
    (top !== "room_shopping" ||
      ((scored[0]?.score ?? 0) >= ROOM_SHOPPING_COMPLEX_SCORE_FLOOR && anyWord(text, RECOMMENDATION_CUES)))
  )
    return "complex";
  if (top && TRANSACTION_FAMILIES.includes(top)) return "transaction";
  /* A write verb in an otherwise informational message ("tôi muốn đặt bàn tối
     nay") is a transaction, not a lookup. Two exclusions for the same reason:
     "đặt cọc" (the deposit, a noun) is not the verb "đặt" (to book), and
     "thanh toán bằng hình thức nào" (which payment methods exist — asking
     about a form/method) is not "thanh toán" as an imperative (pay now). */
  if (anyWord(text, WRITE_WORDS) && !/đặt cọc|deposit|hình thức|phương thức/iu.test(text)) return "transaction";
  return "knowledge";
}

/* ------------------------------------------------------------ retrieval gate */

export type GateVerdict = {
  ok: boolean;
  /** Why the gate refused, for the trace and for the operator. */
  reason?: "no_match" | "low_score" | "unverified_only";
  passages: Retrieved[];
  topScore: number;
};

/**
 * Decide whether the retrieved passages are good enough to answer from.
 *
 * Pure so it can be tested without a database: the caller supplies what search
 * returned.
 */
export function gateRetrieval(results: Retrieved[], minScore = LOCAL_MIN_SCORE): GateVerdict {
  if (!results.length) return { ok: false, reason: "no_match", passages: [], topScore: 0 };

  const topScore = results[0]?.relevance ?? 0;
  if (topScore < minScore) return { ok: false, reason: "low_score", passages: results, topScore };

  /* `relevance` is a fusion score — 1/(60+rank) — so the top three results carry
     the same three constants for every query ever asked, and the threshold above
     can only ever catch "nothing came back at all". It was letting "Tôi mang
     theo chó nhỏ được không?" reach the model on a lodging-declaration notice
     and a Chinese-restaurant page, because BM25 found no better lexical overlap
     and RRF happily ranked the garbage 1-2-3.

     Coverage measures the thing the threshold was supposed to: how much of what
     the guest asked is actually in the passage. A passage the query barely
     touches is not evidence, whatever its rank. Coverage returns -1 for scripts
     it cannot tokenise, and an unknown must not be read as a zero — those
     queries fall through to the checks below, exactly as before.

     Word overlap is evidence of a match, but its ABSENCE is not evidence of a
     miss. A dense retriever answers "Tôi mang theo chó nhỏ được không?" with an
     English-titled house-rules page that shares no word with the question and is
     exactly right. So the floor applies only where lexical overlap is the sole
     thing that ranked the passage; once the embedding has spoken, it is the
     stronger signal and coverage does not get a veto. */
  const semantic = results.some((r) => r.matched_by.includes("semantic"));
  const best = Math.max(...results.map((r) => r.coverage ?? -1));
  if (!semantic && best >= 0 && best < MIN_COVERAGE) {
    return { ok: false, reason: "low_score", passages: results, topScore };
  }

  /* A placeholder documents a gap — it says "we do not know this yet".
   *
   * When it is the BEST match, that is the corpus answering the question: we do
   * not have this fact. Dropping it and handing the model the next-best passage
   * is how "phòng gym mở mấy giờ?" gets answered from an unrelated page — the
   * offline benchmark caught exactly that. So a placeholder at the top escalates,
   * and placeholders further down are merely filtered out. */
  if (results[0]?.quality === "placeholder") {
    return { ok: false, reason: "unverified_only", passages: results, topScore };
  }
  const usable = results.filter((r) => r.quality !== "placeholder");
  if (!usable.length) return { ok: false, reason: "unverified_only", passages: results, topScore };

  return { ok: true, passages: usable, topScore };
}

/** Facts that live in the property record rather than in any document. */
export type PropertyBasics = { checkIn: string; checkOut: string; currency: string };

/**
 * The language the reply must be written in.
 *
 * Widened from `"vi" | "en"` after the answer benchmark showed Korean, Chinese
 * and Japanese guests being answered in Vietnamese: the type forced every
 * non-English question into the Vietnamese branch, so the pipeline was correct
 * on the facts and wrong in the only way a guest immediately notices. The
 * Vietnamese prompt is kept verbatim for `vi`; every other language uses the
 * English instruction with the reply language named.
 */
export type ReplyLang = "vi" | "en" | "ko" | "ja" | "zh" | "ru";

/* ---------------------------------------------------------------- answering */

/**
 * The prompt is short on purpose. Every token spent on instructions is a token
 * of passage the model does not read, and small models lose the middle of a long
 * context first.
 */
export function buildAnswerPrompt(
  question: string,
  passages: Retrieved[],
  lang: ReplyLang,
  basics?: PropertyBasics,
  history?: string,
  retrievalNote?: string,
) {
  /* A handful of facts live in the `hotels` row rather than in any document, so
     retrieval cannot reach them and the offline path has no tools to read them
     with. The gold benchmark caught this: asked "mấy giờ tôi được nhận phòng?"
     the model could only find 14:00 buried inside the early-arrival FEE policy
     and answered around it. These are read straight from the database, cost
     about fifty tokens, and are never chosen by the model. */
  const factBlock = basics
    ? `[0] ${lang === "vi" ? "Thông tin cơ bản" : "Property basics"}\n` +
      `${lang === "vi" ? "Giờ nhận phòng tiêu chuẩn" : "Standard check-in"}: ${basics.checkIn}. ` +
      `${lang === "vi" ? "Giờ trả phòng tiêu chuẩn" : "Standard check-out"}: ${basics.checkOut}. ` +
      `${lang === "vi" ? "Tiền tệ" : "Currency"}: ${basics.currency}.\n\n`
    : "";

  /* hybridSearch() already computes this exact caution — "some passages are
     not source-verified, don't state an unconfirmed figure as fact" — from
     the chunk's own `verified` column, and the hosted tool loop already sees
     it because it reads the raw hybridSearch() object as its tool result.
     This offline path built its own prompt instead and silently dropped it.
     Found live: Bách Giai's dining-venue chunk carries specific hours with no
     source_url (unverified by schema default) while its OWN curated,
     verified KB article explicitly says hours are not published — retrieval
     sometimes surfaces the unverified chunk, and with no caution attached the
     model reported its numbers as settled fact instead of flagging them. */
  const noteBlock = retrievalNote ? `⚠️ ${retrievalNote}\n\n` : "";

  const context =
    factBlock +
    noteBlock +
    passages
      .map((p, i) => `[${i + 1}] ${p.title}\n${p.content.replace(/\s+/g, " ").slice(0, 700)}`)
      .join("\n\n");

  /* The reply must be in the language the GUEST wrote, which is not always one
     of the two the prompt is written in. With a Vietnamese-only instruction the
     model answered Korean, Chinese and Japanese questions in Vietnamese —
     correctly, on the facts, and unusably. The corpus is Vietnamese and English,
     so the passages stay in whatever language they are; only the reply is
     pinned, and it is named explicitly rather than left to the model to infer,
     because a small model follows a named language far more reliably than an
     implied one. */
  const LANGUAGE_NAME: Record<string, string> = {
    vi: "tiếng Việt", en: "English", ko: "한국어 (Korean)",
    ja: "日本語 (Japanese)", zh: "中文 (Chinese)", ru: "русский (Russian)",
  };
  const replyIn = LANGUAGE_NAME[lang] ?? "the same language as the question";

  /* The history line only tells the model what the CURRENT question is about
     when read together with an earlier turn — it must never become a second,
     looser source of facts alongside the passages. Stated as its own sentence
     so a small model does not conflate "use conversation to understand" with
     "use conversation as evidence". */
  const historyInstruction = history
    ? lang === "vi"
      ? " Dùng lịch sử hội thoại CHỈ để hiểu khách đang hỏi về điều gì (chủ ngữ bị lược, đại từ, điều vừa sửa lại) — mọi sự thật trong câu trả lời vẫn phải lấy từ tài liệu, không lấy từ lịch sử hội thoại."
      : " Use the conversation history ONLY to understand what the guest is asking about (an omitted subject, a pronoun, a correction) — every fact in your answer must still come from the passages, never from the history."
    : "";

  const system =
    lang === "vi"
      ? `Bạn là lễ tân khách sạn. CHỈ trả lời dựa trên các đoạn tài liệu bên dưới.
Nếu tài liệu không chứa câu trả lời, hãy trả lời đúng một dòng: ${ABSTAIN}
Không suy đoán, không thêm số liệu nào không có trong tài liệu.
Trả lời ngắn gọn 1-3 câu, lịch sự, bằng tiếng Việt.${historyInstruction}`
      : `You are a hotel concierge. Answer ONLY from the passages below.
If the passages do not contain the answer, reply with exactly one line: ${ABSTAIN}
Do not speculate and do not introduce any figure that is not in the passages.
Answer in 1-3 short, polite sentences.
The passages may be in Vietnamese or English; write your reply in ${replyIn}.${historyInstruction}`;

  /* Working memory for a follow-up turn. The offline path used to see only the
     latest guest message — never the turns before it, even though they sit
     right there in storage — so "Còn bể bơi thì sao?" (omitted subject) or
     "Nó có view biển không?" (pronoun) had nothing to resolve against, and a
     correction like "Ý tôi là giờ đóng cửa, không phải mở cửa" had no prior
     statement to correct. Empty for a fresh conversation's first turn, so this
     changes nothing for every single-turn benchmark case already measured. */
  const historyBlock = history ? `${lang === "vi" ? "Lịch sử hội thoại gần đây" : "Recent conversation"}:\n${history}\n\n` : "";

  return { system, user: `${context}\n\n${historyBlock}---\nCâu hỏi / Question: ${question}` };
}

/** True when the model declined to answer. Tolerant of surrounding prose. */
/**
 * Ways a model says "I don't know" that are not the token it was told to emit.
 *
 * Both showed up in the answer benchmark, and both are worse than an escalation
 * because the guest reads them:
 *
 *   1. The token, RESPELLED. Asked what documents a child needs, the model wrote
 *      "KHÔNG_DU_THONG_TIN" — Vietnamese diacritics on a token defined without
 *      them. A plain `RegExp(ABSTAIN)` misses it, so the pipeline treated the
 *      literal string as an ANSWER and sent it to the guest.
 *   2. The same refusal in prose: "Dựa trên tài liệu đã cung cấp, không có thông
 *      tin về giờ phục vụ ăn sáng." Nothing escalates, the guest is told nothing,
 *      and a human never sees the question.
 *
 * The prose patterns are deliberately narrow — they all require an explicit
 * statement ABOUT the documents. A plain "không" must never trigger this: "Không
 * được mang thú cưng" is a correct answer, not a refusal.
 */
const ABSTAIN_PROSE = [
  /kh[oô]ng c[oó] th[oô]ng tin/i,
  /kh[oô]ng (?:được )?(?:đề|de) c[aậ]p/i,
  /ch[uư]a (?:được )?(?:đề|de) c[aậ]p/i,
  /kh[oô]ng t[iì]m th[aấ]y th[oô]ng tin/i,
  /t[aà]i li[eệ]u (?:hi[eệ]n c[oó] |đ[aã] cung c[aấ]p )?kh[oô]ng (?:c[oó]|n[eê]u|ch[uứ]a)/i,
  /no information (?:about|on|regarding)/i,
  /(?:is |are )?not mentioned/i,
  /(?:do(?:es)? not|don't|doesn't) (?:contain|mention|include|specify)/i,
];

export function isAbstention(reply: string): boolean {
  const text = reply ?? "";
  if (!text.trim()) return false;
  /* Strip diacritics before comparing to the token, so "KHÔNG_DU_THONG_TIN"
     and "KHONG_DU_THONG_TIN" are the same refusal. */
  const folded = text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d");
  if (new RegExp(ABSTAIN, "i").test(folded)) return true;
  return ABSTAIN_PROSE.some((re) => re.test(text));
}

export type LocalAnswer = {
  /** null when the model abstained or could not be reached. */
  reply: string | null;
  abstained: boolean;
  error?: string;
  /** Ollama's stage-level timing, when the transport reports it. See ChatResponse.timing. */
  timing?: {
    loadMs: number;
    promptEvalMs: number;
    promptEvalTokens: number;
    evalMs: number;
    evalTokens: number;
    totalMs: number;
  };
};

/**
 * Ask the local model to answer from the passages.
 *
 * `callChat` is injectable so the pipeline can be tested end to end without a
 * model running — the deterministic parts are where the risk lives, and they
 * should not be untestable just because inference is unavailable.
 */
export async function answerFromPassages(
  question: string,
  passages: Retrieved[],
  lang: ReplyLang,
  callChat: typeof chat = chat,
  basics?: PropertyBasics,
  history?: string,
  retrievalNote?: string,
): Promise<LocalAnswer> {
  const { system, user } = buildAnswerPrompt(question, passages, lang, basics, history, retrievalNote);
  try {
    const r = await callChat({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0,
      maxTokens: 300,
    });
    const text = (r.choices[0]?.message?.content ?? "").trim();
    if (!text) return { reply: null, abstained: true, timing: r.timing };
    if (isAbstention(text)) return { reply: null, abstained: true, timing: r.timing };
    return { reply: text, abstained: false, timing: r.timing };
  } catch (e: any) {
    return { reply: null, abstained: true, error: e?.message ?? String(e) };
  }
}

/* ------------------------------------------------------------- the pipeline */

export type LocalTurn = {
  route: LocalRoute;
  /** The answer to send, or null when the turn must escalate. */
  reply: string | null;
  /** Set when the turn should be handed to a person (or to the hosted model). */
  escalate: boolean;
  escalateReason?: string;
  passages: Retrieved[];
  topScore: number;
  /** How many times a model was called. Zero on every non-knowledge route. */
  llmCalls: number;
  /** Wall-clock time spent in hybridSearch, ms. 0 when retrieval never ran. */
  retrievalMs?: number;
  /** Ollama's own stage timing for the generation call, when it ran. */
  timing?: LocalAnswer["timing"];
};

/**
 * Run one offline turn.
 *
 * Everything before the single model call is deterministic, so a turn that ends
 * in escalation costs no inference at all — which is what keeps the offline path
 * fast on hardware that has to share 4GB of VRAM.
 */
export async function runLocalTurn(input: {
  question: string;
  isEmergency: boolean;
  lang: ReplyLang;
  search?: typeof hybridSearch;
  callChat?: typeof chat;
  minScore?: number;
  basics?: PropertyBasics;
  /** Recent turns, for a follow-up whose subject or referent is not in
   *  `question` alone ("Còn bể bơi thì sao?", "Nó có view biển không?").
   *  Empty for a conversation's first turn, so nothing here changes for any
   *  single-turn case — this is purely additive. classifyLocal deliberately
   *  still sees only the raw current message: routing safety is decided on
   *  what the guest is asking right now, not on what was asked before. */
  history?: string;
}): Promise<LocalTurn> {
  const search = input.search ?? hybridSearch;
  const route = classifyLocal(input.question, input.isEmergency);

  if (route === "emergency") {
    return {
      route,
      reply: null,
      escalate: true,
      escalateReason: "Khẩn cấp — chuyển nhân viên ngay.",
      passages: [],
      topScore: 0,
      llmCalls: 0,
    };
  }
  if (route === "complex") {
    return {
      route,
      reply: null,
      escalate: true,
      escalateReason: "Yêu cầu cần tính toán hoặc nhiều bước — chuyển nhân viên.",
      passages: [],
      topScore: 0,
      llmCalls: 0,
    };
  }
  if (route === "transaction") {
    return {
      route,
      reply: null,
      escalate: true,
      escalateReason: "Yêu cầu thay đổi/đặt dịch vụ — chuyển nhân viên xác nhận.",
      passages: [],
      topScore: 0,
      llmCalls: 0,
    };
  }

  /* Retrieval sees the same enrichment, and only under the same two gates
     generation does: the question must actually depend on prior turns
     (needsConversationContext — see its own comment for the live incident
     that made this gate necessary; a self-contained question like "Spa mở
     cửa mấy giờ?" must never be enriched with an unrelated earlier topic
     still sitting in history), and it must not be money-shaped (see below —
     a different live incident, cross-topic number attribution). Both gates
     fail closed: missing a genuine follow-up just falls back to this
     feature's pre-existing behavior, never worse than before it existed. */
  const questionHasMoneySignal = MONEY_AMOUNT.test(input.question) || anyWord(input.question, HARD_MONEY_WORDS);
  const useHistory = !!input.history && needsConversationContext(input.question) && !questionHasMoneySignal;
  /* Retrieval gets only the single most recent exchange, not the full
     multi-exchange block the prompt gets below. Found live: a correction
     ("Ý tôi là hỏi giờ đóng cửa...") two turns after a pool question and one
     turn after a breakfast question enriched with BOTH — and BM25 is a
     keyword counter, not a reader, so it matched the pool passage because
     that document happens to literally say "đóng cửa" while the breakfast
     one just states an hour range. The model, given the full two-exchange
     block instead, can actually read which topic a correction refers to;
     BM25 cannot, so it only gets the exchange most likely to be the right
     one — the last one. */
  const lastExchangeOnly = input.history?.split("\n").slice(-2).join("\n") ?? "";
  const retrievalQuery = useHistory && lastExchangeOnly ? `${lastExchangeOnly}\n${input.question}` : input.question;
  const retrievalStart = Date.now();
  const found = await search(retrievalQuery, { k: LOCAL_PASSAGES });
  const retrievalMs = Date.now() - retrievalStart;
  const gate = gateRetrieval(found.results, input.minScore ?? LOCAL_MIN_SCORE);
  if (!gate.ok) {
    return {
      route,
      reply: null,
      escalate: true,
      escalateReason: `Không đủ căn cứ trong kho tri thức (${gate.reason}).`,
      passages: gate.passages,
      topScore: gate.topScore,
      llmCalls: 0,
      retrievalMs,
    };
  }

  const answer = await answerFromPassages(
    input.question,
    gate.passages,
    input.lang,
    input.callChat,
    input.basics,
    useHistory ? input.history : undefined,
    found.note,
  );
  if (answer.abstained) {
    return {
      route,
      reply: null,
      escalate: true,
      escalateReason: answer.error
        ? `Model nội bộ không phản hồi: ${answer.error}`
        : "Model nội bộ không tìm thấy câu trả lời trong tài liệu.",
      passages: gate.passages,
      topScore: gate.topScore,
      llmCalls: 1,
      retrievalMs,
      timing: answer.timing,
    };
  }

  return {
    route,
    reply: answer.reply,
    escalate: false,
    passages: gate.passages,
    topScore: gate.topScore,
    llmCalls: 1,
    retrievalMs,
    timing: answer.timing,
  };
}
