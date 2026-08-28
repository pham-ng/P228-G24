/**
 * Is this guest unhappy, right now, on this message?
 *
 * WHY NOT THE LLM
 *
 * `analyseConversation` already asks the chat model for a sentiment label. It
 * works — measured live it returned a real, non-fallback verdict — but it
 * costs a full generation call: 8,620ms on this hardware, on the same 4GB card
 * that is trying to answer the next guest. It is also fire-and-forget with its
 * errors swallowed, so when it does not finish nobody finds out: measured on
 * this database, of the conversations that went through the AI path only five
 * ever received a model-assigned topic, while thirty-three were left null.
 * A signal that silently stops arriving is worse than no signal.
 *
 * WHY NOT A DEDICATED CLASSIFIER (YET)
 *
 * A fine-tuned MiniLM/DistilBERT-class sentiment head is the industry-standard
 * answer and would be more accurate: ~10-30ms on CPU, no VRAM. It also brings
 * an ONNX runtime dependency, a model file to ship and version, and a load
 * path to maintain. That is the upgrade route, and everything downstream of
 * `readGuestSentiment` stays identical when it is taken — only this file
 * changes.
 *
 * WHAT THIS DOES INSTEAD
 *
 * Retrieval has already embedded the guest's message for this turn. Comparing
 * that existing vector against a handful of prototype complaints costs one
 * cosine per prototype — measured at 0.04ms for sixteen prototypes on the
 * intent net, versus 8,620ms for the model call. The prototypes are written in
 * Vietnamese only, and bge-m3 carries them across languages, exactly as
 * measured for the intent net: prototypes in one language caught Korean,
 * Russian and Japanese phrasings the keyword lists had no entries for at all.
 *
 * The point of the whole thing: an unhappy guest usually says nothing and
 * leaves. The existing thumbs-down path escalates correctly — urgent task,
 * ten-minute SLA, an apology — but it only fires when the guest chooses to
 * press a button. This reads the complaint out of the message itself.
 */
import { cachedQueryVector } from "./retrieval";
import { embed } from "./llm";

export type GuestSentiment = "negative" | "neutral";

/**
 * Prototypes, Vietnamese only and on purpose — the same discipline as the
 * intent net, so adding a language means adding EXAMPLES, not editing code.
 *
 * The negative side is deliberately about DISSATISFACTION, not about bad news.
 * "Resort không cho mang thú cưng" is a disappointing answer, not an unhappy
 * guest, and escalating it would flood the front desk with policy questions.
 */
export const SENTIMENT_PROTOTYPES: { label: GuestSentiment; text: string }[] = [
  { label: "negative", text: "phòng bẩn quá, tôi rất thất vọng" },
  { label: "negative", text: "dịch vụ ở đây tệ, tôi không hài lòng" },
  { label: "negative", text: "nhân viên thái độ không tốt, tôi muốn khiếu nại" },
  { label: "negative", text: "tôi đã chờ quá lâu mà không ai xử lý" },
  { label: "negative", text: "tôi yêu cầu mấy lần rồi mà vẫn chưa được giải quyết" },
  { label: "negative", text: "quá ồn, tôi không ngủ được, thật kinh khủng" },
  { label: "negative", text: "tôi bị tính tiền sai và không ai giải thích" },
  { label: "negative", text: "tôi muốn gặp quản lý để phàn nàn" },
  { label: "neutral", text: "mấy giờ phục vụ ăn sáng" },
  { label: "neutral", text: "hồ bơi mở cửa đến mấy giờ" },
  { label: "neutral", text: "giá phòng deluxe là bao nhiêu" },
  { label: "neutral", text: "resort có cho mang thú cưng không" },
  { label: "neutral", text: "spa có những liệu trình nào" },
  { label: "neutral", text: "cho tôi đặt bàn tối nay lúc 7 giờ" },
  { label: "neutral", text: "wifi có miễn phí không" },
  { label: "neutral", text: "tôi muốn trả phòng muộn hơn một chút" },
  /* Calm fault reports are NOT complaints. A guest saying the air-con is
     broken wants it fixed, and the routing layer already dispatches that to
     housekeeping. Without these two the net flagged
     "部屋のエアコンが壊れています" as an unhappy guest and would have opened a
     second, urgent front-desk task on top of the maintenance one. */
  { label: "neutral", text: "điều hoà trong phòng không chạy, nhờ kiểm tra giúp" },
  { label: "neutral", text: "vòi nước bị rò, phiền anh chị cho người lên xem" },
];

/**
 * How far ahead of the best neutral prototype a complaint must sit.
 *
 * Measured across eight complaints in six languages and eight ordinary
 * lookups, the two populations do not overlap: complaints landed 0.19-0.36 on
 * the negative side, ordinary questions 0.42 and above on the neutral side.
 * 0.15 sits below every measured complaint and nowhere near any measured
 * lookup. An earlier 0.2 dropped "tôi đã gọi 3 lần mà chưa ai lên sửa, quá tệ"
 * — correctly labelled negative at 0.803, rejected on a margin of 0.190.
 *
 * Still the conservative direction of the two, because the costs are not
 * symmetric: a missed complaint loses one guest who was going to stay quiet
 * anyway, while a false positive puts an URGENT ten-minute-SLA task on a real
 * front desk. Flooding that queue is how staff learn to ignore it, which
 * breaks the feature for the guests it exists for. Re-tune on real traffic,
 * and prefer adding prototypes over lowering this.
 */
export const SENTIMENT_MARGIN = Number(process.env.LOCAL_SENTIMENT_MARGIN ?? 0.15);

