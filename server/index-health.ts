/**
 * Vector-index compatibility check.
 *
 * The failure this exists to prevent is not a crash — it is a system that looks
 * healthy while retrieving nothing. This deployment stored 139 vectors from
 * text-embedding-3-small (1536-d) and ran with a 384-d local embedder. Cosine
 * similarity between those is undefined, so the vector leg turned itself off and
 * retrieval quietly became BM25-only. On Vietnamese and English the damage was
 * invisible (BM25 alone scores hit@1 88.5%); on the multilingual set it was
 * total, because BM25 cannot tokenise Korean, Chinese or Japanese and returned
 * ZERO results for all eighteen of those queries.
 *
 * Nobody noticed, because nothing said anything. The only signal was a substring
 * inside a `strategy` field nobody read.
 *
 * So the rule this module enforces is narrow and absolute: the system may run
 * BM25-only, but never by accident. Degradation must be either impossible, or
 * declared by the operator and visible in the logs, the health endpoint and
 * every trace.
 */

import { storage } from "./storage";
import { EMBED_PROVIDER, MODEL_EMBED, embed } from "./llm";
import type { IndexMeta } from "@shared/schema";

/**
 * Version of the text PREPARATION pipeline, independent of the model name.
 *
 * E5-family models need "query: " / "passage: " prefixes; others must not have
 * them. Change how passages are built — prefixes, chunk boundaries, title
 * concatenation — and vectors built before the change are no longer comparable
 * with queries built after it, even though `embed_model` still matches. That
 * mismatch is invisible to every other check here, so it gets its own number
 * and this constant must be bumped by hand when the preparation changes.
 */
export const EMBEDDING_VERSION = "1";

export type IndexHealth = {
  /** Can the vector leg be trusted to produce meaningful similarities? */
  usable: boolean;
  /** True when retrieval is running on keywords alone. */
  degraded: boolean;
  /** Set when the operator asked for BM25-only rather than it happening to them. */
  degradedByChoice: boolean;
  severity: "ok" | "warn" | "error";
  code:
    | "ok"
    | "no_index"
    | "no_vectors"
    | "dimension_mismatch"
    | "model_mismatch"
    | "version_mismatch"
    | "partial_index"
    | "declared_bm25_only"
    | "probe_failed";
  message: string;
  meta: IndexMeta | null;
  runtime: { provider: string; model: string; dimension: number | null; version: string };
};

/**
 * Operator's explicit consent to run without semantic search.
 *
 * Deliberately not a boolean that defaults to true somewhere: an operator who
 * has read what they lose sets this, and the loss is still reported on every
 * startup and every trace. It exists because a genuine air-gapped install with
 * no embedding server is a legitimate deployment, and refusing to start would be
 * the wrong answer for it.
 */
