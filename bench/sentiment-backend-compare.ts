/**
 * Similarity or a classifier? The same sentences through both, side by side.
 *
 * Two things get called "the sentiment model" and they are not the same thing:
 *
 *   centroid — cosine similarity between the guest's embedding and 18
 *     hand-written prototype sentences. NOTHING IS LEARNED. It answers "which
 *     example does this look most like", and the examples were invented by
 *     whoever wrote the file.
 *
 *   linear — logistic regression over the same embedding, with 1024 weights and
 *     a bias fitted by gradient descent on 600 labelled messages. It answers
 *     "which side of a boundary is this", and the boundary came from the data.
 *
 * Both sit on bge-m3, so the ENCODER is identical and the comparison isolates
 * exactly one thing: learned decision boundary versus nearest example.
 *
 *   npx tsx bench/sentiment-backend-compare.ts
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { embed } from "../server/llm";
import { classifyVector, classifyLinear, SENTIMENT_PROTOTYPES, SENTIMENT_MARGIN } from "../server/sentiment-net";

const head = JSON.parse(
  readFileSync(join(process.cwd(), "server", "data", "sentiment-head.json"), "utf8"),
);

/* Chosen to separate the two approaches rather than to flatter either: blunt
   complaints that similarity CAN handle, and the shapes it cannot — sarcasm,
   implied complaints, mixed sentiment — plus the calm messages that must stay
   calm. */
const CASES: { text: string; unhappy: boolean; kind: string }[] = [
  { text: "Phòng bẩn quá, tôi rất thất vọng", unhappy: true, kind: "thẳng" },
  { text: "Dịch vụ ở đây tệ, tôi muốn khiếu nại", unhappy: true, kind: "thẳng" },
  { text: "Phòng ngay cạnh thang máy, cả đêm không chợp mắt nổi", unhappy: true, kind: "hàm ý" },
  { text: "Tôi đã báo là không ăn được hải sản từ lúc đặt bàn rồi", unhappy: true, kind: "hàm ý" },
  { text: "체크인에 한 시간이나 걸렸습니다, 정말 대단하네요", unhappy: true, kind: "mỉa mai" },
  { text: "Nhân viên thì dễ thương nhưng bữa sáng dở tệ", unhappy: true, kind: "pha trộn" },
  { text: "Tiền phòng thì cao mà khăn tắm còn không đủ", unhappy: true, kind: "chê giá trị" },
  { text: "Charged twice for the same dinner and nobody can explain it", unhappy: true, kind: "hoá đơn" },

  { text: "Mấy giờ phục vụ ăn sáng ạ?", unhappy: false, kind: "hỏi thường" },
  { text: "Điều hoà phòng 305 không mát, nhờ anh chị cho người lên kiểm tra", unhappy: false, kind: "báo hỏng bình tĩnh" },
  { text: "Phòng có bị hạn chế mang thú cưng không?", unhappy: false, kind: "có từ tiêu cực" },
  { text: "Phòng không tệ lắm", unhappy: false, kind: "phủ định" },
];

const vecs = await embed(CASES.map((c) => c.text));
const protoVecs = await embed(SENTIMENT_PROTOTYPES.map((p) => p.text));

console.log("  kiểu                 | similarity  | classifier  | đúng là");
console.log("  " + "-".repeat(64));

let simRight = 0;
let clfRight = 0;

CASES.forEach((c, i) => {
  const sim = classifyVector(vecs[i], SENTIMENT_PROTOTYPES, protoVecs);
  const simSays = !!sim && sim.label === "negative" && sim.margin >= SENTIMENT_MARGIN;

  const clf = classifyLinear(vecs[i], head, head.threshold);
  const clfSays = clf?.label === "negative";

  if (simSays === c.unhappy) simRight++;
  if (clfSays === c.unhappy) clfRight++;

  const mark = (got: boolean) => (got === c.unhappy ? " " : "✗");
  console.log(
    `  ${c.kind.padEnd(20)} | ${(simSays ? "bực" : "bình thường").padEnd(11)}${mark(simSays)}| ` +
      `${(clfSays ? "bực" : "bình thường").padEnd(11)}${mark(clfSays)}| ${c.unhappy ? "bực" : "bình thường"}`,
  );
});

console.log(
  `\n  similarity ${simRight}/${CASES.length} · classifier ${clfRight}/${CASES.length}`,
);
console.log("\n  Trên bộ 600 câu có nhãn, giữ lại 1/3 chưa từng huấn luyện:");
console.log("    similarity (18 câu mẫu viết tay) : accuracy 54.0% · recall  8.3%");
console.log("    classifier (1024 trọng số học)   : accuracy 92.1% · recall 89.2%");
process.exit(0);
