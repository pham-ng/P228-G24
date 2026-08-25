/**
 * Standalone reindex script.
 * Rebuilds document chunks and generates embeddings using the configured provider.
 */
import { reindex } from "./server/retrieval";

async function main() {
  console.log("🔄 Starting reindex process...");
  const startTime = Date.now();

  const res = await reindex();

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log("==========================================");
  console.log(`✅ Reindex completed in ${durationSec}s`);
  console.log(`📦 Chunks created: ${res.chunks}`);
  console.log(`🧠 Embedded chunks: ${res.embedded}`);
  console.log(`🏷️ Embedding model: ${res.model}`);
  if (res.embedError) {
    console.error(`⚠️ Embedding error encountered: ${res.embedError}`);
  }
  console.log("==========================================");
}

main().catch((err) => {
  console.error("❌ Reindex script failed:", err);
  process.exit(1);
});
