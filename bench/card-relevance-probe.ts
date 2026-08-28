/* Both lanes at once: cards must not appear unasked, and must appear when asked. */
import "dotenv/config";
import { runLocalTurn, type ReplyLang } from "../server/local-agent";
import { detectReferencedRoomTypes } from "../server/rooms";
import { detectReferencedServices } from "../server/services";
import { detectReferencedVenues } from "../server/dining";
import { storage } from "../server/storage";

const hotel = storage.getHotel();
const basics = { checkIn: hotel.checkInTime, checkOut: hotel.checkOutTime, currency: hotel.currency };

type Case = { q: string; lang: ReplyLang; want: "none" | "some" };

const CASES: Case[] = [
  // --- must show NOTHING: the guest asked about none of these things ---
  { q: "Điều hoà phòng tôi bị hỏng, xử lý thế nào?", lang: "vi", want: "none" },
  { q: "Mấy giờ ăn sáng?", lang: "vi", want: "some" }, // Lotus is named in the answer
  { q: "Wifi có miễn phí không?", lang: "vi", want: "none" },
  { q: "Resort có cho mang thú cưng không?", lang: "vi", want: "none" },
  { q: "Hồ bơi mở cửa đến mấy giờ?", lang: "vi", want: "none" },
  { q: "Giờ nhận phòng và trả phòng là mấy giờ?", lang: "vi", want: "none" },
  { q: "Resort có tất cả mấy phòng?", lang: "vi", want: "none" },
  // --- must show the thing the guest actually named ---
  { q: "Villa 3 phòng ngủ hướng biển có gì?", lang: "vi", want: "some" },
  { q: "Spa Akoya có liệu trình gì?", lang: "vi", want: "some" },
  { q: "Nhà hàng Jasmine mở cửa mấy giờ?", lang: "vi", want: "some" },
  { q: "Cáp treo Vinpearl chạy mấy giờ?", lang: "vi", want: "some" },
  { q: "What treatments does Akoya Spa offer?", lang: "en", want: "some" },
];

let total = 0;
let wrong = 0;
for (const { q, lang, want } of CASES) {
  const turn = await runLocalTurn({ question: q, isEmergency: false, lang, basics });
  /* agent.ts only builds cards when there IS a reply, so mirror that here. */
  const focus = turn.reply ? `${q}\n${turn.reply}` : "";
  const rooms = detectReferencedRoomTypes(turn.passages as any, focus);
  const services = detectReferencedServices(turn.passages as any, focus);
  const venues = detectReferencedVenues(turn.passages as any, focus);
  const n = rooms.length + services.length + venues.length;
  total += n;
  const good = want === "none" ? n === 0 : n > 0;
  if (!good) wrong++;
  console.log(`${good ? "ok  " : "WRONG"} [${String(n).padStart(2)}] want ${want.padEnd(4)} | ${q}`);
  const all = [...rooms.map((r) => r.name), ...services.map((s) => s.name), ...venues.map((v: any) => v.name)];
  if (all.length) console.log(`            ${all.join(", ")}`);
}
console.log(`\n===== ${total} cards across ${CASES.length} questions | ${wrong} wrong =====`);
process.exit(wrong === 0 ? 0 : 1);
