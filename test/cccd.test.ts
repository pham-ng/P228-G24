/**
 * Bộ đọc QR thẻ CCCD.
 *
 * Dữ liệu ở đây sẽ được nộp cho công an qua phiếu khai báo lưu trú, nên phép
 * thử quan trọng nhất KHÔNG phải "đọc đúng thẻ hợp lệ" — mà là "từ chối thẳng
 * mọi thứ nó không chắc". Một hồ sơ nhân thân sai tệ hơn nhiều so với việc bắt
 * lễ tân gõ tay.
 *
 * Mọi số căn cước trong file này là số GIẢ, dựng cho phép thử.
 */
import { ok, strictEqual } from "node:assert";
import { parseCccdQr, maskId, nameMatch } from "../server/cccd";

let failures = 0;
const t = (cond: boolean, msg: string) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures++;
};

/* Thẻ dựng: 12 số, CMND cũ, tên có dấu, sinh 01/01/1990, Nam, địa chỉ, cấp 01/01/2021 */
const THE_HOP_LE = "001099012345|123456789|Nguyễn Văn An|01011990|Nam|Số 1, Phường Bến Nghé, Quận 1, TP.HCM|01012021";

console.log("=== ĐỌC ĐƯỢC MỘT THẺ HỢP LỆ ===");
{
  const r = parseCccdQr(THE_HOP_LE);
  t(r.ok, "thẻ đúng quy cách thì đọc được");
  if (r.ok) {
    strictEqual(r.data.idNumber, "001099012345");
    strictEqual(r.data.oldIdNumber, "123456789");
    strictEqual(r.data.fullName, "Nguyễn Văn An");
    t(r.data.dob === "1990-01-01", `ngày sinh đổi sang ISO (được "${r.data.dob}")`);
    t(r.data.issuedAt === "2021-01-01", `ngày cấp đổi sang ISO (được "${r.data.issuedAt}")`);
    t(r.data.gender === "male", "giới tính đọc đúng");
    t(r.data.permanentAddress.includes("Bến Nghé"), "giữ nguyên dấu trong địa chỉ");
  }
}

console.log("=== NỮ, VÀ THẺ KHÔNG CÓ CMND CŨ ===");
{
  const r = parseCccdQr("079200001111||Trần Thị Bích|15081985|Nữ|Số 9, Phường 5, Đà Nẵng|20032022");
  t(r.ok, "thẻ không có số CMND cũ vẫn đọc được");
  if (r.ok) {
    t(r.data.oldIdNumber === null, "trường CMND rỗng ghi null, không phải chuỗi rỗng");
    t(r.data.gender === "female", '"Nữ" đọc đúng');
    t(r.data.dob === "1985-08-15", "ngày 15/08 không bị lẫn thành tháng 15");
  }
  /* Máy quét đôi khi trả về chuỗi đã mất dấu. */
  const kd = parseCccdQr("079200001111||Tran Thi Bich|15081985|Nu|So 9, Da Nang|20032022");
  t(kd.ok && kd.data.gender === "female", '"Nu" không dấu vẫn đọc là nữ');
}

console.log("=== TỪ CHỐI THẲNG THỨ NÓ KHÔNG CHẮC ===");
{
  /* Đây là phép thử quan trọng nhất trong file. Mỗi ca dưới đây, nếu đoán bừa,
     sẽ tạo ra một hồ sơ nhân thân sai trên giấy tờ nộp cho công an. */
  const xau: [string, string][] = [
    ["", "chuỗi rỗng"],
    ["VPNT-4Q18ZM", "quét nhầm mã đặt phòng"],
    ["a|b|c", "quá ít trường"],
    ["1|2|3|4|5|6|7|8", "quá nhiều trường"],
    ["12345|123456789|Nguyễn Văn A|01011990|Nam|Hà Nội|01012021", "số căn cước chỉ 5 chữ số"],
    ["00109901234X|123456789|Nguyễn Văn A|01011990|Nam|Hà Nội|01012021", "số căn cước có chữ cái"],
    ["001099012345|123456789||01011990|Nam|Hà Nội|01012021", "thiếu họ tên"],
    ["001099012345|123456789|Nguyễn Văn A|31022000|Nam|Hà Nội|01012021", "ngày 31/02 không tồn tại"],
    ["001099012345|123456789|Nguyễn Văn A|01131990|Nam|Hà Nội|01012021", "tháng 13"],
    ["001099012345|123456789|Nguyễn Văn A|1990|Nam|Hà Nội|01012021", "ngày sinh sai định dạng"],
    ["001099012345|123456789|Nguyễn Văn A|01011990|Khác|Hà Nội|01012021", "giới tính lạ"],
    ["001099012345|123456789|Nguyễn Văn A|01011990|Nam||01012021", "thiếu nơi thường trú"],
  ];
  for (const [payload, vi] of xau) {
    const r = parseCccdQr(payload);
    t(!r.ok, `từ chối: ${vi}`);
    if (!r.ok) ok(r.error.length > 0, "và nói rõ lý do để lễ tân biết phải nhập tay");
  }
}

