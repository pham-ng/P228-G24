/**
 * Cross-encoder style reranking, behind a flag, measured like everything else.
 *
 * First-stage retrieval (BM25 + vectors) scores a query against each document
 * independently, which is fast but shallow: it cannot tell that a page about
 * Bách Giai is the wrong answer to a question naming Lotus, because both look
 * like restaurant pages. A reranker reads the query and the candidate TOGETHER
 * and scores relevance directly, which is exactly the judgement first-stage
 * scoring cannot make.
 *
 * Here that judgement comes from the hosted model, in one batched call over the
 * top-N candidates. That costs a round-trip, so it is off by default and only
 * worth switching on where the benchmark shows it winning.
 *
 * SAFETY: the reranker only REORDERS candidates that retrieval already found. It
 * cannot introduce a document, cannot edit one, and cannot invent a fact — a
 * model failure degrades to the original order, never to wrong content.
 */

import { chat, extractJsonObject } from "./llm";

export function rerankEnabled(): boolean {
  return process.env.RERANK_ENABLED === "1" || process.env.RERANK_ENABLED === "true";
}

/** How many first-stage candidates to rerank.
 *
 *  For the LLM backend, beyond ~10 the cost stops paying and the default stays
 *  8. The cross-encoder backends are cheap per candidate (one batched GPU pass),
 *  and the depth MATTERS: measurement showed correct documents that BM25 buries
 *  sit as deep as rank #17-21 in the fused list, so a depth-8 pool never sees
 *  them. Set RERANK_DEPTH=30 for the cross-encoder. Cap raised to 60 so that is
 *  expressible; the LLM path should not be pushed that deep. */
export function rerankDepth(): number {
  const n = Number(process.env.RERANK_DEPTH ?? 8);
  return Number.isFinite(n) && n > 1 ? Math.min(60, n) : 8;
}

/** Which reranker scores candidates: the local GPU cross-encoder, the hosted HF
 *  cross-encoder, or the LLM. Defaults to the LLM for backward compatibility —
 *  the offline kiosk sets RERANK_BACKEND=local. */
export function rerankBackend(): "local" | "hf" | "llm" {
  const b = (process.env.RERANK_BACKEND ?? "llm").toLowerCase();
  return b === "local" || b === "hf" ? b : "llm";
}

/**
 * Score candidates with whichever backend is configured. Each backend has the
 * same contract — id → score, or null to keep the first-stage order — so the
 * caller does not care which one ran. A cross-encoder backend that returns null
 * (service down) falls back to the LLM reranker rather than to no reranking,
 * unless RERANK_STRICT=1 pins it to the chosen backend for clean measurement.
 */
export async function getRerankScores(
  query: string,
  candidates: RerankCandidate[],
): Promise<Map<number, number> | null> {
  const backend = rerankBackend();
  if (backend === "local") {
    const { localCrossEncoderScores } = await import("./rerank-local");
    const s = await localCrossEncoderScores(query, candidates);
    if (s || process.env.RERANK_STRICT === "1") return s;
    return rerankScores(query, candidates);
  }
  if (backend === "hf") {
    const { hfCrossEncoderScores } = await import("./rerank-hf");
    const s = await hfCrossEncoderScores(query, candidates);
    if (s || process.env.RERANK_STRICT === "1") return s;
    return rerankScores(query, candidates);
  }
  return rerankScores(query, candidates);
}

export type RerankCandidate = { id: number; title: string; text: string };

const SYSTEM =
  "You rank hotel knowledge-base passages by how well each ANSWERS a guest's question. " +
  "A passage that merely shares a topic is not relevant; a passage naming a different venue, room or policy than the one asked about is NOT relevant. " +
  'Reply with a single minified JSON object: {"scores":[{"id":<id>,"score":<0-10>}]} covering every candidate, and nothing else.';

/**
 * Score candidates against the query. Returns a map of id → score, or null when
 * the model could not be used — callers keep the original order in that case.
 */
export async function rerankScores(
  query: string,
  candidates: RerankCandidate[],
): Promise<Map<number, number> | null> {
  if (candidates.length < 2) return null;
  const listing = candidates
    .map((c) => `[${c.id}] ${c.title}\n${c.text.replace(/\s+/g, " ").slice(0, 400)}`)
    .join("\n\n");
  try {
    const r = await chat({
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Question: ${query}\n\nCandidates:\n${listing}` },
      ],
      temperature: 0,
      maxTokens: 400,
    });
    const parsed = extractJsonObject(r.choices[0]?.message?.content ?? "") as {
      scores?: Array<{ id: number; score: number }>;
    };
    if (!Array.isArray(parsed.scores) || !parsed.scores.length) return null;
    const known = new Set(candidates.map((c) => c.id));
    const out = new Map<number, number>();
    for (const s of parsed.scores) {
      /* Ignore ids the model invented — a hallucinated candidate must never
         enter the ranking. */
      if (known.has(s.id) && Number.isFinite(s.score)) out.set(s.id, Number(s.score));
    }
    return out.size ? out : null;
  } catch {
    return null;
  }
}

/**
 * Apply reranker scores to a ranked list.
 *
 * Candidates the reranker did not score keep their first-stage order BELOW the
 * scored ones: an unscored document is unjudged, not judged irrelevant, and
 * dropping it would let one flaky model call lose a correct answer entirely.
 */
export function applyRerank<T extends { id: number }>(ranked: T[], scores: Map<number, number>): T[] {
  const scored = ranked.filter((r) => scores.has(r.id));
  const unscored = ranked.filter((r) => !scores.has(r.id));
  scored.sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0));
  return [...scored, ...unscored];
}
