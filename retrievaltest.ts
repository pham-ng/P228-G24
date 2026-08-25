/**
 * Retrieval test suite verifying hybrid search, E5 embeddings, dimension guard,
 * cross-lingual capabilities, and BM25 fallback.
 */
import "dotenv/config";
import { hybridSearch, indexStats } from "./server/retrieval";
import { storage } from "./server/storage";
import * as llm from "./server/llm";
import { MODEL_EMBED } from "./server/llm";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`  FAIL  ${msg}`);
    process.exit(1);
  }
  console.log(`  PASS  ${msg}`);
}

async function runTests() {
  console.log("=== RETRIEVAL TEST SUITE ===");

  /* Test 1: every stored vector shares one dimensionality.
     Previously this asserted a literal 384, which is e5-small's width — so
     upgrading to a better embedding model failed the test even though the index
     was perfectly healthy. The invariant that actually matters is CONSISTENCY:
     vectors from two different models cannot be compared, and a mixed index
     produces confident nonsense rather than an error. The width itself is a
     property of whichever model is configured. */
  const chunks = storage.listChunks().filter((c) => c.embedding);
  assert(chunks.length > 0, "DB contains embedded chunks");

  const dims = new Set(chunks.map((c) => (JSON.parse(c.embedding!) as number[]).length));
  const models = new Set(chunks.map((c) => c.embedModel));
  assert(
    dims.size === 1,
    `Mọi vector trong DB (${chunks.length} chunks) cùng số chiều: ${[...dims].join(", ")} (model: ${[...models].join(", ")})`,
  );
  assert(models.size === 1, `Toàn bộ index dùng cùng một model embedding: ${[...models].join(", ")}`);

  // Test 2: Cross-lingual retrieval (Truy vấn tiếng Việt tìm được đoạn văn nguồn tiếng Anh)
  const vietnameseQuery = "Trả phòng muộn mất bao nhiêu tiền?";
  const searchRes = await hybridSearch(vietnameseQuery, { k: 4 });
  assert(searchRes.results.length > 0, "Hybrid search returns results for Vietnamese query");
  
  const foundCheckoutPolicy = searchRes.results.some(
    (r) => r.category.includes("checkout") || r.category.includes("policy") || r.title.toLowerCase().includes("check") || r.content.toLowerCase().includes("checkout") || r.content.toLowerCase().includes("late")
  );
  assert(foundCheckoutPolicy, "Truy vấn tiếng Việt tìm thành công đoạn văn policy nguồn tiếng Anh (cross-lingual)");


  // Test 3: Khẳng định hệ thống báo lỗi rõ ràng khi số chiều bị lệch (Dimension mismatch guard)
  // Tạo giả lập một chunk với vector 1536 chiều
  const originalChunks = storage.listChunks();
  const sampleChunk = originalChunks.find((c) => c.embedding);
  assert(!!sampleChunk, "Found sample chunk for dimension guard test");

  const originalEmbedding = sampleChunk!.embedding;
  /* The injected vector must differ from whatever the CONFIGURED model produces.
     This used to hard-code 1536 on the assumption the real vectors were 384 —
     which silently stopped testing anything the moment a 1536-dimension model was
     indexed, because the "wrong" vector was then the right width. Derive it. */
  const realDim = (JSON.parse(sampleChunk!.embedding!) as number[]).length;
  const wrongDim = realDim === 384 ? 1536 : 384;
  const fakeVector = JSON.stringify(new Array(wrongDim).fill(0.1));

  // Set fake vector into DB chunk temporarily
  storage.setChunkEmbedding(sampleChunk!.id, fakeVector, `fake-${wrongDim}-model`);

  let dimensionGuardTriggered = false;
  let errorMessage = "";
  // Production defaults the vector leg off (RRF_VEC_WEIGHT=0), which skips the
  // embedding call — and therefore the dimension guard. Force the leg on so this
  // test actually exercises the guard it is about.
  const prevWeight = process.env.RRF_VEC_WEIGHT;
  process.env.RRF_VEC_WEIGHT = "1";
  try {
    await hybridSearch("Kiểm tra báo lỗi số chiều", { k: 1 });
  } catch (err: any) {
    dimensionGuardTriggered = true;
    errorMessage = err?.message ?? String(err);
  } finally {
    if (prevWeight === undefined) delete process.env.RRF_VEC_WEIGHT;
    else process.env.RRF_VEC_WEIGHT = prevWeight;
    // Restore original vector
    if (sampleChunk && originalEmbedding) {
      storage.setChunkEmbedding(sampleChunk.id, originalEmbedding, sampleChunk.embedModel ?? MODEL_EMBED);
    }
  }

  assert(
    dimensionGuardTriggered && errorMessage.includes("Embedding dimension mismatch"),
    `Khẳng định hệ thống báo lỗi rõ ràng khi số chiều lệch: "${errorMessage.slice(0, 80)}..."`
  );

  /* Test 4: an embedding outage must degrade to lexical search, never fail.
     The outage has to be simulated against whichever provider is configured —
     pointing LOCAL_EMBED_BASE at a dead port proves nothing when embeddings are
     served by the hosted API, and the test silently passed for the wrong reason. */
  const originalEmbedBase = process.env.LOCAL_EMBED_BASE;
  const originalKey = process.env.OPENAI_API_KEY;
  const usingLocal = llm.EMBED_PROVIDER === "local";
  if (usingLocal) process.env.LOCAL_EMBED_BASE = "http://127.0.0.1:9999";
  else process.env.OPENAI_API_KEY = "sk-invalid-for-this-test";

  try {
    const bm25FallbackRes = await hybridSearch("đặt cọc trả phòng", { k: 2 });
    assert(
      bm25FallbackRes.strategy.includes("bm25-only"),
      `Khi embedding không khả dụng (${llm.EMBED_PROVIDER}), hệ thống tự động rơi về BM25 thuần (strategy: "${bm25FallbackRes.strategy}")`
    );
    assert(bm25FallbackRes.results.length > 0, "BM25 thuần vẫn tìm ra được kết quả phù hợp");
  } finally {
    process.env.LOCAL_EMBED_BASE = originalEmbedBase;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }

  console.log("\nALL PASS");

}

runTests().catch((err) => {
  console.error("Test error:", err);
  process.exit(1);
});
