/**
 * Nhận phòng bằng cách quét thẻ CCCD — cả đường, trên server thật.
 *
 * Bài kiểm thử thuần đã chứng minh bộ đọc QR đúng. Nó KHÔNG chứng minh được
 * phần nối: quét có tìm ra đúng đặt phòng không, nhận phòng có chuyển trạng
 * thái không, phiếu khai báo lưu trú có được ghi không, phòng có được đánh dấu
 * có người không, và vai không đủ quyền có bị chặn không. Mỗi thứ đó là một mối
 * nối giữa các mô-đun mà một bài kiểm thử thuần không nhìn thấy.
 *
 * Quan trọng nhất: kiểm rằng quét thẻ **KHÔNG** mở phiên nào. Số căn cước in
 * trên thẻ và bị photocopy khắp nơi; nếu nó mở được phiên thì một tấm ảnh chụp
 * thẻ mở được hoá đơn của khách.
 *
 * Trả lại nguyên trạng mọi thứ nó đụng vào.
 *
 *   npx tsx bench/checkin-probe.ts
 */
import { storage, db } from "../server/storage";
import { guestRegistrations, auditEvents } from "@shared/schema";
import { inArray } from "drizzle-orm";

const BASE = process.env.PROBE_BASE || "http://localhost:5000";
const TOKEN = process.env.STAFF_API_TOKEN || "";
let failures = 0;
const ok = (c: boolean, m: string) => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${m}`);
  if (!c) failures++;
};

const post = (p: string, body: unknown, tok = TOKEN) =>
  fetch(`${BASE}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(tok ? { "x-staff-token": tok } : {}) },
    body: JSON.stringify(body),
  }).then(async (r) => ({ s: r.status, j: (await r.json().catch(() => ({}))) as any }));

const login = async (name: string) => (await post("/api/staff/login", { name, pin: "1234" }, "")).j.staffApiToken as string;

/** Dựng nội dung QR đúng bảy trường, từ một cái tên có sẵn trong hệ thống. */
const qrFor = (name: string, id = "001099012345") =>
  `${id}|123456789|${name}|01011990|Nam|Số 1, Phường Bến Nghé, Quận 1, TP.HCM|01012021`;

const beforeReg = new Set(storage.listRegistrations(500).map((r) => r.id));
const beforeEv = new Set(storage.listEvents(500).map((e) => e.id));

