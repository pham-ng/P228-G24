/**
 * Real cross-encoder reranking via BAAI/bge-reranker-v2-m3, hosted on Hugging
 * Face's Inference API.
 *
 * `server/rerank.ts` already has a reranker, but it is an LLM (GPT-5.4-mini)
 * asked to score candidates in a batched chat call — a judgement call, not a
 * purpose-trained relevance model. The Ollama package for the actual
 * bge-reranker-v2-m3 model turned out to expose only single-text embedding
 * (`/api/embed`), which cannot score a (query, passage) PAIR at all — the one
 * thing a cross-encoder is for. This module is the real thing, confirmed by a
 * direct probe before writing a line of scoring logic: a relevant pair scored
 * 0.72, an irrelevant one 0.000017, three orders of magnitude apart.
 *
 * Two things about the endpoint that were not in the generic docs and had to
 * be found by calling it:
 *   1. `router.huggingface.co/hf-inference/models/...` — the current routing
 *      host. The older `api-inference.huggingface.co` does not resolve
 *      through this environment's egress proxy.
 *   2. The pipeline rejects the documented `{text, text_pair}` object shape
 *      ("missing 1 required positional argument: 'inputs'") and only accepts
 *      a single string with the two texts joined by "[SEP]" — the raw format
 *      the model's own tokenizer expects, which the hosted pipeline passes
 *      through unprocessed rather than building for you.
 *
 * This is a NETWORK call to a third party, unlike the local bge-m3 embedding.
 * It answers "does cross-encoder reranking help" for the hosted path, which
 * already calls out to OpenAI — it says nothing about the 100%-offline kiosk,
 * which by definition cannot make this call.
 */

const MODEL = "BAAI/bge-reranker-v2-m3";
const URL = `https://router.huggingface.co/hf-inference/models/${MODEL}`;

export function hfRerankConfigured(): boolean {
  return !!process.env.HF_API_KEY;
}

type HfResponse = [{ label: string; score: number }][];

/**
 * Score one (query, passage) pair. Returns a relevance score in [0, 1], or
 * null on any failure — callers keep the original rank order in that case,
 * same fallback contract as the LLM reranker.
 */
async function scoreOne(query: string, passage: string): Promise<number | null> {
  try {
    const res = await fetch(URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.HF_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ inputs: `${query} [SEP] ${passage}` }),
    });
    if (!res.ok) return null;
    const parsed = (await res.json()) as HfResponse;
    return parsed?.[0]?.[0]?.score ?? null;
  } catch {
    return null;
  }
}

export type RerankCandidate = { id: number; title: string; text: string };

/**
 * Score every candidate against the query. One HTTP call per candidate — the
 * Inference API's text-classification pipeline takes one input at a time, so
 * this cannot be batched into a single request the way the LLM reranker's
 * chat call is. Run with limited concurrency to stay polite to the free tier.
 *
 * Returns null (not a partial map) if MORE THAN HALF the calls fail, so a
 * rate-limited run degrades to "reranker unavailable" rather than silently
 * reordering on a mix of real scores and missing ones.
 */
export async function hfCrossEncoderScores(
  query: string,
  candidates: RerankCandidate[],
): Promise<Map<number, number> | null> {
  if (candidates.length < 2 || !hfRerankConfigured()) return null;

  const CONCURRENCY = 3;
  const scores = new Map<number, number>();
  let failed = 0;
  let i = 0;
  async function worker() {
    while (i < candidates.length) {
      const c = candidates[i++];
      const s = await scoreOne(query, c.text.slice(0, 1000));
      if (s === null) failed++;
      else scores.set(c.id, s);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, worker));

  if (failed > candidates.length / 2) return null;
  return scores;
}