function bm25OnlyDeclared(): boolean {
  const v = (process.env.ALLOW_BM25_ONLY ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Compare the stored index against the running configuration.
 *
 * `probeDimension` is injected so tests can exercise every branch without an
 * embedding server, and so callers that already hold a vector do not pay for a
 * second round trip.
 */
export async function checkIndexHealth(
  probeDimension?: () => Promise<number | null>,
): Promise<IndexHealth> {
  const meta = storage.getIndexMeta();
  const chunks = storage.listChunks();
  const vectors = chunks.filter((c) => c.embedding != null).length;

  const runtime = {
    provider: EMBED_PROVIDER,
    model: MODEL_EMBED,
    dimension: null as number | null,
    version: EMBEDDING_VERSION,
  };

  const declared = bm25OnlyDeclared();
  const base = { meta, runtime, degradedByChoice: declared };

  if (declared) {
    return {
      ...base,
      usable: false,
      degraded: true,
      severity: "warn",
      code: "declared_bm25_only",
      message:
        "ALLOW_BM25_ONLY is set: running keyword-only retrieval by operator choice. " +
        "Semantic and cross-language search are OFF — questions in Korean, Chinese or Japanese " +
        "will return no results against a Vietnamese/English corpus.",
    };
  }

  if (!vectors) {
    return {
      ...base,
      usable: false,
      degraded: true,
      severity: "error",
      code: chunks.length ? "no_vectors" : "no_index",
      message: chunks.length
        ? `${chunks.length} chunks are indexed but none carry a vector. Run reindex.ts, or set ALLOW_BM25_ONLY=1 to accept keyword-only retrieval.`
        : "The retrieval index is empty. Run reindex.ts.",
    };
  }

  /* A half-embedded corpus is the quietest failure of all: search works, and the
     documents that happen to lack vectors are simply never found semantically. */
  if (vectors < chunks.length) {
    return {
      ...base,
      usable: false,
      degraded: true,
      severity: "error",
      code: "partial_index",
      message:
        `Only ${vectors} of ${chunks.length} chunks have vectors. A partial index hides ` +
        `documents from semantic search without any error. Re-run reindex.ts.`,
    };
  }

  /* The width of the vectors actually stored, measured rather than declared.
     This is the one fact available even on an index built before index_meta
     existed, and it is what makes the check work on legacy databases: the first
     version of this module trusted the stamp, so the exact database that caused
     the incident — 1536-d vectors, 384-d runtime, no stamp — came back as a mild
     "identity unverified" warning and `usable: true`. Measuring closes that. */
  const measuredDim = (() => {
    const c = chunks.find((x) => x.embedding != null);
    try {
      return c ? (JSON.parse(c.embedding!) as number[]).length : 0;
    } catch {
      return 0;
    }
  })();

  /* An index built before this table existed. Its identity is unverified, but
     its SHAPE is not — so probe the embedder and compare widths before deciding
     anything is fine. */
  if (!meta) {
    let d: number | null = null;
    try {
      d = probeDimension ? await probeDimension() : (await embed(["dimension probe"]))[0]?.length ?? null;
    } catch (e) {
      return {
        ...base,
        usable: false,
        degraded: true,
        severity: "error",
        code: "probe_failed",
        message: `The embedding endpoint did not answer, so semantic search is off: ${String(e).slice(0, 200)}`,
      };
    }
    runtime.dimension = d;

    if (d !== null && measuredDim > 0 && d !== measuredDim) {
      return {
        ...base,
        usable: false,
        degraded: true,
        severity: "error",
        code: "dimension_mismatch",
        message:
          `Index holds ${measuredDim}-d vectors but the runtime embedder "${MODEL_EMBED}" returns ${d}-d. ` +
          `Similarity is undefined and the vector leg will not run — retrieval is keyword-only. Re-run reindex.ts.`,
      };
    }

    return {
      ...base,
      usable: true,
      degraded: false,
      severity: "warn",
      code: "no_index",
      message:
        `The index carries ${vectors} ${measuredDim}-d vectors whose width matches the runtime embedder, but no ` +
        `recorded identity (built before index_meta existed). Two models of equal width are still different ` +
        `embedding spaces, so this is unverified rather than verified. Re-run reindex.ts to stamp it.`,
    };
  }

  if (meta.model !== MODEL_EMBED) {
    return {
      ...base,
      usable: false,
      degraded: true,
      severity: "error",
      code: "model_mismatch",
      message:
        `Index was built by "${meta.model}" (${meta.provider}, ${meta.dimension}-d) but the runtime embedder ` +
        `is "${MODEL_EMBED}" (${EMBED_PROVIDER}). Vectors from different models are not comparable. ` +
        `Re-run reindex.ts, or set the runtime model back to "${meta.model}".`,
    };
  }

  if (meta.embeddingVersion !== EMBEDDING_VERSION) {
    return {
      ...base,
      usable: false,
      degraded: true,
      severity: "error",
      code: "version_mismatch",
      message:
        `Index was built with embedding preparation version ${meta.embeddingVersion}, the runtime uses ` +
        `${EMBEDDING_VERSION}. The model matches but the text fed to it does not. Re-run reindex.ts.`,
    };
  }

  /* Last and strongest check: ask the live embedder what it actually returns.
     Model names can be aliases, quantisations can differ, and a served model can
     be swapped underneath an unchanged name. */
  let dim: number | null = null;
  try {
    dim = probeDimension ? await probeDimension() : (await embed(["dimension probe"]))[0]?.length ?? null;
  } catch (e) {
    return {
      ...base,
      usable: false,
      degraded: true,
      severity: "error",
      code: "probe_failed",
      message:
        `The embedding endpoint did not answer, so the index cannot be verified and semantic search is off: ` +
        `${String(e).slice(0, 200)}`,
    };
  }
  runtime.dimension = dim;

  if (dim !== null && dim !== meta.dimension) {
    return {
      ...base,
      usable: false,
      degraded: true,
      severity: "error",
      code: "dimension_mismatch",
      message:
        `Index holds ${meta.dimension}-d vectors ("${meta.model}") but the runtime embedder returned ${dim}-d ` +
        `("${MODEL_EMBED}"). Similarity is undefined. Re-run reindex.ts.`,
    };
  }

  return {
    ...base,
    usable: true,
    degraded: false,
    severity: "ok",
    code: "ok",
    message: `Hybrid retrieval ready: ${vectors} vectors, ${meta.dimension}-d, "${meta.model}" (${meta.provider}).`,
  };
}

/**
 * Cached health, so the trace annotation on every turn costs nothing.
 *
 * Retrieval configuration is fixed at process start, so a single evaluation per
 * process is the correct scope; anything that changes it also restarts the app.
 */
let cached: IndexHealth | null = null;

export async function indexHealth(force = false): Promise<IndexHealth> {
  if (!cached || force) cached = await checkIndexHealth();
  return cached;
}

/** Synchronous read for hot paths. Null until the startup check has run. */
export function cachedIndexHealth(): IndexHealth | null {
  return cached;
}

/**
 * Report health at startup. Loud on the failure that used to be silent.
 *
 * Returns false when the operator should stop and fix something. Whether that
 * halts the process is the caller's decision — a hotel kiosk degrading to
 * keyword search is better than a kiosk that will not boot, provided everyone
 * can see which one they have.
 */
export async function reportIndexHealth(): Promise<boolean> {
  const h = await indexHealth(true);
  const bar = "═".repeat(76);
  if (h.severity === "ok") {
    console.log(`[retrieval] ${h.message}`);
    return true;
  }
  const tag = h.severity === "error" ? "RETRIEVAL DEGRADED" : "RETRIEVAL WARNING";
  console.error(`\n${bar}\n  ${tag} — ${h.code}\n${bar}`);
  console.error(`  ${h.message}`);
  console.error(`  index  : ${h.meta ? `${h.meta.model} · ${h.meta.dimension}-d · v${h.meta.embeddingVersion} · ${h.meta.vectorCount} vectors` : "(no recorded identity)"}`);
  console.error(`  runtime: ${h.runtime.model} · ${h.runtime.dimension ?? "?"}-d · v${h.runtime.version} · ${h.runtime.provider}`);
  if (h.degraded) {
    console.error(
      `  effect : keyword-only retrieval. Vietnamese and English degrade quietly; ` +
        `Korean, Chinese and Japanese return nothing.`,
    );
  }
  console.error(`${bar}\n`);
  return h.severity !== "error";
}
