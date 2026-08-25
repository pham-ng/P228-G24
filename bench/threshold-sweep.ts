import "dotenv/config";

/**
 * Part 2 (kiosk validation): sweep LOCAL_MIN_SCORE over the REAL 63-case
 * offline set (the one that actually contains the 8 rejected CJK cases —
 * bench/offline-eval.ts's own golden set does not).
 *
 * Zero model calls: this measures only classifyLocal + gateRetrieval, so a
 *13-point sweep costs nothing but wall-clock on embedding calls, and can be
 * re-run any time the corpus or embedding model changes.
 *
 * For every threshold, for every ANSWER-lane case, records:
 *   - whether the gate passed
 *   - whether the passage that gate returned actually contains the gold fact
 *     (checked the same way offline-answers.ts checks a final reply: do the
 *     expected fact strings appear in the passages the model would read)
 *
 * This is retrieval recall + gate pass rate — not hallucination or safety,
 * which still require a real model call and are checked separately, once,
 * at the chosen threshold (see 02-threshold-choice-confirmation).
 *
 *   DB_FILE=data.db npx tsx bench/threshold-sweep.ts
 */

import { hybridSearch } from "../server/retrieval";
import { classifyLocal, gateRetrieval, LOCAL_PASSAGES } from "../server/local-agent";
import { ANSWER, ESCALATE } from "./offline-cases";

const THRESHOLDS = [0, 0.002, 0.004, 0.006, 0.0065, 0.007, 0.0075, 0.008, 0.009, 0.010, 0.012];

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");
function factsInPassages(passagesText: string, expect: string[][] | undefined): boolean {
  if (!expect?.length) return true; // no assertable fact — not counted against recall
  const t = norm(passagesText);
  return expect.every((g) => g.some((alt) => t.includes(norm(alt))));
}

const DEBUG_THRESHOLD = Number(process.env.DEBUG_AT ?? "");

async function main() {
  // Pre-fetch retrieval once per case (embedding-stable across thresholds —
  // only the GATE decision changes, not what hybridSearch returns).
  const prefetched = await Promise.all(
    ANSWER.map(async (c) => ({
      c,
      route: classifyLocal(c.q, false),
      found: await hybridSearch(c.q, { k: LOCAL_PASSAGES }),
    })),
  );
  const knowledgeCases = prefetched.filter((p) => p.route === "knowledge");

  // Escalate-lane cases never touch the gate (classifyLocal routes them away
  // before retrieval), so they are constant across every threshold — recorded
  // once to prove the sweep cannot silently weaken safety.
  const escalateLeaks = ESCALATE.filter((c) => classifyLocal(c.q, false) === "knowledge");

  console.log(`Case tri thức (route=knowledge): ${knowledgeCases.length}/${ANSWER.length}`);
  console.log(`Case ESCALATE lọt vào route=knowledge (phải luôn = 0): ${escalateLeaks.length}\n`);

  console.log(
    "ngưỡng".padEnd(8),
    "gate qua".padEnd(10),
    "đúng bằng chứng".padEnd(16),
    "chặn oan (đúng nhưng bị chặn)".padEnd(30),
    "qua nhưng SAI (nguy hiểm)",
  );

  for (const th of THRESHOLDS) {
    let gatePassed = 0;
    let correctEvidence = 0;
    let wronglyBlocked = 0; // gold fact IS retrievable at this threshold's passages but gate still says no
    let passedButWrong = 0; // gate passed, but the passages returned do NOT contain the gold fact

    for (const { c, found } of knowledgeCases) {
      const gate = gateRetrieval(found.results, th);
      const passagesText = found.results
        .slice(0, LOCAL_PASSAGES)
        .map((r) => r.content)
        .join(" ");
      const hasFact = factsInPassages(passagesText, c.expect);

      if (gate.ok) {
        gatePassed++;
        if (hasFact) correctEvidence++;
        else {
          passedButWrong++;
          if (th === DEBUG_THRESHOLD) {
            console.log(`  QUA NHƯNG SAI @ ${th}: "${c.q}"`);
            console.log(`     kỳ vọng: ${JSON.stringify(c.expect)}`);
            console.log(`     đoạn văn top-${LOCAL_PASSAGES}: ${found.results.slice(0, LOCAL_PASSAGES).map((r) => r.title).join(" | ")}`);
          }
        }
      } else if (hasFact) {
        wronglyBlocked++;
        if (th === DEBUG_THRESHOLD) console.log(`  CHẶN OAN @ ${th}: "${c.q}"`);
      }
    }

    console.log(
      String(th).padEnd(8),
      `${gatePassed}/${knowledgeCases.length}`.padEnd(10),
      `${correctEvidence}/${knowledgeCases.length}`.padEnd(16),
      String(wronglyBlocked).padEnd(30),
      String(passedButWrong),
    );
  }

  console.log(
    "\n'chặn oan' = câu có đúng bằng chứng trong top-k nhưng ngưỡng vẫn từ chối (mất cơ hội trả lời).",
  );
  console.log(
    "'qua nhưng SAI' = ngưỡng cho qua nhưng đoạn văn trả về KHÔNG chứa sự thật cần — đây là rủi ro an toàn thật, phải bằng 0 hoặc gần 0 ở mọi ngưỡng được chọn.",
  );
}

main();
