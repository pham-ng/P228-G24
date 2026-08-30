/**
 * When to ask back, and — more important — when NOT to.
 *
 * A clarifier that fires on a clear question is worse than one that never
 * fires: the guest already told you what they wanted, and you asked them to
 * repeat themselves. Most of this file is the negative case.
 *
 *   npx tsx test/clarify.test.ts
 */
import { needsClarification } from "../server/clarify";

let failures = 0;
function ok(cond: boolean, msg: string) {
  if (cond) console.log(`  PASS  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}

console.log("=== PHẢI HỎI LẠI: thuộc tính có, chủ thể không ===");
const asks: [string, string][] = [
  ["Mấy giờ mở cửa vậy?", "hours"],
  ["Giá bao nhiêu ạ?", "price"],
  ["Bao lâu thì tới ạ?", "duration"],
  ["Huỷ được không anh?", "cancel"],
  ["Tôi có được giảm giá không?", "discount"],
  ["Cho tôi đặt lúc 7 giờ nhé.", "book"],
];
for (const [q, want] of asks) {
  const r = needsClarification(q);
  ok(r?.attribute === want, `"${q}" → hỏi lại (${want})`);
  ok(!!r?.reply && r.reply.length > 20, `  …và câu hỏi lại có nội dung`);
}

console.log("\n=== KHÔNG ĐƯỢC HỎI LẠI: khách đã nói rõ chủ thể ===");
/* Every one of these names what it is about. Firing here would ask a guest to
   repeat a question they asked perfectly well. */
const clear = [
  "Hồ bơi mở cửa lúc nào vậy?",
  "Phòng gym mở cửa từ mấy giờ ạ?",
  "Akoya Spa mở đến mấy giờ?",
  "Nhà hàng Lotus phục vụ bữa tối từ mấy giờ?",
  "Bữa sáng phục vụ đến mấy giờ ạ?",
  "Vịt quay Bắc Kinh ở Bách Giai bao nhiêu tiền?",
  "Xe đưa đón sân bay Cam Ranh giá bao nhiêu?",
  "Tôi muốn huỷ phòng thì mất bao nhiêu?",
  "Giặt một bộ áo dài hết bao nhiêu tiền?",
  "Hội viên Diamond được giảm bao nhiêu?",
  "Tiền cọc nhận phòng là bao nhiêu ạ?",
  "Gọi đồ ăn lên phòng mất bao lâu?",
  "Cho tôi đặt bàn ăn tối lúc 7 giờ nhé.",
];
for (const q of clear) ok(needsClarification(q) === null, `"${q}" → trả lời bình thường`);

console.log("\n=== KHÔNG ĐƯỢC HỎI LẠI: không phải câu hỏi thuộc tính ===");
const notAsking = [
  "Điều hoà phòng tôi không mát.",
  "Tôi bị đau ngực, khó thở.",
  "Xin chào, tôi vừa nhận phòng.",
  "Cảm ơn em nhé.",
  "",
  "   ",
];
for (const q of notAsking) ok(needsClarification(q) === null, `"${q.trim() || "(rỗng)"}" → không hỏi lại`);

console.log("\n=== CÂU DÀI TỰ MANG NGỮ CẢNH ===");
/* Thirteen words carry enough around them that guessing is safer than asking;
   the rule only fires on short, bare questions. */
ok(
  needsClarification(
    "Xin chào anh, tôi mới tới sáng nay và đang muốn biết là giá bao nhiêu vậy ạ?",
  ) === null,
  "câu dài không bị hỏi lại dù không nêu chủ thể",
);

console.log("\n=== KHÔNG DẤU CŨNG PHẢI CHẠY ===");
ok(needsClarification("may gio mo cua vay?")?.attribute === "hours", "không dấu vẫn nhận ra");
ok(needsClarification("ho boi mo cua luc nao") === null, "không dấu vẫn nhận ra chủ thể");

console.log("\n=== NGÔN NGỮ ===");
const SCRIPT: Record<string, RegExp> = {
  ko: /[가-힯]/,
  ja: /[぀-ヿ]/,
  zh: /[一-鿿]/,
  ru: /[Ѐ-ӿ]/,
};
for (const [l, re] of Object.entries(SCRIPT)) {
  const r = needsClarification("Giá bao nhiêu ạ?", l as never);
  ok(!!r && re.test(r.reply), `${l} hỏi lại bằng đúng chữ viết của mình`);
}
ok(
  /which one/i.test(needsClarification("Mấy giờ mở cửa vậy?", "en")?.reply ?? ""),
  "en hỏi lại bằng tiếng Anh",
);

console.log(failures === 0 ? "\nALL CLARIFY TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
