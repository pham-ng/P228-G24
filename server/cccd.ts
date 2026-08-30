/**
 * Đọc mã QR in trên thẻ Căn cước công dân gắn chip.
 *
 * PHẠM VI — đọc kỹ trước khi mở rộng.
 *
 * File này đọc **QR TĨNH in trên mặt trước thẻ CCCD**: bảy trường ngăn bằng
 * dấu `|`, không bao giờ thay đổi trong suốt đời thẻ. Nó KHÔNG đọc QR do ứng
 * dụng VNeID sinh ra — thứ mà sân bay dùng. Hai cái khác nhau về bản chất:
 *
 *   · QR trên thẻ  — tĩnh, đọc offline được, và **lặp lại được**. Ảnh chụp một
 *                    lần dùng được mãi. Không đủ làm thông tin đăng nhập.
 *   · QR VNeID     — động, đổi theo thời gian, gắn với phiên đã xác thực trong
 *                    app. Muốn biết nó thật hay là ảnh chụp màn hình thì phải
 *                    gọi hệ thống của C06, tức phải là đối tác tích hợp chính
 *                    thức. Chưa có tích hợp đó thì không xác minh được.
 *
 * Vì thế dữ liệu ở đây chỉ dùng để **ĐIỀN PHIẾU khai báo lưu trú**, không dùng
 * để mở phiên. Lễ tân là người xác thực: họ nhìn mặt, đối chiếu thẻ, rồi bấm
 * xác nhận. QR chỉ tiết kiệm việc gõ tay bảy trường và tránh sai chính tả trên
 * một biểu mẫu có giá trị pháp lý.
 *
 * KHÔNG ĐOÁN. Payload không đúng dạng thì trả về lỗi kèm lý do, để màn hình
 * lễ tân hiện ô nhập tay — chứ không im lặng dựng ra một hồ sơ nhân thân sai.
 * Đây là dữ liệu sẽ được nộp cho công an; đoán bừa ở đây tệ hơn nhiều so với
 * bắt người ta gõ.
 */

/** Bảy trường theo đúng thứ tự in trên thẻ. */
export type CccdScan = {
  idNumber: string;
  /** Số CMND 9 số cũ, in trên thẻ của người đổi từ CMND sang. Thường rỗng. */
  oldIdNumber: string | null;
  fullName: string;
  /** ISO `YYYY-MM-DD`, đổi từ `ddmmyyyy` trên thẻ. */
  dob: string;
  gender: "male" | "female" | "other";
  permanentAddress: string;
  /** ISO `YYYY-MM-DD`. */
  issuedAt: string;
};

export type CccdParse = { ok: true; data: CccdScan } | { ok: false; error: string };

/**
 * `ddmmyyyy` → `YYYY-MM-DD`.
 *
 * Kiểm ngày thật chứ không chỉ đếm chữ số: `31022000` đúng tám chữ số nhưng
 * không phải một ngày. `new Date()` sẽ âm thầm cuộn nó sang 02/03, và một hồ sơ
 * nhân thân sai ngày sinh thì tệ hơn một hồ sơ báo lỗi.
 */
