/**
 * Local cross-encoder reranking — BAAI/bge-reranker-v2-m3 served on the GPU by
 * `reranker/rerank_server.py`, reached over loopback. This is the OFFLINE
 * counterpart to `rerank-hf.ts`: same model, same (query, passage) scoring, but
 * no network leaves the box, so the 100%-offline kiosk can use it.
 *
 * The Python service scores every candidate in ONE batched forward pass, so
 * unlike the HF path (one HTTP call per candidate) this is a single request for
 * the whole pool — a few tens of milliseconds for a depth-30 rerank on the GPU.
 *
 * SAFETY, identical to the other rerank backends: this only returns scores for
 * candidates retrieval already found. On any failure it returns null and the
 * caller keeps the first-stage order — a down reranker degrades ranking, never
 * content.
 */

import type { RerankCandidate } from "./rerank";

function base(): string {
  return process.env.LOCAL_RERANK_BASE || "http://127.0.0.1:11435";
}

export function localRerankConfigured(): boolean {
  // Enabled by pointing at the service; the URL has a working default, so the
  // backend selector (RERANK_BACKEND=local) is what actually turns it on.
  return true;
}

/**
 * Score every candidate against the query in one batched call. Returns id →
 * score in [0, 1], or null when the service could not be used (down, timeout,
 * malformed) — same fallback contract as the LLM and HF rerankers.
 */
export async function localCrossEncoderScores(
  query: string,
  candidates: RerankCandidate[],
): Promise<Map<number, number> | null> {
  if (candidates.length < 2) return null;
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), Number(process.env.LOCAL_RERANK_TIMEOUT_MS ?? 8000));
  try {
    const res = await fetch(`${base()}/rerank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        docs: candidates.map((c) => ({ id: c.id, text: c.text.slice(0, 2000) })),
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const parsed = (await res.json()) as { scores?: Array<{ id: number; score: number }> };
    if (!Array.isArray(parsed.scores) || !parsed.scores.length) return null;
    const known = new Set(candidates.map((c) => c.id));
    const out = new Map<number, number>();
    for (const s of parsed.scores) {
      if (known.has(s.id) && Number.isFinite(s.score)) out.set(s.id, Number(s.score));
    }
    return out.size ? out : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
