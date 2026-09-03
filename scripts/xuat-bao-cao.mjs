/**
 * Xuất dữ liệu vận hành ra tệp VĂN BẢN để sao lưu và báo cáo.
 *
 *   node scripts/xuat-bao-cao.mjs [thu-muc-dich]     # mặc định: bao-cao/
 *
 * VÌ SAO KHÔNG CHỈ CHÉP data.db. Sao lưu định kỳ một tệp SQLite lên git là cách
 * chắc chắn làm phình kho: mỗi lần chạy sinh một blob nhị phân mới ~1,6 MB mà
 * git không delta được. Ba mươi phút một lần là ~7 GB mỗi năm.
 *
 * CSV/JSON thì ngược lại — chúng diff theo dòng, nên hai lần chạy cách nhau nửa
 * giờ chỉ tốn đúng phần thay đổi. Và đây mới là thứ đọc được: mở thẳng bằng
 * Excel, đưa vào Power BI, gửi cho doanh nghiệp. `data.db` vẫn được chụp, nhưng
 * thưa hơn (xem sao-luu.sh).
 */
import Database from "better-sqlite3";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DICH = process.argv[2] ?? "bao-cao";
mkdirSync(DICH, { recursive: true });

const db = new Database("data.db", { readonly: true });

/** Bọc mọi truy vấn: một bảng thiếu không được làm hỏng cả bản sao lưu. */
const hoi = (sql, ...p) => {
  try {
    return db.prepare(sql).all(...p);
  } catch (e) {
    console.error(`  ! bỏ qua (${e.message.slice(0, 60)})`);
    return [];
  }
};

/* CSV thủ công thay vì thêm phụ thuộc: chỉ cần đúng RFC 4180 ở ba chỗ —
   dấu nháy kép, dấu phẩy, xuống dòng. */
const o = (v) => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
const csv = (ten, hang) => {
  const cot = hang.length ? Object.keys(hang[0]) : [];
  const noiDung = [cot.join(","), ...hang.map((h) => cot.map((c) => o(h[c])).join(","))].join("\n");
  writeFileSync(join(DICH, ten), noiDung + "\n");
  console.log(`  ✓ ${ten.padEnd(22)} ${String(hang.length).padStart(6)} dòng`);
};

/* ------------------------------------------------------- hội thoại + tin nhắn */

csv(
  "hoi-thoai.csv",
  hoi(`
    select c.id, c.reservation_id, r.confirmation_code ma_dat_phong, g.name khach,
           g.lang ngon_ngu, c.channel kenh, c.mode che_do,
           c.topic chu_de, c.sentiment cam_xuc, c.first_response_seconds giay_phan_hoi_dau,
           count(m.id) so_tin_nhan,
           sum(case when m.role='guest' then 1 else 0 end) tin_khach,
           min(m.created_at) bat_dau, max(m.created_at) ket_thuc
    from conversations c
    left join reservations r on r.id = c.reservation_id
    left join guests g       on g.id = coalesce(c.guest_id, r.guest_id)
    left join messages m     on m.conversation_id = c.id
    group by c.id order by c.id`),
);

csv(
  "tin-nhan.csv",
  hoi(`
    select m.id, m.conversation_id, m.role vai_tro, m.created_at thoi_diem,
           m.latency_ms do_tre_ms, length(m.body) do_dai, m.body noi_dung
    from messages m order by m.id`),
);

/* --------------------------------------------------------------------- trace */

csv(
  "trace-spans.csv",
  hoi(`
    select trace_id, conversation_id, name, kind loai, status trang_thai,
           provider nha_cung_cap, model, duration_ms, started_at, error loi
    from trace_spans order by started_at`),
);

csv("loi.csv", hoi(`select trace_id, conversation_id, name, kind loai, error loi, started_at
                    from trace_spans where status != 'ok' order by started_at desc`));

/* ------------------------------------------------------------------ tổng hợp */

const mot = (sql, ...p) => hoi(sql, ...p)[0] ?? {};
const phanVi = (mang, p) => {
  if (!mang.length) return null;
  const s = [...mang].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const treChat = hoi(`select latency_ms v from messages
                     where role='ai' and latency_ms is not null`).map((r) => r.v);

const tongHop = {
  chupLuc: new Date().toISOString(),
  hoiThoai: mot("select count(*) n from conversations").n ?? 0,
  tinNhan: mot("select count(*) n from messages").n ?? 0,
  khach: mot("select count(*) n from guests").n ?? 0,
  datPhong: mot("select count(*) n from reservations").n ?? 0,
  doTreTraLoiMs: {
    soMau: treChat.length,
    trungVi: phanVi(treChat, 0.5),
    p95: phanVi(treChat, 0.95),
    max: treChat.length ? Math.max(...treChat) : null,
  },
  spanTheoLoai: hoi(`select kind loai, count(*) so, round(avg(duration_ms)) trung_binh_ms,
                            max(duration_ms) max_ms
                     from trace_spans group by kind order by so desc`),
  soSpanLoi: mot("select count(*) n from trace_spans where status != 'ok'").n ?? 0,
  theoNgay: hoi(`select substr(created_at,1,10) ngay, count(*) so_tin_nhan
                 from messages group by ngay order by ngay desc limit 30`),
};

writeFileSync(join(DICH, "tong-hop.json"), JSON.stringify(tongHop, null, 2) + "\n");
console.log(`  ✓ tong-hop.json`);
console.log(
  `\n  ${tongHop.hoiThoai} hội thoại · ${tongHop.tinNhan} tin nhắn · ` +
    `p95 trả lời ${tongHop.doTreTraLoiMs.p95 ?? "—"}ms · ${tongHop.soSpanLoi} span lỗi`,
);
