/**
 * Migration 013: nói RÕ thời gian hoàn tiền bằng tiếng Việt.
 *
 * Bộ eval 461 (2026-09-03) hỏi "Thời gian hoàn tiền đặt cọc tối đa là bao nhiêu
 * ngày làm việc?" và mô hình 4B trả lời rỗng rồi chuyển người. Truy xuất đúng
 * (article DEPOSIT #1) nhưng con số "45 ngày" nằm ở CHỖ KHÁC và dạng khó đọc:
 *   - Tiền CỌC: "returned in full at check-out" (hoàn NGAY khi trả phòng).
 *   - "45 working days" thực ra là hạn hoàn tiền khi LỖI GIAO DỊCH (article
 *     PAYMENT), lưu dưới field máy `refund_window_working_days: 45`.
 * Model 4B không nối được câu hỏi tiếng Việt với field English key:value, và
 * hai khái niệm (hoàn cọc vs hoàn do lỗi giao dịch) bị lẫn.
 *
 * Sửa DỮ LIỆU, không sửa model: thêm một câu tiếng Việt tường minh vào article
 * DEPOSIT, phân biệt rõ hai mốc thời gian — trung thực (KHÔNG viết "cọc hoàn sau
 * 45 ngày", vì cọc hoàn tại checkout). Idempotent theo dấu câu đã thêm.
 *
 *   DB_FILE=data.db npx tsx server/migrations/013-refund-timing-vi.ts
 */
import "dotenv/config";
import { storage } from "../storage";
import { reindex } from "../retrieval";

const MARK = "Thời gian hoàn tiền (tiếng Việt)";
const ADD =
  "\n\nThời gian hoàn tiền (tiếng Việt): Tiền đặt cọc được hoàn ĐẦY ĐỦ NGAY tại thời điểm trả phòng (check-out) nếu không phát sinh chi phí chưa thanh toán và không có hư hỏng/mất mát — không phải chờ ngày làm việc. Với các khoản hoàn tiền khác (ví dụ hoàn tiền do lỗi giao dịch/kỹ thuật hoặc theo chính sách hủy), thời gian xử lý tối đa là 45 ngày làm việc.";

function main() {
  const a = storage.listKb().find((x: any) => x.title === "Check-in deposit");
  if (!a) {
    console.log("[skip] Không thấy article 'Check-in deposit'");
    return;
  }
  if (String((a as any).body).includes(MARK)) {
    console.log("Đã có câu hoàn tiền tiếng Việt — không đổi.");
    return;
  }
  storage.updateKb((a as any).id, { body: (a as any).body + ADD, updatedAt: new Date().toISOString() } as any);
  console.log(`[kb] thêm câu thời gian hoàn tiền vào "${(a as any).title}" (id ${(a as any).id})`);
  console.log("Reindexing...");
  reindex().then((r) => console.log(`  ${r.embedded}/${r.chunks} chunks embedded (${r.model})`));
}

main();
