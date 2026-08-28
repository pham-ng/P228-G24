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
 * WHY A TRAINED HEAD RATHER THAN AN ONNX MODEL
 *
 * A fine-tuned MiniLM/XLM-R sentiment head is the industry-standard answer.
 * But SetFit — the usual recipe at this data size — is two steps: contrastive
 * fine-tuning of a sentence transformer, then a LINEAR CLASSIFIER on the
 * resulting embeddings. This service already runs bge-m3, a strong 1024-d
 * multilingual encoder, and has already embedded the guest's message for
 * retrieval before this code runs. So the second step is available for free,
 * and the `linear` backend below is exactly that: logistic regression over
 * bge-m3, trained on the project's own 600 labelled messages.
 *
 * Measured on a held-out third of that set (`bench/sentiment-probe-eval.ts`):
 *
 *   hand-written prototypes   accuracy 54.0%   recall  8.3%   F1 ~15
 *   k-NN over the labels      accuracy 77.9%   recall 74.2%   F1 77.1
 *   linear head               accuracy 92.1%   recall 89.2%   F1 91.8
 *
 * against a 90.8 cross-validation F1 on train, so the tuning did not overfit
 * the split. It costs one dot product over a vector that already exists — no
 * ONNX runtime, no model file to ship beyond 20KB of weights, no VRAM, and no
 * second forward pass. An ONNX MiniLM would be strictly SLOWER here, because
 * it would have to encode the text again.
 *
 * What it does NOT do is fine-tune the encoder, which is where SetFit's last
 * few points live. The remaining errors say that is not the bottleneck: the
 * largest single failure is one unseen complaint ("the pool water is filthy,
 * my child got a rash") missed in all six languages at once — a gap in the
 * ~100 independent items the training set contains, which a better encoder
 * would not fill. More labelled items beat a bigger model here.
 *
 * WHAT THE CENTROID FLOOR DOES INSTEAD
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
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
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

/**
 * On by default — but see SENTIMENT_ACT: on means "classify and record", not
 * "open tasks". Reading the mood costs one dot product over a vector retrieval
 * has already computed, so leaving it off buys nothing and loses the shadow log
 * that a deployment needs in order to justify turning SENTIMENT_ACT on.
 *
 * Set LOCAL_SENTIMENT_NET=0 to silence it entirely.
 */
export const SENTIMENT_NET_ENABLED =
  process.env.LOCAL_SENTIMENT_NET !== "0" && process.env.LOCAL_SENTIMENT_NET !== "false";

/**
 * Shadow mode: decide, record, but do not act.
 *
 * This is the DEFAULT, and it stays the default even now that the classifier
 * is good, because BENCHMARK ACCURACY IS NOT THE DECIDING NUMBER — the base
 * rate is.
 *
 * The labelled set is balanced 50/50. Real guest traffic is not: complaints
 * are maybe one message in twenty. Carry the held-out rates through that base
 * rate and the picture changes completely. Per 1,000 real messages, at the
 * shipped 0.60 operating point (recall 89.2%, false-positive rate 5.0%):
 *
 *   50 complaints  -> 45 caught          950 ordinary -> 48 false alarms
 *
 * Slightly WORSE than a coin flip on any given alert, which is exactly the
 * flood that teaches a front desk to ignore the queue. At 0.80 the same
 * held-out set gave 100% precision at 71.7% recall (0 false positives in 240),
 * which is the direction to move before acting, at the cost of missing roughly
 * one complaint in four.
 *
 * So: LOCAL_SENTIMENT_ACT=1 wants LOCAL_SENTIMENT_THRESHOLD=0.8 alongside it,
 * and neither should go on before the shadow log has been read. In shadow mode
 * every verdict is logged with the message that produced it — including the
 * near-misses, because a missed complaint is the failure this feature exists to
 * prevent and it is invisible unless the misses are written down too. That log
 * is the next training set: score a few hundred real turns by hand, append them
 * to the labelled file, and re-run
 *
 *   npx tsx bench/sentiment-probe-eval.ts <set>.jsonl --augment --emit
 *
 * to retrain the head on this deployment's own guests.
 */
export const SENTIMENT_ACT = process.env.LOCAL_SENTIMENT_ACT === "1" || process.env.LOCAL_SENTIMENT_ACT === "true";

/**
 * Which implementation reads the guest's mood.
 *
 * "linear" — DEFAULT. Logistic regression over bge-m3, trained on the project's
 *   own labelled messages (`server/data/sentiment-head.json`, regenerate with
 *   `npx tsx bench/sentiment-probe-eval.ts <set>.jsonl --augment --emit`).
 *   F1 91.8 held out. Falls back to the centroid if the weights are missing or
 *   were trained for a different embedding width.
 * "centroid" — the cosine-against-prototypes floor implemented here. Needs no
 *   training data at all, which is why it stays: it is what a fresh deployment
 *   with no labels of its own runs on. Measurably weak (F1 ~15) on anything
 *   but blunt complaints.
 * "onnx" — a separately-encoded MiniLM/XLM-R head. NOT IMPLEMENTED, and on
 *   this architecture it would be slower than `linear` rather than faster,
 *   since bge-m3 has already encoded the text. Selecting it logs once and
 *   falls back rather than failing a guest's turn.
 *
 * The split exists so the swap is a one-file change: everything downstream —
 * the escalation, the task contract, the shadow log — reads `readGuestSentiment`
 * and does not care which backend answered.
 */
export type SentimentBackend = "linear" | "centroid" | "onnx";
export const SENTIMENT_BACKEND = (process.env.LOCAL_SENTIMENT_BACKEND as SentimentBackend) || "linear";

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
  /* The linear head needs no warm-up — it is 20KB of weights read from disk.
     Only fall through to embedding the prototypes when the head is missing,
     which also keeps startup independent of Ollama in the normal case. */
  if (SENTIMENT_BACKEND === "linear" && linearHead()) return;
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

/* ---------------------------------------------------------------- linear head */

type LinearHead = { dim: number; bias: number; threshold: number; weights: number[]; trainedOn: number; embedModel?: string };
let head: LinearHead | null | undefined;

/** Load once. `null` means "tried and cannot" — the caller falls back to the
 *  centroid, so a missing or stale weights file degrades the feature instead of
 *  breaking the kiosk. */
function linearHead(): LinearHead | null {
  if (head !== undefined) return head;
  head = null;
  try {
    const path = join(process.cwd(), "server", "data", "sentiment-head.json");
    if (!existsSync(path)) {
      console.warn("[sentiment] no sentiment-head.json — falling back to the centroid floor.");
      return head;
    }
    const parsed = JSON.parse(readFileSync(path, "utf8")) as LinearHead;
    if (!Array.isArray(parsed.weights) || parsed.weights.length !== parsed.dim) {
      console.warn("[sentiment] sentiment-head.json is malformed — falling back to the centroid floor.");
      return head;
    }
    head = parsed;
    /* Report the EFFECTIVE operating point, not the head's own. An env override
       is exactly the thing an operator is checking for when they read this
       line, and printing the baked-in value while a different one is in force
       is how a misconfiguration survives a look at the logs. */
    const eff = SENTIMENT_THRESHOLD ?? parsed.threshold;
    console.info(
      `[sentiment] linear head loaded: dim=${parsed.dim} trained on ${parsed.trainedOn} labelled messages ` +
        `(${parsed.embedModel ?? "unknown encoder"}) · nguong=${eff}` +
        (SENTIMENT_THRESHOLD !== null ? ` (LOCAL_SENTIMENT_THRESHOLD ghi de ${parsed.threshold})` : "") +
        ` · ${SENTIMENT_ACT ? "MO TASK THAT cho Le tan" : "shadow mode, chi ghi log"}`,
    );
  } catch (err) {
    console.warn(`[sentiment] could not load sentiment-head.json (${String(err)}) — using the centroid floor.`);
  }
  return head;
}

/**
 * Operating point. The head ships the threshold that cross-validation chose,
 * but the right one depends on traffic, not on the benchmark.
 *
 * The benchmark is balanced 50/50; real guest traffic is not — complaints are
 * maybe one message in twenty. At that base rate the held-out numbers (recall
 * 89.2%, false-positive rate 5.0%) work out to roughly one true alert for
 * every one false one, which is exactly the flood that teaches a front desk to
 * ignore the queue. On the same held-out set a threshold of 0.80 gave 100%
 * precision at 71.7% recall. Raise this before setting LOCAL_SENTIMENT_ACT=1,
 * and lower it again once real labels exist to re-tune on.
 */
export const SENTIMENT_THRESHOLD = process.env.LOCAL_SENTIMENT_THRESHOLD
  ? Number(process.env.LOCAL_SENTIMENT_THRESHOLD)
  : null;

/** Pure, so the operating point can be tested without a model or an index. */
export function classifyLinear(vector: number[], h: LinearHead, threshold: number): SentimentVerdict | null {
  if (!vector?.length || vector.length !== h.dim) return null;
  /* The head was trained on L2-normalised vectors, so normalise here too —
     bge-m3 does not guarantee unit length and an unnormalised vector silently
     shifts every score. */
  let n = 0;
  for (const x of vector) n += x * x;
  n = Math.sqrt(n) || 1;
  let z = h.bias;
  for (let i = 0; i < h.dim; i++) z += h.weights[i] * (vector[i] / n);
  const p = 1 / (1 + Math.exp(-z));
  /* `margin` is distance past the operating point, so the shadow log reads the
     same way for both backends: bigger means more confident. */
  return p >= threshold
    ? { label: "negative", score: p, margin: p - threshold }
    : { label: "neutral", score: p, margin: threshold - p };
}

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
  if (!SENTIMENT_NET_ENABLED) return null;
  if (SENTIMENT_BACKEND === "onnx") warnOnnxNotReady();
  const v = cachedQueryVector(query);
  if (!v) return null;

  /* The linear head is preferred but not required. When its weights are absent
     — a fresh deployment that has not labelled anything yet — this drops to the
     prototype floor rather than going silent, because a weak signal on an angry
     guest still beats none. */
  const h = SENTIMENT_BACKEND === "linear" ? linearHead() : null;
  let verdict: SentimentVerdict | null;
  let backend: SentimentBackend;
  if (h) {
    backend = "linear";
    verdict = classifyLinear(v, h, SENTIMENT_THRESHOLD ?? h.threshold);
  } else {
    backend = "centroid";
    if (!protoVectors) return null;
    verdict = classifyVector(v, SENTIMENT_PROTOTYPES, protoVectors);
  }
  if (!verdict) return null;

  /* The linear head's threshold IS its operating point — the margin is already
     measured from it, so a second margin gate would double-count. The centroid
     has no calibrated threshold, which is what SENTIMENT_MARGIN is for. */
  const fires =
    verdict.label === "negative" && (backend === "linear" || verdict.margin >= SENTIMENT_MARGIN);

  /* Every verdict is recorded, hit or miss, in BOTH modes. Logging only the
     hits would hide the failure this feature exists to prevent — a complaint
     that scored 0.49 and went nowhere is invisible unless the miss is written
     down, and it is also the most useful line to relabel and retrain on.

     `HIT`/`miss` says whether it crossed the threshold; `acting` says whether
     anything was allowed to happen because of it. */
  {
    console.info(
      `[sentiment] ${fires ? "HIT " : "miss"} label=${verdict.label} score=${verdict.score.toFixed(3)} margin=${verdict.margin.toFixed(3)} ` +
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
