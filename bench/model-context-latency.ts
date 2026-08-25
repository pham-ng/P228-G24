import "dotenv/config";

/**
 * Phase 8: does latency scale with context length, and is it prefill-bound or
 * generation-bound? Diagnostic only — calls chat() directly with real
 * retrieved passages padded to target token counts, not scored for
 * correctness. Uses Ollama's native timing telemetry (already returned by
 * chat() when LOCAL_API=ollama) rather than estimating from wall time alone.
 *
 *   LLM_MODE=local LOCAL_AGENT_MODEL=<model> npx tsx bench/model-context-latency.ts --out <path>
 */
import { writeFileSync } from "node:fs";
import { chat } from "../server/llm";
import { hybridSearch } from "../server/retrieval";

const TARGETS = [300, 600, 900, 1300, 1800];
const SAMPLES_PER_BUCKET = 2;

/** ~4 chars/token is a reasonable rough estimate for mixed VI/EN text. */
function padTo(text: string, targetTokens: number): string {
  const targetChars = targetTokens * 4;
  if (text.length >= targetChars) return text.slice(0, targetChars);
  const filler = " Thông tin bổ sung không thay đổi câu trả lời, chỉ để đạt độ dài ngữ cảnh mục tiêu cho phép đo độ trễ.";
  let out = text;
  while (out.length < targetChars) out += filler;
  return out.slice(0, targetChars);
}

async function main() {
  const model = process.env.LOCAL_AGENT_MODEL ?? "unknown";
  const found = await hybridSearch("Spa mở cửa mấy giờ và có những loại massage nào?", { k: 5 });
  const basePassage = found.results.map((r) => r.content).join("\n\n");

  const rows: any[] = [];
  for (const target of TARGETS) {
    const context = padTo(basePassage, target);
    for (let i = 0; i < SAMPLES_PER_BUCKET; i++) {
      const t0 = Date.now();
      const r = await chat({
        messages: [
          { role: "system", content: `Bạn là lễ tân khách sạn. Trả lời dựa trên thông tin sau:\n${context}` },
          { role: "user", content: "Spa mở cửa mấy giờ?" },
        ],
        temperature: 0,
        maxTokens: 150,
      });
      const wallMs = Date.now() - t0;
      rows.push({
        model, targetTokens: target, sample: i,
        wallMs,
        loadMs: r.timing?.loadMs ?? null,
        promptEvalMs: r.timing?.promptEvalMs ?? null,
        promptEvalTokens: r.timing?.promptEvalTokens ?? null,
        evalMs: r.timing?.evalMs ?? null,
        evalTokens: r.timing?.evalTokens ?? null,
      });
      console.log(`target=${target} sample=${i} wall=${wallMs}ms promptEval=${r.timing?.promptEvalMs ?? "?"}ms(${r.timing?.promptEvalTokens ?? "?"}tok) gen=${r.timing?.evalMs ?? "?"}ms(${r.timing?.evalTokens ?? "?"}tok)`);
    }
  }

  const oi = process.argv.indexOf("--out");
  if (oi >= 0) {
    writeFileSync(process.argv[oi + 1], JSON.stringify({ model, ranAt: new Date().toISOString(), rows }, null, 2));
    console.log(`written to ${process.argv[oi + 1]}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
