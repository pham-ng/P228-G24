/**
 * The shipped head, on sentences it has never seen, through the real code path.
 *
 * `sentiment-probe-eval.ts` measures on a held-out third of the labelled file.
 * That is the honest accuracy number, but it is still the same file, written by
 * one generator in one sitting. This is the other check: fresh sentences typed
 * by hand, none of them in the training data, run through the SHIPPED weights
 * and the SHIPPED `classifyLinear` — so a mistake in loading, normalising or
 * thresholding shows up here rather than in production.
 *
 * It also times the classification, because the whole argument for a linear
 * head over an ONNX model is that it costs nothing on a vector that already
 * exists.
 *
 *   npx tsx bench/sentiment-live-probe.ts
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { embed } from "../server/llm";
import { classifyLinear } from "../server/sentiment-net";

const head = JSON.parse(readFileSync(join(process.cwd(), "server", "data", "sentiment-head.json"), "utf8"));
const T = head.threshold;

/* Deliberately awkward: unaccented Vietnamese, sarcasm, a complaint with no
   complaint words, and — on the calm side — the cases that must NOT fire,
   including a fault report and a question that merely contains a negative word. */
const cases: { text: string; want: "negative" | "neutral"; note: string }[] = [
  { text: "toi goi le tan 4 lan roi ma van chua ai len", want: "negative", note: "vi khong dau, implied" },
  { text: "Phòng ngay cạnh thang máy, cả đêm không chợp mắt nổi", want: "negative", note: "vi, implied" },
  { text: "chuyen nghiep that, check-in mat cua toi gan mot tieng", want: "negative", note: "vi khong dau, sarcasm" },
  { text: "Tiền phòng thì cao mà khăn tắm còn không đủ", want: "negative", note: "vi, value" },
  { text: "Nhân viên thì dễ thương nhưng bữa sáng dở tệ", want: "negative", note: "vi, mixed" },
  { text: "I have asked three times for extra pillows and nothing has arrived", want: "negative", note: "en, implied" },
  { text: "Charged twice for the same dinner and nobody can explain it", want: "negative", note: "en, billing" },
  { text: "체크인에 한 시간이나 걸렸습니다, 정말 대단하네요", want: "negative", note: "ko, sarcasm" },
  { text: "隣の部屋がうるさくて一睡もできませんでした", want: "negative", note: "ja, implied" },
  { text: "前台态度很差，我要投诉", want: "negative", note: "zh, direct" },
  { text: "Уже третий раз прошу убрать номер", want: "negative", note: "ru, implied" },

  { text: "Bể bơi mở cửa từ mấy giờ đến mấy giờ ạ", want: "neutral", note: "vi, lookup" },
  { text: "khach san co xe dua don san bay khong", want: "neutral", note: "vi khong dau, lookup" },
  { text: "Phòng có bị hạn chế mang thú cưng không?", want: "neutral", note: "vi, negative word in a plain question" },
  { text: "Điều hoà phòng 305 không mát, nhờ anh chị cho người lên kiểm tra", want: "neutral", note: "vi, calm fault report" },
  { text: "Could you book a table for four at seven tonight", want: "neutral", note: "en, request" },
  { text: "회원 등급에 따라 스파 할인이 얼마나 되나요", want: "neutral", note: "ko, lookup" },
  { text: "朝食は何時からですか", want: "neutral", note: "ja, lookup" },
  { text: "Мне нужен поздний выезд, это возможно?", want: "neutral", note: "ru, request" },
  { text: "房间可以延迟退房吗", want: "neutral", note: "zh, request" },
];

console.log(`head: dim=${head.dim} nguong=${T} trained on ${head.trainedOn}\n`);
const vecs = await embed(cases.map((c) => c.text));

/* Time the decision only — the embedding is not attributable to this feature,
   because retrieval computes it for the turn regardless. */
const ITER = 20000;
const t0 = performance.now();
for (let i = 0; i < ITER; i++) classifyLinear(vecs[i % vecs.length], head, T);
const perCall = ((performance.now() - t0) / ITER) * 1000;

let ok = 0;
for (const side of ["negative", "neutral"] as const) {
  console.log(`=== phai doc la ${side.toUpperCase()} ===`);
  cases.forEach((c, i) => {
    if (c.want !== side) return;
    const v = classifyLinear(vecs[i], head, T)!;
    const hit = v.label === c.want;
    if (hit) ok++;
    console.log(`  ${hit ? "OK  " : "SAI "} p=${v.score.toFixed(2)}  [${c.note}]  ${c.text}`);
  });
}
console.log(`\n${ok}/${cases.length} dung tren cau moi hoan toan (ngoai bo du lieu huan luyen)`);
console.log(`chi phi phan loai: ${perCall.toFixed(1)} microgiay/tin nhan (vector da co san tu retrieval)`);
process.exit(0);
