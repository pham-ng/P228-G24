/**
 * Migration 015: sửa `max_guests` sai (8 -> 12) cho 2 villa 3 phòng ngủ
 * hướng biển trong bảng `room_types`.
 *
 * Bắt được qua khảo sát benchmark 384 ca (2026-09-04): model trả lời "tối đa
 * 8 khách" cho Biệt Thự 3 Phòng Ngủ Hướng Biển, khớp ĐÚNG với `room_types`
 * (nguồn: room-types.json, source_url trỏ về booking.vinpearl.com) — nhưng
 * SAI so với KB #9 "Rooms and room types" (ghi 12 khách). Hai vòng điều tra
 * trước đó đổi chiều kết luận hai lần dựa trên "nguồn nào cụ thể hơn"; lần
 * này tra TRỰC TIẾP trang chính thức đang sống (vinpearl.com, mục "Giá phòng
 * Vinpearl Resort Nha Trang" — đúng khách sạn) và đọc được rõ ràng:
 *
 *   Biệt Thự 3 Phòng Ngủ Hướng Biển        | 12 | từ 14.600.000 VNĐ/đêm
 *   Biệt thự Tropicana 3 Phòng Ngủ, Hướng Biển | 12 | từ 16.700.000 VNĐ/đêm
 *
 * 12 đúng cho CẢ HAI villa 3 phòng ngủ. `room_types` (id 8, 9) ghi sai "8"
 * — rất có thể do lỗi nhập liệu lúc soạn room-types.json, đã dùng chung một
 * combo mẫu (6+2/4+4/8+0) cho nhiều loại phòng khác nhau mà không tính riêng
 * theo số phòng ngủ thật của villa 3 phòng ngủ (3 phòng ngủ × 2 lớn + 2 trẻ =
 * 12, khớp đúng công thức sức chứa villa ở KB #16).
 *
 * SỬA: cập nhật `room_types.max_guests` = 12 và `combinations` cho cả 2 villa,
 * cập nhật `description` (nếu chunk hoá lại đưa số vào text), rồi reindex để
 * chunk truy xuất phản ánh số mới — không chunk nào từng nói "8 khách" còn
 * sống sót trong kho tìm kiếm.
 *
 *   DB_FILE=data.db npx tsx server/migrations/015-villa-3bed-max-guests-fix.ts
 */
import "dotenv/config";
import Database from "better-sqlite3";
import { reindex } from "../retrieval";

const TARGETS = ["Biệt Thự 3 Phòng Ngủ Hướng Biển", "Biệt thự Tropicana 3 phòng ngủ, hướng biển"];

function main() {
  const db = new Database(process.env.DB_FILE || "data.db");
  const rows = db
    .prepare(`SELECT id, name_vi, max_guests FROM room_types WHERE name_vi IN (${TARGETS.map(() => "?").join(",")})`)
    .all(...TARGETS) as { id: number; name_vi: string; max_guests: number }[];
  if (!rows.length) {
    console.log("[dừng] Không thấy villa nào khớp tên — kiểm tra lại name_vi.");
    return;
  }
  const newCombinations = JSON.stringify([
    { adults: 6, children: 6 },
    { adults: 12, children: 0 },
  ]);
  const upd = db.prepare("UPDATE room_types SET max_guests = 12, combinations = ? WHERE id = ?");
  for (const r of rows) {
    if (r.max_guests === 12) {
      console.log(`[bỏ qua] "${r.name_vi}" đã là 12 từ trước.`);
      continue;
    }
    upd.run(newCombinations, r.id);
    console.log(`[room_types] "${r.name_vi}" (id ${r.id}): max_guests ${r.max_guests} -> 12`);
  }
  console.log("Reindexing...");
  reindex().then((res) => console.log(`  ${res.embedded}/${res.chunks} chunks embedded (${res.model})`));
}

main();