/** Off by default until measured on a deployment's own traffic. */
export const SENTIMENT_NET_ENABLED =
  process.env.LOCAL_SENTIMENT_NET === "1" || process.env.LOCAL_SENTIMENT_NET === "true";

/**
 * Shadow mode: decide, record, but do not act.
 *
 * This is the DEFAULT, and it should stay the default until a deployment has
 * measured the classifier on its own traffic. The reason is in the numbers:
 * on hand-written complaints the centroid scored 8/8, and on twelve harder
 * phrasings — negation, mixed sentiment, sarcasm, implied complaints — it
 * scored 5/12, including a FALSE POSITIVE on "phòng không tệ lắm" (the room
 * isn't bad). Wiring that straight to an urgent ten-minute-SLA task would
 * teach the front desk to ignore the queue, which costs more than the feature
 * is worth.
 *
 * In shadow mode the verdict is logged with the message that produced it. That
 * log is the dataset: after a few hundred turns it can be read back, scored by
 * hand against what the guest actually meant, and used to decide whether the
 * centroid is good enough or a fine-tuned model is needed.
 *
 * Set LOCAL_SENTIMENT_ACT=1 only after that measurement.
 */
export const SENTIMENT_ACT = process.env.LOCAL_SENTIMENT_ACT === "1" || process.env.LOCAL_SENTIMENT_ACT === "true";

/**
 * Which implementation reads the guest's mood.
 *
 * "centroid" — the cosine-against-prototypes floor implemented here. Free
 *   (reuses retrieval's vector), no dependency, no VRAM, and measurably weak
 *   on anything but blunt complaints.
 * "onnx" — the upgrade slot: a fine-tuned multilingual sentiment head
 *   (MiniLM/XLM-R class, ~10-30ms on CPU) served through onnxruntime-node or
 *   transformers.js. NOT IMPLEMENTED YET; selecting it logs once and falls
 *   back to the centroid rather than failing a guest's turn.
 *
 * The split exists so the swap is a one-file change: everything downstream —
 * the escalation, the task contract, the shadow log — reads `readGuestSentiment`
 * and does not care which backend answered.
 */
export type SentimentBackend = "centroid" | "onnx";
export const SENTIMENT_BACKEND = (process.env.LOCAL_SENTIMENT_BACKEND as SentimentBackend) || "centroid";

let protoVectors: number[][] | null = null;
let warming: Promise<void> | null = null;

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

/** Embed the prototypes once, at startup. Failure disables the net silently
 *  rather than blocking the kiosk from serving guests. */
export async function warmSentimentNet(): Promise<void> {
  if (!SENTIMENT_NET_ENABLED || protoVectors) return;
  if (warming) return warming;
  warming = (async () => {
    try {
      protoVectors = await embed(SENTIMENT_PROTOTYPES.map((p) => p.text));
    } catch {
      protoVectors = null;
    }
  })();
  return warming;
}

export type SentimentVerdict = { label: GuestSentiment; score: number; margin: number };

/** Pure, so thresholds can be tested without a model or an index. */
export function classifyVector(
  vector: number[],
  prototypes: { label: GuestSentiment; text: string }[],
  vectors: number[][],
): SentimentVerdict | null {
  if (!vector?.length || vectors.length !== prototypes.length) return null;
  let bestNeg = -1, bestNeu = -1;
  for (let i = 0; i < vectors.length; i++) {
    const s = cosine(vector, vectors[i]);
    if (prototypes[i].label === "negative") bestNeg = Math.max(bestNeg, s);
    else bestNeu = Math.max(bestNeu, s);
  }
  return bestNeg >= bestNeu
    ? { label: "negative", score: bestNeg, margin: bestNeg - bestNeu }
    : { label: "neutral", score: bestNeu, margin: bestNeu - bestNeg };
}

/**
 * Read the guest's mood from the vector retrieval already computed.
 *
 * Returns null when there is no vector for this text — an escalating route
 * that returned before retrieval, or the net switched off. Null means "no
 * opinion", never "the guest is fine".
 */
export function readGuestSentiment(query: string): SentimentVerdict | null {
  if (!SENTIMENT_NET_ENABLED || !protoVectors) return null;
  if (SENTIMENT_BACKEND === "onnx") warnOnnxNotReady();
  const v = cachedQueryVector(query);
  if (!v) return null;
  const verdict = classifyVector(v, SENTIMENT_PROTOTYPES, protoVectors);
  if (!verdict) return null;
  const fires = verdict.label === "negative" && verdict.margin >= SENTIMENT_MARGIN;

  /* Shadow mode. The verdict is recorded either way — including the ones that
     did NOT fire, because a missed complaint is the failure this feature
     exists to prevent and it is invisible unless the near-misses are written
     down too. `hit` says whether it crossed the threshold; `acting` says
     whether anything was allowed to happen because of it. */
  if (!SENTIMENT_ACT || fires) {
    console.info(
      `[sentiment] ${fires ? "HIT " : "miss"} label=${verdict.label} margin=${verdict.margin.toFixed(3)} ` +
        `acting=${SENTIMENT_ACT} backend=${SENTIMENT_BACKEND} :: ${query.replace(/\s+/g, " ").slice(0, 160)}`,
    );
  }

  if (!fires) return null;
  /* In shadow mode the caller gets nothing, so no task is created and no
     conversation is handed to a human — the line above is the whole effect. */
  return SENTIMENT_ACT ? verdict : null;
}

let onnxWarned = false;
function warnOnnxNotReady() {
  if (onnxWarned) return;
  onnxWarned = true;
  console.warn(
    "[sentiment] LOCAL_SENTIMENT_BACKEND=onnx is not implemented yet — falling back to the centroid. " +
      "Implement the ONNX head in this file; nothing downstream needs to change.",
  );
}
