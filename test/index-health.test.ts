/**
 * Vector-index compatibility checks.
 *
 * The bug these pin is not a crash. This deployment ran with 139 vectors from
 * text-embedding-3-small (1536-d) and a 384-d runtime embedder: cosine
 * similarity was undefined, the vector leg turned itself off, retrieval became
 * keyword-only, and eighteen of eighteen Korean, Chinese and Japanese benchmark
 * queries returned ZERO documents. Nothing logged a word.
 *
 * Every branch below therefore asserts two things: that the mismatch is
 * detected, and that it is reported as degraded rather than quietly tolerated.
 *
 *   DB_FILE=<a copy> npx tsx test/index-health.test.ts
 */

import { checkIndexHealth, EMBEDDING_VERSION } from "../server/index-health";
import { storage, migrate } from "../server/storage";
import { MODEL_EMBED, EMBED_PROVIDER } from "../server/llm";

let failures = 0;
function ok(cond: boolean, msg: string) {
  if (cond) console.log(`  PASS  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}

/* The checks read the real database, so the fixtures are the stored metadata
   row, which is restored at the end. migrate() creates index_meta on databases
   indexed before it existed. */
migrate();
const original = storage.getIndexMeta();
const chunks = storage.listChunks();
const vectors = chunks.filter((c) => c.embedding != null).length;
const realDim = (() => {
  const c = chunks.find((x) => x.embedding != null);
  try {
    return c ? (JSON.parse(c.embedding!) as number[]).length : 0;
  } catch {
    return 0;
  }
})();

function stamp(over: Partial<{ model: string; dimension: number; version: string }> = {}) {
  storage.setIndexMeta({
    provider: EMBED_PROVIDER,
    model: over.model ?? MODEL_EMBED,
    dimension: over.dimension ?? realDim,
    embeddingVersion: over.version ?? EMBEDDING_VERSION,
    chunkCount: chunks.length,
    vectorCount: vectors,
  });
}

async function main() {
  if (!vectors) {
    console.error("This test needs an embedded index. Run reindex.ts against the test copy first.");
    process.exit(2);
  }

  console.log("=== MATCHING INDEX ===");
  stamp();
  const good = await checkIndexHealth(async () => realDim);
  ok(good.usable, "a matching index is usable");
  ok(!good.degraded, "and not reported as degraded");
  ok(good.code === "ok", `code is ok (got ${good.code})`);

  console.log("=== DIMENSION MISMATCH — the bug that shipped ===");
  stamp({ dimension: realDim === 1536 ? 384 : 1536 });
  const dim = await checkIndexHealth(async () => realDim);
  ok(!dim.usable, "a dimension mismatch is NOT usable");
  ok(dim.degraded && dim.severity === "error", "it is degraded, at error severity");
  ok(dim.code === "dimension_mismatch", `code names the mismatch (got ${dim.code})`);
  ok(/reindex/i.test(dim.message), "and the message says what to do about it");

  console.log("=== MODEL MISMATCH — same dimension, different embedding space ===");
  /* Worse than a dimension clash, because nothing crashes: two models can share
     a width and share no meaning. */
  stamp({ model: "some-other-model" });
  const mod = await checkIndexHealth(async () => realDim);
  ok(!mod.usable, "a model mismatch is NOT usable even when dimensions agree");
  ok(mod.code === "model_mismatch", `code names it (got ${mod.code})`);
  ok(mod.message.includes("some-other-model"), "and the message names both models");

  console.log("=== PREPARATION VERSION MISMATCH ===");
  /* E5 needs "query:"/"passage:" prefixes and other models must not have them.
     Change how text is prepared and old vectors stop being comparable while
     every other field still matches. */
  stamp({ version: "999" });
  const ver = await checkIndexHealth(async () => realDim);
  ok(!ver.usable, "a preparation-version mismatch is NOT usable");
  ok(ver.code === "version_mismatch", `code names it (got ${ver.code})`);

  console.log("=== LEGACY INDEX WITH NO STAMP — the exact database that shipped ===");
  /* The first version of this check trusted the stamp, so a database with no
     index_meta row skipped the dimension probe entirely. That meant the very
     configuration that caused the incident — 1536-d vectors, 384-d runtime, no
     stamp, because the row did not exist yet — came back as a mild "identity
     unverified" warning with usable: true. Width is measurable without any
     metadata, so it gets measured. */
  storage.clearIndexMeta();
  const legacyBad = await checkIndexHealth(async () => (realDim === 1536 ? 384 : 1536));
  ok(!legacyBad.usable, "an unstamped index with the WRONG runtime width is not usable");
  ok(legacyBad.code === "dimension_mismatch", `code names it (got ${legacyBad.code})`);
  ok(legacyBad.severity === "error", "at error severity, not a warning");

  const legacyOk = await checkIndexHealth(async () => realDim);
  ok(legacyOk.usable, "an unstamped index with the RIGHT width still works");
  ok(legacyOk.severity === "warn" && legacyOk.code === "no_index", "but is reported as unverified");
  ok(/unverified/i.test(legacyOk.message), "and the message says so plainly");

  console.log("=== EMBEDDING ENDPOINT DOWN ===");
  stamp();
  const down = await checkIndexHealth(async () => {
    throw new Error("connection refused");
  });
  ok(!down.usable && down.code === "probe_failed", "an unreachable embedder is reported, not assumed healthy");
  ok(down.severity === "error", "at error severity");

  console.log("=== OPERATOR DECLARES BM25-ONLY ===");
  /* An air-gapped install with no embedding server is legitimate. It must still
     be visible, and it must still say what is lost. */
  process.env.ALLOW_BM25_ONLY = "1";
  const declared = await checkIndexHealth(async () => realDim);
  ok(declared.degraded && declared.degradedByChoice, "declared BM25-only is degraded BY CHOICE");
  ok(declared.severity === "warn", "warning, not error — the operator asked for it");
  ok(
    /Korean|Chinese|Japanese/.test(declared.message),
    "and the warning states which languages stop working",
  );
  delete process.env.ALLOW_BM25_ONLY;

  console.log("=== NOTHING IS SILENT ===");
  /* The property that actually matters: no configuration produces a healthy
     verdict while the vector leg is off. */
  for (const [label, h] of [
    ["dimension mismatch", dim],
    ["model mismatch", mod],
    ["version mismatch", ver],
    ["endpoint down", down],
    ["unstamped index, wrong width", legacyBad],
    ["declared bm25-only", declared],
  ] as const) {
    ok(h.degraded && h.message.length > 40, `${label} produces a degraded verdict with an explanation`);
  }

  /* Leave the database as it was found. */
  if (original) {
    storage.setIndexMeta({
      provider: original.provider,
      model: original.model,
      dimension: original.dimension,
      embeddingVersion: original.embeddingVersion,
      chunkCount: original.chunkCount,
      vectorCount: original.vectorCount,
    });
  }

  console.log(failures === 0 ? "\nALL INDEX-HEALTH TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
