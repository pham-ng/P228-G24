/**
 * Lõi nhận phòng — dùng chung cho quầy lễ tân và kiosk tự phục vụ.
 *
 * Tách ra vì có HAI đường dẫn tới cùng một việc, và chúng phải làm y hệt nhau:
 * ghi phiếu khai báo lưu trú, chuyển đặt phòng sang `in_house`, gắn phòng, đánh
 * dấu phòng có người. Hai bản sao của bốn bước đó sẽ trôi khỏi nhau ở lần sửa
 * thứ ba, và cái trôi mất thường là phiếu khai báo — thứ duy nhất có nghĩa vụ
 * pháp lý.
 */
import { storage, nowIso, hotelToday } from "./storage";
import { hotelIso, missingLodgingFields } from "./ops";
import { nameMatch, maskId, type CccdScan } from "./cccd";
import type { Reservation } from "@shared/schema";

export type CheckinMatch = {
  reservationId: number;
  confirmationCode: string;
  guestName: string;
  roomNumber: string | null;
  checkIn: string;
  checkOut: string;
  status: string;
  nameMatch: "exact" | "likely";
  daKhaiBao: boolean;
};

/**
 * Những đặt phòng có thể là của người trên thẻ.
 *
 * Chỉ xét đặt phòng ĐẾN HÔM NAY hoặc ĐANG Ở. Không có giới hạn đó thì một cái
 * tên trùng ở lượt lưu trú năm ngoái cũng hiện ra, và ở kiosk thì không có ai
 * đứng cạnh để loại nó đi.
 */
export function findCheckinMatches(card: Pick<CccdScan, "fullName">): CheckinMatch[] {
  const t = hotelToday();
  const daKhaiBao = new Set(storage.listRegistrations(500).map((x) => x.reservationId));
  return storage
    .listReservations()
    .filter((r) => (r.status === "confirmed" && r.checkIn <= t) || r.status === "in_house")
    .map((r) => {
      const g = storage.getGuest(r.guestId);
      return { r, g, muc: g ? nameMatch(card.fullName, g.name) : ("different" as const) };
    })
    .filter((x) => x.muc !== "different")
    /* Trùng khít lên trước: ở quầy thì lễ tân đang có khách đứng đợi, ở kiosk
       thì dòng đầu là dòng được chọn tự động. */
    .sort((a, b) => (a.muc === "exact" ? 0 : 1) - (b.muc === "exact" ? 0 : 1))
    .map(({ r, g, muc }) => ({
      reservationId: r.id,
      confirmationCode: r.confirmationCode,
      guestName: g?.name ?? "",
      roomNumber: storage.getRoom(r.roomId)?.number ?? null,
      checkIn: r.checkIn,
      checkOut: r.checkOut,
      status: r.status,
      nameMatch: muc as "exact" | "likely",
      daKhaiBao: daKhaiBao.has(r.id),
    }));
}

export type CheckinFields = {
  fullName: string;
  idType: "passport" | "national_id" | "other";
  idNumber: string;
  nationality: string;
  dob?: string;
  gender?: string;
  permanentAddress?: string;
  visaNumber?: string;
  entryDate?: string;
  entryPort?: string;
  roomId?: number;
};

export type CheckinResult =
  | { ok: false; status: number; message: string; confirmationCode?: string }
  | {
      ok: true;
      reservation: Reservation;
      registrationId: number;
      room: { id: number; number: string };
      confirmationCode: string;
      lodgingMissing: string[];
    };

/** Thực hiện nhận phòng. `actor` chỉ dùng cho nhật ký. */
export function performCheckIn(resv: Reservation, f: CheckinFields, actor: string): CheckinResult {
  if (resv.status === "cancelled") return { ok: false, status: 409, message: "Đặt phòng đã huỷ, không nhận phòng được." };
  if (resv.status === "checked_out") return { ok: false, status: 409, message: "Lượt lưu trú này đã trả phòng." };
  /* Nhận phòng hai lần tạo ra hai phiếu khai báo cho cùng một người. Trả kèm mã
     đặt phòng: ở kiosk, "đã nhận phòng rồi" không phải lỗi mà là lối vào. */
  if (resv.status === "in_house")
    return { ok: false, status: 409, message: "Khách đã nhận phòng rồi.", confirmationCode: resv.confirmationCode };

  const hotel = storage.getHotel();
  const roomId = f.roomId ?? resv.roomId;
  if (!roomId) return { ok: false, status: 400, message: "Chưa gắn phòng cho đặt phòng này." };
  const room = storage.getRoom(roomId);
  if (!room) return { ok: false, status: 404, message: "Không có phòng này." };
  if (room.status === "out_of_order")
    return { ok: false, status: 409, message: `Phòng ${room.number} đang ngưng sử dụng.` };

  /* Cách viết quốc tịch trên hộ chiếu rất nhiều kiểu. Khớp giống hệt
     `declare_lodging` để một khách không bị tool xếp là người nước ngoài còn
     quầy xếp là người trong nước. */
  const isForeigner = !/vi[eệ]t\s*nam|vietnam|^vn$/i.test(f.nationality.trim());
  const draft = {
    hotelId: hotel.id,
    reservationId: resv.id,
    guestId: resv.guestId,
    fullName: f.fullName,
    idType: f.idType,
    idNumber: f.idNumber,
    nationality: f.nationality,
    dob: f.dob ?? null,
    gender: f.gender ?? null,
    visaNumber: f.visaNumber ?? null,
    entryDate: f.entryDate ?? null,
    entryPort: f.entryPort ?? null,
    permanentAddress: f.permanentAddress ?? null,
    /* Giờ đến THẬT, không phải giờ nhận phòng theo chính sách: phiếu khai báo
       lưu trú hỏi khách có mặt lúc nào. */
    arrivalAt: nowIso(),
    departureAt: hotelIso(resv.checkOut, resv.checkOutTime),
    isForeigner: isForeigner ? 1 : 0,
  };
  const missing = missingLodgingFields(draft);

  const reg = storage.createRegistration({
    ...draft,
    status: missing.length ? "collected" : "queued",
    channel: null,
    submittedAt: null,
    submittedBy: null,
    receiptRef: null,
    taskId: null,
    note: missing.length ? `Thiếu: ${missing.join(", ")}` : null,
    createdAt: nowIso(),
  });

  const updated = storage.updateReservation(resv.id, { status: "in_house", roomId, checkInTime: nowIso() });
  storage.updateRoom(roomId, { status: "occupied" });
  storage.updateGuest(resv.guestId, {
    idType: f.idType,
    idNumber: f.idNumber,
    nationality: f.nationality,
    ...(f.dob ? { dob: f.dob } : {}),
  });

  storage.logEvent({
    type: "reservation.checked_in",
    actor,
    /* Số căn cước đầy đủ nằm trong phiếu khai báo, KHÔNG nằm trong nhật ký. */
    summary: `${f.fullName} nhận phòng ${room.number} (${resv.confirmationCode}), giấy tờ ${maskId(f.idNumber)}.`,
    payload: null,
    conversationId: null,
    createdAt: nowIso(),
  });

  return {
    ok: true,
    reservation: updated,
    registrationId: reg.id,
    room: { id: room.id, number: room.number },
    confirmationCode: resv.confirmationCode,
    lodgingMissing: missing,
  };
}
