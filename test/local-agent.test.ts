/**
 * Offline (RAG-first) pipeline tests.
 *
 * The model call is injected, so the whole pipeline is exercised without a
 * running SLM — which matters, because the risk in this design lives in the
 * deterministic parts (what gets routed where, what gets refused, what never
 * reaches the model at all), not in the phrasing.
 *
 *   npx tsx test/local-agent.test.ts
 */

import {
  classifyLocal,
  gateRetrieval,
  buildAnswerPrompt,
  isAbstention,
  answerFromPassages,
  runLocalTurn,
  needsConversationContext,
  ABSTAIN,
  LOCAL_MIN_SCORE,
} from "../server/local-agent";
import type { Retrieved } from "../server/retrieval";

let failures = 0;
function ok(cond: boolean, msg: string) {
  if (cond) console.log(`  PASS  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}
function route(q: string, expected: string, note = "") {
  const got = classifyLocal(q, false);
  if (got === expected) console.log(`  PASS  "${q}" -> ${got}${note ? ` (${note})` : ""}`);
  else {
    failures++;
    console.error(`  FAIL  "${q}" -> ${got}, expected ${expected}`);
  }
}

const passage = (o: Partial<Retrieved> & { title: string; relevance: number }): Retrieved => ({
  category: "policy",
  source_url: null,
  content: "Giờ trả phòng tiêu chuẩn là 12:00. Trả phòng muộn tới 18:00 tính 50% giá phòng.",
  matched_by: "keyword",
  quality: "curated",
  verified: "verified",
  content_class: "static",
  ...o,
});

/* ------------------------------------------------------------------ routing */

console.log("=== ROUTING: knowledge stays local ===");
route("Mấy giờ ăn sáng?", "knowledge");
route("Hồ bơi mở đến mấy giờ", "knowledge");
route("Khách sạn có cho mang thú cưng không", "knowledge");
route("Spa có những liệu trình gì", "knowledge");

console.log("=== ROUTING: money and multi-step escalate ===");
/* A 4B model must never do folio arithmetic offline. */
route("Tổng hoá đơn của tôi bao nhiêu tiền", "complex", "money");
route("Tôi có 5 triệu thì nên đặt phòng nào", "complex", "budget reasoning");
route("Gói nào rẻ nhất cho 4 người", "complex", "multi-constraint");

console.log("=== ROUTING: writes go to a person ===");
route("Tôi muốn huỷ phòng", "transaction");
route("Đổi ngày trả phòng giúp tôi", "transaction");
route("Cho tôi đặt bàn tối nay", "transaction", "write verb inside a dining question");
route("Phòng tôi hết khăn tắm", "transaction", "housekeeping");

console.log("=== ROUTING: money shape escalates (regression) ===");
/* These reached the model as "knowledge" while the money regex was silently
   broken: JavaScript's \b does not fire before "đ", and a patch had eaten the
   backslashes so \d and \s matched the literal letters instead. A guest asking
   about an amount must never be answered by the 4B model. */
route("phòng này 2.500.000đ phải không", "complex", "money with đ");
route("giá 5 triệu có ổn không", "complex", "triệu");
route("dịch vụ spa 1200000 vnd", "complex", "vnd");
/* Phase 9: these two bare fragments ("how much money" / "tell me the cost",
   naming no entity at all) used to escalate purely because they contain a
   money word, with no notion of intent. They are now informational-shaped —
   knowledge routing lets retrieval and the gate decide whether there is
   anything to answer, rather than a keyword forcing a human handoff before
   retrieval runs at all. See server/local-agent.ts's classifyLocal comment
   and bench/baselines/kiosk-validation/09-ROUTING-AND-HALLUCINATION-REMEDIATION.md. */
route("hết bao nhiêu tiền", "knowledge", "Phase 9: bare fragment, no personal/sum signal, no entity — now a lookup attempt, not an auto-escalate");
route("cho tôi biết chi phí", "knowledge", "Phase 9: same — informational-shaped, not personal or a computed total");

console.log("=== ROUTING: money cues in every language (regression) ===");
/* "How much to check in early?" reached the model and it invented a time; the
   numeric guard caught the fabrication, but the turn should never have got that
   far. A price question is a price question in any language — and the CJK cues
   need substring matching, because Korean, Chinese and Japanese are written
   without the word boundaries the Latin matcher relies on.
   Phase 9: this specific case (a guest-supplied clock time, "8am", paired with
   a fee question) is re-protected by CLOCK_TIME_SUPPLIED precisely because it
   is a personalised-quote request, not a published-rate lookup — still complex. */
route("I land at 8am. How much to check in early?", "complex", "en — clock time supplied, still needs a computed personal answer");
/* Phase 9: "What is the cancellation fee?" and its ko/zh equivalents no longer
   need the hardMoney/quantityCue escalation this test originally exercised —
   they now escalate via the stay_changes FAMILY match instead (still an
   escalation, "transaction" not "complex"; both hand off to a person, only the
   route label differs). This is an intentional, documented residual
   conservatism from Phase 9, not a regression — see the remediation report. */
route("What is the cancellation fee?", "transaction", "en — still escalates, now via stay_changes family not the money rule");
route("레이트 체크아웃 요금은 얼마인가요?", "transaction", "ko — still escalates, now via stay_changes family not the money rule");
route("延迟退房要收多少钱？", "transaction", "zh — still escalates, now via stay_changes family not the money rule");
/* Phase 9: the Japanese breakfast-price equivalent has no stay_changes-style
   family hit and no personal/sum signal, so it is now correctly informational
   — matching its Vietnamese/English siblings, which is the exact
   cross-language inconsistency Phase 8 found and this phase fixed. */
route("ビュッフェ朝食は一人いくらですか？", "knowledge", "ja — Phase 9: now matches the vi/en breakfast-price cases, a published rate");
/* And the same matcher must not drag ordinary lookups into the escalation lane. */
route("What time does the pool close?", "knowledge", "en stays local");
route("水疗中心有哪些按摩项目？", "knowledge", "zh stays local");
route("스파에는 어떤 마사지가 있나요?", "knowledge", "ko stays local");

console.log("=== ROUTING: counting questions are not money questions (regression) ===");
/* "bao nhiêu" and "how many" are the same words whether a guest asks about a
   bill or about a beach. The first router could not tell them apart and handed
   four ordinary lookups to a human. A counting unit near the cue releases the
   question — unless the sentence also names money. */
route("Bãi biển riêng của resort dài bao nhiêu km?", "knowledge", "km, not money");
route("How many people fit in the grand ballroom?", "knowledge", "people");
route("Danh sách khách phải gửi trước bao nhiêu ngày?", "knowledge", "days");
/* NOT asserted here: "Phòng ở được bao nhiêu người?" still escalates, because
   "bao nhiêu người" is a room_shopping cue in the tool router — it is how a
   booking gets sized. That is the family router's call, not the money rule's,
   and weakening it to win one benchmark case would loosen room shopping. */
/* Phase 9: a bare published room rate or deposit amount, with no personal or
   sum signal, is now informational — the counting unit was never the reason
   these escalated (the money word alone forced it before); now that a money
   word alone no longer auto-escalates, these read the way they always should
   have: a general room-rate / deposit-amount lookup. "Ở thêm 2 ngày..."
   (extending the stay) still escalates via the stay_changes family — an
   extend request is a real stay-change action, independent of this rule. */
route("Phòng này bao nhiêu tiền một đêm?", "knowledge", "Phase 9: general room-rate lookup, no personal/sum signal");
route("How much does a room cost per night?", "knowledge", "Phase 9: same, en");
route("Ở thêm 2 ngày mất bao nhiêu tiền?", "transaction", "extend-stay is a real action (stay_changes family), unaffected by this rule");
route("Đặt cọc bao nhiêu tiền một phòng?", "knowledge", "Phase 9: general deposit-amount lookup, no personal/sum signal");

console.log("=== ROUTING: emergency outranks everything ===");
ok(classifyLocal("Mấy giờ ăn sáng?", true) === "emergency", "the emergency flag wins over content");
ok(classifyLocal("", true) === "emergency", "an empty message with the flag still escalates");

/* ------------------------------------------------------------- gate */

console.log("=== RETRIEVAL GATE ===");
ok(gateRetrieval([]).ok === false, "no results is refused");
ok(gateRetrieval([]).reason === "no_match", "and reported as no_match");

const weak = gateRetrieval([passage({ title: "X", relevance: 0.0001 })]);
ok(!weak.ok && weak.reason === "low_score", "a weak match is refused before the model is asked");

const strong = gateRetrieval([passage({ title: "Checkout", relevance: 0.05 })]);
ok(strong.ok, "a strong match passes the gate");
ok(strong.topScore === 0.05, "the top score is reported for the trace");

/* A placeholder records that we do NOT know something. Handing it to a small
   model produces a confident non-answer. */
const placeholderOnly = gateRetrieval([
  passage({ title: "Wi-Fi (chưa xác minh)", relevance: 0.05, quality: "placeholder" }),
]);
ok(!placeholderOnly.ok && placeholderOnly.reason === "unverified_only", "placeholder-only results are refused");

/* A placeholder ranked FIRST is the corpus saying "we do not know this". Letting
   the next-best passage through answers a different question — the offline
   benchmark caught this on "phòng gym mở mấy giờ?". */
const placeholderTop = gateRetrieval([
  passage({ title: "Phòng Gym (chưa xác minh)", relevance: 0.05, quality: "placeholder" }),
  passage({ title: "Beach and pool", relevance: 0.04 }),
]);
ok(!placeholderTop.ok, "a placeholder as the TOP match escalates, even with other results below");
ok(placeholderTop.reason === "unverified_only", "and the reason names it");

const mixed = gateRetrieval([
  passage({ title: "Checkout", relevance: 0.05 }),
  passage({ title: "Wi-Fi (chưa xác minh)", relevance: 0.04, quality: "placeholder" }),
]);
ok(mixed.ok, "a real top match passes even with a placeholder below it");
ok(mixed.passages.every((p) => p.quality !== "placeholder"), "and the placeholder is dropped from what the model reads");

ok(gateRetrieval([passage({ title: "X", relevance: 0.02 })], 0.5).ok === false, "the floor is configurable");

/* --------------------------------------------------------------- prompt */

console.log("=== PROMPT ===");
const { system, user } = buildAnswerPrompt("Mấy giờ trả phòng?", [passage({ title: "Checkout", relevance: 0.05 })], "vi");
ok(system.includes(ABSTAIN), "the abstain token is taught in the system prompt");
ok(/CHỈ trả lời dựa trên/.test(system), "the model is told to answer only from the passages");
ok(user.includes("Checkout"), "the passage title reaches the prompt");
ok(user.includes("Mấy giờ trả phòng?"), "the question reaches the prompt");
/* Small models degrade past a few thousand tokens; the whole prompt must stay
   far below that even with the maximum number of passages. */
const big = buildAnswerPrompt(
  "x",
  [1, 2, 3].map((i) => passage({ title: `T${i}`, relevance: 0.05, content: "y".repeat(5000) })),
  "vi",
);
const approxTokens = Math.ceil((big.system.length + big.user.length) / 4.2);
ok(approxTokens < 700, `prompt stays small even with long passages (~${approxTokens} tok)`);

console.log("=== RETRIEVAL NOTE reaches the prompt (regression) ===");
/* hybridSearch() already computes "some passages are not source-verified,
   don't state an unconfirmed figure as fact" from a chunk's `verified`
   column — the hosted tool loop sees it because it reads the raw hybridSearch
   object as its tool result, but this offline path built its own prompt and
   silently dropped it. Found live: Bách Giai's dining-venue chunk states
   specific hours with no source, while its own curated, VERIFIED KB article
   explicitly says hours are not published — retrieval sometimes surfaces the
   unverified one, and with no caution attached the model reported the
   number as settled fact. Root cause confirmed shared with the beach/pool
   mix-up too: both source chunks are `verified: "unverified"` in the DB. */
const withNote = buildAnswerPrompt(
  "q",
  [passage({ title: "T", relevance: 0.05 })],
  "vi",
  undefined,
  undefined,
  "Some passages are not yet source-verified. State facts only from the retrieved text; if a figure or detail is missing, say you will confirm rather than inventing it.",
);
ok(withNote.user.includes("not yet source-verified"), "an unverified-passage caution reaches the prompt when hybridSearch supplies one");
const withoutNote = buildAnswerPrompt("q", [passage({ title: "T", relevance: 0.05 })], "vi");
ok(!withoutNote.user.includes("⚠️"), "and is absent when hybridSearch has no caution to add");

console.log("=== PROPERTY BASICS (regression) ===");
/* Check-in and check-out times live in the `hotels` row, not in any document, so
   retrieval cannot reach them and the offline path has no tools to read them
   with. The gold benchmark caught it: asked "mấy giờ tôi được nhận phòng?" the
   model could only find 14:00 buried inside the early-ARRIVAL FEE policy and
   answered around it. These facts are read from the database and injected. */
const withBasics = buildAnswerPrompt("Mấy giờ nhận phòng?", [passage({ title: "T", relevance: 0.05 })], "vi", {
  checkIn: "14:00",
  checkOut: "12:00",
  currency: "VND",
});
ok(withBasics.user.includes("14:00"), "the check-in time reaches the prompt without any document containing it");
ok(withBasics.user.includes("12:00"), "and the check-out time too");
ok(withBasics.user.indexOf("14:00") < withBasics.user.indexOf("[1]"), "basics are stated before the retrieved passages");
const noBasics = buildAnswerPrompt("q", [passage({ title: "T", relevance: 0.05 })], "vi");
ok(!noBasics.user.includes("Thông tin cơ bản"), "and the block is absent when no basics are supplied");

console.log("=== WORKING MEMORY: history block (regression) ===");
/* The offline path used to see only the latest guest message, never the
   turns before it, even though they sit in storage — so a follow-up like
   "Còn bể bơi thì sao?" (omitted subject) had nothing to resolve against.
   `history` is additive: absent, the prompt must be byte-identical to before. */
const withHistory = buildAnswerPrompt(
  "Còn bể bơi thì sao?",
  [passage({ title: "T", relevance: 0.05 })],
  "vi",
  undefined,
  "Khách: Spa mở cửa mấy giờ?\nTrợ lý: Spa mở cửa 09:00-22:00.",
);
ok(withHistory.user.includes("Lịch sử hội thoại gần đây"), "a history block appears when history is supplied");
ok(withHistory.user.includes("Spa mở cửa mấy giờ"), "the prior turn's text reaches the prompt");
ok(withHistory.system.includes("CHỈ để hiểu khách đang hỏi về điều gì"), "the system prompt tells the model history is for context only, not facts");
const withoutHistory = buildAnswerPrompt("q", [passage({ title: "T", relevance: 0.05 })], "vi");
ok(!withoutHistory.user.includes("Lịch sử hội thoại"), "no history block when none is supplied — unchanged from before this feature");
ok(!withoutHistory.system.includes("CHỈ để hiểu"), "no history instruction added to the system prompt either");

console.log("=== WORKING MEMORY: retrieval query enrichment (regression) ===");
const answeringChatStub = (async () => ({
  choices: [{ message: { content: "Hồ bơi mở cửa 06:00-20:00." }, finish_reason: "stop" }],
})) as any;
let capturedQuery = "";
const capturingSearch = (async (q: string) => {
  capturedQuery = q;
  return { results: [passage({ title: "Pool", relevance: 0.05 })], strategy: "test" };
}) as any;
await runLocalTurn({
  question: "Còn bể bơi thì sao?",
  isEmergency: false,
  lang: "vi",
  search: capturingSearch,
  callChat: answeringChatStub,
  history: "Khách: Spa mở cửa mấy giờ?\nTrợ lý: Spa mở cửa 09:00-22:00.",
});
ok(capturedQuery.includes("Spa mở cửa"), "retrieval query is enriched with recent history for a follow-up");
ok(capturedQuery.includes("Còn bể bơi thì sao?"), "and still contains the current question");

capturedQuery = "";
await runLocalTurn({ question: "Spa mở cửa mấy giờ?", isEmergency: false, lang: "vi", search: capturingSearch, callChat: answeringChatStub });
ok(capturedQuery === "Spa mở cửa mấy giờ?", "with no history, the retrieval query is exactly the raw question — unchanged from before this feature");

console.log("=== WORKING MEMORY: unrelated-topic switch is NOT enriched (live incident regression) ===");
/* Found live, not in a benchmark: a real guest asked about Lotus's menu, then
   ten messages later asked "Spa mở cửa mấy giờ?" — a complete question naming
   its own subject. Enriching it with the still-present Lotus/breakfast turns
   flooded the retrieval query with restaurant terms and the spa document
   failed the gate — a real guest got an unnecessary escalation for one of the
   simplest questions in the whole benchmark. */
ok(!needsConversationContext("Spa mở cửa mấy giờ?"), "a complete, self-contained question is not treated as context-dependent");
ok(!needsConversationContext("Phòng còn trống không?"), "\"còn\" meaning \"still/remaining\" does not false-positive as the continuation cue \"còn\" (what about)");
ok(needsConversationContext("Còn bể bơi thì sao?"), "\"Còn X thì sao\" IS the continuation shape this feature exists for");
ok(needsConversationContext("Ý tôi là hỏi giờ đóng cửa, không phải giờ mở cửa"), "a correction is recognised as context-dependent");
ok(needsConversationContext("Nó có view biển không?"), "a leading pronoun is recognised as context-dependent");

capturedQuery = "";
await runLocalTurn({
  question: "Spa mở cửa mấy giờ?",
  isEmergency: false,
  lang: "vi",
  search: capturingSearch,
  callChat: answeringChatStub,
  history: "Khách: lotus có món gì\nTrợ lý: Lotus Restaurant phục vụ các nhóm món gồm thịt gà, thịt bò, thịt heo, hải sản, thịt vịt.",
});
ok(capturedQuery === "Spa mở cửa mấy giờ?", "reproduces the live incident: an unrelated prior topic must not reach the retrieval query for a self-contained question");

console.log("=== WORKING MEMORY: retrieval sees only the most recent exchange, not the whole block (live incident regression) ===");
/* Found live: "Còn hồ bơi thì sao?" then "Ăn sáng phục vụ từ mấy giờ?" then
   "Ý tôi là hỏi giờ đóng cửa, không phải giờ mở cửa" — the correction is about
   breakfast (the immediately preceding turn), but with the full two-exchange
   block BM25 matched the OLDER pool exchange instead, because the pool
   passage happens to literally contain "đóng cửa" while the breakfast one
   only states an hour range. The model still gets the full block (it can
   actually read which topic is meant); only the keyword search is narrowed. */
capturedQuery = "";
await runLocalTurn({
  question: "Ý tôi là hỏi giờ đóng cửa, không phải giờ mở cửa",
  isEmergency: false,
  lang: "vi",
  search: capturingSearch,
  callChat: answeringChatStub,
  history:
    "Khách: Còn hồ bơi thì sao?\nTrợ lý: Hồ bơi ngoài trời đóng cửa lúc 20:00.\n" +
    "Khách: Ăn sáng phục vụ từ mấy giờ?\nTrợ lý: Lotus Restaurant phục vụ bữa sáng từ 06:00 đến 10:30.",
});
ok(!capturedQuery.includes("hồ bơi"), "the older (pool) exchange does not reach the retrieval query");
ok(capturedQuery.includes("Ăn sáng"), "only the most recent (breakfast) exchange does");

console.log("=== WORKING MEMORY: money-shaped follow-up is NOT retrieval-enriched (regression) ===");
/* Measured directly during rollout: enriching "Nếu mang theo thì bị phạt bao
   nhiêu tiền?" (asked right after a pets question) pulled in the house-rules
   chunk — correct topic, but the chunk has no pet fine, only a smoking fine —
   and the model reported the smoking fine as if it answered the pet question.
   The mitigation: a money-shaped question is never enriched, so it fails the
   gate on its own exactly as it did before this feature, and escalates. */
capturedQuery = "";
await runLocalTurn({
  question: "Nếu mang theo thì bị phạt bao nhiêu tiền?",
  isEmergency: false,
  lang: "vi",
  search: capturingSearch,
  callChat: answeringChatStub,
  history: "Khách: Tôi mang theo chó nhỏ được không?\nTrợ lý: Không, khách không được mang chó vào khách sạn.",
});
ok(capturedQuery === "Nếu mang theo thì bị phạt bao nhiêu tiền?", "a money-shaped follow-up is retrieved on the raw question alone, not enriched with history");

console.log("=== ABSTENTION DETECTION ===");
ok(isAbstention(ABSTAIN), "the bare token is an abstention");
ok(isAbstention(`Dạ, ${ABSTAIN}`), "the token wrapped in prose still counts");
ok(!isAbstention("Giờ trả phòng là 12:00."), "a real answer is not an abstention");
ok(!isAbstention(""), "empty is not matched as the token");

/* ------------------------------------------------------------- pipeline */

console.log("=== ABSTENTION: respelled and prose forms (regression) ===");
/* Both of these reached a GUEST in the answer benchmark. The token respelled
   with Vietnamese diacritics slipped past a plain string match and was printed
   verbatim; the prose refusal was treated as an answer, so nobody was told and
   no human ever saw the question. */
ok(isAbstention("KHÔNG_DU_THONG_TIN"), "the token respelled with diacritics is still an abstention");
ok(isAbstention("Dựa trên tài liệu đã cung cấp, không có thông tin về giờ phục vụ ăn sáng."), "a prose refusal counts");
ok(isAbstention("Điều này không được đề cập trong tài liệu."), "\"không được đề cập\" counts");
ok(isAbstention("The documents do not mention the pool hours."), "an English prose refusal counts");
ok(isAbstention("This is not mentioned in the provided documents."), "\"not mentioned\" counts");
/* And a real answer that merely contains a negation must NOT be swallowed —
   "no pets allowed" is the correct answer to a pet question, not a refusal. */
ok(!isAbstention("Dạ, resort không cho phép mang thú cưng ạ."), "a negative ANSWER is not an abstention");
ok(!isAbstention("Không, hồ bơi đóng cửa lúc 20:00."), "a negative answer with a fact is not an abstention");
ok(!isAbstention("Pets are not allowed anywhere on the property."), "an English negative answer is not an abstention");

console.log("=== PIPELINE: no model call on the escalating routes ===");
const noSearch = (async () => ({ results: [], strategy: "test" })) as any;
const explodingChat = (async () => {
  throw new Error("the model must not be called on this route");
}) as any;

for (const [q, label] of [
  ["Tổng hoá đơn bao nhiêu tiền", "complex"],
  ["Tôi muốn huỷ phòng", "transaction"],
] as const) {
  const t = await runLocalTurn({ question: q, isEmergency: false, lang: "vi", search: noSearch, callChat: explodingChat });
  ok(t.escalate && t.llmCalls === 0, `"${q}" escalates with zero model calls (${label})`);
  ok(t.reply === null, `"${q}" produces no answer of its own`);
}

const emergency = await runLocalTurn({
  question: "tôi bị đau ngực",
  isEmergency: true,
  lang: "vi",
  search: noSearch,
  callChat: explodingChat,
});
ok(emergency.route === "emergency" && emergency.escalate && emergency.llmCalls === 0, "an emergency escalates immediately, no retrieval, no model");

console.log("=== PIPELINE: knowledge route ===");
const goodSearch = (async () => ({
  results: [passage({ title: "Checkout policy", relevance: 0.05 })],
  strategy: "bm25",
})) as any;
const answeringChat = (async () => ({
  choices: [{ message: { content: "Dạ, giờ trả phòng tiêu chuẩn là 12:00 ạ." }, finish_reason: "stop" }],
})) as any;

const answered = await runLocalTurn({
  question: "Mấy giờ trả phòng?",
  isEmergency: false,
  lang: "vi",
  search: goodSearch,
  callChat: answeringChat,
});
ok(answered.route === "knowledge", "a lookup is routed to knowledge");
ok(answered.reply?.includes("12:00"), "the answer comes back");
ok(!answered.escalate, "and the turn does not escalate");
ok(answered.llmCalls === 1, "exactly one model call — never a loop");

console.log("=== PIPELINE: abstention escalates ===");
const abstainingChat = (async () => ({
  choices: [{ message: { content: ABSTAIN }, finish_reason: "stop" }],
})) as any;
const abstained = await runLocalTurn({
  question: "Mấy giờ trả phòng?",
  isEmergency: false,
  lang: "vi",
  search: goodSearch,
  callChat: abstainingChat,
});
ok(abstained.escalate && abstained.reply === null, "an abstention escalates instead of answering");
ok(/không tìm thấy/i.test(abstained.escalateReason ?? ""), "and the reason says why");

console.log("=== PIPELINE: weak retrieval never reaches the model ===");
const weakSearch = (async () => ({
  results: [passage({ title: "Something", relevance: 0.0001 })],
  strategy: "bm25",
})) as any;
const weakTurn = await runLocalTurn({
  question: "Mấy giờ trả phòng?",
  isEmergency: false,
  lang: "vi",
  search: weakSearch,
  callChat: explodingChat,
});
ok(weakTurn.escalate && weakTurn.llmCalls === 0, "a weak match escalates without calling the model");

console.log("=== PIPELINE: a model outage degrades, never throws ===");
const brokenChat = (async () => {
  throw new Error("connection refused");
}) as any;
const outage = await runLocalTurn({
  question: "Mấy giờ trả phòng?",
  isEmergency: false,
  lang: "vi",
  search: goodSearch,
  callChat: brokenChat,
});
ok(outage.escalate && outage.reply === null, "a model outage escalates rather than failing the turn");
ok(/không phản hồi/i.test(outage.escalateReason ?? ""), "and the outage is named in the reason");

console.log("=== ANSWER HELPER ===");
const empty = await answerFromPassages("q", [passage({ title: "T", relevance: 1 })], "vi", (async () => ({
  choices: [{ message: { content: "   " }, finish_reason: "stop" }],
})) as any);
ok(empty.abstained, "an empty model reply counts as an abstention, not as an answer");

console.log(`\nLOCAL_MIN_SCORE floor in use: ${LOCAL_MIN_SCORE}`);
console.log(failures === 0 ? "ALL LOCAL-AGENT TESTS PASSED" : `${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
