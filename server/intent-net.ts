/**
 * A semantic safety net under the keyword router.
 *
 * WHY THIS EXISTS
 *
 * Routing is decided by hand-written cue lists — 600 in `toolrouter`, 254 more
 * in `local-agent`. They are precise, auditable and instant, and they should
 * stay. What they are not is complete: measured by language, `toolrouter` has
 * 202 Vietnamese cues, 152 English, 148 Chinese, 98 Korean and **zero
 * Japanese, zero Russian** — while the kiosk serves all six. The consequence
 * was not theoretical. Six SAFETY_ESCALATION cases in the release evaluation
 * reached the model unescalated, every one of them a CJK request to cancel a
 * booking, correct a card charge or refund money to a third party. Each was
 * fixed by adding more words to more lists, which is a treadmill: the seventh
 * language starts the same cycle again, and a gap is invisible until a guest
 * happens to type the phrasing nobody thought of.
 *
 * The retriever already solved this problem for entities. bge-m3 matches a
 * Korean, Russian or misspelled query to the right document without a single
 * keyword. This applies the same tool to intent: a handful of prototype
 * sentences, written in ONE language, embedded once, compared by cosine.
 *
 * MEASURED (bench/intent-embedding-spike.ts, 18 cases the lexicon is known to
 * struggle with, prototypes written only in Vietnamese):
 *
 *     lexicon correct    14/18
 *     embedding correct  17/18
 *     both wrong          0/18   <- the number that matters
 *
 * The four the lexicon missed were Japanese and Russian action requests. The
 * one the embedding missed ("予約のキャンセルポリシーは何ですか" — what is the
 * cancellation policy) the lexicon caught, and it scored 0.712, the lowest of
 * any escalate prediction. The two layers fail in different directions, which
 * is the entire argument for running both.
 *
 * HOW IT IS WIRED
 *
 * The lexicon stays the floor and keeps the last word on speed: when it says
 * escalate, the turn escalates with no vector work at all. This net only
 * inspects turns the lexicon released to the knowledge lane — and those turns
 * have already been embedded for retrieval, so the added cost is one cosine
 * per prototype: 0.043ms against 16 prototypes, on a turn that takes ~6000ms.
 *
 * Adding a seventh language here means adding EXAMPLES, not editing code.
 */
import { embed } from "./llm";
import { cachedQueryVector } from "./retrieval";

export type Intent = "escalate" | "lookup";

/**
 * Prototype utterances, deliberately Vietnamese-only.
 *
 * Keeping them in one language is the point: it is what proves the net
 * generalises through the embedding rather than through vocabulary overlap.
 * Add examples for a shape the net gets wrong, not translations.
 */
export const INTENT_PROTOTYPES: { intent: Intent; text: string }[] = [
  // Actions on a booking, money, or a broken thing — a person must handle these.
  { intent: "escalate", text: "tôi muốn huỷ đặt phòng" },
  { intent: "escalate", text: "hoàn tiền lại cho tôi" },
  { intent: "escalate", text: "hoá đơn của tôi bị tính sai, sửa lại giúp" },
  { intent: "escalate", text: "đổi ngày nhận phòng cho tôi" },
  { intent: "escalate", text: "điều hoà trong phòng bị hỏng" },
  { intent: "escalate", text: "tôi muốn đặt thêm một phòng nữa" },
  { intent: "escalate", text: "chuyển tiền hoàn về tài khoản khác" },
  { intent: "escalate", text: "tổng hoá đơn của tôi là bao nhiêu" },
  // Published facts the kiosk is meant to answer itself.
  { intent: "lookup", text: "mấy giờ phục vụ ăn sáng" },
  { intent: "lookup", text: "hồ bơi mở cửa đến mấy giờ" },
  { intent: "lookup", text: "giá phòng deluxe là bao nhiêu" },
  { intent: "lookup", text: "resort có cho mang thú cưng không" },
  { intent: "lookup", text: "spa có những liệu trình nào" },
  { intent: "lookup", text: "chính sách huỷ phòng quy định thế nào" },
  { intent: "lookup", text: "wifi có miễn phí không" },
  { intent: "lookup", text: "nhà hàng nào phục vụ buffet" },
];

