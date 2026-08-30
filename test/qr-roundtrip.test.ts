/**
 * Mã QR mẫu sinh ra có đọc lại được không, và đọc ra có đúng nội dung không?
 *
 * Hai thư viện khác nhau, hai tác giả khác nhau: `qrcode` sinh, `jsqr` đọc.
 * Không có gì bảo đảm chúng hiểu nhau cho tới khi thử. Và nếu chúng không hiểu
 * nhau thì buổi demo hỏng theo cách tệ nhất — camera bật, đèn sáng, người xem
 * chờ, mà không có gì xảy ra cả.
 *
 * Đây là phép thử duy nhất chứng minh được đường quét bằng camera hoạt động mà
 * không cần camera thật.
 *
 * Mọi số căn cước ở đây bắt đầu bằng `000` — mã tỉnh KHÔNG tồn tại (mã thật
 * chạy 001–096), nên không chuỗi nào trùng thẻ của người thật.
 */
import QRCode from "qrcode";
import jsQR from "jsqr";
import { parseCccdQr } from "../server/cccd";

let failures = 0;
const t = (cond: boolean, msg: string) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures++;
};

/**
 * Vẽ ma trận QR thành ảnh RGBA để `jsqr` đọc.
 *
 * `SCALE` và `QUIET` không phải số tuỳ tiện. jsQR định vị mã bằng ba ô vuông
 * góc; một module chỉ 1 pixel thì thuật toán không tìm nổi mép, và vùng lặng
 * quá hẹp thì nó không tách được mã khỏi nền. 4 px/module với vùng lặng 4
 * module là mức mà một mã QR in trên giấy nhìn qua camera sẽ có.
 */
const SCALE = 4;
const QUIET = 4;
function veRaAnh(text: string) {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const data = qr.modules.data;
  const canh = (n + QUIET * 2) * SCALE;
  /* Nền trắng: jsQR tìm module TỐI trên nền SÁNG. Đảo lại là không đọc được —
     cũng là lý do khung ảnh trên giao diện có nền trắng cố định kể cả ở chế độ
     tối. */
  const px = new Uint8ClampedArray(canh * canh * 4).fill(255);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!data[y * n + x]) continue;
      for (let dy = 0; dy < SCALE; dy++) {
        for (let dx = 0; dx < SCALE; dx++) {
          const px_ = (x + QUIET) * SCALE + dx;
          const py_ = (y + QUIET) * SCALE + dy;
          const i = (py_ * canh + px_) * 4;
          px[i] = px[i + 1] = px[i + 2] = 0;
        }
      }
    }
  }
  return { px, canh };
}

const doc = (text: string) => {
  const { px, canh } = veRaAnh(text);
  return jsQR(px, canh, canh, { inversionAttempts: "dontInvert" })?.data ?? null;
};

console.log("=== VÒNG KHÉP KÍN: SINH RỒI ĐỌC LẠI ===");
{
  const payload = "000123456789|123456789|Nguyễn Văn An|01011990|Nam|Số 1, Phường Bến Nghé, Quận 1, TP.HCM|01012021";
  const back = doc(payload);
  t(back !== null, "mã QR sinh ra đọc lại được bằng jsqr");
  t(back === payload, "và ra ĐÚNG chuỗi ban đầu, không sai một ký tự");
}

console.log("=== DẤU TIẾNG VIỆT SỐNG SÓT QUA QR ===");
{
  /* Chỗ dễ hỏng nhất: tên và địa chỉ tiếng Việt phải đi qua tầng mã hoá của QR
     rồi về nguyên vẹn. Sai ở đây thì phiếu khai báo lưu trú mang một cái tên
     méo, và nó là giấy tờ nộp cho công an. */
  for (const ten of ["Nguyễn Thị Bích Hường", "Đỗ Minh Khoa", "Trần Đăng Khoa", "Võ Thị Ánh Nguyệt"]) {
    const payload = `000123456789||${ten}|15081985|Nữ|Số 9, Phường 5, Quận Phú Nhuận, TP.HCM|20032022`;
    const back = doc(payload);
    t(back === payload, `giữ nguyên dấu: ${ten}`);
  }
}

console.log("=== ĐỌC XONG THÌ BỘ PHÂN TÍCH HIỂU ĐƯỢC ===");
{
  /* Đọc ra chuỗi đúng vẫn chưa đủ — chuỗi đó phải đi lọt qua `parseCccdQr`,
     nếu không thì demo dừng ở bước sau. Nối cả ba mắt xích trong một phép thử. */
  const payload = "000123456789|123456789|Nguyễn Văn An|01011990|Nam|Số 1, Phường Bến Nghé, Quận 1, TP.HCM|01012021";
  const back = doc(payload)!;
  const r = parseCccdQr(back);
  t(r.ok, "chuỗi đọc từ ảnh QR phân tích được");
  if (r.ok) {
    t(r.data.fullName === "Nguyễn Văn An", "họ tên đúng sau cả vòng sinh → đọc → phân tích");
    t(r.data.dob === "1990-01-01", "ngày sinh đúng");
    t(r.data.permanentAddress.includes("Bến Nghé"), "địa chỉ giữ nguyên dấu");
  }
}

console.log("=== SỐ DEMO KHÔNG THỂ TRÙNG THẺ THẬT ===");
{
  /* Mã tỉnh trên CCCD thật nằm trong 001–096. `000` không thuộc dải đó, nên một
     mã QR demo trôi ra ngoài cũng không phải số định danh của ai. */
  const ma = "000123456789".slice(0, 3);
  t(ma === "000", "số mẫu bắt đầu bằng 000");
  t(Number(ma) < 1 || Number(ma) > 96, "và 000 không phải mã tỉnh hợp lệ nào");
}

console.log(failures === 0 ? "\nALL QR ROUNDTRIP TESTS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
