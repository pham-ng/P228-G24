/**
 * When to ask back, and — more important — when NOT to.
 *
 * A clarifier that fires on a clear question is worse than one that never
 * fires: the guest already told you what they wanted, and you asked them to
 * repeat themselves. Most of this file is the negative case.
 *
 *   npx tsx test/clarify.test.ts
 */
import { needsClarification, mentionsKnownSubject } from "../server/clarify";

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

console.log("=== ẢNH: ca thật từ hội thoại 2026-09-01 ===");
/* Bản gốc có DẤU CÁCH KÉP giữa "hình" và "ảnh" — đúng như khách gõ. Nếu
   regex dùng dấu cách đơn thay vì \s+ thì ca này im lặng trượt qua. */
ok(needsClarification("cho tôi xem hình  ảnh được không")?.attribute === "photos", "dấu cách kép vẫn nhận ra");
ok(needsClarification("Can I see some photos?")?.attribute === "photos", "tiếng Anh cũng nhận ra");
ok(needsClarification("chụp ảnh giúp tôi được không")?.attribute === "photos", "chụp ảnh cũng khớp");
/* "ảnh" gập dấu thành "anh" — TRÙNG với đại từ "anh/chị". Đây là bài test
   quan trọng nhất trong cả khối: nếu quy tắc lỏng tay khớp "anh" đứng một
   mình, gần như MỌI câu tiếng Việt trong hội thoại khách sạn sẽ bị hiểu
   nhầm thành yêu cầu xem ảnh. */
ok(needsClarification("anh ơi cho em hỏi chút")?.attribute !== "photos", "'anh' một mình KHÔNG bị hiểu thành ảnh");
ok(needsClarification("dạ anh chờ em chút ạ")?.attribute !== "photos", "…kể cả khi đứng giữa câu");
ok(needsClarification("anh có thể giúp tôi đặt phòng không")?.attribute !== "photos", "…hay đầu câu");
/* Có nêu chủ thể (phòng) thì không hỏi lại — cùng luật với 6 thuộc tính kia. */
ok(needsClarification("cho tôi xem ảnh phòng Deluxe") === null, "có nêu phòng thì trả lời bình thường");

console.log("=== RANH GIỚI TỪ: chuỗi con ngắn không được ăn theo từ dài hơn ===");
/* Bắt được khi viết test cho "photos": SUBJECTS.some(s => f.includes(s)) so
   chuỗi con thô, không có \b — nên "xe" (xe cộ) khớp bên trong "xem", và
   "ui" (bàn ủi) khớp bên trong "vui". Cả hai khiến một câu hỏi giá/thông tin
   KHÔNG nêu dịch vụ nào bị hiểu nhầm là đã nêu chủ thể, nên không được hỏi
   lại dù đáng lẽ phải hỏi. */
ok(
  needsClarification("vui lòng cho tôi biết giá bao nhiêu")?.attribute === "price",
  "'vui lòng' không bị hiểu nhầm thành 'ủi' (bàn ủi)",
);
ok(needsClarification("xem thử giá thế nào")?.attribute === "price", "'xem' không bị hiểu nhầm thành 'xe'");
/* Đối chứng: các mục SUBJECTS thật vẫn phải khớp bình thường sau khi đổi
   sang \b — không phải chỉ thêm ranh giới rồi vô tình không khớp gì nữa. */
ok(needsClarification("giá phòng bao nhiêu") === null, "'phòng' (chủ thể thật) vẫn được nhận ra");
ok(needsClarification("xe đưa đón sân bay giá bao nhiêu") === null, "'sân bay' (chủ thể thật) vẫn được nhận ra");

console.log("=== mentionsKnownSubject: soi LỊCH SỬ, không phải câu hiện tại ===");
ok(mentionsKnownSubject("") === false, "lịch sử rỗng → không có chủ thể");
ok(mentionsKnownSubject("giá phòng Deluxe Giường Đôi bao nhiêu") === true, "lịch sử vừa nhắc 'phòng' → có chủ thể");
ok(mentionsKnownSubject("nhà hàng Lotus mở cửa mấy giờ") === true, "lịch sử vừa nhắc 'nhà hàng' → có chủ thể");
ok(mentionsKnownSubject("vị trí check-in của khách sạn ở đâu") === false, "hỏi vị trí check-in KHÔNG tính là đã nêu chủ thể ảnh");

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
