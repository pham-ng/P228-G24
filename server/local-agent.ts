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

import { recordRetrieval } from "./metrics-extra";
import { neutraliseUntrusted } from "./untrusted";
import { hybridSearch, tokenise, fold, hasVietnameseDiacritics, type Retrieved } from "./retrieval";
import { storage } from "./storage";
import type { DocChunk } from "@shared/schema";
import { chat } from "./llm";
import { scoreFamilies, type FamilyName } from "./toolrouter";
import { checkReply, repairReply, checkCategoricalTraps } from "./numguard";
import { namedEntities } from "./name-alias";
import { shouldEscalateByIntent } from "./intent-net";
import { needsClarification, mentionsKnownSubject, type ClarifyLang } from "./clarify";
import { greetingReply, type GreetLang } from "./greeting";

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
/* Live bug: a guest asked "chọn phòng nào" (which room should I pick) instead
 * of "nên đặt phòng nào" (which room should I book) — swapping one verb —
 * and the exact-phrase list let it straight through to the model, which
 * answered as if occupancy/budget were known when neither had been given.
 * This is not a hardcoding-vs-not-answering tradeoff: escalating here is
 * correct because the guest is asking staff to DECIDE for them without
 * having supplied the numbers a decision needs, and this path has no way to
 * ask a clarifying question mid-turn. The bug was that the phrase list was
 * too NARROW, not that it existed — every synonym for "decide/pick for me"
 * paired with a room/package noun belongs here, not just the one verb a
 * benchmark case happened to use. */
const RECOMMENDATION_CUES = [
  "rẻ nhất", "gói nào", "nên đặt phòng nào", "ngân sách", "so sánh giúp", "khoảng giá",
  "chọn phòng nào", "chọn loại nào", "nên chọn", "nên ở phòng nào", "loại nào phù hợp",
  "phòng nào phù hợp", "loại nào tốt nhất", "gợi ý giúp", "tư vấn giúp",
  "which room should", "recommend a room", "suggest a room", "help me choose",
];

/** Families whose flows are driven by deterministic code plus a confirmation. */
const TRANSACTION_FAMILIES: FamilyName[] = ["stay_changes", "housekeeping", "transport_tours"];

/**
 * Route "transaction" gộp chung hai việc rất khác nhau dưới cùng một xử lý:
 * "làm giúp tôi việc X" (cần người thật thao tác) và "cho tôi biết X là bao
 * nhiêu" (câu hỏi tri thức thuần tuý về một chủ đề NGHE giống giao dịch —
 * "đổi tên khách mất phí bao nhiêu", "đặt xe giá bao nhiêu"). Trước bản vá
 * này, CẢ HAI đều bị gán `escalate: true` + một câu "đã chuyển thông tin
 * cho nhân viên" tự động — kể cả khi câu trả lời đã đầy đủ, đúng, và không
 * còn gì cần lễ tân làm thêm. Đo được qua khảo sát "chuyển nhân viên 49%":
 * 40+ ca route=transaction mà giám khảo (tôi) đã chấm "đúng và đủ" chỉ vì
 * câu hỏi tình cờ chạm gói từ khoá vận chuyển/đổi phòng, không phải vì
 * khách thật sự cần ai đó xử lý gì thêm — một tin nhắn "đã chuyển việc"
 * KHÔNG CÓ VIỆC GÌ để chuyển vừa gây hiểu lầm cho khách, vừa tạo việc thừa
 * cho lễ tân.
 *
 * Hàm này CỐ Ý bảo thủ theo hướng AN TOÀN: chỉ trả `true` (bỏ qua escalate)
 * khi câu hỏi rõ ràng ở dạng hỏi thông tin (kết thúc bằng cụm hỏi) VÀ không
 * mang bất kỳ dấu hiệu nào của yêu cầu hành động thật (nhờ vả trực tiếp, mã
 * đặt phòng cụ thể, hoặc mở đầu bằng động từ mệnh lệnh). Nghi ngờ ở đâu thì
 * giữ nguyên hành vi cũ (escalate) — thà chuyển việc thừa một lần còn hơn bỏ
 * sót một yêu cầu thật.
 */
const ACTION_REQUEST_MARKERS =
  /giúp (tôi|mình|em|anh|chị)|gi[uù]m (tôi|mình)|hộ (tôi|mình)|làm ơn|please\b|for me\b|VPNT-[A-Z0-9]{4,}|mã đặt phòng|reservation (code|number)/i;
const IMPERATIVE_VERB_START = /^\s*(đặt|huỷ|hủy|đổi|xoá|xóa|thêm|gửi|xác nhận|đăng ký|confirm|cancel|book|change)\b/i;
const PURE_INFO_QUESTION_TAIL = /(bao nhiêu|là gì|thế nào|ở đâu|mấy giờ|có .*không|đúng không)\s*[?.!]?\s*$/i;
function looksLikePureInfoQuestion(question: string): boolean {
  const q = question.trim();
  if (ACTION_REQUEST_MARKERS.test(q) || IMPERATIVE_VERB_START.test(q)) return false;
  return PURE_INFO_QUESTION_TAIL.test(q);
}

/**
 * The `housekeeping` family's lexicon (toolrouter.ts) mixes bare amenity nouns
 * ("wifi", "điều hoà", "khăn"...) with real fault/request words ("hỏng",
 * "không hoạt động"...) so the family scorer can catch "wifi không hoạt động"
 * as a dispatchable fault. Most of those nouns have no KB fact behind them
 * either way (no article answers "do you have towels"), so routing them to
 * transaction unconditionally is harmless. WiFi is the one exception — a
 * published "Wi-Fi / Internet" KB article exists — so a bare informational
 * "wifi có miễn phí không?" was being force-escalated with zero retrieval
 * purely because "phí" and "wifi" are both in a lexicon, live-reproduced and
 * confirmed via classifyLocal() directly, not assumed. Only fall through to
 * retrieval when NO fault/request word is also present — a real complaint
 * ("wifi yếu quá", "wifi không vào được") must still dispatch as before.
 */
const WIFI_FAULT_CUES = [
  "hỏng", "không hoạt động", "không kết nối", "không vào được", "không dùng được",
  "rớt mạng", "mất mạng", "không có sóng", "yếu quá", "chậm quá", "lỗi", "sự cố",
  "broken", "not working", "can't connect", "cannot connect", "no connection", "down", "slow",
];
function isWifiInfoOnly(text: string): boolean {
  return anyWord(text, ["wifi", "wi-fi"]) && !anyWord(text, WIFI_FAULT_CUES);
}

/**
 * The same shape of bug as WiFi above, found live in the same session:
 * `transport_tours`'s lexicon (toolrouter.ts) mixes bare nouns ("sân bay",
 * "xe", "taxi"...) with the family's real job, dispatching a transfer
 * booking — so "Giá đưa đón sân bay Cam Ranh bao nhiêu?" (a plain published-
 * rate lookup, now answerable from the KB article this session added the
 * price to) was being force-escalated with zero retrieval purely because
 * "đưa đón" and "sân bay" are both in the lexicon. A genuine booking request
 * always carries its own WRITE_WORDS verb ("đặt xe", "book a transfer"),
 * which is checked independently right after this — so letting a bare
 * price/quantity question fall through to knowledge here never lets an
 * actual booking slip past; it only stops a lookup from being escalated for
 * no reason. */
const TRANSPORT_BOOKING_CUES = [
  "đặt xe", "gọi xe", "cần xe", "book a car", "book a taxi", "arrange a transfer",
  "arrange transport", "reserve a car", "schedule a pickup", "call a taxi",
];
function isTransportInfoOnly(text: string): boolean {
  return (anyWord(text, HARD_MONEY_WORDS) || anyWord(text, ARITHMETIC_WORDS)) && !anyWord(text, TRANSPORT_BOOKING_CUES);
}

/** Max characters kept per passage in the model's context. Configurable so
 * the context-compression experiment can sweep it against the real
 * benchmark without a code change. */
export const PASSAGE_CHAR_CAP = Number(process.env.LOCAL_PASSAGE_CHAR_CAP || 700);

/**
 * Cut passage content at a sentence boundary, never mid-fact.
 *
 * The previous cut was a bare `.slice(0, cap)` — for a passage like
 * "...phòng gồm 2 giường đơn. Giá 2.870.000đ/đêm. Trẻ em dưới 6 tuổi ở miễn
 * phí." a naive cut at, say, char 620 could land mid-price ("Giá 2.870.0")
 * and hand the model a truncated number instead of no number at all. This
 * looks for the last sentence-ending punctuation within the allowed window
 * and cuts there; only when no sentence boundary exists anywhere in a
 * reasonable range does it fall back to a word boundary, and it always cuts
 * on whitespace, never inside a word/number.
 */
export function truncateAtBoundary(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const window = text.slice(0, cap + 1);
  const sentenceEnd = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf(".\n"),
    window.lastIndexOf("! "),
    window.lastIndexOf("? "),
    window.lastIndexOf("।"),
  );
  // Accept a sentence boundary only if it doesn't throw away most of the
  // passage — a boundary at char 40 of a 700-char cap is not a good cut.
  const minAcceptable = cap * 0.5;
  if (sentenceEnd >= minAcceptable) return text.slice(0, sentenceEnd + 1).trim();
  const lastSpace = window.lastIndexOf(" ");
  if (lastSpace >= minAcceptable) return text.slice(0, lastSpace).trim() + "…";
  // No good boundary anywhere reasonable (e.g. one long unbroken clause) —
  // still better than an arbitrary mid-word cut.
  return text.slice(0, cap).trim() + "…";
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
}

/**
 * Pick the sentences most relevant to the guest's question, instead of
 * always keeping the head of the passage.
 *
 * Live bug: "villa giá bao nhiêu" got answered with the deposit amount
 * (3,000,000đ/villa) instead of the room rate (8,610,000 / 10,130,000đ).
 * Root cause: the "Rooms and room types" KB chunk bundles six room/villa
 * prices into one 773-char paragraph, and the villa sentence sits at char
 * 492 — past the frozen 400-char PASSAGE_CHAR_CAP (see 10-FROZEN-CONTEXT-
 * CONFIG.md). truncateAtBoundary always kept the HEAD of the passage, so
 * the villa fact was silently cut before the model ever saw it, and it
 * answered from the nearest number it could see in a different passage.
 * A scan of every seed KB chunk found 9 more chunks with a numeric fact
 * sitting past char 400 — the same failure mode was latent, not villa-
 * specific — so the fix has to be general: score each sentence against the
 * guest's own question and keep the ones that match, wherever they sit in
 * the passage, still cutting only on sentence boundaries. Falls back to the
 * old head-truncation when nothing in the passage matches the question at
 * all (short/no-token queries, or a genuinely irrelevant passage) — that is
 * exactly the case the existing 73-case regression benchmark already
 * measured, so this changes nothing for it.
 */
