import "dotenv/config";

/**
 * Part 6: root-cause diagnosis for the 7 remaining retrieval-classified
 * failures. Reproduces each case against the frozen production config
 * WITHOUT changing anything, and separates the three legs (BM25-only,
 * vector-only, fused hybrid) so a claim like "RRF demoted it" has to survive
 * an actual per-leg rank comparison instead of being assumed from the label.
 *
 * Step 1: find which chunks actually contain the required fact (proves or
 * disproves DATA_GAP before anything else is investigated).
 * Step 2: rank of each such chunk's parent document in lexical / vector /
 * hybrid, from retrievalRanking() — the same rankers hybridSearch() uses,
 * exposed at full depth instead of truncated to k.
 * Step 3: the actual production call — hybridSearch() -> gateRetrieval() ->
 * answerFromPassages() — so the gate result and model output are the real
 * ones, not simulated.
 *
 *   DB_FILE=data.db LLM_MODE=local LOCAL_API=ollama LOCAL_AGENT_MODEL=qwen3.5:4b \
 *     npx tsx bench/retrieval-failure-diagnosis.ts --out bench/baselines/kiosk-validation/05-retrieval-diagnosis.json
 */

import { writeFileSync } from "node:fs";
import { storage } from "../server/storage";
import { hybridSearch, retrievalRanking, chunkDocKey } from "../server/retrieval";
import { classifyLocal, gateRetrieval, answerFromPassages, LOCAL_MIN_SCORE, LOCAL_PASSAGES, MIN_COVERAGE, type ReplyLang } from "../server/local-agent";

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");

type Case = { id: string; lang: string; q: string; expect: string[][] };
const CASES: Case[] = [
  { id: "pets-vi", lang: "vi", q: "Tôi mang theo chó nhỏ được không?", expect: [["không"]] },
  { id: "id-required", lang: "vi", q: "Nhận phòng cần giấy tờ gì?", expect: [["căn cước", "cccd", "hộ chiếu", "passport", "giấy tờ"]] },
  { id: "chinese-restaurant", lang: "vi", q: "Resort có nhà hàng Trung Hoa không?", expect: [["bách giai", "bach giai"]] },
  { id: "room-count", lang: "vi", q: "Resort có tất cả mấy phòng?", expect: [["476"]] },
  { id: "package-codes", lang: "vi", q: "Mã BB trong bảng giá nghĩa là gì?", expect: [["bed and breakfast", "bữa sáng", "ăn sáng"]] },
  { id: "guestlist-lowseason", lang: "vi", q: "Danh sách khách phải gửi trước bao nhiêu ngày mùa thấp điểm?", expect: [["7"]] },
  { id: "payment-methods", lang: "vi", q: "Resort nhận thanh toán bằng hình thức nào?", expect: [["thẻ", "chuyển khoản", "qr"]] },
];

function rankOf(docKey: string, list: { docKey: string }[]): number {
  const i = list.findIndex((d) => d.docKey === docKey);
  return i === -1 ? -1 : i + 1;
}

