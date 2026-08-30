/**
 * Xuất bộ câu hỏi vàng ra CSV cho RAGAS / Excel.
 *
 * RAGAS và hầu hết công cụ eval đọc ba cột: `question`, `ground_truth`,
 * `contexts`. Bộ vàng ở đây giữ nhiều hơn thế — `behaviour`, `anchors`, `why` —
 * và ba cột đó là lý do bộ này bắt được lỗi mà một bộ ba cột không bắt được:
 *
 *   - `behaviour` phân biệt "trả lời sai" với "đáng lẽ phải im lặng mà lại trả
 *     lời". Với ca UNANSWERABLE, `ground_truth` mô tả sự im lặng đúng đắn
 *     ("phải nói không có thông tin và chuyển lễ tân") — nên đọc riêng cột
 *     ground_truth thì nó trông y hệt một câu trả lời, và chỉ `behaviour` mới
 *     nói được rằng trả lời ở đây là SAI.
 *   - `anchors` là các con số phải xuất hiện. Chấm ngữ nghĩa cho điểm cao một
 *     câu trả lời trôi chảy mang sai giá; `anchors` thì không.
 *   - `why` ghi ca này sinh ra để bắt lỗi gì, nên khi nó hỏng sáu tháng sau vẫn
 *     còn người hiểu tại sao nó tồn tại.
 *
 * Nên file CSV này xuất ĐỦ CẢ SÁU cột: ba cột chuẩn để nạp thẳng vào RAGAS, và
 * ba cột kia để không mất thông tin khi ai đó mở bằng Excel.
 *
 * CSV được viết theo RFC 4180 (bọc dấu nháy kép, nhân đôi nháy bên trong) và
 * kèm BOM UTF-8 — không có BOM thì Excel trên Windows đọc "Phòng gym" thành
 * "PhÃ²ng gym", và đó là lỗi đầu tiên người nhận file sẽ gặp.
 *
 *   npx tsx bench/golden-export.ts            -> bench/data/golden-vi.csv
 *   npx tsx bench/golden-export.ts --ragas    -> chỉ 3 cột chuẩn RAGAS
 */
import { readFileSync, writeFileSync } from "node:fs";

type Case = {
  id: string;
  category: string;
  behaviour: string;
  question: string;
  ground_truth: string;
  contexts: string[];
  anchors: string[];
  why: string;
};

const SRC = "bench/data/golden-vi.json";
const ragasOnly = process.argv.includes("--ragas");
const OUT = ragasOnly ? "bench/data/golden-vi-ragas.csv" : "bench/data/golden-vi.csv";

const g = JSON.parse(readFileSync(SRC, "utf8")) as { cases: Case[] };

/**
 * RFC 4180: mọi ô đều được bọc nháy kép, nháy bên trong nhân đôi.
 *
 * Bọc vô điều kiện chứ không chỉ khi "có dấu phẩy": ground truth ở đây chứa
 * dấu phẩy, xuống dòng và cả dấu nháy, và một ô lọt lưới sẽ đẩy lệch mọi cột
 * phía sau — hỏng theo kiểu vẫn mở được file nên không ai để ý.
 */
const cell = (v: unknown): string => {
  const s = Array.isArray(v) ? v.join(" | ") : String(v ?? "");
  return `"${s.replace(/"/g, '""')}"`;
};

const HEAD_RAGAS = ["question", "ground_truth", "contexts"];
const HEAD_FULL = ["id", "category", "behaviour", "question", "ground_truth", "contexts", "anchors", "why"];
const head = ragasOnly ? HEAD_RAGAS : HEAD_FULL;

const lines = [head.map(cell).join(",")];
for (const c of g.cases) {
  const row = ragasOnly
    ? [c.question, c.ground_truth, c.contexts]
    : [c.id, c.category, c.behaviour, c.question, c.ground_truth, c.contexts, c.anchors, c.why];
  lines.push(row.map(cell).join(","));
}

/* \r\n vì Excel trên Windows là nơi file này sẽ được mở. BOM vì nếu không có
   nó Excel đoán codepage hệ thống và tiếng Việt hỏng hết. */
writeFileSync(OUT, "﻿" + lines.join("\r\n") + "\r\n", "utf8");

const n = g.cases.length;
/* Đếm theo BEHAVIOUR chứ không theo ô rỗng: mọi ca đều có ground_truth bằng
   lời, kể cả ca phải im lặng — ở đó ground_truth mô tả sự im lặng đúng đắn
   ("phải nói không có thông tin và chuyển lễ tân") chứ không phải một ô trống.
   Ô trống là quy ước tồi vì không phân biệt được "đáp án là im lặng" với
   "chưa ai điền ca này". */
const silent = g.cases.filter((c) => c.behaviour !== "answer").length;
console.log(`Đã ghi ${OUT}`);
console.log(`  ${n} ca · ${head.length} cột`);
console.log(`  ${silent}/${n} ca KHÔNG được phép trả lời (hỏi lại / từ chối / chuyển người).`);
console.log(`  Đừng lọc chúng ra khi nạp vào RAGAS — bỏ chúng đi là bỏ mất toàn bộ`);
console.log(`  phép đo "có biết im lặng không", vốn là lỗi sản phẩm này đang có.`);
if (ragasOnly) {
  console.log(`\n  Bản --ragas chỉ có 3 cột chuẩn. Nó KHÔNG mang 'behaviour' và 'anchors',`);
  console.log(`  nên nó không phân biệt được "trả lời sai" với "đáng lẽ phải im lặng",`);
  console.log(`  và không bắt được câu trôi chảy mang sai số. Dùng bản đầy đủ khi chấm nội bộ.`);
}