export function selectRelevantWindow(text: string, cap: number, question: string): string {
  if (text.length <= cap) return text;
  const sentences = splitSentences(text);
  if (sentences.length <= 1) return truncateAtBoundary(text, cap);

  const qTokens = new Set(tokenise(question));
  if (!qTokens.size) return truncateAtBoundary(text, cap);
  const sentenceTokens = sentences.map((s) => new Set(tokenise(s)));

  /* Greedily pick sentences by MARGINAL new coverage of the question's
   * tokens, not by raw occurrence count.
   *
   * Live regression, found by re-tracing this exact fix against the "Ozone"
   * capacity question: the venue's own title/description sentence repeats
   * "Ozone", "hải sản" and "nhà hàng" several times (Vietnamese name +
   * English name + description all restate them), scoring 14 raw token
   * hits against the question — versus 2 for "Giờ mở cửa: ..." and 3 for
   * "Sức chứa 360 khách." A raw-count anchor-and-grow window anchored on
   * the repetitive title and spent its whole budget on adjacent menu items
   * that also happen to repeat "hải sản", never reaching the hours or
   * capacity sentence at all — the model then filled the gap by copying
   * Lotus's capacity (800) from a different passage instead. Scoring by
   * how many QUESTION TOKENS NOT YET COVERED a sentence adds fixes this
   * generally: once the title sentence is taken for "ozone"/"hải sản", it
   * stops paying for those tokens again, so "giờ"/"mở"/"sức"/"chứa"/"khách"
   * — genuinely new information — outweigh another menu line that only
   * repeats what is already covered. */
  const covered = new Set<string>();
  const picked: number[] = [];
  /* A sentence that doesn't fit the remaining budget must be skipped, not
   * treated as "we're done" — otherwise the single best-scoring sentence
   * being too big to fit stops a much smaller, still-useful sentence from
   * ever being considered. Found live: the top pick after the venue's menu
   * block was the short "Giờ mở cửa: ..." sentence, but an earlier version
   * of this loop `break`-ed the moment ANY top candidate didn't fit,
   * discarding it and everything after it in the same pass. */
  const excluded = new Set<number>();
  let len = 0;
  while (true) {
    let bestIdx = -1;
    let bestGain = 0;
    for (let i = 0; i < sentences.length; i++) {
      if (picked.includes(i) || excluded.has(i)) continue;
      let gain = 0;
      for (const t of sentenceTokens[i]) if (qTokens.has(t) && !covered.has(t)) gain++;
      if (gain > bestGain) {
        bestGain = gain;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break;
    const candidateLen = len + (picked.length ? 1 : 0) + sentences[bestIdx].length;
    if (candidateLen > cap) {
      excluded.add(bestIdx);
      continue;
    }
    picked.push(bestIdx);
    len = candidateLen;
    for (const t of sentenceTokens[bestIdx]) covered.add(t);
  }

  /* Spend the REST of the budget instead of throwing it away.
   *
   * The loop above stops as soon as no remaining sentence adds a question
   * token it has not already covered. That is the right way to CHOOSE, and
   * the wrong way to STOP: a sentence whose marginal gain is zero is not
   * worthless, it is merely redundant in vocabulary — and a price is exactly
   * that kind of sentence, because a number is not a word the guest typed.
   *
   * Live, reported by the operator: "Giá phòng Deluxe giường đôi được công
   * bố là 100%." Retrieval had done its job — three of the five passages were
   * the right "Gói giá phòng" chunks with the real rates in them — and then
   * every one of the thirteen passages reached the model with its price
   * deleted here. Traced on the room description: the question "Giá phòng
   * Deluxe giường đôi bao nhiêu?" has its tokens {gia, phong, deluxe, giuong,
   * doi} fully covered by the opening prose sentence ("...bảng giá niêm yết:
   * Với diện tích 32 m², Deluxe Giường Đôi là phòng khách sạn..."), so
   * "Giá công bố~ 4.600.000VNĐ/đêm Giá chỉ từ~ 4.370.000VNĐ/đêm" scored a
   * gain of 0 and was dropped — with 179 of the 400-character budget still
   * unused. The model was then asked a price question with no price in front
   * of it, and reached for the nearest percentage it could see.
   *
   * So: keep filling, and fill with the KIND of figure the question asked
   * for. A money question ranks a currency amount above the room's occupancy
   * line, which ranks above prose — ordering by "has a digit" alone was not
   * enough: the occupancy sentence is also a figure, it won on document
   * order, and the price sentence then missed the 400-character budget by a
   * single character. Ties and the remainder fall back to document order. */
  if (len < cap) {
    const wantsMoney = anyWord(question, HARD_MONEY_WORDS) || /bao nhiêu|how much/i.test(question);
    /* Currency only — deliberately NOT percentages. The reported failure
       answered a room-rate question with "100%", and a percentage sitting in
       a fee or cancellation clause must not outrank an actual rate. It still
       qualifies as an ordinary figure on the tier below. */
    const MONEY_SHAPE = /\d[\d.,]{2,}\s*(đ|₫|vn[dđ]|triệu|nghìn)/iu;
    const tier = (s: string) => {
      if (wantsMoney && MONEY_SHAPE.test(s)) return 0;
      return /\d/.test(s) ? 1 : 2;
    };
    const remaining = sentences
      .map((_, i) => i)
      .filter((i) => !picked.includes(i))
      .sort((a, b) => {
        const ta = tier(sentences[a]);
        const tb = tier(sentences[b]);
        return ta !== tb ? ta - tb : a - b;
      });
    for (const i of remaining) {
      const candidateLen = len + (picked.length ? 1 : 0) + sentences[i].length;
      if (candidateLen > cap) continue;
      picked.push(i);
      len = candidateLen;
    }
  }

  /**
   * Một câu dài hơn cả ngân sách vẫn phải có cơ hội trả lời được.
   *
   * Hai vòng ở trên chỉ CHẤP NHẬN được câu vừa khít, nên một câu dài hơn `cap`
   * bị loại âm thầm dù nó liên quan tới đâu — và thực đơn nhà hàng đúng là hình
   * dạng đó. Đo trên "Vịt quay Bắc Kinh ở Bách Giai bao nhiêu tiền?": chunk Bách
   * Giai để cả bảng giá thành MỘT mạch 600 ký tự ("… Xôi gà lá sen 200.000đ,
   * Vịt quay Bắc Kinh 750.000đ, Gà quay kiểu Ma Cao 450.000đ …") vì mọi dấu chấm
   * đều nằm trong con số nên không kết thúc câu nào. Nó không lọt nổi 400 ký tự,
   * bị vứt nguyên khối, ngân sách rơi vào đoạn văn tả không gian — và model,
   * ĐÚNG ĐẮN, báo là không tìm thấy giá. Từ chối đó trông như lỗi model nhưng là
   * lỗi ngữ cảnh.
   *
   * Nên khi ngân sách còn dư mà không mẩu nào giữ lại mang ĐÚNG LOẠI con số câu
   * hỏi cần, hãy cắt một cửa sổ từ câu quá dài tốt nhất, canh vào chỗ chính chữ
   * của khách xuất hiện. Giới hạn trong phần còn thừa, cắt ở ranh giới từ, và chỉ
   * làm khi loại số được hỏi vắng mặt — đây là thêm một mẩu, không phải mở lại cả
   * đoạn văn.
   */
  const wantsFigure = anyWord(question, HARD_MONEY_WORDS) || /bao nhiêu|how much|giá|mấy giờ/i.test(question);
  const FIGURE_SHAPE = /\d[\d.,]{2,}\s*(đ|₫|vn[dđ]|triệu|nghìn)|\d{1,2}:\d{2}/iu;
  const keptText = picked.map((i) => sentences[i]).join(" ");
  if (wantsFigure && len < cap && !FIGURE_SHAPE.test(keptText)) {
    const room = cap - len - (picked.length ? 1 : 0);
    /* Cần đủ chỗ để mang được con số kèm nhãn của nó, không thì mẩu cắt ra chỉ là
       nhiễu: tốn ngân sách mà không dạy model điều gì. */
    if (room >= 80) {
      const qTok = [...qTokens].filter((t) => t.length > 2).map((t) => fold(t));
      let bestI = -1;
      let bestAt = -1;
      let bestHits = 0;
      for (let i = 0; i < sentences.length; i++) {
        if (picked.includes(i)) continue;
        const sent = sentences[i];
        if (sent.length <= room || !FIGURE_SHAPE.test(sent)) continue;
        /**
         * Trượt một cửa sổ và giữ chỗ TẬP TRUNG nhiều từ khoá nhất.
         *
         * Bản đầu neo vào vị trí CUỐI CÙNG có từ khoá và trượt sai hẳn: tên nhà
         * hàng ("Bách Giai") lặp lại suốt bảng giá, nên "lần cuối" trỏ vào mục
         * Mì ở cuối thực đơn thay vì "Vịt quay Bắc Kinh" mà khách hỏi. Đếm số
         * từ khoá RIÊNG BIỆT rơi vào cửa sổ sẽ tự đề cao chỗ có cả tên món lẫn
         * giá của nó, và tự hạ chỗ chỉ lặp lại tên nhà hàng.
         */
        const folded = fold(sent);
        const step = Math.max(16, Math.floor(room / 8));
        for (let from = 0; from < folded.length; from += step) {
          const win = folded.slice(from, from + room);
          if (!FIGURE_SHAPE.test(sent.slice(from, from + room))) continue;
          let hits = 0;
          for (const t of qTok) if (win.includes(t)) hits++;
          if (hits > bestHits) {
            bestHits = hits;
            bestI = i;
            bestAt = from;
          }
        }
      }
      if (bestI >= 0) {
        const sent = sentences[bestI];
        /* Lùi lại một chút trước chữ khớp để không cắt cụt cái nhãn. */
        const from = Math.max(0, bestAt);
        let slice = sent.slice(from, from + room);
        const sp = slice.lastIndexOf(" ");
        if (sp > room * 0.6) slice = slice.slice(0, sp);
        picked.push(bestI);
        sentences[bestI] = (from > 0 ? "…" : "") + slice.trim() + "…";
      }
    }
  }
  if (!picked.length) return truncateAtBoundary(text, cap);

  return picked
    .sort((a, b) => a - b)
    .map((i) => sentences[i])
    .join(" ")
    .trim();
}

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
  /* Compare with diacritics stripped from BOTH sides.
   *
   * Vietnamese guests type without diacritics constantly — it is faster, and a
   * phone without a Vietnamese keyboard leaves no choice. Every cue list in
   * this file is written WITH diacritics, and this matcher used to build its
   * regex from the cue and run it against the guest's raw text, so none of
   * them ever fired on unaccented input. Measured across the safety-critical
   * routing cases, SEVEN OUT OF SEVEN lost their guard:
   *
   *     "Tôi muốn huỷ phòng"  -> transaction   (handed to a person)
   *     "Toi muon huy phong"  -> knowledge     (answered by the model)
   *
   * and the same for a refund, a broken air-con, a date change, a folio total
   * and a table booking. The router looked robust because every test case in
   * the suite was written with correct diacritics.
   *
   * Folding costs some precision: "giá" (price) and "gia" (as in "gia đình",
   * family) become the same string, so a few questions now read as
   * money-shaped when they are not. That trade is the one this file's header
   * already chose — over-escalation is the cheap failure, answering a
   * cancellation or a price wrong is the expensive one — and the routing
   * regression cases are re-measured against it rather than assumed safe.
   *
   * CJK is unaffected: those scripts carry no diacritics and still match as
   * substrings, because they are written without spaces and a word boundary
   * never occurs around a cue ("얼마" inside "얼마인가요"). */
  /* Fold only when the guest wrote without accents — see
     hasVietnameseDiacritics for the "đôi" / "đổi" collision that made
     unconditional folding misroute every double-bed question. */
  const loose = !hasVietnameseDiacritics(text);
  const hay = loose ? fold(text) : text;
  return words.some((w) => {
    if (/[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(w)) {
      return text.includes(w);
    }
    const cue = loose ? fold(w) : w;
    const esc = cue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "iu").test(hay);
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
  /* ko / ja / zh — this list was Vietnamese and English ONLY, so the entire
   * write-action safety net did not exist for a Korean, Japanese or Chinese
   * guest. Found by the release evaluation: six of the six SAFETY_ESCALATION
   * cases that reached the model unescalated were CJK, and every one of them
   * moved money or changed a booking —
   *
   *     "제 예약을 지금 취소하고 환불해 주세요"        cancel my booking and refund me
   *     "帮我把账单退款到我朋友的银行账户，不是我自己的"  refund to my FRIEND's account
   *     "クレジットカードの請求額が間違っているので今すぐ訂正してください"  correct my card charge
   *
   * — while the Vietnamese and English equivalents escalated correctly. The
   * hole is in routing, not in the model: qwen2.5:3b only appeared safer here
   * because it abstains more often, which escalates by accident rather than
   * by rule.
   *
   * Only unambiguous ACTION verbs are listed. The nouns for "reservation"
   * (예약 / 予約 / 预订) are deliberately excluded: they appear in ordinary
   * policy questions ("예약 정책이 무엇인가요") and would escalate lookups the
   * kiosk should answer. CJK matches as a substring (see anyWord), which is
   * correct for scripts written without spaces. */
  // ko
  "취소", "환불", "결제", "변경", "정정", "바꿔", "연장", "앞당",
  // ja
  "キャンセル", "返金", "支払", "変更", "訂正", "延長", "早めて",
  // zh
  "取消", "退款", "支付", "付款", "更改", "变更", "更正", "提前", "推迟", "延长",
];

/** Money shape, and words that ask for a sum — arithmetic a 4B model must not attempt. */
/* Every Vietnamese pattern in this file is matched against fold(text) — see
   anyWord's comment for the seven safety rules that silently stopped firing
   when a guest typed without diacritics. The alternatives here are therefore
   written already-folded ("trieu", "nghin"), which also makes them plain
   ASCII and easier to read. */
const MONEY_AMOUNT = /\d[\d.,]*\s*(d|₫|vnd|trieu|nghin|k)(?![\p{L}\p{N}])/iu;
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
  /* ru — the kiosk serves Russian guests (there is one in the seed data and a
     Russian chip set in the guest UI), but every money list here stopped at
     Japanese. "Сколько стоит номер Deluxe Queen Bed?" therefore registered as
     no kind of price question at all: no rate block was built for it, and it
     was the one language out of six that still could not be quoted a room
     rate after the rest were fixed. */
  "сколько", "стоит", "цена", "стоимость", "тариф",
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
  /* ru — see the same gap in ARITHMETIC_WORDS above. "сколько" is deliberately
     NOT here: on its own it means "how many", a counting question, and belongs
     with the quantity cues rather than with the words that mean money whatever
     else is in the sentence. */
  "стоит", "цена", "стоимость", "тариф",
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
/* Folded alternatives — tested against fold(text), like every other Vietnamese
   pattern in this file. See anyWord for why. */
const CLOCK_TIME_SUPPLIED = /\b\d{1,2}(:\d{2})?\s?(am|pm)\b|\d{1,2}\s?(gio|h)\s?(sang|chieu|toi|dem)|\b\d{1,2}:\d{2}\b/iu;

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

/**
 * A quantity of ADDITIONAL nights the guest supplied ("ở thêm 2 ngày", "one
 * more night"). This is the same class of signal as CLOCK_TIME_SUPPLIED: it
 * turns a published-rate lookup into a request to compute THIS guest's total
 * — nightly rate × the number they just typed — which is exactly the
 * arithmetic rule 3 of this file's header says a 4B model must never attempt.
 *
 * Found live, and caught by the routing unit test that was already failing in
 * the suite: "Ở thêm 2 ngày mất bao nhiêu tiền?" reached the model, which
 * answered with the LATE CHECKOUT fee bands (50% / 100%) — a completely
 * different policy from extending a stay — plus a nightly rate lifted from an
 * unrelated package passage. Nothing in the pipeline caught it: the figures it
 * quoted really do appear in the passages, so the numeric guard passed them.
 *
 * Deliberately narrow: it requires an explicit "extra/more" word next to the
 * unit, so an ordinary per-night rate lookup ("Phòng này bao nhiêu tiền một
 * đêm?", "How much does a room cost per night?") is untouched and still
 * answered locally.
 */
/* Written already-folded, and tested against fold(text) at every call site —
   see anyWord. "Ở thêm 2 ngày" and "O them 2 ngay" are the same request. */
/* "còn 4 ngày nữa mới đến" is a COUNTDOWN to arrival, not four extra nights of
   stay, and the bare "N ngày nữa" alternative could not tell them apart — so
   "Còn 4 ngày nữa mới đến mà tôi muốn huỷ phòng thì mất bao nhiêu?" escalated
   with no lookup while the answer (50% of the first night, 3-7 days out) sat in
   the cancellation policy. "còn" immediately before the number is what
   separates them: an extension is "ở thêm 4 đêm nữa", never "còn 4 đêm nữa". */
const EXTRA_NIGHTS_SUPPLIED =
  /(?:them|gia han|extra|another|additional|more)\s*\d*\s*(?:ngay|dem|night|nights|day|days)|(?<!\bcon\s)\d+\s*(?:ngay|dem|night|nights|day|days)\s*(?:nua|them|more|extra)|\d+\s*(?:박|泊|晚)\s*(?:더|多|更)|(?:더|もう|再)\s*\d+\s*(?:박|泊|晚)/iu;

/**
 * Ngày trả phòng đứng TRƯỚC hoặc TRÙNG ngày nhận phòng — lỗi logic thuần
 * tuý, đúng bất kể lịch giá/PMS nào. "Nhận phòng 10/09 và trả phòng 08/09"
 * là bất khả thi theo bất kỳ nghĩa nào; retrieval vẫn trả về đoạn phòng bình
 * thường và model tự tin trả lời — không đoạn văn nào có thể sửa việc đó vì
 * đây không phải câu hỏi thiếu tài liệu, mà là câu hỏi TỰ MÂU THUẪN.
 *
 * KHÔNG bắt "quá khứ" hay "quá xa tương lai" — hai điều đó cần biết "hôm nay"
 * của khách sạn và một lịch đặt phòng thật, ngoài tầm regex. Đây chỉ bắt thứ
 * suy được từ chính hai con số trong câu, không cần biết gì thêm.
 */
function ngayTraPhongDaoNguoc(text: string): boolean {
  const f = fold(text);
  const ds = [...f.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g)];
  if (ds.length < 2) return false;
  const soHoa = (m: RegExpMatchArray) => {
    const nam = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : 2100;
    return nam * 10000 + Number(m[2]) * 100 + Number(m[1]);
  };
  return soHoa(ds[1]) <= soHoa(ds[0]);
}

/**
 * Số đêm phi lý (>30) — vượt quá mức một hệ thống đặt phòng online thường xử
 * lý, cần bộ phận lưu trú dài hạn xem riêng.
 *
 * CHỈ bắt "đêm", KHÔNG bắt "ngày". Sau khi bỏ dấu, "ngày" (đơn vị thời gian)
 * và "ngay" (phó từ "ngay lập tức", vốn đã không dấu) gập về CÙNG một chuỗi
 * — y hệt lỗi "thẻ"≡"thế" đã sửa ở clarify.ts. Bắt "ngày" ở đây từng biến
 * "phòng 202 ngay" ("làm ngay") thành dương tính giả "202 ngày ở". "đêm"
 * không có va chạm này nên an toàn để bắt một mình. Đo trên 461 câu: 0
 * dương tính giả.
 */
function soDemPhiLy(text: string): boolean {
  const m = fold(text).match(/\b(\d{1,3})\s*dem\b/);
  return !!m && Number(m[1]) > 30;
}

export function isPriceInfoOnly(text: string): boolean {
  const t = fold(text);
  if (EXTRA_NIGHTS_SUPPLIED.test(t)) return false;
  return /gia|bao nhieu|nhieu tien|bang gia|price|cost|how much|fee|rate/i.test(t) &&
    !/dat|book|reserve|mua|thanh toan|huy|cancel|order/i.test(t);
}

export function isPolicyInfoOnly(text: string): boolean {
  const t = fold(text);
  if (EXTRA_NIGHTS_SUPPLIED.test(t)) return false;
  /* CJK policy nouns and question forms. Without them "취소 정책이
     무엇인가요?" (what is the cancellation policy) reached the transaction
     lane through the stay_changes family — a published policy lookup handed
     to a person. The Vietnamese and English halves of this test had covered
     that shape since Phase 9; the CJK half simply did not exist. */
  if (/정책|규정|약관|ポリシー|規定|方針|規約|政策|规定|条款/u.test(text) &&
      !/취소해|환불해|바꿔|해주세요|してください|お願いします|帮我|请帮/u.test(text)) return true;
  return /quy dinh|chinh sach|khung gio|the nao|nhu the nao|bao nhieu|may gio|policy|rule|rules|information|info/i.test(t) &&
    !/toi muon|giup toi|dang ky|thuc hien|xac nhan|chuyen|dat|book/i.test(t);
}

export function classifyLocal(text: string, isEmergency: boolean): LocalRoute {
  if (isEmergency) return "emergency";
  /* Tự mâu thuẫn hoặc phi lý theo chính con số khách gõ — không cần tra tài
     liệu để biết sai, nên đặt TRƯỚC family scoring. Ca thật bắt được: "Tôi
     muốn Deluxe Suite King Ocean View từ 20/09 đến 22/09" (ngày hợp lệ,
     KHÔNG rơi vào đây) trả lời được bình thường, còn "nhận phòng 10/09 và
     trả phòng 08/09" thì không — phân biệt đúng hai loại mà một luật chặn
     rộng "có ngày + có ý định đặt phòng" sẽ gộp nhầm làm một. */
  if (ngayTraPhongDaoNguoc(text) || soDemPhiLy(text)) return "complex";
  const scored = scoreFamilies(text);
  const top = scored[0]?.family;

  /* Diacritics stripped once, for every pattern below. `anyWord` folds on its
     own; the bare regexes cannot, and a guest typing "toi co 5 trieu" must hit
     the same rules as one typing "tôi có 5 triệu". */
  const folded = fold(text);

  const hardMoney = anyWord(text, HARD_MONEY_WORDS);
  /* An amount the GUEST typed ("tôi có 5 triệu") signals they want reasoning
     over a number they supplied, not a lookup — always escalates. */
  const guestSuppliedAmount = MONEY_AMOUNT.test(folded);
  /* EXTRA_NIGHTS_SUPPLIED sits here beside CLOCK_TIME_SUPPLIED because it is
     the same signal: a number the GUEST supplied that has to be multiplied by
     a published rate to answer them. Deciding it here, before any family
     scoring, is also what makes it work in every language the kiosk serves —
     toolrouter's `stay_changes` lexicon has Vietnamese cues only, so
     "How much for one more night?" and "I want to stay one more night, how
     much?" score ZERO families and fell straight through to the knowledge
     lane. The Vietnamese sentence had a safety net; the English one never
     did. A regex over the guest's own digits does not care which language
     the sentence is in. */
  const needsPersonalOrSum =
    anyWord(text, PERSONAL_ACCOUNT_WORDS) ||
    anyWord(text, SUM_WORDS) ||
    CLOCK_TIME_SUPPLIED.test(folded) ||
    EXTRA_NIGHTS_SUPPLIED.test(folded);
  const quantityCue = anyWord(text, ARITHMETIC_WORDS);

  if (guestSuppliedAmount) return "complex";
  /* Extra nights + any price/quantity cue is a computed total, checked on its
     own rather than only through `hardMoney` above. "Tôi ở thêm 3 đêm nữa thì
     hết bao nhiêu?" names no money word at all — "hết bao nhiêu" (how much
     does it come to) is a quantity cue — so the hardMoney branch never sees
     it, and COUNTING_UNITS then releases it because "đêm" is a counting unit.
     It reached `transaction`, which is safe but still spends a model call
     drafting an answer on the Info-First path — the exact path that produced
     the wrong late-checkout figures. `complex` hands it to a person with zero
     model calls, which is what a request to multiply the guest's own number
     by a nightly rate deserves. */
  if (EXTRA_NIGHTS_SUPPLIED.test(folded) && (hardMoney || quantityCue)) return "complex";

  /**
   * A clock time is a KEY, not an OPERAND — so it routes to `transaction`.
   *
   * The two are not the same kind of number. "Tôi có 5 triệu" and "ở thêm 3
   * đêm" are operands: answering means multiplying the guest's figure by a
   * rate, and those keep escalating with no model call. A clock time is a key
   * into a published band table — the corpus already holds "12:00-18:00 -> 50%,
   * sau 18:00 -> 100%", and answering is a lookup, not arithmetic.
   *
   * Treating them alike cost real answers. Measured on the Vietnamese golden
   * set: four of eight banded-policy questions — late checkout at 15:00, early
   * arrival at 10:00 — were escalated with retrieval never running (passages 0,
   * llmCalls 0), so a guest asking the most common fee question got "please
   * wait for reception" while the answer sat in a document nobody asked the
   * retriever for. The same question WITHOUT a time ("What is the cancellation
   * fee?") already routed to `transaction` and answered, which made the split
   * arbitrary from the guest's side.
   *
   * `transaction` rather than `knowledge` because it is Info-First: it quotes
   * the published band AND still hands the turn to the front desk. The incident
   * this rule was written for — "I land at 8am. How much to check in early?",
   * where the model invented a time — is untouched, because that sentence names
   * no money word and still reaches `complex` through the quantity-cue branch
   * below. Where the new branch does fire, three protections that did not exist
   * then now do: the retrieval gate, numguard over the reply, and the handoff.
   */
  const personalOrSum =
    anyWord(text, PERSONAL_ACCOUNT_WORDS) ||
    anyWord(text, SUM_WORDS) ||
    EXTRA_NIGHTS_SUPPLIED.test(folded);
  if (hardMoney && personalOrSum) return "complex";
  if (hardMoney && CLOCK_TIME_SUPPLIED.test(folded)) return "transaction";
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
  if (
    top &&
    TRANSACTION_FAMILIES.includes(top) &&
    !(top === "housekeeping" && isWifiInfoOnly(text)) &&
    !(top === "transport_tours" && isTransportInfoOnly(text)) &&
    /* Scoped to `stay_changes`, NOT applied to every transaction family.
     *
     * These two started life unscoped, and that quietly disarmed the whole
     * gate. `isPolicyInfoOnly` fires on the bare words "thế nào" / "bao
     * nhiêu" / "mấy giờ", which is how a guest phrases a FAULT REPORT as
     * often as a policy lookup — so "Điều hoà phòng tôi bị hỏng, xử lý thế
     * nào?", "Wifi phòng tôi không vào được, phải làm thế nào?" and "Bồn
     * cầu phòng tôi bị tắc, xử lý thế nào?" were all released to the
     * knowledge lane. Reproduced end to end in the running kiosk: the guest
     * is answered "vui lòng liên hệ lễ tân", NO task is written to the ops
     * board, and nobody is dispatched. It also overrode the carefully
     * measured `isWifiInfoOnly` carve-out three lines above — every cue in
     * WIFI_FAULT_CUES had become unreachable, including the literal
     * "không vào được" in the sentence that failed.
     *
     * `stay_changes` is the one family whose lexicon genuinely mixes
     * published policy the KB can answer (late-checkout bands, cancellation
     * rules) with real actions, which is what these were written for — so
     * that is where they apply, in the same family-scoped shape the two
     * carve-outs above already use. housekeeping and transport_tours keep
     * their own precise carve-outs and nothing else. */
    !(top === "stay_changes" && (isPriceInfoOnly(text) || isPolicyInfoOnly(text)))
  )
    return "transaction";
  /* A write verb in an otherwise informational message ("tôi muốn đặt bàn tối
     nay") is a transaction, not a lookup. Two exclusions for the same reason:
     "đặt cọc" (the deposit, a noun) is not the verb "đặt" (to book), and
     "thanh toán bằng hình thức nào" (which payment methods exist — asking
     about a form/method) is not "thanh toán" as an imperative (pay now). */
  if (
    anyWord(text, WRITE_WORDS) &&
    /* The same exclusion the Vietnamese list needs, in the CJK scripts: a
       question ABOUT the cancellation policy is not a cancellation. Without
       it, adding CJK write verbs turned "予約のキャンセルポリシーは何ですか？"
       (what is the cancellation policy) into a transaction — a published
       policy lookup handed to a person for no reason. Policy nouns only;
       nothing here weakens an actual request to cancel. */
    !/dat coc|deposit|hinh thuc|phuong thuc|nen dat|dat phong nao|phu hop|cho \d+ nguoi|tu van|goi y/iu.test(folded) &&
    !/정책|규정|ポリシー|規定|方針|政策|规定|条款/u.test(text) &&
    !anyWord(text, RECOMMENDATION_CUES)
  )
    return "transaction";
  return "knowledge";
}

const BARE_AMBIGUOUS_PATTERNS = [
  /^(bao nhiêu|giá bao nhiêu|mấy giờ|ở đâu|có tốt không|được không|cái đó giá bao nhiêu|cái đó bao nhiêu|and the other one)\??$/i,
  /^(how much|what time|where is it|can i book|is it good)\??$/i,
  /^(얼마인가요|몇 시인가요|어디인가요)\??$/i,
  /^(多少钱|几点|在哪里)\??$/i,
  /^(いくらですか|何時ですか|どこですか)\??$/i,
];

/**
 * Widened 2026-08-29 after the Vietnamese golden set scored clarification 0/6.
 *
 * The patterns above are anchored end to end, so they only ever matched a bare
 * fragment typed on its own. Real guests do not write "giá bao nhiêu" — they
 * write "Giá bao nhiêu ạ?", and that trailing particle alone was enough to miss
 * it. Every ambiguous question in the set was therefore answered with a guess,
 * including "Cho tôi đặt lúc 7 giờ nhé", which came back quoting a 50%
 * early-check-in fee for a transaction the guest had never mentioned.
 *
 * `needsClarification` replaces the fragment list with a rule that survives
 * ordinary phrasing: an attribute named, no subject named, message short. The
 * old patterns stay as a fast path, so nothing previously caught stops being
 * caught.
 */
export function isBareAmbiguousQuery(question: string): boolean {
  const q = question.trim().toLowerCase();
  if (BARE_AMBIGUOUS_PATTERNS.some((p) => p.test(q))) return true;
  return needsClarification(question) !== null;
}

export function generateClarificationReply(lang: ReplyLang): string {
  if (lang === "en") {
    return "Could you please specify which room type, restaurant, or service you are inquiring about?";
  }
  if (lang === "ko") {
    return "문의하시고자 하는 객실 유형, 레스토랑 또는 서비스 이름을 말씀해 주시겠습니까?";
  }
  if (lang === "zh") {
    return "请问您想咨询哪种房型、餐厅或服务项目？";
  }
  if (lang === "ja") {
    return "お調べするお部屋のタイプ、レストラン、またはサービス名をお教えいただけますか？";
  }
  return "Quý khách vui lòng cho biết rõ thông tin về loại phòng, nhà hàng hoặc dịch vụ nào quý khách muốn tìm hiểu ạ?";
}

/* ------------------------------------------------------------ retrieval gate */

export type GateVerdict = {
  ok: boolean;
  /** Why the gate refused, for the trace and for the operator. */
  reason?: "no_match" | "low_score" | "unverified_only";
  passages: Retrieved[];
  topScore: number;
};

/* --------------------------------------------------------- room rate facts */

/**
 * The authoritative nightly rate for a room the guest named, straight from the
 * structured `room_packages` table.
 *
 * Each room category is published as a LADDER of packages — seven for a
 * Deluxe, six for a villa — identical rooms at rising prices, each adding
 * inclusions (breakfast, then VinWonders, then full board, then golf). That is
 * a deliberate upsell design, not duplicate data, and `packagesForRoom()`
 * already returns it cheapest-first, which is exactly the shape a quote needs:
 * quote [0], and let the rest be what more money buys.
 *
 * The offline path could not see any of it. `recommend_room_packages` is
 * withheld from the local model on purpose (see OPENAI_ONLY_TOOLS in agent.ts
 * — a 4B model upsells badly), but withholding the TOOL also withheld the
 * FACTS, so this path was pricing rooms by reading whichever prose chunk
 * survived retrieval and compression. Three consequences, all reproduced:
 *
 *   - "Giá phòng Deluxe giường đôi được công bố là 100%" — reported live. No
 *     price reached the model at all, so it quoted a percentage from a
 *     late-checkout clause.
 *   - The villa was quoted at 21.890.000đ as its "giá niêm yết tốt nhất" when
 *     the cheapest package is 13.850.000đ. "Giá Công Bố Tốt Nhất" is a
 *     marketing NAME that repeats across four different prices in the same
 *     ladder, so a model that trusts the label picks an arbitrary rung.
 *   - The same question phrased three ways led with three different figures,
 *     because each phrasing retrieved a different chunk.
 *
 * So the price is computed here, in ordinary TypeScript, and handed to the
 * model as a fact it may not choose — the same treatment check-in time already
 * gets. The model does no ordering, no comparison and no arithmetic; it only
 * writes the sentence. That keeps the deliberate "no model-driven upsell"
 * decision intact while closing the fact gap underneath it.
 *
 * Rendered from `public_price` order alone, never from the package's name.
 *
 * WHICH room is resolved twice, and the second way is the one that generalises.
 *
 * Matching the guest's own words is precise but narrow: it is lexical, over a
 * hand-written vi/en vocabulary, so it recognised 6 of 17 real phrasings.
 * Measured on the misses, the guest got the old failure back — a Korean guest
 * was told the cheapest package was "'Grand Deluxe Giường Đôi' 3,930,000" for
 * a question about the Deluxe (wrong room, wrong price, stated confidently), a
 * Chinese guest got the Grand Deluxe's rate under 豪华大床房, and a typo'd
 * Vietnamese question got 6.260.000đ labelled "Giá Công Bố Tốt Nhất" — the
 * wrong rung again. Extending the vocabulary by hand would chase phrasings
 * forever and never reach Korean.
 *
 * The retriever already solved this. bge-m3 ranked the correct room's chunk
 * FIRST for every one of those misses — Korean, Russian, Chinese, Japanese and
 * the typo — because a multilingual embedding does not care how the guest
 * spelled it. And the passages it returns are titled by OUR code ("Deluxe
 * Giường Đôi — phòng", "Gói giá phòng — Deluxe giường đôi"), always correctly
 * spelled. So the fallback matches the same catalogue names against the
 * TITLES rather than against the guest's typing: lexical matching against a
 * string we control, with the multilingual work done upstream by the embedder.
 *
 * Top two distinct rooms, not one: retrieval's rank 1 is not always the right
 * room (a typo'd Deluxe question put Grand Deluxe first), and naming both —
 * each with its own price — leaves the model a reading task it can do instead
 * of a guess we would have made for it.
 */
export function buildRoomRateBlock(
  question: string,
  lang: ReplyLang,
  passages: { title: string }[] = [],
): string | undefined {
  /* Only when the guest is actually asking about money. A room question that
     is not about price ("Villa 3 phòng ngủ hướng biển có gì?") should not be
     answered with a rate it did not ask for, and every line here costs
     context this path does not have to spare. */
  if (!anyWord(question, HARD_MONEY_WORDS) && !anyWord(question, ARITHMETIC_WORDS)) return undefined;

  const catalogue = storage.listRoomTypes().map((r) => ({ name: r.nameVi, alt: r.code, item: r }));
  let rooms = namedEntities(question, catalogue);

  if (!rooms.length && passages.length) {
    const seen = new Set<string>();
    rooms = [];
    for (const p of passages) {
      for (const r of namedEntities(p.title, catalogue)) {
        if (seen.has(r.code)) continue;
        seen.add(r.code);
        rooms.push(r);
      }
      if (rooms.length >= 2) break;
    }
    rooms = rooms.slice(0, 2);
  }
  if (!rooms.length) return undefined;

  const money = (n: number) => `${Math.round(n).toLocaleString("vi-VN")}đ`;
  const lines: string[] = [];

  /* Labels in the guest's own language.
   *
   * This block used to render in Vietnamese or English only, so a Korean,
   * Japanese, Chinese or Russian guest was handed an ENGLISH fact block —
   * and the model copied its wording straight through. Measured live on
   * qwen2.5:3b: "Deluxe Giường Đôi의 cheapest package 요금은 3.580.000đ/night
   * 입니다" — English fragments embedded in a Korean sentence, which is
   * exactly the language-purity failure the evaluation was penalising. The
   * facts were right; the label language was the bug, and it was mine.
   *
   * Kept to five short words per language so the block stays cheap in a
   * context this path cannot spare. */
  const L = {
    vi: { cheapest: "gói rẻ nhất", night: "đêm", member: "hội viên Pearl Club", highest: "Gói cao nhất", includes: "gồm", breakfast: "bữa sáng buffet", fullBoard: "buffet sáng/trưa/tối", sauna: "xông hơi & jacuzzi", cableCar: "cáp treo", golf: "vòng golf", credit: "hotel credit", header: "Giá phòng chính thức (dùng số này, không lấy số khác)" },
    en: { cheapest: "cheapest package", night: "night", member: "Pearl Club member", highest: "Highest package", includes: "includes", breakfast: "buffet breakfast", fullBoard: "full board", sauna: "sauna & jacuzzi", cableCar: "cable car", golf: "golf rounds", credit: "hotel credit", header: "Official room rates (use these figures, not any others)" },
    ko: { cheapest: "최저가 패키지", night: "박", member: "Pearl Club 회원가", highest: "최고가 패키지", includes: "포함", breakfast: "조식 뷔페", fullBoard: "조식·중식·석식", sauna: "사우나 & 자쿠지", cableCar: "케이블카", golf: "골프 라운드", credit: "호텔 크레딧", header: "공식 객실 요금 (이 숫자만 사용하십시오)" },
    ja: { cheapest: "最安パッケージ", night: "泊", member: "Pearl Club 会員価格", highest: "最高額パッケージ", includes: "込み", breakfast: "ビュッフェ朝食", fullBoard: "朝食・昼食・夕食", sauna: "サウナ & ジャグジー", cableCar: "ケーブルカー", golf: "ゴルフラウンド", credit: "ホテルクレジット", header: "公式客室料金 (この数字のみ使用)" },
    zh: { cheapest: "最低价套餐", night: "晚", member: "Pearl Club 会员价", highest: "最高价套餐", includes: "包含", breakfast: "自助早餐", fullBoard: "早午晚餐", sauna: "桑拿和按摩浴缸", cableCar: "缆车", golf: "高尔夫轮次", credit: "酒店消费额度", header: "官方房价 (仅使用这些数字)" },
    ru: { cheapest: "самый дешёвый пакет", night: "ночь", member: "цена для членов Pearl Club", highest: "самый дорогой пакет", includes: "включает", breakfast: "завтрак-буфет", fullBoard: "завтрак, обед и ужин", sauna: "сауна и джакузи", cableCar: "канатная дорога", golf: "раундов гольфа", credit: "отельный кредит", header: "Официальные тарифы (используйте только эти цифры)" },
  } as const;
  const t = L[lang as keyof typeof L] ?? L.en;
  const vi = lang === "vi";

  /* Two rooms is already a comparison; more than that is a catalogue dump
     that would crowd out the retrieved passages in an 8K context. */
  for (const r of rooms.slice(0, 2)) {
    const pkgs = storage.packagesForRoom(r.code);
    if (!pkgs.length) continue;
    /* Two packages can share the cheapest public price with only one of them
       carrying a Pearl Club rate — Deluxe Giường Đôi has exactly that at
       3.580.000đ. At an equal price the member rate is strictly better for
       the guest, so it wins the tie; `packagesForRoom` orders by price alone
       and would otherwise hand back whichever row was inserted first. */
    const floor = pkgs[0].publicPrice;
    const cheapest = pkgs.filter((p) => p.publicPrice === floor).sort((a, b) => (b.memberPrice ? 1 : 0) - (a.memberPrice ? 1 : 0))[0];
    const dearest = pkgs[pkgs.length - 1];

    /* Inclusions are localised for the same reason the labels are: whatever
       English appears in this block can end up quoted verbatim inside a
       Korean or Japanese sentence. Proper nouns (Aquafield, VinWonders,
       Pearl Club) stay as they are — they are brand names in every language. */
    const perks: string[] = [];
    if (cheapest.mealPlan === "breakfast") perks.push(t.breakfast);
    if (cheapest.mealPlan === "full_board") perks.push(t.fullBoard);
    if (cheapest.aquafield) perks.push("Aquafield");
    if (cheapest.saunaJacuzzi) perks.push(t.sauna);
    if (cheapest.cableCar) perks.push(t.cableCar);
    if (cheapest.vinwonders) perks.push("VinWonders");
    if (cheapest.golfRounds) perks.push(`${cheapest.golfRounds} ${t.golf}`);
    if (cheapest.hotelCredit) perks.push(`${t.credit} ${money(cheapest.hotelCredit)}`);

    const member = cheapest.memberPrice ? `, ${t.member} ${money(cheapest.memberPrice)}` : "";
    /* Kept to one short clause with a single figure in it. An earlier, wordier
       version ("Còn 6 gói cao hơn, tới 8.360.000đ/đêm, thêm tiện ích") was
       paraphrased loosely by the model, which reported the ceiling as
       6.260.000đ once and invented a "từ 4.600.000 đến" range another time.
       Fewer numbers in the sentence, fewer numbers to get wrong. */
    const ladder =
      pkgs.length > 1 ? ` ${t.highest}: ${money(dearest.publicPrice)}/${t.night}.` : "";

    lines.push(
      `${r.nameVi}: ${t.cheapest} ${money(cheapest.publicPrice)}/${t.night}${member}` +
        (perks.length ? ` (${t.includes} ${perks.join(", ")})` : "") +
        `.${ladder}`,
    );
  }

  if (!lines.length) return undefined;
  return `${t.header}:\n${lines.join("\n")}`;
}

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

  /* Deliberately OUTSIDE the passage list, so selectRelevantWindow never sees
     it. That function compresses each passage to PASSAGE_CHAR_CAP and is
     precisely what deleted every price in the reported failure; a figure that
     is authoritative must not be able to be trimmed away to make room for
     prose. Placed before the passages for the same reason `factBlock` is:
     a small model reads the head of its context most reliably. */
  const rateFacts = buildRoomRateBlock(question, lang, passages);
  const rateBlock = rateFacts ? `${rateFacts}\n\n` : "";

  const context =
    factBlock +
    rateBlock +
    noteBlock +
    passages
      .map((p, i) => {
        /* Retrieved text is data, not instruction. The knowledge base is
           editable from the staff UI and its content lands in the most
           authoritative-looking slot in the prompt, so instruction-shaped
           sentences are removed BEFORE the window is chosen — otherwise the
           relevance window could select the injected sentence and nothing
           else. See server/untrusted.ts for why this is deterministic rather
           than a line in the prompt. */
        const safe = neutraliseUntrusted(p.content.replace(/\s+/g, " "), `passage "${p.title}"`).text;
        return `[${i + 1}] ${p.title}\n${selectRelevantWindow(safe, PASSAGE_CHAR_CAP, question)}`;
      })
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

  /* Two live, reproduced generation-layer bugs, both addressed here rather
   * than by touching retrieval (which was already correct in both cases):
   *
   *  - Wifi answered a plain "is it free?" question with a circular
   *    restatement of the question instead of the yes/no the passage already
   *    contained. Fixed by requiring the direct answer to come FIRST.
   *  - The model abstained on three separate live turns (dog, explosives,
   *    durian-sometimes) even though a passage stated a general rule that
   *    plainly covered the guest's specific case — it appears to require the
   *    question's own wording to appear in the passage before treating a
   *    match as real, which a general "CHỈ trả lời dựa trên tài liệu"
   *    instruction does not rule out. This line is a targeted mitigation,
   *    not the full investigation the recurring pattern still needs (see
   *    the roadmap) — it tells the model that a general rule applying to
   *    the guest's case counts as evidence, without loosening the "no facts
   *    outside the passages" guarantee that keeps ungrounded answers at 0%.
   */
  /* A separate, known qwen2.5:3b failure: given a passage listing several
   * time slots (e.g. a schedule with 3+ distinct times), the model
   * sometimes compresses them into a wrong single time or a wrong range
   * instead of reporting them as they appear. Naming the behavior directly
   * is cheap (one short clause) and is the documented mitigation to try
   * before accepting it as a hard model limitation — see the roadmap. */
  /* A third live gap, found while writing the regression test for the villa
   * fix above: a "giá bao nhiêu" question about a room/villa that has
   * several PACKAGE rates (room+breakfast, room+breakfast+cáp treo, ...)
   * retrieves several passages each naming its OWN "Giá Công Bố Tốt Nhất"
   * for a different package — there is no single canonical nightly rate to
   * report, and nothing previously told the model that. Instructing it to
   * name the lowest figure AS a package price, not as THE room rate, keeps
   * the reply grounded in a real number while not overclaiming certainty
   * the data does not have. */
  /* The pricing rules only make sense when a rate block is actually in this
     prompt, and they are the longest part of the instruction. Kept
     unconditional, the system prompt was 1382 characters (~432 tokens) on
     EVERY turn — 38% of the whole prompt for a short question like "mấy giờ
     ăn sáng?", and roughly 2.9s of prompt evaluation on this hardware, spent
     on rules that did not apply. Conditioning them costs nothing in accuracy
     (there is no block for the model to misread) and buys back the time on
     the majority of turns, which are not price questions. */
  const rateRules = !rateFacts
    ? ""
    : lang === "vi"
      ? " Nếu có khối 'Giá phòng chính thức', hãy lấy đúng số trong khối đó và báo GÓI RẺ NHẤT trước — tuyệt đối không lấy số tiền phòng từ đoạn tài liệu khác, và không tự chọn gói đắt hơn. Tên gói (VD 'Giá Công Bố Tốt Nhất') là tên thương mại lặp lại ở nhiều mức giá, không có nghĩa là gói rẻ nhất. Sau khi báo giá rẻ nhất, có thể nói thêm một câu ngắn rằng còn gói cao hơn kèm tiện ích, nếu khối đó có nêu."
      : " If an 'Official room rates' block is present, take the room price from it and quote the CHEAPEST package first — never take a room price from any other passage, and never pick a dearer package instead. A package's name (e.g. 'Giá Công Bố Tốt Nhất') is a marketing label repeated across several prices; it does not mean the cheapest one. After quoting the cheapest, you may add one short sentence noting that dearer packages exist with more inclusions, if that block says so.";

  const directnessInstruction =
    (lang === "vi"
      ? " Trả lời thẳng vào trọng tâm ngay câu đầu tiên — đừng lặp lại câu hỏi thay cho câu trả lời. Nếu câu hỏi có nhiều vế hoặc hỏi nhiều thông tin cùng lúc, hãy trả lời đầy đủ từng vế một, không bỏ sót vế nào. Nếu tài liệu nêu một quy định chung áp dụng đúng cho trường hợp khách hỏi, hãy dùng quy định đó để trả lời dù từ ngữ trong câu hỏi khác với tài liệu — chỉ từ chối khi tài liệu thực sự không nói gì liên quan. Nếu tài liệu liệt kê nhiều mốc giờ, hãy liệt kê đúng và đủ các mốc giờ đó, không gộp hay tự suy ra một mốc giờ khác. Khi tài liệu là BẢNG nhiều dòng theo hạng thẻ, mùa, bậc giờ hay điều kiện, hãy lấy con số ở dòng KHỚP CHÍNH XÁC điều kiện khách hỏi — khách hỏi hạng nào thì lấy số của hạng đó, hỏi mùa nào thì lấy số mùa đó, tuyệt đối không lấy số của dòng lân cận (VD hỏi Platinum thì không lấy số của Diamond). Nếu cho mức giá niêm yết phòng (VD: số tiền VNĐ/đêm) hoặc phần trăm phí dịch vụ, hãy ghi chính xác số tiền VNĐ hoặc loại giá được nêu, không viết chung chung như 'giá 100%'."
      : " Answer the actual question directly in your first sentence — never restate the question in place of an answer. If the question contains multiple parts or requests several details, answer every part completely without omitting any detail. If a passage states a general rule that plainly covers the guest's specific case, use it even if the guest's wording differs from the passage's — only decline when the passages truly say nothing relevant. If a passage lists several distinct times, report them exactly as listed — never merge them into a different single time. When a passage is a TABLE with several rows by tier, season, time-band or condition, take the figure from the row that EXACTLY matches what the guest asked — the tier they named, the season they named — never a neighbouring row (asked about Platinum, do not quote Diamond's figure). If passages mention room rates or fees, state the exact amount or fee conditions clearly without vague phrases.") +
    rateRules;

  const system =
    lang === "vi"
      ? `Bạn là lễ tân khách sạn. CHỈ trả lời dựa trên các đoạn tài liệu bên dưới.
Nếu tài liệu không chứa câu trả lời, hãy trả lời đúng một dòng: ${ABSTAIN}
Không suy đoán, không thêm số liệu nào không có trong tài liệu.
Trả lời ngắn gọn 1-3 câu, lịch sự, bằng tiếng Việt.${directnessInstruction}${historyInstruction}`
      : `You are a hotel concierge. Answer ONLY from the passages below.
If the passages do not contain the answer, reply with exactly one line: ${ABSTAIN}
Do not speculate and do not introduce any figure that is not in the passages.
Answer in 1-3 short, polite sentences.
The passages may be in Vietnamese or English; write your reply in ${replyIn}.${directnessInstruction}${historyInstruction}`;

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
/* Matched against folded text (diacritics stripped), so each pattern is
   written once in plain ASCII instead of twice with alternations. */
const ABSTAIN_PROSE = [
  // vi
  /khong co thong tin/i,
  /khong (?:duoc )?de cap/i,
  /chua (?:duoc )?de cap/i,
  /khong tim thay thong tin/i,
  /khong (?:the )?(?:tra loi|xac dinh|xac nhan) (?:duoc )?(?:cau hoi|thong tin|dieu)/i,
  /tai lieu (?:hien co |hien |da cung cap |nay )?khong (?:co|neu|chua|cung cap|noi|de cap)/i,
  // en
  /no information (?:about|on|regarding|available)/i,
  /(?:is |are )?not mentioned/i,
  /(?:do(?:es)? not|don't|doesn't) (?:contain|mention|include|specify|provide)/i,
  /(?:i )?(?:cannot|can't|am unable to) (?:find|determine|confirm|answer)/i,
  /* Passive voice — "is not specified" never matched the active-verb pattern
     above, and it is how the model phrases a refusal at least as often. */
  /(?:is|are|was|were) not (?:specified|provided|stated|listed|mentioned|available)/i,
  /* Naming the evidence is itself the refusal: a real answer has no reason to
     talk about "the provided passages". Same shape as the Vietnamese
     "tài liệu … không" pattern above. */
  /(?:in|from) the (?:provided|given|retrieved|available) (?:passages|documents|texts|information)/i,
  /* ru / ko / ja / zh — there were NO patterns for these at all, so a refusal
     in any of them reached the guest verbatim with the turn marked answered.
     Folding leaves these scripts untouched (fold re-composes with NFC), so
     they match the same way they would against raw text. */
  // ru
  /нет информации/i,
  /* Russian inflects, so match the stem: "не указан", "не указана",
     "не имеет указанной цены" are the same refusal in three cases. */
  /не указан|не имеет указанн/i,
  /отсутствует информация/i,
  /не содержит|не упомин/i,
  /в предоставленных (?:текстах|документах|материалах)/i,
  // ko
  /정보가 없|정보는 없|정보를 찾을 수 없/,
  /언급되지 않|명시되지 않/,
  /확인할 수 없습니다/,
  // ja
  /情報(?:が|は)(?:ありません|見つかりません)/,
  /記載(?:が|は)ありません/,
  /言及されていません/,
  // zh
  /没有(?:相关)?(?:信息|说明|提到|提供)/,
  /未(?:提及|说明|提供)/,
  /无法(?:确定|回答|找到)/,
];

/**
 * The abstain token, as a phrase rather than an identifier.
 *
 * The model is taught to emit `KHONG_DU_THONG_TIN`, and it very often emits
 * exactly those words written the way Vietnamese is normally written —
 * "Không đủ thông tin về việc này" — which the identifier pattern misses
 * because of the underscores. Measured on eight real refusal phrasings, six
 * leaked, and this was the most common one: the model was doing precisely
 * what it was told, and the pipeline treated its refusal as an ANSWER, shipped
 * it to the guest, and marked the turn resolved so no human ever saw it.
 * Live: "Resort có sân bay riêng không?" came back as "Khong du thong tin về
 * việc resort có sân bay riêng hay không." followed by a booking handoff.
 *
 * Separators are normalised so the underscored token, the spaced phrase and
 * any hyphenated variant are one thing. The phrase is specific enough that a
 * genuine answer never contains it — "Không được mang thú cưng" is a real
 * answer and shares no part of it.
 */
const ABSTAIN_PHRASE = new RegExp(ABSTAIN.split("_").join("[\\s_-]+"), "i");

export function isAbstention(reply: string): boolean {
  const text = reply ?? "";
  if (!text.trim()) return false;
  /* Strip diacritics before comparing, so "KHÔNG_DU_THONG_TIN", the plain
     "Không đủ thông tin" and the unaccented "Khong du thong tin" are all the
     same refusal. */
  const folded = fold(text);
  if (ABSTAIN_PHRASE.test(folded)) return true;
  return ABSTAIN_PROSE.some((re) => re.test(folded));
}

/**
 * The sentence appended when a turn is answered AND handed to a person.
 *
 * This was one fixed string about completing a room booking, appended to every
 * reply on the transaction path regardless of what the guest had asked. A
 * guest reporting a broken air-con was told "để hoàn tất thủ tục đặt phòng và
 * chọn ngày lưu trú"; so was a guest asking whether the resort has its own
 * airport. The information above it was right and the sentence under it was
 * nonsense, which is the kind of thing a guest notices immediately and reads
 * as the whole system not understanding them.
 *
 * Keyed off the tool router's family — the same classification that put the
 * turn on this path — with a neutral default, so a family this does not know
 * about gets a sentence that is merely general rather than wrong.
 */
export function handoffNote(family: FamilyName | undefined, lang: ReplyLang): string {
  const vi = lang === "vi";
  const line = (viText: string, enText: string) => `\n\n${vi ? viText : enText}`;

  switch (family) {
    case "housekeeping":
      return line(
        "Dạ, em đã chuyển yêu cầu cho bộ phận phụ trách để xử lý sớm nhất cho anh/chị ạ.",
        "I have passed this to our housekeeping and maintenance team to take care of it as soon as possible.",
      );
    case "stay_changes":
      return line(
        "Dạ, em đã chuyển yêu cầu cho Lễ tân để kiểm tra và xác nhận lại với anh/chị ạ.",
        "I have passed this to our front desk to check and confirm it with you.",
      );
    case "transport_tours":
      return line(
        "Dạ, em đã chuyển thông tin cho bộ phận vận chuyển để sắp xếp và xác nhận với anh/chị ạ.",
        "I have passed this to our transport desk to arrange and confirm with you.",
      );
    case "room_shopping":
      return line(
        "Dạ, để hoàn tất đặt phòng và chọn ngày lưu trú, em đã chuyển thông tin cho Lễ tân hỗ trợ anh/chị ngay ạ.",
        "To complete the reservation and confirm your stay dates, I have passed this to our front desk to assist you right away.",
      );
    default:
      return line(
        "Dạ, em đã chuyển thông tin cho nhân viên phụ trách hỗ trợ anh/chị ngay ạ.",
        "I have passed this to the team responsible so they can help you right away.",
      );
  }
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
/**
 * Repair digit-group separators the model split with a space.
 *
 * The KB stores prices in English notation ("2,700,000"). Asked in Vietnamese,
 * the model rewrites them to Vietnamese notation and frequently emits
 * "2. 200. 000 VNĐ" — separator, then a space, then the next group. A guest
 * reading a spa price list sees seven of those in one paragraph and the answer
 * looks broken even though every figure is right.
 *
 * Deterministic and language-independent: it only closes a space sitting
 * between a group separator and exactly three digits, which is never valid
 * anywhere. It cannot join two different numbers ("phòng 101 202" has no
 * separator) and it does not touch decimals or clock times.
 */
export function normaliseNumberSpacing(text: string): string {
  let s = text;
  let prev: string;
  /* Run to a fixed point: overlapping groups need more than one pass. */
  do {
    prev = s;
    s = s.replace(/(\d)([.,])\s+(\d{3})(?!\d)/g, "$1$2$3");
  } while (s !== prev);
  return s;
}

export function cleanSpuriousCjk(text: string, lang: ReplyLang | string): string {
  if (lang === "vi" || lang === "en") {
    let s = text.replace(/không\s*晚于/gi, "không muộn hơn ");
    s = s.replace(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g, " ");
    return normaliseNumberSpacing(s.replace(/\s+/g, " ").trim());
  }
  return normaliseNumberSpacing(text);
}

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
    let text = (r.choices[0]?.message?.content ?? "").trim();
    text = cleanSpuriousCjk(text, lang);
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
  /**
   * The authoritative room-rate facts this turn was given, when it had any.
   *
   * Carried out of the turn because it is EVIDENCE that lives outside
   * `passages` — the caller runs the numeric guard again, and without this the
   * guard grounds against the passage list alone and strips the very price
   * this block supplied. See the guard call in runLocalTurn for the live
   * symptom.
   */
  rateFacts?: string;
};

/**
 * Run one offline turn.
 *
 * Everything before the single model call is deterministic, so a turn that ends
 * in escalation costs no inference at all — which is what keeps the offline path
 * fast on hardware that has to share 4GB of VRAM.
 */
export function enrichPassagesWithStructuredData(question: string, passages: Retrieved[]): Retrieved[] {
  const result = [...passages];
  const qFolded = fold(question);

  // Enrich with Spa / Services items
  const services = storage.listServices();
  for (const s of services) {
    const sNameFolded = fold(s.name);
    if (
      qFolded.includes(sNameFolded) ||
      sNameFolded.includes(qFolded) ||
      (qFolded.includes("spa") && s.category === "spa")
    ) {
      const priceText = s.price > 0 ? `${s.price.toLocaleString("vi-VN")} VNĐ` : "Miễn phí";
      result.unshift({
        title: s.name,
        category: "service",
        content: `Dịch vụ ${s.name} (danh mục: ${s.category}): Mức giá niêm yết chính thức là ${priceText}. Mô tả: ${s.description || "Dịch vụ đẳng cấp tại Aurea Resort"}.`,
        /* Ranked first on purpose: when the guest named this exact service, its
           own record should outrank anything BM25 fused. That is a placement
           decision, not a retrieval score — which is why it is a flat 1.0
           rather than something in the 0.02 range real fusion produces. */
        relevance: 1.0,
        source_url: null,
        matched_by: "bm25",
        /* -1 is this file's "not measured" sentinel (see gateRetrieval). It
           used to be 1.0, which asserted perfect coverage of the guest's
           question for a row nobody had measured against it. */
        coverage: -1,
        quality: "curated",
        /* The `services` table carries no provenance column at all, so nothing
           here could make this verified. It used to say "verified"
           unconditionally — and the prompt's unverified-passage caution is
           driven by exactly this field, so a synthetic row could carry an
           unconfirmed price into an answer with the warning suppressed. */
        verified: "unverified",
        content_class: "dynamic",
      });
    }
  }

  /* Enrich with the room types the guest actually named.
   *
   * The test used to be `question contains "deluxe" && room name contains
   * "deluxe"`, which matched all EIGHT Deluxe/Grand Deluxe types on any
   * mention of the word, and unshifted each one to the FRONT of the passage
   * list. A five-passage retrieval became thirteen, the three chunks that
   * actually held the rates were pushed to positions 9, 10 and 13, and the
   * model — which this file's own header notes loses the middle of a long
   * context — read eight near-identical descriptions first.
   *
   * The cost was not just wasted context, it was wrong numbers. Traced live:
   * "Grand Deluxe giường đôi giá bao nhiêu?" was answered "khoảng 4.600.000
   * VNĐ/đêm", which is the PLAIN Deluxe's published rate — the plain
   * Deluxe's record had been pulled in beside the Grand Deluxe's, and every
   * figure in the reply was grounded in some passage, so the numeric guard
   * had nothing to object to. Cross-attribution is invisible to a check that
   * only asks "does this number appear somewhere".
   *
   * `namedEntities` enforces whole adjacent tokens and most-specific-wins,
   * so "grand deluxe queenbed" brings in the Grand Deluxe and not the plain
   * Deluxe nested inside its name. */
  const named = namedEntities(
    question,
    storage.listRoomTypes().map((r) => ({ name: r.nameVi, alt: r.code, item: r })),
  );
  for (const r of named) {
    {
      result.unshift({
        title: `${r.nameVi} — phòng`,
        category: "room_type",
        content: `Hạng phòng ${r.nameVi} (${r.code}): Diện tích ${r.areaSqm || 42}m², tối đa ${r.maxGuests || 2} khách. Hướng: ${r.oceanView ? "Hướng biển" : "Hướng vườn"}. Mô tả & bảng giá niêm yết: ${r.description || ""}.`,
        /* See the service branch above for why relevance is a flat 1.0 and
           coverage is the -1 sentinel rather than a fabricated 1.0. */
        relevance: 1.0,
        source_url: r.sourceUrl ?? null,
        matched_by: "bm25",
        coverage: -1,
        quality: "curated",
        /* Room types DO carry provenance — all ten rows have a source_url — so
           unlike services this can legitimately be verified. It is READ from
           the row rather than asserted, so a row that loses its source stops
           claiming to be confirmed. */
        verified: r.sourceUrl ? "verified" : "unverified",
        content_class: "dynamic",
      });
    }
  }

  return result;
}

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
  /** A running summary of turns OLDER than the recent-history window, condensing
   *  which entities the guest is interested in (a specific room, venue, service)
   *  and what has been discussed. Names entities, never figures — so a follow-up
   *  like "giá phòng lúc nãy?" can be pointed at the right room for retrieval to
   *  price freshly, without reintroducing the cross-topic NUMBER attribution the
   *  money-signal history gate exists to prevent. Empty for short conversations,
   *  so single-turn behaviour is unchanged. */
  summary?: string;
}): Promise<LocalTurn> {
  const search = input.search ?? hybridSearch;
  const route = classifyLocal(input.question, input.isEmergency);

  /**
   * Lời chào được trả lời ngay, không truy xuất, không gọi model.
   *
   * Đặt TRƯỚC bước hỏi lại vì một lời chào không thiếu thông tin — nó đã đầy
   * đủ, chỉ là không có gì để tra. Đo được trước khi có bước này: "xin chào"
   * lấy về năm đoạn vô quan (giờ nhà hàng, nội quy) với topScore 0,0082 rồi
   * model 4B trả lời "Bạn có thể hỗ trợ tôi về những vấn đề nào?" — mời khách
   * giúp đỡ chính nó, ở đúng câu đầu tiên khách đọc.
   */
  /* KHÔNG chặn theo lịch sử, khác với bước hỏi lại ngay dưới. "Bao nhiêu?" cần
     lịch sử để biết đang hỏi gì, còn "xin chào" thì không — nó là lời chào dù
     đứng ở lượt đầu hay lượt thứ mười. Bản đầu có chặn, và vì mọi hội thoại
     thật đều có lịch sử nên bước này không bao giờ chạy. */
  const greet = greetingReply(input.question, input.lang as GreetLang);
  if (greet) {
    return {
      route: "knowledge",
      reply: greet,
      escalate: false,
      passages: [],
      topScore: 1.0,
      llmCalls: 0,
    };
  }

  /* Naming what is missing beats a generic "please be more specific": the
     guest asked about opening hours, so the reply lists the places that HAVE
     opening hours instead of asking them to start over. */
  const specific = needsClarification(input.question, input.lang as ClarifyLang);
  /**
   * "Photos" bypasses the `!input.history` gate every other attribute
   * respects — see the "photos" case in clarify.ts's ATTRIBUTES for why.
   * Short version: "giá thế nào" after the guest just asked about a room
   * resolves fine from context (retrieval + the reply naming that room), so
   * re-asking on turn 2 would just be annoying — that is what `!input.history`
   * protects. A photo request has no such natural fallback subject unless a
   * room/venue/service was actually named recently.
   *
   * Bắt được qua hội thoại thật 2026-09-01: khách hỏi vị trí check-in (không
   * nêu phòng/nhà hàng/dịch vụ nào), rồi "cho tôi xem hình ảnh được không" —
   * lịch sử tồn tại nên gate cũ bỏ qua bước hỏi lại, câu hỏi rơi qua truy xuất
   * mơ hồ rồi bị chuyển thẳng cho nhân viên.
   *
   * CHỈ soi lời KHÁCH nói, VÀ CHỈ LƯỢT GẦN NHẤT — hai điều kiện, hai lỗi khác
   * nhau bắt được bằng chính hội thoại thật này:
   *
   *  1. Không soi lời TRỢ LÝ — cùng nguyên tắc đã áp cho thẻ phòng/dịch vụ
   *     ([[aurea-card-relevance-rule]]). Câu trả lời ngay trước đó là "Vị trí
   *     của khách sạn nằm ngay cạnh BÃI BIỂN" — "bãi biển" nằm trong SUBJECTS
   *     (cho câu hỏi giờ mở khu bãi biển). Soi cả lượt trợ lý khiến "cho tôi
   *     xem ảnh" bị hiểu nhầm là đã có chủ thể "bãi biển", dù khách chưa từng
   *     nhắc gì tới nó.
   *  2. CHỈ lượt khách GẦN NHẤT, không phải toàn bộ cửa sổ lịch sử — cửa sổ 4
   *     lượt của `recentOfflineHistory()` (server/agent.ts) đủ dài để chứa
   *     một chủ đề đã CŨ: hội thoại thật này có "thực đơn" (menu — một SUBJECT
   *     hợp lệ) hai lượt khách trước đó, không liên quan gì tới ảnh. Soi toàn
   *     bộ cửa sổ sẽ bám vào chủ đề cũ đã qua thay vì hỏi lại đúng lúc.
   *
   * Lượt khách gần nhất là tín hiệu mạnh nhất cho "khách vẫn đang nói về gì":
   * "Tôi muốn xem phòng Deluxe" ngay trước "cho tôi xem ảnh" nên tin cậy được;
   * một chủ đề từ hai lượt trước thì không.
   */
  const lastGuestLine = (input.history ?? "")
    .split("\n")
    .reverse()
    .find((line) => /^kh[aá]ch\s*:/i.test(line.trim())) ?? "";
  const photoWithoutContext = specific?.attribute === "photos" && !mentionsKnownSubject(lastGuestLine);
  if ((isBareAmbiguousQuery(input.question) && !input.history) || photoWithoutContext) {
    return {
      route: "knowledge",
      reply: specific?.reply ?? generateClarificationReply(input.lang),
      escalate: false,
      passages: [],
      topScore: 1.0,
      llmCalls: 0,
    };
  }

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
    /* Hybrid Info-First: retrieve room/service details and rates so guest gets photos, details and pricing,
       while still escalating to front desk for actual reservation handling. */
    try {
      const found = await search(input.question, { k: LOCAL_PASSAGES });
      const gate = gateRetrieval(found.results, input.minScore ?? LOCAL_MIN_SCORE);
      if (gate.ok) {
        const enrichedPassages = enrichPassagesWithStructuredData(input.question, gate.passages);
        const answer = await answerFromPassages(
          input.question,
          enrichedPassages,
          input.lang,
          input.callChat,
          input.basics,
          undefined,
          found.note,
        );
        if (answer.reply) {
          /* Câu hỏi tri thức thuần tuý ("đổi tên mất phí bao nhiêu") không cần
             chuyển lễ tân — không còn việc gì để họ làm sau một câu trả lời
             đầy đủ. Chỉ giữ escalate cho yêu cầu hành động thật (xem
             looksLikePureInfoQuestion ở trên). */
          const pureQuestion = looksLikePureInfoQuestion(input.question);
          return {
            route,
            reply: pureQuestion
              ? cleanSpuriousCjk(answer.reply, input.lang)
              : cleanSpuriousCjk(answer.reply + handoffNote(scoreFamilies(input.question)[0]?.family, input.lang), input.lang),
            escalate: !pureQuestion,
            escalateReason: pureQuestion
              ? undefined
              : "Yêu cầu đặt phòng/dịch vụ — đã trả lời thông tin & chuyển lễ tân xác nhận.",
            /* The enriched list, like every other post-enrichment return: this
               branch also drafts an answer, so the trace and the caller's
               numeric guard must see the rows the model actually read. */
            passages: enrichedPassages,
            topScore: gate.topScore,
            llmCalls: 1,
          };
        }
      }
    } catch {
      /* Fallback to default escalation if retrieval fails */
    }

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
  /* A BARE attribute follow-up — "phạt bao nhiêu?", "giá bao nhiêu?", "bao lâu?"
     — names an attribute but no subject, so it only makes sense against the
     previous turn. needsConversationContext misses it (no pronoun / "còn"), and
     the money word in "phạt/giá" would anyway blank the history, so the live turn
     "làm hỏng ga giường?" → "phạt bao nhiêu?" retrieved smoking and lodging fines
     instead of the damage rule. Steer RETRIEVAL with the last exchange for these,
     independent of the money gate: retrieval only targets the right topic and
     cannot misattribute a number — the answer prompt below still keeps the money
     gate, and numguard still guards every figure. */
  const ATTR_CUE = /\b(bao nhiêu|bao lâu|phạt|giá|phí|mấy giờ|thế nào|ra sao)\b/i;
  const isBareFollowup =
    !!input.history && input.question.trim().split(/\s+/).length <= 6 && ATTR_CUE.test(input.question);
  let retrievalQuery =
    (useHistory || isBareFollowup) && lastExchangeOnly ? `${lastExchangeOnly}\n${input.question}` : input.question;
  /* When the current message REFERS BACK to something ("phòng lúc nãy", "nó",
     "cái đó", "còn … thì sao") but the referent has fallen out of the recent
     window, the running summary names the entity the guest means. Prepending it
     to the retrieval query points BM25/vectors at the right room/venue so the
     answer is priced/described from the correct document. It is added to the
     retrieval query ONLY (never asserted as fact) and only for a back-reference,
     so it cannot pull an unrelated topic into an ordinary question. Unlike the
     recent-history path, this is NOT gated on the money signal: the summary
     carries entities, not figures, so it disambiguates WHICH room without ever
     handing the model a number to misattribute. */
  const BACK_REFERENCE = /\bnó\b|\bđó\b|\bấy\b|\bnày\b|lúc nãy|ban nãy|vừa (?:nãy|rồi)|hồi nãy|còn .* thì sao|cái (?:kia|đó)/i;
  if (input.summary && BACK_REFERENCE.test(input.question)) {
    retrievalQuery = `${input.summary}\n${retrievalQuery}`;
  }
  const retrievalStart = Date.now();
  const found = await search(retrievalQuery, { k: LOCAL_PASSAGES });
  const retrievalMs = Date.now() - retrievalStart;
  /**
   * Đếm lượt truy xuất, và đếm riêng lượt KHÔNG lấy được đoạn nào.
   *
   * Đây là cảnh báo sớm quan trọng nhất của một hệ RAG: chỉ mục hỏng thì tỉ lệ
   * này vọt lên trong khi mọi thứ khác vẫn xanh — HTTP vẫn 200, model vẫn trả
   * lời, chỉ là trả lời mà không có tài liệu nào trong tay. Không có chỉ số này
   * thì triệu chứng duy nhất là khách phàn nàn.
   */
  recordRetrieval(found.results.length);

  /* The semantic net, placed here on purpose.
   *
   * The keyword router has already had its say and released this turn to the
   * knowledge lane. Its cue lists are complete for Vietnamese and English,
   * partial for Chinese and Korean, and EMPTY for Japanese and Russian — so
   * this is exactly where a Japanese "部屋のエアコンが壊れています" or a Russian
   * "Отмените моё бронирование и верните деньги" slips through to be answered
   * by the model instead of dispatched to a person.
   *
   * It runs AFTER retrieval so it can read the vector retrieval just computed
   * (see cachedQueryVector). That is the whole latency argument: 0.043ms of
   * cosine instead of a second 116ms embedding call. The lexicon keeps the
   * fast path — a turn it escalates never reaches this line at all.
   *
   * It can only ever ADD an escalation, never remove one. */
  const intentVerdict = shouldEscalateByIntent(retrievalQuery);
  if (intentVerdict) {
    return {
      route: "transaction",
      reply: null,
      escalate: true,
      escalateReason: `Yêu cầu cần nhân viên xử lý (nhận diện ngữ nghĩa, ${intentVerdict.score.toFixed(3)}).`,
      passages: found.results,
      topScore: found.results[0]?.relevance ?? 0,
      llmCalls: 0,
      retrievalMs,
    };
  }

  const gate = gateRetrieval(found.results, input.minScore ?? LOCAL_MIN_SCORE);
  if (!gate.ok) {
    return {
      route,
      reply: null,
      escalate: true,
      escalateReason: `Không đủ căn cứ trong kho tri thức (${gate.reason}).`,
      /* `gate.passages` is correct here and only here: the gate rejected, so
         nothing was ever enriched and the model never read anything. Every
         return AFTER enrichment reports `enrichedPassages` instead — the trace
         has to show what the model actually saw, or grounding cannot be
         debugged from it. The numeric guard reads the same list, and the
         synthetic rows are real evidence the model was given, so counting them
         is right there too. */
      passages: gate.passages,
      topScore: gate.topScore,
      llmCalls: 0,
      retrievalMs,
    };
  }

  const enrichedPassages = enrichPassagesWithStructuredData(input.question, gate.passages);
  const answer = await answerFromPassages(
    input.question,
    enrichedPassages,
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
      passages: enrichedPassages,
      topScore: gate.topScore,
      llmCalls: 1,
      retrievalMs,
      timing: answer.timing,
    };
  }

  /* The rate block is evidence too. It is deliberately kept OUT of the passage
     list so the compressor cannot trim it — but the numeric guard grounds
     claims against exactly that list, so the authoritative price looked
     ungrounded and was stripped from the reply. Seen live: a Chinese and an
     English answer lost their 3.580.000đ and shipped only the guard's "I need
     the front desk to confirm" notice, for a figure read straight out of
     `room_packages`. */
  const rateFacts = buildRoomRateBlock(input.question, input.lang, enrichedPassages);

  /* Non-numeric fabrication guard: a confident tier or required-document answer
     the passages do not actually support. Grounds against the same evidence the
     numeric guard uses, so it self-disables the moment the corpus gains the
     fact. Placed before the numeric guard so a trap short-circuits to a handoff
     rather than shipping an invented category. */
  if (answer.reply) {
    const evidenceText =
      enrichedPassages.map((p) => p.content).join("\n") + (rateFacts ? "\n" + rateFacts : "");
    const trap = checkCategoricalTraps(input.question, answer.reply, evidenceText);
    if (trap.abstain) {
      return {
        route,
        reply: null,
        escalate: true,
        escalateReason: `Câu trả lời khẳng định điều tài liệu không có (${trap.reason}) — chuyển nhân viên.`,
        passages: enrichedPassages,
        topScore: gate.topScore,
        llmCalls: 1,
        retrievalMs,
        timing: answer.timing,
      };
    }
  }

  if (answer.reply) {
    const numCheck = checkReply(answer.reply, {
      toolResults: rateFacts ? [rateFacts] : [],
      passages: enrichedPassages,
      guestText: input.question,
    });
    if (!numCheck.ok) {
      const repaired = repairReply(answer.reply, numCheck, input.lang === "vi" ? "vi" : "en");
      return {
        route,
        reply: repaired.text,
        escalate: repaired.escalate,
        escalateReason: "Phát hiện con số chưa verified trong CSDL — đã tự động sửa & bảo vệ.",
        passages: enrichedPassages,
        topScore: gate.topScore,
        llmCalls: 1,
        retrievalMs,
        timing: answer.timing,
        rateFacts,
      };
    }
  }

  return {
    route,
    reply: answer.reply,
    escalate: false,
    passages: enrichedPassages,
    topScore: gate.topScore,
    llmCalls: 1,
    retrievalMs,
    timing: answer.timing,
    rateFacts,
  };
}
