/**
 * Lời chào: bắt đúng lời chào trống, và tuyệt đối không nuốt câu hỏi.
 *
 * Phần lớn tệp này là các ca PHẢI TRẢ VỀ NULL. Nhận nhầm một câu có câu hỏi
 * bên trong nghĩa là khách hỏi giờ ăn sáng và nhận lại một lời chào — tệ hơn
 * hẳn so với việc bỏ lỡ một lời chào.
 *
 *   npx tsx test/greeting.test.ts
 */
import { greetingReply } from "../server/greeting";

let failures = 0;
function ok(cond: boolean, msg: string) {
  if (cond) console.log(`  PASS  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}

console.log("=== LỜI CHÀO TRỐNG → TRẢ LỜI CỐ ĐỊNH ===");
for (const g of ["xin chào", "Xin chào!", "chào em", "chào anh", "chào bạn ạ", "alo", "hello", "Hi", "hey", "Good morning"])
  ok(greetingReply(g) !== null, `"${g}"`);
for (const [g, l] of [["안녕하세요", "ko"], ["こんにちは", "ja"], ["你好", "zh"], ["Здравствуйте", "ru"]] as const)
  ok(greetingReply(g, l) !== null, `"${g}" (${l})`);

console.log("\n=== CÓ CÂU HỎI KÈM → KHÔNG ĐƯỢC BẮT ===");
/* Đây là nhóm quan trọng nhất. Bắt nhầm ở đây là nuốt mất việc khách cần. */
const withQuestion = [
  "chào em, mấy giờ ăn sáng?",
  "chào em cho anh hỏi mấy giờ ăn sáng",
  "xin chào, hồ bơi ở đâu ạ?",
  "hello, what time is breakfast?",
  "hi, can I get a late checkout?",
  "chào bạn, tôi muốn đặt bàn",
  "안녕하세요, 조식은 몇 시까지인가요?",
];
for (const q of withQuestion) ok(greetingReply(q) === null, `"${q}"`);

console.log("\n=== KHÔNG PHẢI LỜI CHÀO ===");
const notGreeting = [
  "giá phòng bao nhiêu",
  "chào giá phòng deluxe thế nào",
  "điều hoà không mát",
  "tôi muốn huỷ phòng",
  "cảm ơn em nhé",
  "",
  "   ",
  /* Dài hơn một lời chào: có nội dung thật bên trong. */
  "chào em, anh vừa nhận phòng xong và muốn hỏi thêm vài thứ về dịch vụ spa",
];
for (const q of notGreeting) ok(greetingReply(q) === null, `"${q.trim() || "(rỗng)"}"`);

console.log("\n=== CÂU TRẢ LỜI PHẢI ĐÚNG VAI ===");
/* Lỗi gốc: model trả lời "Bạn có thể hỗ trợ tôi về những vấn đề nào?" — mời
   khách giúp đỡ mình. Trợ lý phải là bên đề nghị giúp. */
const vi = greetingReply("xin chào")!;
ok(!/bạn có thể hỗ trợ tôi|bạn giúp tôi/i.test(vi), "không mời khách hỗ trợ mình");
ok(/em có thể giúp|hỗ trợ anh\/chị/i.test(vi), "trợ lý là bên đề nghị giúp");
ok(vi.length > 80, "có nêu được những việc làm giúp khách, không chỉ chào suông");

console.log("\n=== ĐÚNG CHỮ VIẾT CỦA TỪNG NGÔN NGỮ ===");
const SCRIPT: Record<string, RegExp> = {
  ko: /[가-힯]/,
  ja: /[぀-ヿ]/,
  zh: /[一-鿿]/,
  ru: /[Ѐ-ӿ]/,
};
for (const [l, re] of Object.entries(SCRIPT))
  ok(re.test(greetingReply("xin chào", l as never) ?? ""), `${l}`);
ok(/hotel assistant/i.test(greetingReply("xin chào", "en") ?? ""), "en");

console.log(failures === 0 ? "\nALL GREETING TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
