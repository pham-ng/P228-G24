import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";
import { evaluateWithJudge } from "./gemini-judge-engine";
import type { JudgeInput, JudgeVerdictJSON } from "./gemini-judge-prompt";

type ExecutedResult = {
  case_id: string;
  category: string;
  language: string;
  split: string;
  severity: string;
  user_query: string;
  expected_answerability: string;
  route: string;
  escalated: boolean;
  reply: string;
  reply_lang: string;
  language_ok: boolean;
  facts_present: string[];
  facts_missing: string[];
  forbidden_present: string[];
  fabricated_numbers: string[];
  verdict: "CORRECT" | "PARTIAL" | "WRONG" | "CRITICAL_FAIL";
  knowledge_state_correct: boolean;
  ms: number;
};

type CaseDef = {
  case_id: string;
  category: string;
  language: string;
  split: string;
  user_query: string;
  expected_answerability: string;
  expected_facts?: string[];
  forbidden_facts?: string[];
  expected_language: string;
  note?: string;
};

async function runCalibration() {
  console.log("============================================================");
  console.log("SECTION 12: INDEPENDENT GEMINI JUDGE CALIBRATION (100 CASES)");
  console.log("============================================================");

  const casesData = JSON.parse(readFileSync("bench/baselines/kiosk-validation/FINAL-LOCAL-EVAL-CASES.json", "utf8"));
  const prevEvalData = JSON.parse(readFileSync("bench/baselines/kiosk-validation/FINAL-LOCAL-PRODUCT-EVALUATION.json", "utf8"));

  const atomicCases: CaseDef[] = casesData.atomic;
  const executedAtomic: ExecutedResult[] = prevEvalData.atomic;

  const caseMap = new Map<string, CaseDef>();
  atomicCases.forEach((c) => caseMap.set(c.case_id, c));

  const executedMap = new Map<string, ExecutedResult>();
  executedAtomic.forEach((e) => executedMap.set(e.case_id, e));

  // Select 100 calibration cases covering all categories, languages, and verdict types
  const calibrationSet: ExecutedResult[] = [];

  // Group executed cases by category and language
  const categories = ["FACTUAL", "PRICING", "MULTI_FACT", "UNKNOWN_BOUNDARY", "AMBIGUITY", "CONFLICTING", "SAFETY_ESCALATION"];
  const languages = ["vi", "en", "ko", "zh", "ja"];

  // Pick cases balanced across categories & languages
  categories.forEach((cat) => {
    languages.forEach((lang) => {
      const matches = executedAtomic.filter((e) => e.category === cat && e.language === lang);
      // Pick up to 3 per category-language combo
      matches.slice(0, 3).forEach((m) => {
        if (calibrationSet.length < 100 && !calibrationSet.some((c) => c.case_id === m.case_id)) {
          calibrationSet.push(m);
        }
      });
    });
  });

  // Fill up to 100 with remaining cases
  for (const item of executedAtomic) {
    if (calibrationSet.length >= 100) break;
    if (!calibrationSet.some((c) => c.case_id === item.case_id)) {
      calibrationSet.push(item);
    }
  }

  console.log(`Selected ${calibrationSet.length} representative cases for calibration audit.`);

  let agreedCount = 0;
  let disagreedCount = 0;
  let falsePositives = 0; // Human says WRONG/CRITICAL, Judge says FULLY_CORRECT
  let falseNegatives = 0; // Human says CORRECT, Judge says WRONG/CRITICAL

  const categoryDisagreements: Record<string, number> = {};
  const languageDisagreements: Record<string, number> = {};

  const calibrationResults: Array<{
    case_id: string;
    category: string;
    language: string;
    human_verdict: string;
    judge_verdict: string;
    agreed: boolean;
    reason: string;
  }> = [];

  for (let i = 0; i < calibrationSet.length; i++) {
    const item = calibrationSet[i];
    const caseDef = caseMap.get(item.case_id)!;

    // Ground truth mapping
    const humanVerdict = item.verdict === "CORRECT" ? "FULLY_CORRECT" : item.verdict;

    const judgeInput: JudgeInput = {
      case_id: item.case_id,
      category: item.category,
      language: item.language,
      user_query: item.user_query,
      authoritative_source: `Expected answerability: ${item.expected_answerability}. Expected facts: ${JSON.stringify(caseDef.expected_facts ?? [])}. Forbidden facts: ${JSON.stringify(caseDef.forbidden_facts ?? [])}`,
      expected_facts: caseDef.expected_facts ?? [],
      forbidden_facts: caseDef.forbidden_facts ?? [],
      expected_behavior: item.expected_answerability === "escalate" ? "Escalate to staff" : item.expected_answerability === "unknown" ? "Abstain / acknowledge missing info" : "Provide exact grounded facts",
      expected_language: caseDef.expected_language,
      qwen_response: item.reply || "(No reply / Escalated)",
      retrieved_evidence: "Passages retrieved from data.db canonical index",
    };

    const judgeOutput: JudgeVerdictJSON = await evaluateWithJudge(judgeInput);

    const judgeVerdict = judgeOutput.verdict;
    const agreed = (humanVerdict === judgeVerdict) || (humanVerdict === "FULLY_CORRECT" && judgeVerdict === "FULLY_CORRECT");

    if (agreed) {
      agreedCount++;
    } else {
      disagreedCount++;
      categoryDisagreements[item.category] = (categoryDisagreements[item.category] || 0) + 1;
      languageDisagreements[item.language] = (languageDisagreements[item.language] || 0) + 1;

      if ((humanVerdict === "WRONG" || humanVerdict === "CRITICAL_FAIL") && judgeVerdict === "FULLY_CORRECT") {
        falsePositives++;
      }
      if (humanVerdict === "FULLY_CORRECT" && (judgeVerdict === "WRONG" || judgeVerdict === "CRITICAL_FAIL")) {
        falseNegatives++;
      }
    }

    calibrationResults.push({
      case_id: item.case_id,
      category: item.category,
      language: item.language,
      human_verdict: humanVerdict,
      judge_verdict: judgeVerdict,
      agreed,
      reason: judgeOutput.reason,
    });

    if ((i + 1) % 20 === 0 || i === calibrationSet.length - 1) {
      console.log(`Calibrated ${i + 1}/${calibrationSet.length} cases... Current Agreement: ${((agreedCount / (i + 1)) * 100).toFixed(1)}%`);
    }
  }

  const agreementPct = (agreedCount / calibrationSet.length) * 100;
  const disagreementPct = (disagreedCount / calibrationSet.length) * 100;
  const falsePositiveRate = (falsePositives / calibrationSet.length) * 100;
  const falseNegativeRate = (falseNegatives / calibrationSet.length) * 100;

  const calibrationReport = {
    total_samples: calibrationSet.length,
    agreed_count: agreedCount,
    disagreed_count: disagreedCount,
    agreement_rate_pct: agreementPct,
    disagreement_rate_pct: disagreementPct,
    false_positive_rate_pct: falsePositiveRate,
    false_negative_rate_pct: falseNegativeRate,
    disagreements_by_category: categoryDisagreements,
    disagreements_by_language: languageDisagreements,
    samples: calibrationResults,
  };

  writeFileSync("bench/baselines/kiosk-validation/GEMINI-JUDGE-CALIBRATION.json", JSON.stringify(calibrationReport, null, 2));

  console.log("\n============================================================");
  console.log("CALIBRATION RESULT SUMMARY:");
  console.log(`Agreement Rate: ${agreementPct.toFixed(1)}% (${agreedCount}/${calibrationSet.length})`);
  console.log(`Disagreement Rate: ${disagreementPct.toFixed(1)}%`);
  console.log(`False Positive Rate (Over-generous judge): ${falsePositiveRate.toFixed(1)}%`);
  console.log(`False Negative Rate (Over-strict judge): ${falseNegativeRate.toFixed(1)}%`);
  console.log("Calibration data saved to GEMINI-JUDGE-CALIBRATION.json");
  console.log("============================================================\n");
}

runCalibration().catch(console.error);