async function main() {
  if (!TOKEN) {
    console.log("Cần STAFF_API_TOKEN trong môi trường. `export STAFF_API_TOKEN=$(grep STAFF_API_TOKEN .env | cut -d= -f2)`");
    process.exit(2);
  }

  /* Chọn theo tính chất, không theo id: probe phải còn nghĩa sau khi dựng lại
     dữ liệu mẫu. Cần một đặt phòng CHƯA nhận phòng để có cái mà nhận. */
  const target = storage.listReservations().find((r) => r.status === "confirmed");
  if (!target) {
    console.log("SKIP  không có đặt phòng nào ở trạng thái `confirmed` để thử nhận phòng");
    process.exit(0);
  }
  const guest = storage.getGuest(target.guestId)!;
  const roomTruoc = storage.getRoom(target.roomId);
  console.log(`đặt phòng #${target.id} · ${guest.name} · ${target.confirmationCode} · phòng ${roomTruoc?.number ?? "(chưa gắn)"}\n`);

  console.log("=== QUÉT: TỪ CHỐI THỨ KHÔNG PHẢI THẺ ===");
  const rac = await post("/api/checkin/scan", { qr: target.confirmationCode });
  ok(rac.s === 422, `quét nhầm mã đặt phòng bị từ chối (nhận ${rac.s})`);
  ok(typeof rac.j.message === "string" && rac.j.message.length > 0, "và nói rõ lý do để lễ tân biết nhập tay");

  console.log("=== QUÉT: TÌM ĐÚNG ĐẶT PHÒNG ===");
  const scan = await post("/api/checkin/scan", { qr: qrFor(guest.name) });
  ok(scan.s === 200, `thẻ hợp lệ đọc được (nhận ${scan.s})`);
  const m = (scan.j.matches ?? []).find((x: any) => x.reservationId === target.id);
  ok(!!m, "đặt phòng của khách này có trong danh sách khớp");
  ok(m?.confirmationCode === target.confirmationCode, "kèm mã đặt phòng để lễ tân đọc cho khách");
  ok(m?.nameMatch === "exact" || m?.nameMatch === "likely", `và nói mức khớp tên (${m?.nameMatch})`);
  /* Điểm mấu chốt của cả probe này. */
  ok(!("sessionToken" in scan.j) && !("token" in scan.j), "QUÉT KHÔNG CẤP PHIÊN — thẻ căn cước không phải chìa khoá");

  console.log("=== QUÉT: TÊN KHÔNG AI CÓ ===");
  const la = await post("/api/checkin/scan", { qr: qrFor("Hoàng Xuân Bất Kỳ Ai") });
  ok(la.s === 200 && (la.j.matches ?? []).length === 0, "tên lạ không khớp đặt phòng nào");

  console.log("=== NHẬN PHÒNG ===");
  const ci = await post(`/api/reservations/${target.id}/check-in`, {
    fullName: guest.name,
    idType: "national_id",
    idNumber: "001099012345",
    nationality: "Việt Nam",
    dob: "1990-01-01",
    gender: "Nam",
    permanentAddress: "Số 1, Phường Bến Nghé, Quận 1, TP.HCM",
  });
  ok(ci.s === 200, `nhận phòng thành công (nhận ${ci.s})`);
  ok(ci.j.confirmationCode === target.confirmationCode, "trả lại mã đặt phòng để đưa khách");

  const sau = storage.getReservation(target.id)!;
  ok(sau.status === "in_house", `đặt phòng chuyển sang in_house (là ${sau.status})`);
  ok(!!sau.checkInTime, "ghi lại giờ nhận phòng thật");
  const phong = storage.getRoom(sau.roomId)!;
  ok(phong.status === "occupied", `phòng ${phong.number} được đánh dấu có người (là ${phong.status})`);

  const reg = storage.listRegistrations(500).find((r) => !beforeReg.has(r.id));
  ok(!!reg, "phiếu khai báo lưu trú được ghi");
  ok(reg?.reservationId === target.id, "gắn đúng đặt phòng");
  ok(reg?.isForeigner === 0, "khách Việt Nam không bị xếp là người nước ngoài");
  ok(reg?.idNumber === "001099012345", "giữ số căn cước ĐẦY ĐỦ trong phiếu — khai báo lưu trú cần nó");

  /* Số đầy đủ nằm trong phiếu, nhưng KHÔNG được nằm trong nhật ký. */
  const ev = storage.listEvents(500).filter((e) => !beforeEv.has(e.id));
  const co = ev.some((e) => (e.summary ?? "").includes("001099012345"));
  ok(!co, "nhật ký KHÔNG chứa số căn cước đầy đủ, chỉ 4 số cuối");
  ok(ev.some((e) => e.type === "reservation.checked_in"), "có dòng nhật ký nhận phòng");

  console.log("=== KHÔNG NHẬN PHÒNG HAI LẦN ===");
  const lai = await post(`/api/reservations/${target.id}/check-in`, {
    fullName: guest.name, idType: "national_id", idNumber: "001099012345", nationality: "Việt Nam",
  });
  ok(lai.s === 409, `nhận phòng lần hai bị chặn (nhận ${lai.s})`);
  ok(storage.listRegistrations(500).filter((r) => !beforeReg.has(r.id)).length === 1, "và không sinh phiếu khai báo thứ hai");

  console.log("=== PHÂN QUYỀN ===");
  const anon = await post("/api/checkin/scan", { qr: qrFor(guest.name) }, "");
  ok(anon.s === 401, `người lạ không quét được (nhận ${anon.s})`);
  const bp = storage.listStaff().find((s) => s.dept === "housekeeping");
  if (!bp) console.log("  SKIP  không có nhân viên buồng phòng trong cơ sở dữ liệu này");
  else {
    const tok = await login(bp.name);
    const r = await post("/api/checkin/scan", { qr: qrFor(guest.name) }, tok);
    ok(r.s === 403, `buồng phòng không quét được giấy tờ khách (nhận ${r.s})`);
  }

  /* --- dọn dẹp: trả lại đúng nguyên trạng --- */
  const regIds = storage.listRegistrations(500).filter((r) => !beforeReg.has(r.id)).map((r) => r.id);
  const evIds = storage.listEvents(500).filter((e) => !beforeEv.has(e.id)).map((e) => e.id);
  if (regIds.length) db.delete(guestRegistrations).where(inArray(guestRegistrations.id, regIds)).run();
  if (evIds.length) db.delete(auditEvents).where(inArray(auditEvents.id, evIds)).run();
  storage.updateReservation(target.id, {
    status: target.status,
    roomId: target.roomId,
    checkInTime: target.checkInTime,
  });
  if (roomTruoc) storage.updateRoom(roomTruoc.id, { status: roomTruoc.status });
  storage.updateGuest(guest.id, { idType: guest.idType, idNumber: guest.idNumber, nationality: guest.nationality, dob: guest.dob });

  console.log(`\nđã dọn ${regIds.length} phiếu, ${evIds.length} dòng nhật ký; đặt phòng #${target.id} và phòng về nguyên trạng`);
  const conSot = storage.listRegistrations(500).filter((r) => !beforeReg.has(r.id)).length;
  ok(conSot === 0, "probe không để lại phiếu nào");
  ok(storage.getReservation(target.id)!.status === target.status, "trạng thái đặt phòng đã khôi phục");

  console.log(failures === 0 ? "\nALL CHECK-IN CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
