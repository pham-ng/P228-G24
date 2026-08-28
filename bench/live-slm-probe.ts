/* Live probe of the offline SLM pipeline — one turn per question, no conversation state. */
import "dotenv/config";
import { runLocalTurn, classifyLocal, type ReplyLang } from "../server/local-agent";
import { storage } from "../server/storage";

type Case = { q: string; lang: ReplyLang; want: string };

const CASES: Case[] = [
  // --- knowledge lane: published facts the KB should answer ---
  { q: "Mấy giờ ăn sáng?", lang: "vi", want: "answer" },
  { q: "Hồ bơi mở cửa đến mấy giờ?", lang: "vi", want: "answer" },
  { q: "Wifi có miễn phí không?", lang: "vi", want: "answer" },
  { q: "Phòng Deluxe giá bao nhiêu một đêm?", lang: "vi", want: "answer" },
  { q: "Resort có cho mang thú cưng không?", lang: "vi", want: "answer" },
  { q: "Giờ nhận phòng và trả phòng là mấy giờ?", lang: "vi", want: "answer" },
  { q: "What time does the spa close?", lang: "en", want: "answer" },
  { q: "수영장은 몇 시까지 운영하나요?", lang: "ko", want: "answer" },
  { q: "早餐几点开始？", lang: "zh", want: "answer" },

  // --- must escalate ---
  { q: "Tổng hoá đơn của tôi bao nhiêu tiền?", lang: "vi", want: "escalate" },
  { q: "Tôi muốn huỷ phòng", lang: "vi", want: "escalate" },
  { q: "Điều hoà phòng tôi bị hỏng, xử lý thế nào?", lang: "vi", want: "escalate" },
  { q: "Wifi phòng tôi không vào được, phải làm thế nào?", lang: "vi", want: "escalate" },
  { q: "Ở thêm 2 ngày mất bao nhiêu tiền?", lang: "vi", want: "escalate" },
  { q: "Bồn cầu phòng tôi bị tắc, xử lý thế nào?", lang: "vi", want: "escalate" },

  // --- hallucination bait: facts the KB should NOT have ---
  { q: "Resort có sân bay riêng không?", lang: "vi", want: "escalate-or-no" },
  { q: "Phòng gym mở cửa mấy giờ?", lang: "vi", want: "either" },
];

const hotel = storage.getHotel();
const basics = { checkIn: hotel.checkInTime, checkOut: hotel.checkOutTime, currency: hotel.currency };

let ok = 0, bad = 0;
const lat: number[] = [];

for (const c of CASES) {
  const t0 = Date.now();
  let turn;
  try {
    turn = await runLocalTurn({ question: c.q, isEmergency: false, lang: c.lang, basics });
  } catch (e: any) {
    console.log(`\nCRASH  ${c.q}\n       ${e?.message ?? e}`);
    bad++;
    continue;
  }
  const ms = Date.now() - t0;
  lat.push(ms);
  const route = classifyLocal(c.q, false);
  const verdict = turn.escalate ? "ESCALATE" : "ANSWER";
  const match =
    c.want === "either" ? "·" :
    c.want === "answer" ? (turn.escalate ? "✗" : "✓") :
    c.want === "escalate" ? (turn.escalate ? "✓" : "✗") : "·";
  if (match === "✓") ok++; else if (match === "✗") bad++;

  console.log(
    `\n${match} [${route}/${verdict}] ${ms}ms  score=${turn.topScore.toFixed(4)} llm=${turn.llmCalls}` +
    (turn.timing ? ` (prompt ${turn.timing.promptEvalTokens}tok/${turn.timing.promptEvalMs}ms, gen ${turn.timing.evalTokens}tok/${turn.timing.evalMs}ms)` : "")
  );
  console.log(`  Q: ${c.q}`);
  console.log(`  A: ${(turn.reply ?? "(" + (turn.escalateReason ?? "no reply") + ")").replace(/\n/g, " ").slice(0, 400)}`);
  console.log(`  passages: ${turn.passages.map((p) => p.title).slice(0, 5).join(" | ")}`);
}

lat.sort((a, b) => a - b);
console.log(`\n\n===== SUMMARY =====`);
console.log(`expected-behaviour: ${ok} ok / ${bad} wrong (of ${ok + bad} graded)`);
console.log(`latency p50=${lat[Math.floor(lat.length * 0.5)]}ms  p90=${lat[Math.floor(lat.length * 0.9)]}ms  max=${lat[lat.length - 1]}ms`);
process.exit(0);