console.log("=== 31/02 KHÔNG ĐƯỢC CUỘN THÀNH 02/03 ===");
{
  /* `new Date(2000, 1, 31)` trả về ngày 2 tháng 3 mà không báo gì. Nếu bộ đọc
     dùng nó mà không kiểm lại, một ngày sinh không tồn tại sẽ lặng lẽ trở thành
     một ngày sinh hợp lệ nhưng SAI, và không ai phát hiện. */
  const r = parseCccdQr("001099012345||Nguyễn Văn A|31022000|Nam|Hà Nội|01012021");
  t(!r.ok, "ngày không tồn tại bị chặn thay vì bị cuộn sang ngày khác");
}

console.log("=== CHE SỐ CĂN CƯỚC ===");
{
  t(maskId("001099012345") === "••••••••2345", "chỉ để lộ 4 số cuối, đủ để đối chiếu với thẻ đang cầm");
  t(!maskId("001099012345").includes("0010"), "phần đầu bị che thật");
  t(maskId("12") === "••", "chuỗi ngắn không làm vỡ hàm");
  t(maskId("") === "", "chuỗi rỗng không làm vỡ hàm");
}

console.log("=== ĐỐI CHIẾU TÊN THẺ VỚI TÊN ĐẶT PHÒNG ===");
{
  t(nameMatch("Nguyễn Văn An", "Nguyễn Văn An") === "exact", "trùng khít");
  /* Hệ đặt phòng quốc tế gõ không dấu — đây là ca thường gặp nhất. */
  t(nameMatch("Nguyễn Văn An", "Nguyen Van An") === "exact", "bỏ dấu vẫn là trùng khít");
  t(nameMatch("Trần Thị Bích", "TRAN THI BICH") === "exact", "khác hoa thường vẫn trùng");
  t(nameMatch("Đỗ Minh Khoa", "Do Minh Khoa") === "exact", "chữ Đ đổi thành D");
  /* Đảo thứ tự trả về "likely", KHÔNG phải "exact" — và đó là chủ ý.
     Hệ đặt phòng nước ngoài hay ghi "An Nguyen Van"; nhiều khả năng cùng một
     người, nhưng cũng có thể là hai người trùng từ. Mức "likely" bắt lễ tân
     nhìn lại tấm thẻ, mà lễ tân thì đang cầm nó trong tay. Bài kiểm thử đầu
     tiên tôi viết kỳ vọng "exact" và nó báo đỏ — code đúng, kỳ vọng sai. */
  t(nameMatch("Nguyễn Văn An", "An Nguyen Van") === "likely", "đảo thứ tự nhận ra nhưng vẫn bắt xác nhận lại");
  t(nameMatch("Nguyễn Văn An", "Nguyen An") === "likely", "thiếu tên đệm thì báo 'có thể'");
  t(nameMatch("Nguyễn Văn An", "Trần Thị Bích") === "different", "hai người khác nhau thì báo khác");
  t(nameMatch("", "Nguyen Van An") === "different", "tên rỗng không được coi là khớp");
  /* Không tự quyết: hàm trả về mức độ, lễ tân là người bấm xác nhận. */
  t(["exact", "likely", "different"].includes(nameMatch("A B", "C D")), "luôn trả về một trong ba mức");
}

console.log(failures === 0 ? "\nALL CCCD TESTS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
