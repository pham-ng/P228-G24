/**
 * Does a price question come back with a real, correctly-attributed amount?
 *
 * Written for the live report "Giá phòng Deluxe giường đôi được công bố là
 * 100%." — where retrieval had found the right rate chunks and the context
 * compressor then deleted every price before the model saw one.
 *
 * Flags two shapes of failure:
 *   NO-AMOUNT  the reply to a price question contains no currency amount
 *   PERCENT    it answers with a bare percentage instead (the reported bug)
 * Late-checkout is included deliberately as a control: its answer IS a
 * percentage, and must not be flagged.
 */
import "dotenv/config";
import { runLocalTurn } from "../server/local-agent";
import { storage } from "../server/storage";

const hotel = storage.getHotel();
const basics = { checkIn: hotel.checkInTime, checkOut: hotel.checkOutTime, currency: hotel.currency };

const AMOUNT = /\d[\d.,]{2,}\s*(đ|₫|vn[dđ])/i;
const BARE_PERCENT = /\d+\s*%/;

const CASES: { q: string; wants: "amount" | "percent" }[] = [
  { q: "Giá Deluxe giường đôi bao nhiêu?", wants: "amount" },
  { q: "Giá phòng Deluxe giường đôi bao nhiêu?", wants: "amount" },
  { q: "Phòng Deluxe giường đôi giá bao nhiêu một đêm?", wants: "amount" },
  { q: "Giá Deluxe 2 giường đơn bao nhiêu?", wants: "amount" },
  { q: "Grand Deluxe giường đôi giá bao nhiêu?", wants: "amount" },
  { q: "Villa 3 phòng ngủ hướng biển giá bao nhiêu?", wants: "amount" },
  { q: "Buffet sáng giá bao nhiêu một người?", wants: "amount" },
  { q: "Phí trả phòng muộn là bao nhiêu?", wants: "percent" }, // control
];

let bad = 0;
for (const { q, wants } of CASES) {
  const t = await runLocalTurn({ question: q, isEmergency: false, lang: "vi", basics });
  const r = (t.reply ?? "(escalated)").replace(/\s+/g, " ");
  const hasAmount = AMOUNT.test(r);
  const hasPercent = BARE_PERCENT.test(r);

  let verdict = "ok";
  if (wants === "amount") {
    if (!hasAmount && hasPercent) verdict = "PERCENT";
    else if (!hasAmount) verdict = "NO-AMOUNT";
  } else if (!hasPercent) verdict = "NO-PERCENT";
  if (verdict !== "ok") bad++;

  console.log(`${verdict.padEnd(10)} | ${q}`);
  console.log(`             ${r.slice(0, 220)}`);
}

console.log(`\n${bad === 0 ? "ALL PRICE ANSWERS CARRY A REAL FIGURE" : `${bad} BAD`}`);
process.exit(bad === 0 ? 0 : 1);
