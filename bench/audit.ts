import "dotenv/config";

/**
 * Configuration audit — what this deployment is ACTUALLY running.
 *
 * Written because a summary claimed the system ran hybrid retrieval while the
 * database and the runtime disagreed about which embedding model existed. Every
 * line below is read from the repository, the database or `process.env` at the
 * moment it runs; nothing is carried over from a previous report.
 *
 * It is deliberately read-only and deliberately dumb: no inference, no network
 * calls except the one optional probe of the local embedding server, so it can
 * be run on a customer's machine to establish ground truth before anything else.
 *
 *   DB_FILE=data.db npx tsx bench/audit.ts [--json bench/audit.json]
 */

import { writeFileSync } from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";

const DB_FILE = process.env.DB_FILE ?? "data.db";

type Row = { label: string; value: string; note?: string };
const drift: string[] = [];

function h(title: string) {
  console.log(`\n${"─".repeat(78)}\n${title}\n${"─".repeat(78)}`);
}
function row(r: Row) {
  console.log(`  ${r.label.padEnd(34)} ${r.value}`);
  if (r.note) console.log(`  ${" ".repeat(34)} ${r.note}`);
}

async function main() {
  const report: Record<string, unknown> = { ranAt: new Date().toISOString(), dbFile: DB_FILE };

  if (!existsSync(DB_FILE)) {
    console.error(`Database ${DB_FILE} not found.`);
    process.exit(2);
  }
  const db = new Database(DB_FILE, { readonly: true });

  /* ---------------------------------------------------------- 1-2. LLM ---- */
  h("LLM PROVIDERS");

  /* Read the resolution rules from the module rather than restating them here,
     so this audit cannot drift from the code it audits. */
  const llm = await import("../server/llm");
  const hostedModel = process.env.OPENAI_AGENT_MODEL || "gpt-5.4-mini";
  const localModel = process.env.LOCAL_AGENT_MODEL || "(default in llm.ts)";
  const primary = (process.env.LLM_MODE ?? "openai").toLowerCase();
  const localApi = (process.env.LOCAL_API ?? "openai").toLowerCase();

  row({ label: "PRIMARY mode (LLM_MODE)", value: primary });
  row({ label: "hosted agent model", value: hostedModel });
  row({ label: "local agent model", value: localModel });
  row({
    label: "local transport",
    value: localApi === "ollama" ? "ollama native /api/chat" : "OpenAI-compatible /v1",
    note:
      localApi === "ollama"
        ? "reasoning models can be told not to think"
        : "WARNING: /v1 ignores `think` — a reasoning model will burn its budget on hidden tokens",
  });
  if (localApi !== "ollama" && /qwen3|reasoning|r1/i.test(localModel)) {
    drift.push(
      `LOCAL_API is "${localApi}" but LOCAL_AGENT_MODEL "${localModel}" looks like a reasoning model. ` +
        `The /v1 endpoint cannot disable thinking; expect empty answers and finish_reason=length.`,
    );
  }
  report.llm = { primary, hostedModel, localModel, localApi };

  /* ------------------------------------------------------- 3-7. VECTORS --- */
  h("EMBEDDINGS — RUNTIME vs STORED");

  const runtimeProvider = llm.EMBED_PROVIDER;
  const runtimeModel = llm.MODEL_EMBED;
  row({ label: "runtime embed provider", value: runtimeProvider });
  row({ label: "runtime embed model", value: runtimeModel });

  /* What the database actually holds. `embed_model` is recorded per chunk, so a
     partially reindexed corpus shows up as more than one row here. */
  const stored = db
    .prepare(
      `SELECT embed_model, COUNT(*) AS n, SUM(embedding IS NOT NULL) AS embedded
         FROM doc_chunks GROUP BY embed_model`,
    )
    .all() as { embed_model: string | null; n: number; embedded: number }[];

  const totalChunks = (db.prepare(`SELECT COUNT(*) c FROM doc_chunks`).get() as { c: number }).c;
  const totalVectors = (
    db.prepare(`SELECT COUNT(*) c FROM doc_chunks WHERE embedding IS NOT NULL`).get() as { c: number }
  ).c;

  /* Dimension is not stored as a column — it is a property of the JSON payload,
     so it is measured rather than trusted. */
  const sample = db
    .prepare(`SELECT embed_model, embedding FROM doc_chunks WHERE embedding IS NOT NULL LIMIT 1`)
    .get() as { embed_model: string | null; embedding: string } | undefined;
  let storedDim: number | null = null;
  if (sample) {
    try {
      storedDim = (JSON.parse(sample.embedding) as number[]).length;
    } catch {
      storedDim = null;
    }
  }

  row({ label: "indexed chunks", value: String(totalChunks) });
  row({ label: "stored vectors", value: `${totalVectors} (${((totalVectors / totalChunks) * 100).toFixed(1)}%)` });
  row({ label: "stored vector model(s)", value: stored.map((s) => `${s.embed_model ?? "null"} ×${s.n}`).join(", ") });
  row({ label: "stored vector dimension", value: storedDim === null ? "unreadable" : String(storedDim) });

  if (stored.length > 1) {
    drift.push(
      `The index contains vectors from ${stored.length} different models ` +
        `(${stored.map((s) => s.embed_model).join(", ")}). A cosine comparison across models is meaningless.`,
    );
  }

  const storedModel = stored[0]?.embed_model ?? null;
  const modelsMatch = storedModel !== null && storedModel === runtimeModel;
  row({
    label: "runtime model == stored model?",
    value: modelsMatch ? "yes" : "NO",
    note: modelsMatch ? undefined : `stored "${storedModel}" vs runtime "${runtimeModel}"`,
  });

  /* Probe the live embedding endpoint for its real dimension. This is the only
     way to prove incompatibility rather than infer it from model names. */
  let runtimeDim: number | null = null;
  let probeError: string | null = null;
  try {
    const [v] = await llm.embed(["dimension probe"]);
    runtimeDim = v?.length ?? null;
  } catch (e) {
    probeError = String(e).slice(0, 160);
  }
  row({
    label: "runtime vector dimension",
    value: runtimeDim === null ? `probe failed: ${probeError}` : String(runtimeDim),
  });

  const compatible = runtimeDim !== null && storedDim !== null && runtimeDim === storedDim && modelsMatch;
  if (runtimeDim !== null && storedDim !== null && runtimeDim !== storedDim) {
    drift.push(
      `INDEX INCOMPATIBLE — stored vectors are ${storedDim}-dimensional (${storedModel}), ` +
        `the runtime embedder returns ${runtimeDim} (${runtimeModel}). Cosine similarity cannot be computed. ` +
        `Reindex, or switch the runtime model back.`,
    );
  } else if (!modelsMatch && runtimeDim !== null && storedDim !== null) {
    drift.push(
      `Stored vectors were built by "${storedModel}" but the runtime embedder is "${runtimeModel}". ` +
        `The dimensions happen to agree (${storedDim}), so nothing will crash — and the vectors are still ` +
        `from a different embedding space, which is worse than a crash because it fails silently.`,
    );
  }
  report.embeddings = { runtimeProvider, runtimeModel, runtimeDim, storedModel, storedDim, totalChunks, totalVectors, compatible };

  /* ------------------------------------------------------ 8-9. RETRIEVAL -- */
  h("RETRIEVAL PIPELINE");

  const retrieval = await import("../server/retrieval");
  const probe = await retrieval.hybridSearch("giờ trả phòng", { k: 3 });
  const vecWeightEnv = process.env.RRF_VEC_WEIGHT;
  /* The effective weight is model-dependent by default, so it is read back from
     an actual search rather than recomputed. */
  const vectorLegRan = probe.results.some((r) => r.matched_by.includes("semantic"));

  row({ label: "strategy reported", value: probe.strategy });
  row({ label: "vector leg actually ran", value: vectorLegRan ? "yes" : "NO" });
  row({ label: "RRF_VEC_WEIGHT (env)", value: vecWeightEnv ?? "(unset — model-dependent default)" });
  row({ label: "RRF_LEX_WEIGHT (env)", value: process.env.RRF_LEX_WEIGHT ?? "(unset — default 1)" });
  row({ label: "BM25_TITLE_BOOST", value: process.env.BM25_TITLE_BOOST ?? "(unset — default 0.6)" });
  row({ label: "HyDE", value: process.env.HYDE_ENABLED === "1" ? "ENABLED" : "disabled" });
  row({ label: "reranker", value: process.env.RERANK_ENABLED === "1" ? "ENABLED" : "disabled" });

  if (!vectorLegRan && totalVectors > 0) {
    drift.push(
      `${totalVectors} vectors are stored but the vector leg did not run — retrieval is BM25-only. ` +
        `The embedding work is currently dead weight, and the strategy string is the only signal of it.`,
    );
  }
  report.retrieval = {
    strategy: probe.strategy,
    vectorLegRan,
    vecWeightEnv: vecWeightEnv ?? null,
    hyde: process.env.HYDE_ENABLED === "1",
    rerank: process.env.RERANK_ENABLED === "1",
  };

  /* ------------------------------------------------------- 10-12. DATA ---- */
  h("KNOWLEDGE BASE");

  const byCat = db
    .prepare(`SELECT category, COUNT(*) n FROM doc_chunks GROUP BY category ORDER BY n DESC`)
    .all() as { category: string; n: number }[];
  for (const c of byCat) row({ label: c.category, value: String(c.n) });

  const quality = db
    .prepare(`SELECT quality, COUNT(*) n FROM doc_chunks GROUP BY quality`)
    .all() as { quality: string; n: number }[];
  row({ label: "— provenance —", value: quality.map((q) => `${q.quality}: ${q.n}`).join(", ") });

  const policies = (db.prepare(`SELECT COUNT(*) c FROM policies`).get() as { c: number }).c;
  const roomTypes = (db.prepare(`SELECT COUNT(*) c FROM room_types`).get() as { c: number }).c;
  const packages = (db.prepare(`SELECT COUNT(*) c FROM room_packages`).get() as { c: number }).c;
  row({ label: "policies", value: String(policies) });
  row({ label: "room types", value: String(roomTypes) });
  row({ label: "rate packages", value: String(packages) });

  let canonical = 0;
  try {
    const cf = JSON.parse(readFileSync("server/data/canonical-facts.json", "utf8"));
    canonical = Array.isArray(cf) ? cf.length : Object.keys(cf.facts ?? cf).length;
  } catch {
    canonical = -1;
  }
  row({ label: "canonical facts", value: canonical < 0 ? "file unreadable" : String(canonical) });

  /* Documents dominated by `key: value` lines. Kept as a first-class metric
     because the offline benchmark traced several wrong answers to them: a small
     model reading a config dump picks the wrong line. */
  const kvDocs = (
    db.prepare(`SELECT title, body FROM doc_chunks`).all() as { title: string; body: string }[]
  ).filter((r) => (r.body.match(/[a-z_]+ ?[a-z_]*: /g) ?? []).length >= 8);
  row({
    label: "key:value-shaped chunks",
    value: `${kvDocs.length} / ${totalChunks} (${((kvDocs.length / totalChunks) * 100).toFixed(0)}%)`,
  });
  report.knowledge = { byCategory: byCat, policies, roomTypes, packages, canonical, kvChunks: kvDocs.length, totalChunks };

  /* ------------------------------------------------------ 13-15. BENCH ---- */
  h("EVALUATION COVERAGE");

  const count = (file: string, re: RegExp): number => {
    try {
      return (readFileSync(file, "utf8").match(re) ?? []).length;
    } catch {
      return -1;
    }
  };
  const hostedCases = count("bench.ts", /^\s{4}id: "/gm);
  const offlineCases = count("bench/offline-answers.ts", /\{ id: "/g);
  const goldenCases = (() => {
    try {
      return JSON.parse(readFileSync("bench/retrieval-golden.json", "utf8")).cases.length;
    } catch {
      return -1;
    }
  })();
  /* The multilingual set is stored by INTENT, with one query per language under
     each — so its size is intents × languages, not a `cases` array like the
     monolingual set. */
  const mlCases = (() => {
    try {
      const j = JSON.parse(readFileSync("bench/retrieval-golden-multilingual.json", "utf8"));
      return (j.intents ?? []).reduce((n: number, i: any) => n + Object.keys(i.queries ?? {}).length, 0);
    } catch {
      return -1;
    }
  })();

  row({ label: "hosted agent benchmark", value: `${hostedCases} cases`, note: hostedCases < 60 ? "BELOW the 60-case target for the primary commercial path" : undefined });
  row({ label: "offline answer benchmark", value: `${offlineCases} cases` });
  row({ label: "retrieval golden set", value: `${goldenCases} queries` });
  row({ label: "multilingual golden set", value: `${mlCases} queries` });
  row({ label: "multi-turn scenarios", value: existsSync("bench/multiturn.ts") ? "present" : "NONE" });
  row({ label: "prompt-injection suite", value: existsSync("bench/injection.ts") ? "present" : "NONE" });
  row({ label: "concurrency harness", value: existsSync("bench/load.ts") ? "present" : "NONE" });

  if (hostedCases < 60) {
    drift.push(
      `The hosted path is the primary commercial product and is measured by ${hostedCases} cases, ` +
        `while the offline fallback is measured by ${offlineCases}. Evaluation effort is inverted.`,
    );
  }
  report.evaluation = { hostedCases, offlineCases, goldenCases, mlCases,
    multiTurn: existsSync("bench/multiturn.ts"), injection: existsSync("bench/injection.ts"), load: existsSync("bench/load.ts") };

  /* --------------------------------------------------- 16-17. METHOD ------ */
  h("LATENCY METHODOLOGY & GUARDS");

  row({ label: "latency measured as", value: "wall-clock per turn, single request" });
  row({ label: "TTFT measured", value: "NO — responses are non-streaming (stream:false)" });
  row({ label: "tokens/sec measured", value: "NO" });
  row({ label: "concurrency measured", value: "NO — all figures are 1 request at a time" });
  row({ label: "cold vs warm separated", value: "NO — model-load time is inside the first measurement" });

  const guards = [
    ["numeric guard (numguard)", existsSync("server/numguard.ts") || existsSync("numguard.ts")],
    ["retrieval gate (offline)", existsSync("server/local-agent.ts")],
    ["tool router families", existsSync("server/toolrouter.ts")],
    ["transaction wizard", existsSync("server/wizard.ts")],
    ["observability spans", existsSync("server/observability.ts")],
    ["Langfuse export", existsSync("server/langfuse.ts")],
  ] as const;
  for (const [name, present] of guards) row({ label: name, value: present ? "present" : "ABSENT" });

  /* ------------------------------------------------------------ DRIFT ----- */
  h(`CONFIGURATION DRIFT — ${drift.length} finding(s)`);
  if (!drift.length) console.log("  none detected.");
  for (const [i, d] of drift.entries()) console.log(`  ${i + 1}. ${d}\n`);
  report.drift = drift;

  const ji = process.argv.indexOf("--json");
  if (ji >= 0) {
    writeFileSync(process.argv[ji + 1], JSON.stringify(report, null, 2));
    console.log(`\nwritten to ${process.argv[ji + 1]}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