/**
 * How far ahead of the best `lookup` prototype an `escalate` prototype must
 * sit before this net overrides the lexicon.
 *
 * A bare top-1 vote is too eager: "what is the cancellation policy" sits near
 * "tôi muốn huỷ đặt phòng" in embedding space because both are about
 * cancelling, and calling that an escalation sends a published policy lookup
 * to a person. Requiring a MARGIN over the competing intent, rather than an
 * absolute score, is what separates "this is more like an action than a
 * question" from "this merely mentions the same topic".
 *
 * Set from the measured separation, which is wide. Wired end to end, the four
 * escalations the lexicon missed scored margins of 0.276, 0.337, 0.351 and
 * 0.383, while the "what is the cancellation policy" trap scored 0.108 — the
 * two populations are not close, so the threshold sits between them rather
 * than being fitted to either.
 *
 * Tune with bench/intent-embedding-spike.ts. A miss here costs little (the
 * lexicon and the numeric guard are both still in place); a false positive
 * sends a published answer to a person and shows up directly as lost
 * knowledge-state accuracy.
 */
export const INTENT_MARGIN = Number(process.env.LOCAL_INTENT_MARGIN ?? 0.15);

/** Off by default until a deployment has measured it on its own traffic. */
export const INTENT_NET_ENABLED =
  process.env.LOCAL_INTENT_NET === "1" || process.env.LOCAL_INTENT_NET === "true";

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

/**
 * Embed the prototypes once. Costs ~5s on this hardware, so it is done at
 * startup rather than on a guest's first question, and a failure is swallowed:
 * the net is an extra layer, and a kiosk must not fail to boot because an
 * optional safety net could not warm.
 */
export async function warmIntentNet(): Promise<void> {
  if (!INTENT_NET_ENABLED || protoVectors) return;
  if (warming) return warming;
  warming = (async () => {
    try {
      protoVectors = await embed(INTENT_PROTOTYPES.map((p) => p.text));
    } catch {
      protoVectors = null;
    }
  })();
  return warming;
}

export type IntentVerdict = {
  intent: Intent;
  /** Cosine of the winning prototype. */
  score: number;
  /** How far it beat the best prototype of the other intent. */
  margin: number;
};

/** Pure, so the thresholds can be tested without a model or an index. */
export function classifyVector(
  vector: number[],
  prototypes: { intent: Intent; text: string }[],
  vectors: number[][],
): IntentVerdict | null {
  if (!vector?.length || vectors.length !== prototypes.length) return null;
  let bestEsc = -1, bestLook = -1;
  for (let i = 0; i < vectors.length; i++) {
    const s = cosine(vector, vectors[i]);
    if (prototypes[i].intent === "escalate") bestEsc = Math.max(bestEsc, s);
    else bestLook = Math.max(bestLook, s);
  }
  return bestEsc >= bestLook
    ? { intent: "escalate", score: bestEsc, margin: bestEsc - bestLook }
    : { intent: "lookup", score: bestLook, margin: bestLook - bestEsc };
}

/**
 * Should this turn escalate despite the lexicon letting it through?
 *
 * Reads the vector retrieval already computed for `query`. When there is none
 * — the query was never embedded — it returns false: no opinion, and the
 * lexicon's decision stands unchanged.
 */
export function shouldEscalateByIntent(query: string): IntentVerdict | null {
  if (!INTENT_NET_ENABLED || !protoVectors) return null;
  const v = cachedQueryVector(query);
  if (!v) return null;
  const verdict = classifyVector(v, INTENT_PROTOTYPES, protoVectors);
  if (!verdict) return null;
  return verdict.intent === "escalate" && verdict.margin >= INTENT_MARGIN ? verdict : null;
}
