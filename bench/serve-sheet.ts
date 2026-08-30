/**
 * Mở bảng chấm tay qua http.
 *
 *   npx tsx bench/serve-sheet.ts      → http://localhost:5055
 *
 * Vì sao cần: Chrome CHẶN `localStorage` trên `file://`. Bấm đúp vào
 * `label-sheet.html` thì mọi lần đọc/ghi đều ném SecurityError, và tiến độ mất
 * sạch sau một lần lỡ tải lại trang — giữa chừng 101 ca thì đó là một buổi tối
 * đi tong. Bảng có bắt lỗi và lùi về bộ nhớ tạm, nhưng bộ nhớ tạm không sống
 * qua F5.
 *
 * Không dùng `npx serve`: nó tải một gói về chỉ để phục vụ đúng một tệp tĩnh.
 */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const FILE = join(process.cwd(), "bench", "data", "label-sheet.html");
const PORT = Number(process.env.SHEET_PORT ?? 5055);

if (!existsSync(FILE)) {
  console.error("Chưa có bench/data/label-sheet.html — chạy `npx tsx bench/make-label-sheet.ts` trước.");
  process.exit(2);
}

createServer((_req, res) => {
  /* Đọc lại mỗi lần: sinh lại bảng rồi F5 là thấy ngay, không phải khởi động lại. */
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(readFileSync(FILE));
}).listen(PORT, () => {
  console.log(`Bảng chấm: http://localhost:${PORT}`);
  console.log(`Tiến độ lưu trong localStorage của trình duyệt — đóng tab vẫn còn.`);
  console.log(`Chấm xong bấm "Xuất JSON", lưu vào bench/data/human-labels.json. Ctrl+C để dừng.`);
});