async function diagnoseOne(c: Case) {
  const allChunks = storage.listChunks();

  // Step 1: does the corpus actually contain the fact, and where?
  const containing = allChunks
    .filter((ch) => c.expect.some((group) => group.some((alt) => norm(ch.body).includes(norm(alt)))))
    .map((ch) => ({
      docKey: chunkDocKey(ch.kind, ch.refId),
      title: ch.title,
      kind: ch.kind,
      quality: ch.quality,
      verified: ch.verified,
      matchedGroup: c.expect.find((group) => group.some((alt) => norm(ch.body).includes(norm(alt)))),
      snippet: ch.body.replace(/\s+/g, " ").slice(0, 160),
    }));
  const goldDocKeys = [...new Set(containing.map((x) => x.docKey))];
  const dataGap = goldDocKeys.length === 0;

  // Step 2: three-way rank comparison for every candidate gold doc.
  const ranking = await retrievalRanking(c.q, { kind: "all" });
  const rankTable = goldDocKeys.map((dk) => ({
    docKey: dk,
    title: allChunks.find((ch) => chunkDocKey(ch.kind, ch.refId) === dk)?.title ?? dk,
    bm25Rank: rankOf(dk, ranking.lexical),
    denseRank: ranking.vectorAvailable ? rankOf(dk, ranking.vector) : null,
    rrfRank: rankOf(dk, ranking.hybrid),
  }));

  // Step 3: the real production call, unmodified.
  const route = classifyLocal(c.q, false);
  const found = await hybridSearch(c.q, { k: LOCAL_PASSAGES });
  const retrievedTop = found.results.map((r) => ({
    title: r.title, docKey: undefined as any, score: r.relevance, matchedBy: r.matched_by, coverage: r.coverage, quality: r.quality,
  }));
  const gate = gateRetrieval(found.results, LOCAL_MIN_SCORE);
  const topScore = found.results[0]?.relevance ?? 0;
  const usedSemantic = found.results.some((r) => r.matched_by.includes("semantic"));

  let modelOutput = "";
  let abstained = false;
  let evidenceTitles: string[] = [];
  if (gate.ok) {
    const hotel = storage.getHotel();
    const basics = { checkIn: hotel.checkInTime, checkOut: hotel.checkOutTime, currency: hotel.currency };
    evidenceTitles = gate.passages.map((p) => p.title);
    const answer = await answerFromPassages(c.q, gate.passages, c.lang as ReplyLang, undefined, basics);
    modelOutput = answer.reply ?? "";
    abstained = answer.abstained;
  }

  const finalText = modelOutput || "(gate blocked or empty)";
  const factOk = !abstained && c.expect.every((group) => group.some((alt) => norm(finalText).includes(norm(alt))));

  // Step 4: classify the first failure stage.
  let stage: string;
  let rootCause: string;
  if (dataGap) {
    stage = "DATA — corpus does not contain the fact anywhere";
    rootCause = "DATA_GAP";
  } else if (!gate.ok) {
    const goldInTopPicked = retrievedTop.some((r) => goldDocKeys.some((dk) => allChunks.find((ch) => chunkDocKey(ch.kind, ch.refId) === dk)?.title === r.title));
    if (goldInTopPicked) {
      stage = "GATE — gold document was retrieved but the score/coverage gate blocked it";
      rootCause = "RETRIEVAL_GATE_FAILURE";
    } else {
      const bestRrfRank = Math.min(...rankTable.map((r) => (r.rrfRank === -1 ? Infinity : r.rrfRank)));
      const bestBm25Rank = Math.min(...rankTable.map((r) => (r.bm25Rank === -1 ? Infinity : r.bm25Rank)));
      const bestDenseRank = Math.min(...rankTable.map((r) => (r.denseRank == null || r.denseRank === -1 ? Infinity : r.denseRank)));
      if (bestBm25Rank <= 4 || bestDenseRank <= 4) {
        stage = `RRF FUSION — a leg ranked the gold doc in its own top-4 (bm25=${bestBm25Rank === Infinity ? "-" : bestBm25Rank}, dense=${bestDenseRank === Infinity ? "-" : bestDenseRank}) but fusion demoted it out of the retrieved set (rrf=${bestRrfRank === Infinity ? "-" : bestRrfRank})`;
        rootCause = "RRF_FUSION_FAILURE";
      } else {
        stage = `RETRIEVAL — neither leg ranked the gold doc near the top (bm25=${bestBm25Rank === Infinity ? "-" : bestBm25Rank}, dense=${bestDenseRank === Infinity ? "-" : bestDenseRank})`;
        rootCause = bestBm25Rank < bestDenseRank ? "DENSE_FAILURE" : bestDenseRank < bestBm25Rank ? "BM25_FAILURE" : "QUERY_REPRESENTATION";
      }
    }
  } else if (!factOk && !abstained) {
    stage = "MODEL — gate passed correct evidence, model answered wrong or with a different fact";
    rootCause = "MODEL_INTERPRETATION";
  } else if (abstained) {
    stage = "MODEL — gate passed correct evidence, model abstained anyway";
    rootCause = "MODEL_INTERPRETATION";
  } else {
    stage = "NO FAILURE REPRODUCED";
    rootCause = "BENCHMARK_ERROR";
  }

  return {
    id: c.id, lang: c.lang, q: c.q, expect: c.expect,
    dataGap, goldDocKeys, containing,
    rankTable,
    route, retrievedTop, gate: { ok: gate.ok, reason: (gate as any).reason, topScore, usedSemantic }, evidenceTitles,
    modelOutput, abstained, factOk,
    stage, rootCause,
  };
}

async function main() {
  const rows = [];
  for (const c of CASES) {
    process.stderr.write(`  ${c.id}...\n`);
    rows.push(await diagnoseOne(c));
  }

  console.log("\n" + "=".repeat(78));
  console.log("PART 6 — RETRIEVAL FAILURE DIAGNOSIS (7 cases, frozen config, unmodified)");
  console.log("=".repeat(78));
  for (const r of rows) {
    console.log(`\n### ${r.id} [${r.lang}]  ->  ${r.rootCause}`);
    console.log(`  Q: ${r.q}`);
    console.log(`  ${r.stage}`);
    console.log(`  gold doc(s) in corpus: ${r.dataGap ? "NONE FOUND" : r.goldDocKeys.join(", ")}`);
    if (r.rankTable.length) {
      for (const rt of r.rankTable) {
        console.log(`    "${rt.title}"  bm25=${rt.bm25Rank}  dense=${rt.denseRank ?? "n/a"}  rrf=${rt.rrfRank}`);
      }
    }
    console.log(`  gate: ${r.gate.ok ? "PASS" : "BLOCKED (" + r.gate.reason + ")"}  topScore=${r.gate.topScore}`);
    console.log(`  retrieved (production top-k): ${r.retrievedTop.map((t) => t.title).join(" | ")}`);
    console.log(`  model output: ${r.abstained ? "(abstained)" : r.modelOutput.replace(/\s+/g, " ").slice(0, 150)}`);
    console.log(`  fact present in final answer: ${r.factOk}`);
  }

  const oi = process.argv.indexOf("--out");
  if (oi >= 0) {
    writeFileSync(process.argv[oi + 1], JSON.stringify({ ranAt: new Date().toISOString(), rows }, null, 2));
    console.log(`\nwritten to ${process.argv[oi + 1]}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
