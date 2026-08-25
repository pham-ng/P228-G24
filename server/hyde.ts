/**
 * HyDE — Hypothetical Document Embeddings, behind a flag, treated as an experiment.
 *
 * The idea: a short question and a long factual passage sit in different regions
 * of embedding space. Ask the model to *write* the answer it expects, embed that
 * hypothetical passage instead, and it lands nearer the real documents.
 *
 * TWO RULES THAT ARE NOT NEGOTIABLE HERE
 *
 * 1. The hypothetical text is NEVER evidence. It is generated, so it can and does
 *    contain invented prices and hours — the exact thing this system exists to
 *    prevent. It is used only to produce a vector; nothing it says reaches the
 *    guest, and only retrieved real documents ground an answer.
 *
 * 2. It AUGMENTS the query embedding rather than replacing it. Replacing throws
 *    away the guest's own words, and when the hypothesis drifts off-topic the
 *    retrieval has nothing left to anchor it. Averaging the two keeps the real
 *    question in the vector while borrowing the hypothesis's document-shaped
 *    phrasing.
 *
 * Published results for HyDE are corpus-dependent — it helps on some collections
 * and measurably hurts on others — so this ships disabled and stays disabled
 * unless bench/retrieval-eval.ts shows it winning on THIS corpus.
 */

import { chat } from "./llm";

export function hydeEnabled(): boolean {
  return process.env.HYDE_ENABLED === "1" || process.env.HYDE_ENABLED === "true";
}

/** How much of the fused query vector comes from the hypothetical document. */
export function hydeWeight(): number {
  const w = Number(process.env.HYDE_WEIGHT ?? 0.5);
  return Number.isFinite(w) ? Math.min(1, Math.max(0, w)) : 0.5;
}

/**
 * Queries worth spending an extra LLM call on.
 *
 * A short keyword lookup ("giá vé cáp treo") already matches lexically and
 * needs no hypothesis; generating one buys nothing and costs a round-trip on
 * every search. Longer, more conversational questions are where the vocabulary
 * gap between question and passage actually appears.
 */
export function shouldUseHyde(query: string): boolean {
  const words = query.trim().split(/\s+/).filter(Boolean).length;
  if (words >= 8) return true;
  // Explanatory questions ("tại sao", "như thế nào") describe a situation rather
  // than name a thing, which is the case HyDE was designed for.
  return /\b(tại sao|vì sao|như thế nào|thế nào|làm sao|có được không|why|how do|how can|what happens)\b/i.test(query);
}

const SYSTEM =
  "You draft a short, plausible passage from a hotel's knowledge base. Write 2-3 sentences in the same language as the question, in the style of an official policy or facility page. Do not answer conversationally, do not hedge, do not mention that you are uncertain. This text is used only for search matching and is never shown to anyone.";

/**
 * Draft the hypothetical passage. Returns null on any failure — a HyDE outage
 * must degrade to ordinary retrieval, never break a search.
 */
export async function hypotheticalDocument(query: string): Promise<string | null> {
  try {
    const r = await chat({
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: query },
      ],
      temperature: 0,
      maxTokens: 160,
    });
    const text = (r.choices[0]?.message?.content ?? "").trim();
    return text.length > 20 ? text : null;
  } catch {
    return null;
  }
}

/**
 * Combine the query vector with the hypothesis vector.
 *
 * L2-normalised before averaging so neither side dominates through sheer
 * magnitude, then re-normalised: cosine similarity is scale-invariant, but the
 * average of two un-normalised vectors is not the average of their directions.
 */
export function fuseVectors(queryVec: number[], hydeVec: number[], weight = hydeWeight()): number[] {
  const norm = (v: number[]) => {
    let s = 0;
    for (const x of v) s += x * x;
    const n = Math.sqrt(s);
    return n > 0 ? v.map((x) => x / n) : v;
  };
  const a = norm(queryVec);
  const b = norm(hydeVec);
  const n = Math.min(a.length, b.length);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = a[i] * (1 - weight) + b[i] * weight;
  return norm(out);
}
