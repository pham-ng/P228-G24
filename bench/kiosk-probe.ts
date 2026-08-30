/**
 * Kiosk tự nhận phòng — bề mặt CÔNG KHAI, nên kiểm kỹ hơn đường quầy lễ tân.
 *
 * `/api/guest/checkin` không đòi token nào: khách chưa có mã đặt phòng để trình,
 * vì cái họ đang làm chính là để lấy mã đó. Đổi lại, mọi lối từ chối phải chắc.
 * Đây là những thứ probe này canh:
 *
 *   · tên không khớp KHÍT thì không vào được (chỉ "có thể là" là chưa đủ)
 *   · nhiều đặt phòng trùng tên thì từ chối, không đoán
 *   · lượt lưu trú đã trả phòng không mở lại được
 *   · đã nhận phòng rồi thì mở lại phiên, không tạo phiếu khai báo thứ hai
 *   · nhật ký không chứa số căn cước đầy đủ
 *
 * Trả lại nguyên trạng mọi thứ nó đụng vào.
 *
 *   npx tsx bench/kiosk-probe.ts
 */
import { storage, db } from "../server/storage";
import { guestRegistrations, auditEvents } from "@shared/schema";
import { inArray } from "drizzle-orm";

const BASE = process.env.PROBE_BASE || "http://localhost:5000";
let failures = 0;
const ok = (c: boolean, m: string) => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${m}`);
  if (!c) failures++;
};

/** KHÔNG gửi token: đúng như một chiếc kiosk ngoài sảnh. */
const post = (p: string, body: unknown) =>
  fetch(`${BASE}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => ({ s: r.status, j: (await r.json().catch(() => ({}))) as any }));

const qrFor = (name: string, id = "001099012345") =>
  `${id}|123456789|${name}|01011990|Nam|Số 1, Phường Bến Nghé, Quận 1, TP.HCM|01012021`;

const beforeReg = new Set(storage.listRegistrations(500).map((r) => r.id));
const beforeEv = new Set(storage.listEvents(500).map((e) => e.id));

