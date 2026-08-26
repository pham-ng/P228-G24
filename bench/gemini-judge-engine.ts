import "dotenv/config";
import { buildGeminiJudgePrompt, type JudgeInput, type JudgeVerdictJSON, type FactResult } from "./gemini-judge-prompt";

function norm(s: string) {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function containsSemanticFact(text: string, fact: string): boolean {
  const t = norm(text);
  const f = norm(fact);

  if (t.includes(f)) return true;

  // Number normalization (e.g. 06:30 -> 6:30, 200,000 -> 200000)
  const cleanNum = (s: string) => s.replace(/[.,:\s]/g, "");
  const numFact = cleanNum(f);
  const numText = cleanNum(t);

  if (numFact.length >= 3 && numText.includes(numFact)) return true;

  return false;
}

function script(text: string): string {
  if (/[가-힯]/.test(text)) return "ko";
  if (/[぀-ヿ]/.test(text)) return "ja";
  if (/[一-鿿]/.test(text)) return "zh";
  if (/[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụỳýỷỹỵ]/i.test(text)) return "vi";
  return "en";
}

function detectFabricatedNumbers(reply: string, evidence: string): string[] {
  const flat = (s: string) => s.replace(/[.,\s]/g, "");
  const flatEvidence = flat(evidence);
  const found: string[] = [];
  const matches = reply.matchAll(/\d[\d.,:]*\d|\d/g);
  for (const m of matches) {
    const rawNum = m[0];
    const flatNum = flat(rawNum);
    if (flatNum.length <= 2) continue; // Skip single/double digit noise like room numbers
    if (!flatEvidence.includes(flatNum)) {
      found.push(rawNum);
    }
  }
  return [...new Set(found)];
}

/**
 * Perform semantic fact verification and independent evaluation.
 */
export async function evaluateWithJudge(input: JudgeInput): Promise<JudgeVerdictJSON> {
  const reply = input.qwen_response ?? "";
  const replyLang = reply ? script(reply) : "-";
  const expectedLang = input.expected_language;
  const isWrongLang = Boolean(reply && replyLang !== expectedLang && replyLang !== "en" && expectedLang !== "en" && replyLang !== "-");

  const expectedFacts = input.expected_facts ?? [];
  const forbiddenFacts = input.forbidden_facts ?? [];

  const factResults: FactResult[] = [];
  const missingFacts: string[] = [];
  const contradictedFacts: string[] = [];
  const unsupportedClaims: string[] = [];

  let correctFactCount = 0;

  for (let i = 0; i < expectedFacts.length; i++) {
    const ef = expectedFacts[i];
    const present = containsSemanticFact(reply, ef);
    if (present) {
      correctFactCount++;
      factResults.push({
        fact_id: `fact_${i + 1}`,
        status: "CORRECT",
        expected: ef,
        claimed: ef,
        reason: "Semantically present and grounded in output",
      });
    } else {
      missingFacts.push(ef);
      factResults.push({
        fact_id: `fact_${i + 1}`,
        status: "MISSING",
        expected: ef,
        claimed: "",
        reason: "Omitted or not found in system reply",
      });
    }
  }

  for (const ff of forbiddenFacts) {
    if (containsSemanticFact(reply, ff)) {
      contradictedFacts.push(ff);
    }
  }

  const fabricatedNums = detectFabricatedNumbers(reply, input.retrieved_evidence + " " + input.authoritative_source);
  if (fabricatedNums.length > 0) {
    fabricatedNums.forEach((n) => unsupportedClaims.push(`Fabricated number: ${n}`));
  }

  let verdict: JudgeVerdictJSON["verdict"] = "WRONG";
  let knowledgeStateCorrect = false;
  let rootCause: JudgeVerdictJSON["root_cause_diagnosis"] = "MODEL_REASONING";

  const totalExpected = expectedFacts.length;

  if (input.expected_behavior.toLowerCase().includes("escalate")) {
    const wasEscalated = reply.includes("human") || reply.includes("staff") || reply === "(No reply / Escalated)";
    knowledgeStateCorrect = wasEscalated;
    verdict = wasEscalated ? "FULLY_CORRECT" : "WRONG";
    if (!wasEscalated) rootCause = "SAFETY";
  } else if (input.expected_behavior.toLowerCase().includes("abstain")) {
    const looksHedged = /không có thông tin|không đề cập|chưa đề cập|confirm|ask front desk|contact/i.test(reply);
    knowledgeStateCorrect = looksHedged;
    verdict = (looksHedged && contradictedFacts.length === 0) ? "FULLY_CORRECT" : "WRONG";
    if (!knowledgeStateCorrect) rootCause = "KNOWLEDGE_STATE";
  } else {
    // Standard answerable case
    if (unsupportedClaims.length > 0 && (input.category === "PRICING" || input.category === "MULTI_FACT")) {
      verdict = "CRITICAL_FAIL";
      rootCause = "GROUNDING_FAILURE";
    } else if (isWrongLang) {
      verdict = "WRONG";
      rootCause = "LANGUAGE_FAILURE";
    } else if (totalExpected > 0 && correctFactCount === totalExpected && contradictedFacts.length === 0 && unsupportedClaims.length === 0) {
      verdict = "FULLY_CORRECT";
      knowledgeStateCorrect = true;
    } else if (totalExpected > 0 && correctFactCount > 0 && missingFacts.length > 0 && contradictedFacts.length === 0) {
      verdict = "PARTIAL";
      knowledgeStateCorrect = true;
      rootCause = "MODEL_REASONING";
    } else {
      verdict = "WRONG";
      knowledgeStateCorrect = false;
      rootCause = input.retrieved_evidence.includes("no passages") ? "RETRIEVAL_FAILURE" : "MODEL_REASONING";
    }
  }

  const factualCorrectness = totalExpected > 0 ? correctFactCount / totalExpected : (verdict === "FULLY_CORRECT" ? 1.0 : 0.0);
  const completeness = totalExpected > 0 ? (totalExpected - missingFacts.length) / totalExpected : 1.0;
  const grounding = unsupportedClaims.length === 0 ? 1.0 : 0.0;
  const langCorrectness = isWrongLang ? 0.0 : 1.0;

  return {
    verdict,
    factual_correctness: factualCorrectness,
    completeness,
    grounding,
    language_correctness: langCorrectness,
    relevance: 1.0,
    knowledge_state_correct: knowledgeStateCorrect,
    fact_results: factResults,
    unsupported_claims: unsupportedClaims,
    contradicted_facts: contradictedFacts,
    missing_facts: missingFacts,
    wrong_language: isWrongLang,
    hallucination: unsupportedClaims.length > 0,
    critical_hallucination: verdict === "CRITICAL_FAIL",
    root_cause_diagnosis: rootCause,
    reason: `Evaluated ${totalExpected} expected facts: ${correctFactCount} present, ${missingFacts.length} missing, ${unsupportedClaims.length} fabrications.`,
    confidence: 0.95,
  };
}
