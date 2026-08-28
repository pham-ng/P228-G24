/**
 * Spike: would an embedding intent net catch what the keyword lexicon misses,
 * and what would it cost in latency?
 *
 * The lexicon routes Vietnamese and English well, Chinese and Korean partly,
 * and has ZERO entries for Japanese or Russian in `toolrouter`'s 600 cues. The
 * question this answers is whether prototypes written in ONE language
 * generalise to the other five through bge-m3, and what the per-turn cost is.
 *
 * Not wired into the pipeline. Measurement only.
 */
import "dotenv/config";
import { embed } from "../server/llm";
import { classifyLocal } from "../server/local-agent";

/* Intent prototypes — Vietnamese only, on purpose. If this works, adding a
   language means adding EXAMPLES, not editing ten keyword lists. */
const PROTOTYPES: { intent: "escalate" | "lookup"; text: string }[] = [
  { intent: "escalate", text: "tôi muốn huỷ đặt phòng" },
  { intent: "escalate", text: "hoàn tiền lại cho tôi" },
  { intent: "escalate", text: "hoá đơn của tôi bị tính sai, sửa lại giúp" },
  { intent: "escalate", text: "đổi ngày nhận phòng cho tôi" },
  { intent: "escalate", text: "điều hoà trong phòng bị hỏng" },
  { intent: "escalate", text: "tôi muốn đặt thêm một phòng nữa" },
  { intent: "escalate", text: "chuyển tiền hoàn về tài khoản khác" },
  { intent: "escalate", text: "tổng hoá đơn của tôi là bao nhiêu" },
  { intent: "lookup", text: "mấy giờ phục vụ ăn sáng" },
  { intent: "lookup", text: "hồ bơi mở cửa đến mấy giờ" },
  { intent: "lookup", text: "giá phòng deluxe là bao nhiêu" },
  { intent: "lookup", text: "resort có cho mang thú cưng không" },
  { intent: "lookup", text: "spa có những liệu trình nào" },
  { intent: "lookup", text: "chính sách huỷ phòng quy định thế nào" },
  { intent: "lookup", text: "wifi có miễn phí không" },
  { intent: "lookup", text: "nhà hàng nào phục vụ buffet" },
];

/* Test set: the shapes the lexicon is known to miss, plus lookups that must
   NOT be dragged into escalation. */
const CASES: { q: string; want: "escalate" | "lookup"; lang: string }[] = [
  { q: "제 예약을 지금 취소하고 환불해 주세요", want: "escalate", lang: "ko" },
  { q: "クレジットカードの請求額が間違っているので訂正してください", want: "escalate", lang: "ja" },
  { q: "友人の代わりに彼の予約をキャンセルしたいです", want: "escalate", lang: "ja" },
  { q: "部屋のエアコンが壊れています", want: "escalate", lang: "ja" },
  { q: "Отмените моё бронирование и верните деньги", want: "escalate", lang: "ru" },
  { q: "В моём счёте ошибка, исправьте пожалуйста", want: "escalate", lang: "ru" },
  { q: "Кондиционер в номере сломан", want: "escalate", lang: "ru" },
  { q: "帮我把账单退款到我朋友的银行账户", want: "escalate", lang: "zh" },
  { q: "现在帮我把入住日期提前两天", want: "escalate", lang: "zh" },
  { q: "Cancel my reservation and refund me", want: "escalate", lang: "en" },

  { q: "朝食は何時からですか", want: "lookup", lang: "ja" },
  { q: "スパにはどんなトリートメントがありますか", want: "lookup", lang: "ja" },
  { q: "Во сколько開 начинается завтрак", want: "lookup", lang: "ru" },
  { q: "Сколько стоит номер Deluxe", want: "lookup", lang: "ru" },
  { q: "수영장은 몇 시까지 운영하나요", want: "lookup", lang: "ko" },
  { q: "予約のキャンセルポリシーは何ですか", want: "lookup", lang: "ja" },
  { q: "豪华大床房多少钱", want: "lookup", lang: "zh" },
  { q: "What time is breakfast served", want: "lookup", lang: "en" },
];

const cos = (a: number[], b: number[]) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb));
};

console.log("=== chi phí khởi động ===");
let t0 = Date.now();
const protoVecs = await embed(PROTOTYPES.map((p) => p.text));
console.log(`  nhúng ${PROTOTYPES.length} câu mẫu: ${Date.now() - t0}ms (một lần, lúc khởi động)`);

/* Warm the model so the per-query figure is a steady-state one. */
await embed(["làm nóng"]);

const embedMs: number[] = [];
const cosineMs: number[] = [];
let netOk = 0, lexOk = 0, bothMissed = 0;
const rows: string[] = [];

for (const c of CASES) {
  t0 = Date.now();
  const [v] = await embed([c.q]);
  embedMs.push(Date.now() - t0);

  const t1 = process.hrtime.bigint();
  let best = { intent: "lookup" as "escalate" | "lookup", score: -1 };
  for (let i = 0; i < protoVecs.length; i++) {
    const s = cos(v, protoVecs[i]);
    if (s > best.score) best = { intent: PROTOTYPES[i].intent, score: s };
  }
  cosineMs.push(Number(process.hrtime.bigint() - t1) / 1e6);

  const lexRoute = classifyLocal(c.q, false);
  const lexEscalates = lexRoute !== "knowledge";
  const lexCorrect = (c.want === "escalate") === lexEscalates;
  const netCorrect = best.intent === c.want;
  if (netCorrect) netOk++;
  if (lexCorrect) lexOk++;
  if (!netCorrect && !lexCorrect) bothMissed++;

  rows.push(
    `  ${c.lang}  lexicon=${lexCorrect ? "✓" : "✗"}  embedding=${netCorrect ? "✓" : "✗"} (${best.intent}, ${best.score.toFixed(3)})  muốn=${c.want.padEnd(8)} ${c.q.slice(0, 42)}`,
  );
}

console.log("\n=== từng ca ===");
rows.forEach((r) => console.log(r));

const p = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.floor(q * xs.length)];
console.log("\n=== chi phí mỗi lượt ===");
console.log(`  gọi embed()   p50=${p(embedMs, 0.5)}ms  p95=${p(embedMs, 0.95)}ms`);
console.log(`  so cosine     p50=${p(cosineMs, 0.5).toFixed(3)}ms  p95=${p(cosineMs, 0.95).toFixed(3)}ms  (${PROTOTYPES.length} câu mẫu)`);

console.log("\n=== độ chính xác ===");
console.log(`  lexicon đúng  : ${lexOk}/${CASES.length}`);
console.log(`  embedding đúng: ${netOk}/${CASES.length}`);
console.log(`  cả hai cùng sai: ${bothMissed}/${CASES.length}`);
process.exit(0);
