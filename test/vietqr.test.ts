/**
 * A wrong byte in a VietQR payload fails silently — the banking app simply does
 * not recognise the code, with no error to read. So the parts that CAN be
 * checked without a phone are checked hard here:
 *
 *   - the CRC, against the standard CRC-16/CCITT-FALSE test vector;
 *   - every declared length, by parsing the payload back;
 *   - the amount, which is the field where a mistake moves real money.
 *
 * What these assertions do NOT prove is that a bank's scanner accepts the
 * result. That needs one phone and one scan, and it has to happen before this
 * is shown to a guest.
 */
import "dotenv/config";
import { buildVietQrPayload, crc16, parseTlv, verifyCrc, ascii } from "../server/vietqr";

let failures = 0;
function ok(cond: boolean, label: string) {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
}

console.log("=== CRC-16/CCITT-FALSE ===");
/* The canonical check value for this CRC variant. If this passes, the
   polynomial, the init value and the bit order are all right. */
ok(crc16("123456789") === "29B1", `"123456789" -> 29B1 (được ${crc16("123456789")})`);
ok(crc16("") === "FFFF", `chuỗi rỗng -> FFFF (được ${crc16("")})`);
ok(crc16("A").length === 4, "luôn 4 ký tự");

console.log("\n=== cấu trúc payload ===");
const payload = buildVietQrPayload({
  bankBin: "970436", // Vietcombank
  accountNumber: "1021234567",
  amount: 520000,
  description: "VPNT-5K18QA buffet toi",
});
console.log(`  ${payload}`);

const f = parseTlv(payload);
ok(f["00"] === "01", "00 Payload Format Indicator = 01");
ok(f["01"] === "12", "01 Point of Initiation = 12 (có số tiền -> dùng một lần)");
ok(f["53"] === "704", "53 Currency = 704 (VND)");
ok(f["54"] === "520000", `54 Amount = 520000 (được ${f["54"]})`);
ok(f["58"] === "VN", "58 Country = VN");
ok(verifyCrc(payload), "63 CRC khớp với nội dung");

console.log("\n=== khối NAPAS lồng bên trong ===");
const merchant = parseTlv(f["38"]);
ok(merchant["00"] === "A000000727", "GUID NAPAS");
ok(merchant["02"] === "QRIBFTTA", "mã dịch vụ chuyển tới tài khoản");
const beneficiary = parseTlv(merchant["01"]);
ok(beneficiary["00"] === "970436", "BIN ngân hàng");
ok(beneficiary["01"] === "1021234567", "số tài khoản");

console.log("\n=== nội dung chuyển khoản ===");
const extra = parseTlv(f["62"]);
ok(extra["08"] === "VPNT-5K18QA buffet toi", `08 Purpose (được "${extra["08"]}")`);

console.log("\n=== mã mở (không ghi số tiền) ===");
const open = buildVietQrPayload({ bankBin: "970436", accountNumber: "1021234567" });
const of_ = parseTlv(open);
ok(of_["01"] === "11", "không có số tiền -> tĩnh (11), dùng lại được");
ok(of_["54"] === undefined, "không có trường 54");
ok(verifyCrc(open), "CRC vẫn khớp");

console.log("\n=== số tiền: chỗ sai là mất tiền thật ===");
/* VND has no minor units. "520000.00" scans fine and transfers the wrong
   figure, which is the worst kind of bug this file can prevent. */
ok(parseTlv(buildVietQrPayload({ bankBin: "970436", accountNumber: "1", amount: 520000.4 }))["54"] === "520000", "làm tròn xuống, không có dấu thập phân");
ok(parseTlv(buildVietQrPayload({ bankBin: "970436", accountNumber: "1", amount: 519999.6 }))["54"] === "520000", "làm tròn lên");
ok(parseTlv(buildVietQrPayload({ bankBin: "970436", accountNumber: "1", amount: 0 }))["54"] === undefined, "số tiền 0 -> coi như mã mở");
ok(!/\./.test(buildVietQrPayload({ bankBin: "970436", accountNumber: "1", amount: 1500000 })), "không bao giờ có dấu chấm trong payload");

console.log("\n=== từ chối dữ liệu sai thay vì sinh mã hỏng ===");
/* Silently emitting a broken code is the failure mode to avoid: it scans as
   nothing and nobody knows why. */
for (const [label, fn] of [
  ["BIN 5 chữ số", () => buildVietQrPayload({ bankBin: "97043", accountNumber: "1" })],
  ["BIN có chữ", () => buildVietQrPayload({ bankBin: "97043X", accountNumber: "1" })],
  ["thiếu số tài khoản", () => buildVietQrPayload({ bankBin: "970436", accountNumber: "" })],
] as const) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  ok(threw, `báo lỗi: ${label}`);
}

console.log("\n=== làm sạch chữ tiếng Việt ===");
/* The length prefix counts characters, so a diacritic that a scanner decodes
   differently desynchronises every field after it. */
ok(ascii("Nguyễn Thị Lan", 50) === "Nguyen Thi Lan", "bỏ dấu, giữ đọc được");
/* The em dash is removed and the double space it leaves is collapsed — a
   trailing or doubled space would be carried into the bank statement. */
ok(ascii("Phòng 102 — đặt bàn", 50) === "Phong 102 dat ban", `bỏ ký tự ngoài ASCII và gộp khoảng trắng (được "${ascii("Phòng 102 — đặt bàn", 50)}")`);
ok(ascii("x".repeat(200), 25).length === 25, "cắt theo giới hạn");
{
  const p = buildVietQrPayload({ bankBin: "970436", accountNumber: "1", description: "Trả phòng muộn — phòng 305" });
  ok(verifyCrc(p), "payload có tiếng Việt vẫn hợp lệ");
  ok(parseTlv(p) !== null, "vẫn parse lại được từng trường");
  ok(!/[^\x20-\x7E]/.test(p), "payload chỉ chứa ASCII in được");
}

console.log(failures === 0 ? "\nALL VIETQR TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
