/**
 * Tìm những ca **im lặng dù đã có tài liệu**.
 *
 *   npx tsx bench/find-silent.ts            # in ra
 *   npx tsx bench/find-silent.ts --write    # ghi bench/data/relabel-ids.json
 *
 * Định nghĩa, đo được chứ không phải cảm tính: câu hỏi ĐÁNG LẼ phải trả lời
 * được, hệ thống đã lấy lên đúng đoạn tài liệu (`contextRecall ≥ 0.5`), nhưng
 * câu trả lời KHÔNG chứa con số nào trong số phải có (`anchorsFound === 0`).
 * Tức là tri thức nằm sẵn trong tay mà vẫn đẩy việc sang người thật.
 *
 * Vì sao cần một danh sách riêng: bộ luật chấm ban đầu không có ô cho hiện
 * tượng này, nên 13 ca đã bị chấm thành BỐN nhãn khác nhau — 6 `khong_hop_ly`,
 * 3 `sai`, 3 `hop_ly`, 1 `dung_du`. Ba ca rơi vào `hop_ly` là thất bại đang
 * được đếm thành công. Ô `im_lang` đã được thêm; chỉ cần bấm lại đúng những ca
 * này, không phải cả 101.
 *
 * KHÔNG chép cứng mười ba mã ca vào đâu cả. Chạy lại bộ eval thì tập này đổi,
 * và một danh sách chép tay sẽ mục đi trong im lặng — đúng kiểu lỗi mà cả file
 * `bench/rubric.ts` sinh ra để chống.
 *
 * Cảnh báo khi đọc kết quả: `observed === "escalate"` KHÔNG dùng được làm tiêu
 * chí. Nhãn đó bật lên chỉ vì câu trả lời có kèm một câu chuyển tiếp — nhiều
 * ca đã trả lời đủ rồi mới thêm câu đó vào. Lọc theo nhãn ấy cho ra 24 ca,
 * gần một nửa là dương tính giả. Phải lọc theo NỘI DUNG câu trả lời.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Row = {
  id: string;
  category: string;
  question: string;
  expected: string;
  reply: string | null;
  anchorsExpected: number;
  anchorsFound: number;
  contextRecall: number | null;
  contextRank: number | null;
};

const report = JSON.parse(readFileSync(join(process.cwd(), "bench", "rag-eval-report.json"), "utf8")) as {
  rows: Row[];
};

const silent = report.rows.filter(
  (r) =>
    r.expected === "answer" &&
    r.contextRecall !== null &&
    r.contextRecall >= 0.5 &&
    r.anchorsExpected > 0 &&
    r.anchorsFound === 0,
);

console.log(`${silent.length} ca im lặng dù tài liệu đã lấy lên đúng\n`);
for (const r of silent) {
  console.log(`  ${r.id.padEnd(9)} ${r.category.padEnd(20)} rank=${r.contextRank ?? "—"}  cần ${r.anchorsExpected} số, có 0`);
  console.log(`    hỏi: ${r.question.slice(0, 76)}`);
  console.log(`    đáp: ${String(r.reply ?? "(trống)").replace(/\s+/g, " ").slice(0, 76)}`);
}

if (process.argv.includes("--write")) {
  const out = join(process.cwd(), "bench", "data", "relabel-ids.json");
  writeFileSync(out, JSON.stringify(silent.map((r) => r.id), null, 2) + "\n");
  console.log(`\nĐã ghi ${out}`);
  console.log(`Tiếp: npx tsx bench/make-label-sheet.ts --ids-file bench/data/relabel-ids.json`);
}
