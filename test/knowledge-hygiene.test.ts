/**
 * Unit tests for Phase A article classification (server/knowledge-hygiene.ts).
 * Pure: no DB, no model. Pins the quarantine + provenance rules.
 *
 *   npx tsx test/knowledge-hygiene.test.ts
 */

import { classifyArticle } from "../server/knowledge-hygiene";
import { DEFAULT_FACILITY_HOURS } from "../server/ops";

let failures = 0;
function ok(cond: boolean, msg: string) {
  if (cond) console.log(`  PASS  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}

console.log("=== KNOWLEDGE HYGIENE: classification ===");

const scraped = classifyArticle({
  category: "vin_wonder",
  title: "Bỏ túi bản đồ Vinpearl Nha Trang chính xác, mới nhất 2026",
  body: "…marketing…",
});
ok(scraped.quality === "scraped", "vin_wonder -> quality scraped");
ok(scraped.retrievable === 0, "scraped is quarantined (retrievable 0)");
ok(scraped.entity === null, "scraped gets no canonical entity");

const spa = classifyArticle({
  category: "property",
  title: "Akoya Spa — treatments and prices",
  body: "Source: https://example.com/spa\nTreatments…",
});
ok(spa.quality === "curated", "curated property -> quality curated");
ok(spa.retrievable === 1, "curated stays retrievable");
ok(spa.entity === "spa", "Akoya Spa -> entity spa");
ok(spa.domain === "facilities", "property -> domain facilities");
ok(spa.contentClass === "dynamic", "title with 'prices' -> dynamic content class");
ok(spa.sourceUrl === "https://example.com/spa", "source URL extracted from body");

const policy = classifyArticle({
  category: "policy",
  title: "Occupancy limits, extra beds and children",
  body: "no source line here",
});
ok(policy.contentClass === "static", "policy -> static content class");
ok(policy.domain === "policy", "policy -> domain policy");
ok(policy.entity === "occupancy", "occupancy article -> entity occupancy");
ok(policy.sourceUrl === null, "no source line -> null source");

const cablecar = classifyArticle({
  category: "neighborhood",
  title: "Cable car and Vinpearl Harbour ticket prices",
  body: "…",
});
ok(cablecar.contentClass === "dynamic", "ticket prices -> dynamic");
ok(cablecar.entity === "cable_car", "cable car -> entity cable_car");

/* ------------------------------------------------------------------------
   Contradictions between the seeded operational defaults and the curated,
   source-checked corpus.

   `DEFAULT_FACILITY_HOURS` is a table of invented placeholder values carrying a
   note that management must confirm them. That is tolerable until one of them
   contradicts a fact we DO have a source for — and then it is worse than a gap,
   because retrieval cannot tell an invented value from a verified one. The spa
   was seeded 09:00–21:00 while the curated "Akoya Spa — treatments and prices"
   page says 09:00–22:00, and the offline model dutifully told guests 21:00 in
   Vietnamese, Korean and Chinese. Whichever value is right, the two must agree.
   -------------------------------------------------------------------------- */
console.log("\n=== OPERATIONAL DEFAULTS vs CURATED FACTS ===");
{
  const spa = DEFAULT_FACILITY_HOURS.facilities.find((f) => f.key === "spa");
  ok(spa?.from === "09:00", `spa opening hour agrees with the curated page (got ${spa?.from})`);
  ok(spa?.to === "22:00", `spa closing hour agrees with the curated page (got ${spa?.to})`);
}

console.log(failures === 0 ? "\nALL HYGIENE TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