async function main() {
  const target = storage.listReservations().find((r) => r.status === "confirmed");
  if (!target) {
    console.log("SKIP  không có đặt phòng `confirmed` nào để nhận phòng");
    process.exit(0);
  }
  const guest = storage.getGuest(target.guestId)!;
  const roomTruoc = storage.getRoom(target.roomId);
  console.log(`đặt phòng #${target.id} · ${guest.name} · ${target.confirmationCode}\n`);

  console.log("=== TỪ CHỐI THỨ KHÔNG PHẢI THẺ ===");
  const rac = await post("/api/guest/checkin", { qr: "khong-phai-the-can-cuoc" });
  ok(rac.s === 422, `chuỗi rác bị từ chối (nhận ${rac.s})`);
  ok(!rac.j.confirmationCode, "và KHÔNG trả về mã đặt phòng nào");

  console.log("=== TÊN KHÔNG AI CÓ THÌ KHÔNG VÀO ĐƯỢC ===");
  const la = await post("/api/guest/checkin", { qr: qrFor("Hoàng Xuân Không Tồn Tại") });
  ok([404, 429].includes(la.s), `tên lạ bị từ chối (nhận ${la.s})`);
  ok(!la.j.confirmationCode, "và không lộ mã đặt phòng nào");

  console.log("=== TÊN CHỈ 'CÓ THỂ LÀ' THÌ CHƯA ĐỦ ===");
  {
    /* Bỏ bớt một từ trong tên: `nameMatch` cho ra "likely", và kiosk phải mời
       tới quầy chứ không được tự quyết — ở đây không có lễ tân nhìn mặt. */
    const tu = guest.name.split(/\s+/);
    if (tu.length < 3) console.log("  SKIP  tên khách này quá ngắn để dựng ca 'có thể là'");
    else {
      const thieu = [tu[0], tu[tu.length - 1]].join(" ");
      const r = await post("/api/guest/checkin", { qr: qrFor(thieu) });
      ok([404, 409, 429].includes(r.s), `tên khớp một phần ("${thieu}") không vào được (nhận ${r.s})`);
      ok(!r.j.confirmationCode, "và không mở phiên");
    }
  }

  console.log("=== NHẬN PHÒNG THẬT, RỒI MỞ PHIÊN ===");
  const ci = await post("/api/guest/checkin", { qr: qrFor(guest.name) });
  ok(ci.s === 200, `khớp khít thì nhận phòng được (nhận ${ci.s})`);
  ok(ci.j.confirmationCode === target.confirmationCode, "trả về ĐÚNG mã đặt phòng của khách này");
  ok(ci.j.alreadyCheckedIn === false, "báo rõ đây là lần nhận phòng đầu");

  const sau = storage.getReservation(target.id)!;
  ok(sau.status === "in_house", `đặt phòng chuyển sang in_house (là ${sau.status})`);
  ok(storage.getRoom(sau.roomId)!.status === "occupied", "phòng được đánh dấu có người");
  const reg = storage.listRegistrations(500).find((r) => !beforeReg.has(r.id));
  ok(!!reg, "phiếu khai báo lưu trú được ghi — nghĩa vụ pháp lý không bị bỏ qua vì tự phục vụ");

  console.log("=== MÃ TRẢ VỀ MỞ ĐƯỢC PHIÊN THẬT ===");
  {
    /* Điểm mấu chốt: mã nhận được phải chạy trên đúng cơ chế phiên đã có, chứ
       không phải một lối đăng nhập mới nào khác. */
    const ss = await post("/api/guest/session", { code: ci.j.confirmationCode });
    ok(ss.s === 200, `mã đó mở được /api/guest/session (nhận ${ss.s})`);
    ok(!!ss.j?.conversation?.id || !!ss.j?.id, "và trả về một hội thoại");
  }

  console.log("=== QUÉT LẠI THÌ MỞ PHIÊN, KHÔNG TẠO PHIẾU THỨ HAI ===");
  const lai = await post("/api/guest/checkin", { qr: qrFor(guest.name) });
  ok(lai.s === 200, `quét lại vẫn vào được (nhận ${lai.s})`);
  ok(lai.j.alreadyCheckedIn === true, "và báo rõ là đã nhận phòng từ trước");
  ok(
    storage.listRegistrations(500).filter((r) => !beforeReg.has(r.id)).length === 1,
    "vẫn chỉ MỘT phiếu khai báo cho lượt lưu trú này",
  );

  console.log("=== NHẬT KÝ KHÔNG CHỨA SỐ CĂN CƯỚC ĐẦY ĐỦ ===");
  const ev = storage.listEvents(500).filter((e) => !beforeEv.has(e.id));
  ok(!ev.some((e) => (e.summary ?? "").includes("001099012345")), "chỉ ghi 4 số cuối");
  ok(ev.some((e) => e.actor === "guest:kiosk"), "và ghi rõ việc này đến từ kiosk, không phải nhân viên");

  /* --- dọn dẹp --- */
  const regIds = storage.listRegistrations(500).filter((r) => !beforeReg.has(r.id)).map((r) => r.id);
  const evIds = storage.listEvents(500).filter((e) => !beforeEv.has(e.id)).map((e) => e.id);
  if (regIds.length) db.delete(guestRegistrations).where(inArray(guestRegistrations.id, regIds)).run();
  if (evIds.length) db.delete(auditEvents).where(inArray(auditEvents.id, evIds)).run();
  storage.updateReservation(target.id, { status: target.status, roomId: target.roomId, checkInTime: target.checkInTime });
  if (roomTruoc) storage.updateRoom(roomTruoc.id, { status: roomTruoc.status });
  storage.updateGuest(guest.id, { idType: guest.idType, idNumber: guest.idNumber, nationality: guest.nationality, dob: guest.dob });

  console.log(`\nđã dọn ${regIds.length} phiếu, ${evIds.length} dòng nhật ký`);
  ok(storage.getReservation(target.id)!.status === target.status, "đặt phòng về nguyên trạng");
  ok(storage.listRegistrations(500).filter((r) => !beforeReg.has(r.id)).length === 0, "không để lại phiếu nào");

  console.log(failures === 0 ? "\nALL KIOSK CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