function toIsoDate(raw: string): string | null {
  if (!/^\d{8}$/.test(raw)) return null;
  const d = Number(raw.slice(0, 2));
  const m = Number(raw.slice(2, 4));
  const y = Number(raw.slice(4, 8));
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  if (y < 1900 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function readGender(raw: string): CccdScan["gender"] | null {
  const g = raw.trim().toLowerCase();
  if (g === "nam") return "male";
  /* Không dùng dấu: máy quét đôi khi trả về chuỗi đã mất dấu, nên "nu" cũng
     phải nhận. "nu" không đụng nghĩa nào khác trong trường này. */
  if (g === "nữ" || g === "nu") return "female";
  return null;
}

/**
 * Phân tích nội dung QR.
 *
 * Chuỗi mẫu (đã thay bằng số giả):
 *   `001099012345|123456789|Nguyễn Văn A|01011990|Nam|Số 1, Phường X, Hà Nội|01012021`
 */
export function parseCccdQr(raw: string): CccdParse {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, error: "Chưa có dữ liệu quét." };

  const parts = text.split("|");
  if (parts.length !== 7)
    return {
      ok: false,
      error: `Mã QR này có ${parts.length} trường, thẻ CCCD có 7. Có thể là QR khác (VNeID, mã đặt phòng, mã sản phẩm) — vui lòng nhập tay.`,
    };

  const [idNumber, oldIdNumber, fullName, dobRaw, genderRaw, address, issuedRaw] = parts.map((p) => p.trim());

  /* 12 chữ số là quy cách CCCD. Thẻ CMND cũ 9 số không có QR, nên một chuỗi 9
     số ở đây nghĩa là quét nhầm thứ gì đó. */
  if (!/^\d{12}$/.test(idNumber))
    return { ok: false, error: `Số căn cước phải có 12 chữ số, đọc được "${idNumber.slice(0, 20)}".` };

  if (!fullName) return { ok: false, error: "Không đọc được họ tên." };

  const dob = toIsoDate(dobRaw);
  if (!dob) return { ok: false, error: `Ngày sinh "${dobRaw}" không hợp lệ (cần dạng ddmmyyyy).` };

  const issuedAt = toIsoDate(issuedRaw);
  if (!issuedAt) return { ok: false, error: `Ngày cấp "${issuedRaw}" không hợp lệ (cần dạng ddmmyyyy).` };

  const gender = readGender(genderRaw);
  if (!gender) return { ok: false, error: `Không đọc được giới tính từ "${genderRaw}".` };

  if (!address) return { ok: false, error: "Không đọc được nơi thường trú." };

  return {
    ok: true,
    data: {
      idNumber,
      oldIdNumber: /^\d{9}$/.test(oldIdNumber) ? oldIdNumber : null,
      fullName,
      dob,
      gender,
      permanentAddress: address,
      issuedAt,
    },
  };
}

/**
 * Che số căn cước khi đưa ra ngoài hoặc ghi vào nhật ký.
 *
 * Bốn số cuối đủ để lễ tân đối chiếu với tấm thẻ đang cầm, mà một dòng log bị
 * lộ thì không phát tán trọn số định danh của khách. Số đầy đủ chỉ nằm trong
 * `guest_registrations`, nơi khai báo lưu trú thật sự cần đến nó.
 */
export function maskId(idNumber: string): string {
  const s = String(idNumber ?? "");
  if (s.length <= 4) return "•".repeat(s.length);
  return "•".repeat(s.length - 4) + s.slice(-4);
}

/**
 * Hồ sơ quét được có khớp với người đứng tên đặt phòng không?
 *
 * So sánh sau khi bỏ dấu và gộp khoảng trắng, vì tên trong hệ thống đặt phòng
 * hay được gõ không dấu ("Nguyen Van A") trong khi thẻ luôn có dấu. Trả về mức
 * độ khớp chứ không trả về true/false: quyết định cuối là của lễ tân, người
 * đang cầm tấm thẻ và nhìn thấy mặt khách.
 */
export function nameMatch(cardName: string, bookingName: string): "exact" | "likely" | "different" {
  const norm = (s: string) =>
    String(s ?? "")
      .normalize("NFD")
      /* Viết bằng mã escape, không phải ký tự thật: dải dấu thanh tổ hợp là các
         ký tự vô hình, và một lần sao chép qua trình soạn thảo là chúng biến
         mất khỏi biểu thức mà không có gì báo lỗi. */
      .replace(/[̀-ͯ]/g, "")
      .replace(/đ/gi, "d")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  const a = norm(cardName);
  const b = norm(bookingName);
  if (!a || !b) return "different";
  if (a === b) return "exact";
  /* Đặt phòng qua OTA hay rút gọn tên đệm, và người Việt thường được ghi đảo
     thứ tự ở hệ thống nước ngoài — nên so theo TẬP từ, không theo thứ tự. */
  const wa = new Set(a.split(" "));
  const wb = new Set(b.split(" "));
  const chung = [...wa].filter((w) => wb.has(w)).length;
  const nho = Math.min(wa.size, wb.size);
  return chung >= Math.max(2, nho - 1) ? "likely" : "different";
}
