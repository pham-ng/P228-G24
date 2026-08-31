/**
 * Tạo mã đặt phòng riêng cho từng người thử: `npm run seed:testers`
 *
 * VÌ SAO CẦN. Một mã đặt phòng ứng với MỘT hội thoại
 * (`getConversationForReservation`). Nên khi mười người cùng bấm vào một khách
 * có sẵn để thử, cả mười đổ vào cùng một luồng. Hậu quả không chỉ là lộn xộn:
 *
 *   · họ đọc được tin nhắn của nhau — luồng tự cập nhật vài giây một lần;
 *   · model lấy lịch sử của người khác làm ngữ cảnh, rồi trả lời lệch;
 *   · task, cảm xúc, bảng điều hành trộn chung, không truy được ai hỏi gì —
 *     đúng thứ cần cho một báo cáo về khả năng dùng thật.
 *
 * VÌ SAO KHÔNG LÀM TÀI KHOẢN + MẬT KHẨU. Khách hiện không có phiên đăng nhập:
 * mã đặt phòng CHÍNH LÀ giấy thông hành, kiểm ở từng yêu cầu. Thêm mật khẩu là
 * thêm cột băm, tuyến đăng ký, tuyến đăng nhập, quản lý phiên, giao diện — và
 * một bề mặt tấn công mới trên một link công khai. Nó cũng sai với sản phẩm:
 * khách khách sạn không đăng ký tài khoản, họ cầm phiếu có mã in sẵn.
 *
 * Script này chỉ THÊM DỮ LIỆU. Không đổi schema, không đụng xác thực, không
 * chạm vào tám khách demo đang có.
 *
 *   npx tsx scripts/seed-nguoi-thu.ts          # tạo 20 người thử
 *   npx tsx scripts/seed-nguoi-thu.ts 40       # tạo 40
 *   npx tsx scripts/seed-nguoi-thu.ts --xoa    # xoá hết người thử
 */
import { storage, nowIso, hotelToday } from "../server/storage";

const PREFIX = "VPNT-TEST";
const args = process.argv.slice(2);
const XOA = args.includes("--xoa");
const SO_LUONG = Math.max(1, Math.min(200, Number(args.find((a) => /^\d+$/.test(a)) ?? 20)));

const ma = (i: number) => `${PREFIX}${String(i).padStart(2, "0")}`;

/* ---------------------------------------------------------------- xoá */

if (XOA) {
  const tatCa = storage.listReservations().filter((r) => r.confirmationCode.startsWith(PREFIX));
  console.log(`Xoá ${tatCa.length} lượt lưu trú của người thử…`);
  for (const r of tatCa) {
    /* Huỷ chứ không xoá hàng: hội thoại và tin nhắn trỏ tới đặt phòng này, và
       xoá cứng sẽ để lại bản ghi mồ côi mà mọi trang thống kê đều đọc phải. */
    storage.updateReservation(r.id, { status: "cancelled", cancelledAt: nowIso() });
  }
  console.log("Xong. Chúng biến mất khỏi danh sách 'in house', dữ liệu hội thoại giữ nguyên để còn đọc lại.");
  process.exit(0);
}

/* --------------------------------------------------------------- tạo */

const hotel = storage.getHotel();
const homNay = hotelToday();

/**
 * Phòng còn trống — mỗi người thử một phòng riêng.
 *
 * Không dùng chung phòng: `booking.ts` tính tồn phòng theo `room_id`, nên hai
 * lượt lưu trú chồng nhau trên một phòng sẽ làm mọi câu hỏi về phòng trống trả
 * lời sai — và đó lại chính là thứ người thử hay hỏi nhất.
 */
const dangDung = new Set(
  storage
    .listReservations()
    .filter((r) => r.status === "in_house" || r.status === "confirmed")
    .map((r) => r.roomId),
);
const phongTrong = storage.listRooms().filter((p) => !dangDung.has(p.id));

const daCo = new Set(
  storage
    .listReservations()
    .filter((r) => r.confirmationCode.startsWith(PREFIX))
    .map((r) => r.confirmationCode),
);

console.log(`Khách sạn: ${hotel.name} · hôm nay ${homNay}`);
console.log(`Phòng trống: ${phongTrong.length} · đã có sẵn ${daCo.size} người thử\n`);

let taoMoi = 0;
let het = false;

for (let i = 1; i <= SO_LUONG; i++) {
  const code = ma(i);
  if (daCo.has(code)) {
    console.log(`  · ${code} — đã có, bỏ qua`);
    continue;
  }
  const phong = phongTrong[taoMoi];
  if (!phong) {
    het = true;
    break;
  }

  const khach = storage.createGuest({
    name: `Người thử ${String(i).padStart(2, "0")}`,
    /* Số và email là chỗ giữ chỗ có thể nhận ra ngay là dữ liệu thử, không
       phải số của người thật bị lẫn vào. */
    phone: `+8490000${String(i).padStart(4, "0")}`,
    email: `nguoithu${String(i).padStart(2, "0")}@vinaurea.test`,
    lang: "vi",
    vipTier: "none",
    preferences: "",
    notes: "Tài khoản dùng thử — tạo bởi scripts/seed-nguoi-thu.ts",
    staysCount: 0,
    loyaltyPoints: 0,
  });

  storage.createReservation({
    hotelId: hotel.id,
    guestId: khach.id,
    roomId: phong.id,
    confirmationCode: code,
    checkIn: homNay,
    /* Ở tới ngày kia: người thử hỏi "mấy giờ trả phòng" thì câu trả lời phải có
       nghĩa, và một lượt lưu trú kết thúc hôm nay sẽ rơi khỏi danh sách
       'in house' ngay giữa buổi thử. */
    checkOut: new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10),
    checkOutTime: hotel.checkOutTime ?? "12:00",
    adults: 1,
    children: 0,
    ratePerNight: 3_580_000,
    status: "in_house",
    source: "direct",
  });

  taoMoi++;
  console.log(`  ✓ ${code}  ${khach.name}  phòng ${phong.number}`);
}

console.log(`\nTạo mới ${taoMoi} người thử.`);
if (het)
  console.log(
    `Hết phòng trống — chỉ tạo được ${taoMoi}. Muốn thêm thì trả phòng bớt, hoặc thêm phòng vào bảng rooms.`,
  );
console.log(`\nNgười thử vào bằng mã ${ma(1)} … ${ma(taoMoi)}, hoặc bấm thẳng tên trên trang chủ.`);
console.log("Xoá hết: npx tsx scripts/seed-nguoi-thu.ts --xoa");
