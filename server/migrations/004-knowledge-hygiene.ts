/**
 * Migration 004: Phase A knowledge hygiene.
 *
 *   1. Add the metadata columns (quality, verified, content_class, entity,
 *      domain, source_url, effective/last_verified, retrievable) — idempotent.
 *   2. Classify every KB article and quarantine the scraped vin_wonder dump.
 *   3. Ingest the canonical high-priority gap placeholders (wifi, parking,
 *      accessibility, gym, currency, emergency) as UNVERIFIED entries.
 *   4. Rebuild the retrieval index so the changes take effect.
 *
 * Idempotent: re-running re-classifies from the same rules and upserts the same
 * placeholders. Reads DB from process.env.DB_FILE || "data.db".
 *
 *   DB_FILE=data.db npx tsx server/migrations/004-knowledge-hygiene.ts
 */

import "dotenv/config";
import { migrate, storage } from "../storage";
import { applyHygiene } from "../knowledge-hygiene";
import { ingestCanonicalFacts } from "../canonical";
import { reindex } from "../retrieval";

async function main() {
  migrate();

  const before = storage.listKb().length;
  const hy = applyHygiene();
  const cf = ingestCanonicalFacts();

  console.log(
    `[hygiene] classified ${hy.classified} articles: ${hy.curated} retrievable, ${hy.quarantined} quarantined (scraped), ${hy.withSource} with a source URL.`,
  );
  console.log(
    `[canonical] facts — inserted ${cf.inserted}, updated ${cf.updated} (${cf.verified} verified, ${cf.placeholder} placeholder/unverified).`,
  );

  const r = await reindex();
  console.log(
    `[reindex] ${r.chunks} chunks, ${r.embedded} embedded${r.embedError ? ` (embed note: ${r.embedError.slice(0, 60)})` : ""}.`,
  );
  console.log(`[done] kb_articles ${before} -> ${storage.listKb().length}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
