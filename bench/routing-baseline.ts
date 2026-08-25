import "dotenv/config";

/**
 * Phase 9 §1: reproduce the routing defect before changing any code.
 * Pure classifyLocal() calls — no retrieval, no LLM, so this is instant and
 * gives an exact, re-runnable baseline independent of model non-determinism.
 */
import { writeFileSync } from "node:fs";
import { classifyLocal } from "../server/local-agent";
import { QUALITY_CASES } from "./quality-cases";
import { ANSWER, ESCALATE } from "./offline-cases";

function main() {
  const rows: any[] = [];
  for (const c of QUALITY_CASES) {
    const route = classifyLocal(c.q, false);
    rows.push({ id: c.id, set: "quality", lang: c.lang, answerability: c.answerability, q: c.q, route, shortCircuited: route === "complex" || route === "transaction" });
  }
  for (const c of [...ANSWER, ...ESCALATE]) {
    const route = classifyLocal(c.q, false);
    rows.push({ id: c.id, set: "offline63", lang: c.lang, lane: c.lane, q: c.q, route, shortCircuited: route === "complex" || route === "transaction" });
  }

  const quality = rows.filter((r) => r.set === "quality");
  const shortCircuited = quality.filter((r) => r.shortCircuited);
  console.log(`quality set: ${shortCircuited.length}/${quality.length} short-circuited (${((shortCircuited.length / quality.length) * 100).toFixed(1)}%)`);
  console.log(`  of these, answerability breakdown:`, shortCircuited.reduce((acc: any, r) => { acc[r.answerability] = (acc[r.answerability] ?? 0) + 1; return acc; }, {}));

  const offline = rows.filter((r) => r.set === "offline63");
  const escalateLane = offline.filter((r) => r.lane === "escalate");
  const answerLane = offline.filter((r) => r.lane === "answer");
  console.log(`\noffline63 escalate-lane: ${escalateLane.filter((r) => r.shortCircuited).length}/${escalateLane.length} short-circuited (expected: should be most/all)`);
  console.log(`offline63 answer-lane: ${answerLane.filter((r) => r.shortCircuited).length}/${answerLane.length} short-circuited (expected: should be 0)`);
  if (answerLane.some((r) => r.shortCircuited)) {
    console.log("  answer-lane cases wrongly short-circuited:", answerLane.filter((r) => r.shortCircuited).map((r) => r.id));
  }

  writeFileSync("bench/baselines/kiosk-validation/09-routing-baseline.json", JSON.stringify({ ranAt: new Date().toISOString(), rows }, null, 2));
  console.log("\nwritten to bench/baselines/kiosk-validation/09-routing-baseline.json");
}
main();
