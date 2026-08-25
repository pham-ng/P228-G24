import "dotenv/config";

/**
 * Part 2 (kiosk validation): why does LOCAL_MIN_SCORE reject 8 cases where
 * bge-m3 already found the right document?
 *
 * For each case this prints the query, every candidate's RRF score, which
 * rank the GOLD document actually landed at, and whether that gold document
 * would have been sufficient evidence — not inferred, read directly from
 * hybridSearch's own output.
 *
 *   DB_FILE=data.db npx tsx bench/local-min-score-audit.ts
 */

import { hybridSearch } from "../server/retrieval";
import { LOCAL_MIN_SCORE, LOCAL_PASSAGES } from "../server/local-agent";

const CASES: { id: string; lang: string; q: string; goldTitleContains: string }[] = [
  { id: "spa-hours-ko", lang: "ko", q: "스파는 몇 시에 문을 여나요?", goldTitleContains: "Spa" },
  { id: "breakfast-ko", lang: "ko", q: "조식은 몇 시부터인가요?", goldTitleContains: "Breakfast" },
  { id: "pets-ko", lang: "ko", q: "반려견을 데려가도 되나요?", goldTitleContains: "House rules" },
  { id: "spa-hours-zh", lang: "zh", q: "水疗中心几点开门？", goldTitleContains: "Spa" },
  { id: "breakfast-zh", lang: "zh", q: "早餐几点开始供应？", goldTitleContains: "Breakfast" },
  { id: "pool-zh", lang: "zh", q: "酒店有游泳池吗？", goldTitleContains: "pool" },
  { id: "spa-hours-ja", lang: "ja", q: "スパは何時から開いていますか？", goldTitleContains: "Spa" },
  { id: "checkout-ja", lang: "ja", q: "チェックアウトは何時ですか？", goldTitleContains: "check-out" },
];

async function main() {
  console.log(`LOCAL_MIN_SCORE hiện tại: ${LOCAL_MIN_SCORE} · LOCAL_PASSAGES: ${LOCAL_PASSAGES}\n`);
  for (const c of CASES) {
    const r = await hybridSearch(c.q, { k: 10 });
    const goldRank = r.results.findIndex((x) =>
      x.title.toLowerCase().includes(c.goldTitleContains.toLowerCase()),
    );
    console.log(`### ${c.id} (${c.lang})  "${c.q}"`);
    console.log(`   chiến lược: ${r.strategy}`);
    r.results.slice(0, 5).forEach((x, i) => {
      const mark = i === goldRank ? " <-- TÀI LIỆU VÀNG" : "";
      const passGate = x.relevance >= LOCAL_MIN_SCORE ? "qua" : "BỊ CHẶN";
      console.log(`   [${i}] score=${x.relevance.toFixed(5)} (${passGate})  ${x.title}${mark}`);
    });
    if (goldRank < 0) console.log("   !! tài liệu vàng không nằm trong top 10");
    console.log();
  }
}

main();
