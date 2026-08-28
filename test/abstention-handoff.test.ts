/**
 * A refusal must never reach the guest, and a handoff must fit what was asked.
 *
 * Both were live defects found by the answer probe on the same turn:
 *
 *     Q: Resort có sân bay riêng không?
 *     A: "Khong du thong tin về việc resort có sân bay riêng hay không.
 *         Dạ, em xin gửi thông tin chi tiết và mức giá niêm yết ở trên.
 *         Để hoàn tất thủ tục đặt phòng và chọn ngày lưu trú..."
 *
 * Two separate bugs in one sentence. The model abstained in almost exactly the
 * wording it was taught — `KHONG_DU_THONG_TIN` written as ordinary Vietnamese
 * words — and `isAbstention` only recognised the underscored identifier, so the
 * refusal was treated as an ANSWER: shipped to the guest, turn marked resolved,
 * no human ever informed. Measured across eight real refusal phrasings, six
 * leaked, including every Russian, Korean, Chinese and Japanese one, for which
 * no pattern existed at all. Then a fixed booking sentence was appended to it,
 * because the handoff note was one hardcoded string regardless of the request.
 */
import "dotenv/config";
import { isAbstention, handoffNote, ABSTAIN } from "../server/local-agent";
import { scoreFamilies } from "../server/toolrouter";

let failures = 0;
function ok(cond: boolean, label: string) {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
}

console.log("=== a refusal is recognised however it is spelled ===");
const REFUSALS = [
  [ABSTAIN, "the taught token"],
  ["KHÔNG_DU_THONG_TIN", "the token respelled with diacritics"],
  ["Không đủ thông tin về việc này.", "the token as ordinary Vietnamese words — the live leak"],
  ["Khong du thong tin về việc resort có sân bay riêng hay không.", "the same, unaccented"],
  ["Tài liệu hiện không cung cấp thông tin cụ thể về giờ mở cửa.", "vi prose: 'không cung cấp'"],
  ["Dựa trên tài liệu đã cung cấp, không có thông tin về giờ phục vụ.", "vi prose: 'không có thông tin'"],
  ["The price is not specified in the provided passages.", "en passive: 'is not specified'"],
  ["I cannot find this information in the documents.", "en: 'cannot find'"],
  ["В предоставленных текстах нет информации об этом.", "ru: 'нет информации'"],
  ["Номер Deluxe Queen Bed не имеет указанной цены в предоставленных текстах.", "ru inflected: 'не имеет указанной'"],
  ["제공된 문서에는 해당 정보가 없습니다.", "ko: '정보가 없습니다'"],
  ["提供的文件中没有相关信息。", "zh: '没有相关信息'"],
  ["この資料には情報がありません。", "ja: '情報がありません'"],
];
for (const [text, label] of REFUSALS) ok(isAbstention(text), `${label}`);

console.log("\n=== a real answer is never mistaken for a refusal ===");
const ANSWERS = [
  ["Không được mang thú cưng vào phòng.", "a negative ANSWER is not a refusal"],
  ["Không, hồ bơi không có cứu hộ sau 19:00.", "a negative answer carrying a fact"],
  ["Giá gói rẻ nhất là 3.580.000đ/đêm.", "a price answer"],
  ["Phòng Gym mở cửa từ 05:30 đến 22:00, miễn phí cho khách lưu trú.", "an hours answer"],
  ["No, pets are not allowed in the rooms.", "en negative answer"],
  ["Breakfast is served from 06:00 to 10:30.", "en hours answer"],
  ["수영장은 오전 6시부터 오후 8시까지 운영됩니다.", "ko answer"],
  ["早餐从早上 06:00 开始。", "zh answer"],
  ["Стандартное время заезда — 14:00.", "ru answer"],
];
for (const [text, label] of ANSWERS) ok(!isAbstention(text), label);

console.log("\n=== the handoff sentence matches what the guest asked ===");
{
  /* One fixed booking sentence used to be appended to every transaction-path
     reply. A broken air-con was told "để hoàn tất thủ tục đặt phòng và chọn
     ngày lưu trú"; so was a question about whether the resort has an airport. */
  const noteFor = (q: string) => handoffNote(scoreFamilies(q)[0]?.family, "vi");

  const fault = noteFor("Điều hoà phòng tôi bị hỏng, xử lý thế nào?");
  ok(!/đặt phòng|lưu trú/.test(fault), "a fault report is NOT told about completing a booking");
  ok(/xử lý|bộ phận/.test(fault), "it is told the request went to the team that fixes it");

  const cancel = noteFor("Tôi muốn huỷ phòng");
  ok(!/hoàn tất.*đặt phòng/.test(cancel), "a cancellation is NOT told about completing a booking");
  ok(/xác nhận|Lễ tân/.test(cancel), "it is told the front desk will confirm");

  const transfer = noteFor("Xe đưa đón sân bay đặt thế nào?");
  ok(/vận chuyển|sắp xếp/.test(transfer), "a transfer request goes to the transport desk");

  const booking = noteFor("Cho tôi đặt phòng Deluxe");
  ok(/đặt phòng/.test(booking), "an actual booking request DOES get the booking sentence");

  ok(handoffNote(undefined, "vi").trim().length > 0, "an unknown family still gets a neutral sentence");
  ok(!/đặt phòng/.test(handoffNote(undefined, "vi")), "and that neutral sentence does not invent a booking");

  const en = handoffNote("housekeeping", "en");
  ok(/team/i.test(en) && !/[àáảãạăâđêôơư]/i.test(en), "English guests get the English sentence");
}

console.log(failures === 0 ? "\nALL ABSTENTION & HANDOFF TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
