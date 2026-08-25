/**
 * captest.ts — Kiểm tra tính toàn vẹn dữ liệu sức chứa phòng (room capacity).
 *
 * Xác minh rằng:
 *  1. Không còn bản ghi room_type nào có max_guests NULL sau migration.
 *  2. Mọi đặt phòng đang có đều thoả max_guests của loại phòng tương ứng
 *     (adults + children <= max_guests).
 *  3. Mọi loại phòng đều có combinations không rỗng.
 *
 * Chạy: node captest.ts
 * Không dùng Jest. Tuân theo khuôn mẫu test của repo (mục 4.1 tài liệu chuyển giao).
 */

import Database from "better-sqlite3";
import { join } from "node:path";

const DB_PATH = process.env.DB_FILE
  ? join(process.cwd(), process.env.DB_FILE)
  : join(process.cwd(), "data.db");

const db = new Database(DB_PATH, { readonly: true });

let failed = 0;
const pass = (ok: boolean, msg: string) => {
  if (!ok) failed++;
  console.log((ok ? "  PASS  " : "  FAIL  ") + msg);
};

// ---------------------------------------------------------------------------
// Load dữ liệu
// ---------------------------------------------------------------------------
const roomTypes = db
  .prepare("SELECT id, code, max_guests, combinations FROM room_types")
  .all() as Array<{ id: number; code: string; max_guests: number | null; combinations: string }>;

const reservations = db
  .prepare(
    `SELECT r.confirmation_code, r.adults, r.children, r.room_id, rm.type AS room_type
     FROM reservations r
     LEFT JOIN rooms rm ON rm.id = r.room_id
     WHERE r.status != 'cancelled'`
  )
  .all() as Array<{
  confirmation_code: string;
  adults: number;
  children: number;
  room_id: number | null;
  room_type: string | null;
}>;

// Lookup: room_type code → max_guests
const maxGuestByCode = new Map<string, number>();
for (const rt of roomTypes) {
  if (rt.max_guests != null) maxGuestByCode.set(rt.code, rt.max_guests);
}

// ---------------------------------------------------------------------------
// 1. Không còn room_type nào có max_guests NULL
// ---------------------------------------------------------------------------
console.log("\n── Nhóm 1: max_guests không được NULL ──");

const nullRows = roomTypes.filter((rt) => rt.max_guests == null);
pass(
  nullRows.length === 0,
  `tất cả ${roomTypes.length} room_type đều có max_guests khác NULL (null còn lại: ${nullRows.length})`
);

if (nullRows.length > 0) {
  for (const rt of nullRows) {
    console.log(`         → NULL tại: "${rt.code}"`);
  }
}

// ---------------------------------------------------------------------------
// 2. Mọi đặt phòng đang có (không phải cancelled) thoả max_guests loại phòng
// ---------------------------------------------------------------------------
console.log("\n── Nhóm 2: đặt phòng hiện tại thoả giới hạn sức chứa ──");

for (const res of reservations) {
  const total = res.adults + res.children;

  if (res.room_type == null) {
    console.log(
      `  NOTE  ${res.confirmation_code}: room chưa được gán phòng, bỏ qua kiểm sức chứa.`
    );
    continue;
  }

  const maxG = maxGuestByCode.get(res.room_type);

  if (maxG == null) {
    // Đây là lỗi dữ liệu phòng riêng (rooms.type không khớp với room_types.code).
    // Không phải lỗi capacity — ghi NOTE để không che khuất vấn đề thực tế.
    console.log(
      `  NOTE  ${res.confirmation_code}: rooms.type="${res.room_type}" không có trong room_types — cần sửa dữ liệu phòng riêng.`
    );
    continue;
  }

  pass(
    total <= maxG,
    `${res.confirmation_code} — ${res.adults}A+${res.children}C=${total} người ≤ max_guests=${maxG} của "${res.room_type}"`
  );
}

// ---------------------------------------------------------------------------
// 3. Mọi loại phòng đều có combinations không rỗng
// ---------------------------------------------------------------------------
console.log("\n── Nhóm 3: combinations không rỗng ──");

for (const rt of roomTypes) {
  let parsed: unknown[] = [];
  try {
    parsed = JSON.parse(rt.combinations ?? "[]");
  } catch {
    parsed = [];
  }
  pass(
    Array.isArray(parsed) && parsed.length > 0,
    `"${rt.code}" có ${parsed.length} combination(s) được công bố`
  );
}

// ---------------------------------------------------------------------------
// Kết quả
// ---------------------------------------------------------------------------
db.close();
console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
