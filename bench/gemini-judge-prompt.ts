/**
 * Prompt builder and structured output schema definition for the Independent Gemini Judge.
 *
 * SPECIFICATION COMPLIANCE:
 * 1. Independent Judge: Judged strictly against supplied Aurea Authoritative Ground Truth.
 * 2. Distinct Input Layers:
 *    - USER QUERY
 *    - CONVERSATION HISTORY (if multi-turn)
 *    - AUTHORITATIVE SOURCE (Canonical ground truth excerpts / expected facts)
 *    - EXPECTED FACTS & EXPECTED BEHAVIOR
 *    - EXPECTED LANGUAGE
 *    - QWEN RESPONSE (System under test)
 *    - RETRIEVED EVIDENCE (What Aurea actually retrieved, for root cause tracking)
 * 3. Semantic Equivalence & Fact-Level Verification.
 * 4. Verdicts: FULLY_CORRECT | PARTIAL | WRONG | CRITICAL_FAIL
 * 5. Knowledge-State Classification Verification.
 */

export type JudgeInput = {
  case_id: string;
  category: string;
  language: string;
  user_query: string;
  conversation_history?: string[];
  authoritative_source: string;
  expected_facts: string[];
  forbidden_facts?: string[];
  expected_behavior: string;
  expected_language: string;
  qwen_response: string;
  retrieved_evidence: string;
};

export type FactResult = {
  fact_id: string;
  status: "CORRECT" | "MISSING" | "INCORRECT" | "CONTRADICTED";
  expected: string;
  claimed: string;
  reason: string;
};

export type JudgeVerdictJSON = {
  verdict: "FULLY_CORRECT" | "PARTIAL" | "WRONG" | "CRITICAL_FAIL";
  factual_correctness: number;
  completeness: number;
  grounding: number;
  language_correctness: number;
  relevance: number;
  knowledge_state_correct: boolean;
  fact_results: FactResult[];
  unsupported_claims: string[];
  contradicted_facts: string[];
  missing_facts: string[];
  wrong_language: boolean;
  hallucination: boolean;
  critical_hallucination: boolean;
  root_cause_diagnosis?: "RETRIEVAL_FAILURE" | "MODEL_GENERATION_FAILURE" | "GROUNDING_FAILURE" | "KNOWLEDGE_STATE_FAILURE" | "LANGUAGE_FAILURE" | "BENCHMARK_ERROR";
  reason: string;
  confidence: number;
};

export function buildGeminiJudgePrompt(input: JudgeInput): string {
  const historyText = input.conversation_history && input.conversation_history.length > 0
    ? input.conversation_history.map((h, i) => `Turn ${i + 1}: ${h}`).join("\n")
    : "None (Single-turn query)";

  const expectedFactsText = input.expected_facts && input.expected_facts.length > 0
    ? input.expected_facts.map((f, i) => `${i + 1}. ${f}`).join("\n")
    : "None specified explicitly";

  const forbiddenFactsText = input.forbidden_facts && input.forbidden_facts.length > 0
    ? input.forbidden_facts.map((f, i) => `${i + 1}. ${f}`).join("\n")
    : "None specified";

  return `You are an INDEPENDENT EVALUATION JUDGE assessing the performance of Qwen (the local AI concierge system under test) for Aurea Resort.

============================================================
CRITICAL INSTRUCTIONS & RULES
============================================================
1. YOU ARE AN INDEPENDENT JUDGE. You must NOT generate ground truth from your own internal knowledge.
2. DO NOT use external web search. The AUTHORITATIVE SOURCE provided below is the ONLY ground truth.
3. Distinguish clearly between:
   - AUTHORITATIVE SOURCE / EXPECTED FACTS: The absolute ground truth for scoring.
   - RETRIEVED EVIDENCE: What the system actually retrieved from its database.
   (If the system retrieved a wrong chunk and answered based on it, the response is still WRONG relative to the Authoritative Source, but the root cause is RETRIEVAL_FAILURE).
4. Recognize natural semantic equivalences and valid paraphrases (e.g., "06:30" vs "6:30 AM", "14:00" vs "2 PM"). Do NOT penalize natural language phrasing.
5. Identify extra unsupported business claims (fabricated prices, fabricated policies, fabricated curfew hours). Fabricated financial or policy facts MUST trigger CRITICAL_FAIL.

============================================================
INPUT CASE DETAILS
============================================================

CASE ID: ${input.case_id}
CATEGORY: ${input.category}
EXPECTED LANGUAGE: ${input.expected_language}

A. USER QUERY:
"${input.user_query}"

B. CONVERSATION HISTORY:
${historyText}

C. AUTHORITATIVE SOURCE (CANONICAL GROUND TRUTH):
${input.authoritative_source}

D. EXPECTED FACTS:
${expectedFactsText}

FORBIDDEN FACTS (Must NOT be present/claimed):
${forbiddenFactsText}

E. EXPECTED BEHAVIOR:
${input.expected_behavior}

F. QWEN RESPONSE (SYSTEM UNDER TEST):
"${input.qwen_response}"

H. SYSTEM RETRIEVED EVIDENCE (What Aurea actually retrieved):
${input.retrieved_evidence}

============================================================
EVALUATION STANDARDS & VERDICTS
============================================================
Assign EXACTLY one of the following verdicts:

1. FULLY_CORRECT:
   - All mandatory expected facts are correctly stated.
   - No material contradiction.
   - No unsupported business claim (prices, times, rules).
   - Response language matches expected language (${input.expected_language}).
   - Correct knowledge state / escalation behavior.

2. PARTIAL:
   - Stated facts are correct and grounded in authoritative source.
   - One or more non-critical required facts are missing/omitted.
   - No material contradiction, no fabricated price/policy.

3. WRONG:
   - One or more material facts are incorrect or contradicted.
   - Wrong language used when expected language was required.
   - Failed to ask clarifying question or failed to abstain when required.

4. CRITICAL_FAIL:
   - Fabricated prices, monetary amounts, or fee structures not in source.
   - Fabricated policies, operational rules, or curfew hours.
   - Materially dangerous or incorrect financial/booking recommendation.

============================================================
REQUIRED STRUCTURED JSON OUTPUT
============================================================
Return ONLY a valid JSON object matching this schema:

{
  "verdict": "FULLY_CORRECT | PARTIAL | WRONG | CRITICAL_FAIL",
  "factual_correctness": 1.0,
  "completeness": 1.0,
  "grounding": 1.0,
  "language_correctness": 1.0,
  "relevance": 1.0,
  "knowledge_state_correct": true,
  "fact_results": [
    {
      "fact_id": "fact_1",
      "status": "CORRECT | MISSING | INCORRECT | CONTRADICTED",
      "expected": "...",
      "claimed": "...",
      "reason": "..."
    }
  ],
  "unsupported_claims": [],
  "contradicted_facts": [],
  "missing_facts": [],
  "wrong_language": false,
  "hallucination": false,
  "critical_hallucination": false,
  "root_cause_diagnosis": "RETRIEVAL_FAILURE | MODEL_GENERATION_FAILURE | GROUNDING_FAILURE | KNOWLEDGE_STATE_FAILURE | LANGUAGE_FAILURE | BENCHMARK_ERROR",
  "reason": "Brief explanation of the verdict based on evidence",
  "confidence": 1.0
}
`;
}
