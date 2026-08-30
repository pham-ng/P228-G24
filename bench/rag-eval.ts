/**
 * Score the offline RAG pipeline against `bench/data/golden-vi.json`.
 *
 *   npx tsx bench/rag-eval.ts                    # tất định, miễn phí
 *   npx tsx bench/rag-eval.ts --judge            # chạy lại model + giám khảo (tốn tiền)
 *   npx tsx bench/rag-eval.ts --judge-only       # CHỈ chấm lại lượt chạy cũ
 *   npx tsx bench/rag-eval.ts --judge --sample 20
 *
 * Dùng `--judge-only` bất cứ khi nào đã có nhãn người trên lượt chạy hiện tại.
 * `--judge` sinh câu trả lời MỚI, và nhãn người khi đó trỏ vào những câu không
 * còn tồn tại.
 *
 * Giám khảo chạy trên Gemini nếu `.env` có `GEMINI_API_KEY` (rẻ hơn), không thì
 * lùi về OpenAI. `JUDGE_MODEL` ghi đè cả hai.
 *
 * TWO INDEPENDENT SIGNALS, ON PURPOSE.
 *
 * The deterministic half needs no model and costs nothing: whether retrieval
 * returned the right document, where it ranked, whether the numbers in the
 * answer match the numbers in the corpus, and whether the system answered when
 * it should have answered. Run it on every change.
 *
 * The judge half reads meaning: is the answer actually correct, and is every
 * claim in it supported by what was retrieved. Run it before a decision.
 *
 * Where the two disagree is the interesting part, and the report prints those
 * cases separately rather than averaging them away.
 *
 * WHY NOT SUBSTRING MATCHING, WHICH THE OLD EVAL USED. `expected_facts:
 * ["14:00"]` scored a reply saying "2 giờ chiều" as WRONG, and scored a correct
 * Korean answer as WRONG because the expected list only held Vietnamese and
 * English strings. Numeric anchors here are compared after `normalise()`, and
 * everything that is not a number is left to the judge.
 *
 * JUDGE DISCIPLINE — every one of these is enforced in code, not documented and
 * forgotten:
 *   · Different model family. The agent is a local Qwen; the judge must not be.
 *     `assertDifferentFamily` refuses to run otherwise. A model grading its own
 *     output is not evidence.
 *   · Rubric plus worked examples, so "correct" means the same thing twice.
 *   · The judge is never told which system wrote the answer, or that it is ours.
 *   · Case order is shuffled with a seed printed in the report, so a run is
 *     reproducible but not order-biased.
 *   · `--sample` judges a subset. Judging every turn is how eval budgets die.
 *   · Every per-case verdict is written out so a human can label the same rows
 *     and `bench/judge-kappa.ts` can measure agreement.
 */
import { HANDLING_VALUES, SOURCE_VALUES, HANDLING_PASS, SOURCE_PASS, rubricText } from "./rubric";
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runLocalTurn, LOCAL_PASSAGES } from "../server/local-agent";
import { hybridSearch } from "../server/retrieval";
import { storage } from "../server/storage";
import { screenGuestMessage } from "../server/guard";
import { normalise } from "./lib/speech-metrics";
import { percentile } from "./lib/speech-metrics";

type Behaviour = "answer" | "clarify" | "abstain" | "escalate";
type Case = {
  id: string;
  category: string;
  behaviour: Behaviour;
  question: string;
  ground_truth: string;
  contexts: string[];
  anchors: string[];
  why: string;
};

const argv = process.argv.slice(2);
/* `--judge-only` hàm ý luôn là có chấm — nếu không thì nó chỉ phát lại lượt cũ
   rồi không làm gì cả, im lặng và trông y như thành công. */
const useJudge = argv.includes("--judge") || argv.includes("--judge-only");

/**
 * `--judge-only`: chấm lại lượt chạy đã có, KHÔNG sinh câu trả lời mới.
 *
 * Không có cờ này thì `--judge` chạy lại model cho cả 101 ca rồi ghi đè báo
 * cáo. Câu trả lời mới khác câu cũ, nên mọi nhãn người đã chấm trên lượt trước
 * lập tức trỏ vào những câu không còn tồn tại — kappa khi đó đem so hai người
 * chấm HAI BỘ câu trả lời khác nhau, ra một con số thấp vô nghĩa mà không có
 * gì trên màn hình cho thấy vì sao.
 *
 * Câu trả lời lấy nguyên từ báo cáo cũ. Đoạn tài liệu thì TRUY XUẤT LẠI: báo
 * cáo không lưu chúng, nhưng truy xuất là tất định (cùng chỉ mục, cùng truy
 * vấn) và ở eval không có lịch sử hội thoại nên `retrievalQuery` chính là câu
 * hỏi. Xấp xỉ ở một chỗ: bỏ qua bước làm giàu dữ liệu có cấu trúc mà
 * `runLocalTurn` thêm vào sau truy xuất, nên giám khảo thấy đoạn thô. Đủ để
 * chấm "có bịa không"; nói ra ở đây để không ai tưởng là bản sao y hệt.
 */
const judgeOnly = argv.includes("--judge-only");
const priorRows = new Map<string, any>();
if (judgeOnly) {
  const prior = JSON.parse(readFileSync(join(process.cwd(), "bench", "rag-eval-report.json"), "utf8")) as {
    rows: any[];
  };
  for (const r of prior.rows) priorRows.set(r.id, r);
  console.log(`--judge-only: dùng lại ${priorRows.size} câu trả lời từ lượt chạy trước, không chạy model.`);
}
const sampleN = Number(argv[argv.indexOf("--sample") + 1]) || 0;
/* Printed in the report so a run can be repeated exactly. */
const SEED = Number(process.env.EVAL_SEED ?? 42);

const set = JSON.parse(readFileSync(join(process.cwd(), "bench", "data", "golden-vi.json"), "utf8")) as {
  cases: Case[];
};

/** Deterministic shuffle, so order bias is removed without losing reproducibility. */
function shuffled<T>(xs: T[], seed: number): T[] {
  const a = [...xs];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ------------------------------------------------------ behaviour reading */

/**
 * What did the system actually do?
 *
 * Read from the pipeline's own signals, not from the prose: `escalate` is a
 * field, and abstention has a dedicated token. Only "clarify" has to be read
 * from the text, and it is checked narrowly — a question mark plus a request
 * for more detail — because almost every polite Vietnamese reply ends in "ạ?"
 * somewhere and a loose rule would call everything a clarification.
 */
const CLARIFY = /(?:cho (?:em|tôi) hỏi|anh\/chị (?:muốn|đang)|quý khách (?:muốn|đang)|ý anh\/chị|là dịch vụ nào|của (?:tiện ích|dịch vụ) nào|loại nào|mấy giờ sáng hay|bao nhiêu người)/i;

/**
 * Refusal written as prose rather than emitted as the token.
 *
 * The first run of this harness scored abstention 0/8, which was too absolute
 * to believe — and it was wrong. "Resort không có quy định cụ thể về việc này
 * trong tài liệu đã cung cấp" IS a refusal, and reading only `turn.abstained`
 * missed it, so a correct refusal was counted as a fabricated answer.
 *
 * These patterns are written here rather than imported from `local-agent.ts`,
 * which has its own list. Deliberate duplication: if the scorer imported the
 * system's detector, editing that list would silently move the score, and an
 * evaluator whose definition of success is controlled by the thing being
 * evaluated measures nothing. Narrow on purpose — each one requires an explicit
 *
 * MISSED ONCE, and it mattered: the model refused with "thông tin này KHÔNG CÓ
 * TRONG tài liệu đã được truy xuất" — the natural Vietnamese word order — while
 * the pattern only had "tài liệu … không có" and the literal "đã cung cấp".
 * A correct refusal was therefore counted as a FABRICATION, inflating the one
 * number in this report that is read as a safety metric. Check the grader
 * before believing the grade.
 * statement ABOUT the documents, so a plain "không" ("Không được mang thú
 * cưng") stays a real answer.
 */
const ABSTAIN_PROSE =
  /(?:không có (?:thông tin|quy định|đề cập)|không (?:được )?(?:đề cập|nêu)|chưa (?:được )?đề cập|không tìm thấy thông tin|tài liệu (?:[^.]{0,24})?không (?:có|nêu|đề cập|cung cấp)|không có trong (?:tài liệu|dữ liệu)|không (?:thể )?cung cấp (?:[^.]{0,40})?(?:prompt|cấu hình|hệ thống)|trong tài liệu đã (?:cung cấp|được cung cấp|truy xuất|được truy xuất))/i;

function observedBehaviour(turn: { reply: string | null; escalate?: boolean }, abstained: boolean): Behaviour {
  if (turn.escalate) return "escalate";
  if (abstained || !turn.reply?.trim()) return "abstain";
  if (ABSTAIN_PROSE.test(turn.reply)) return "abstain";
  if (CLARIFY.test(turn.reply)) return "clarify";
  return "answer";
}

/**
 * Is what happened an acceptable outcome for what was expected?
 *
 * Escalating on a question the corpus cannot answer is NOT a failure — it is
 * the product's stated contract: never invent, hand to a person. Scoring it
 * wrong the first time made refusal look broken when it was working, and would
 * have pushed exactly the wrong fix.
 *
 * The reverse is not allowed. Escalating instead of asking a one-line
 * clarifying question spends a staff member on something the assistant could
 * have resolved, so `clarify` stays strict and those cases are reported
 * separately.
 */
function acceptable(expected: Behaviour, observed: Behaviour, hasSubstance: boolean): boolean {
  if (expected === observed) return true;
  /* Refusing by handing to a person is refusing. */
  if (expected === "abstain" && observed === "escalate") return true;
  /* This pipeline routinely answers correctly AND escalates — the conservative
     default for anything touching money. Three cancellation cases were graded
     as behaviour failures on the first run while their replies were entirely
     right, which said "conditional policy is broken" about a system that had
     just quoted the policy correctly. What fails an `answer` case is producing
     NOTHING; escalating on top of a real answer is a staffing cost, counted on
     its own axis below, not a wrong answer. */
  if (expected === "answer" && observed === "escalate" && hasSubstance) return true;
  return false;
}

/** Enough words to be an answer rather than a handoff line. */
const HANDOFF = /^(?:dạ[,. ]*)?(?:em (?:đã )?(?:chuyển|xin)|câu này em cần)/i;
function substantive(reply: string): boolean {
  const t = reply.replace(/\s+/g, " ").trim();
  if (t.length < 40) return false;
  /* A reply that is only the handoff sentence carries no answer. */
  return !(HANDOFF.test(t) && t.length < 120);
}

/* ---------------------------------------------------------------- judging */

/**
 * Giám khảo chạy trên OpenAI HOẶC Gemini — chọn theo key đang có.
 *
 * Gemini rẻ hơn hẳn cho đúng việc này: mỗi ca là một lượt gọi ngắn, đọc vài
 * đoạn tài liệu rồi trả về hai nhãn. Không cần model mạnh, cần model rẻ và ổn
 * định. Ưu tiên Gemini khi có GEMINI_API_KEY; không có thì lùi về OpenAI.
 *
 * JUDGE_MODEL ghi đè cả hai. Tên model đổi theo thời gian, nên nếu nhà cung cấp
 * trả 404 thì đặt biến đó sang một tên đang còn sống.
 */
const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
/* gemini-2.0-flash đã bị gỡ — chính API trả 404 kèm câu "use models/gemini-3.6-flash".
   Tên model là thứ mục nhanh nhất trong file này; nếu lại 404 thì đặt JUDGE_MODEL. */
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? (GEMINI_KEY ? "gemini-3.5-flash-lite" : "gpt-4o-mini");
const JUDGE_PROVIDER: "gemini" | "openai" = JUDGE_MODEL.startsWith("gemini") ? "gemini" : "openai";

/**
 * Refuse to let the agent grade its own homework.
 *
 * Not a warning — a hard stop. The whole value of the judge is that it has no
 * stake in the answer, and a Qwen judging a Qwen shares its blind spots by
 * construction: the same tokenizer, the same training data, the same reasons
 * for believing a wrong thing.
 */
function assertDifferentFamily(agentModel: string, judgeModel: string) {
  const family = (m: string) => m.toLowerCase().replace(/[^a-z]/g, "").match(/qwen|llama|gemma|mistral|phi|gpt|claude|gemini/)?.[0] ?? "unknown";
  const a = family(agentModel);
  const j = family(judgeModel);
  if (a === j)
    throw new Error(
      `Giám khảo (${judgeModel}) cùng dòng model với tác nhân (${agentModel}). ` +
        `Một model tự chấm bài của chính nó không phải bằng chứng. Đặt JUDGE_MODEL sang dòng khác.`,
    );
  return { agentFamily: a, judgeFamily: j };
}

/**
 * Luật chấm dựng từ `bench/rubric.ts` — KHÔNG viết tay lại ở đây.
 *
 * Bản trước viết tay, và nó chứa dòng "từ chối đúng là câu trả lời đúng →
 * correctness 3" mà bảng chấm tay của người không hề có. Hai bộ luật lệch nhau
 * chính là thứ đã dìm κ xuống 0,36. Sinh từ một nguồn nên không lệch lại được.
 */
const RUBRIC = `Bạn chấm cách xử lý của một trợ lý lễ tân khách sạn.

Với mỗi mục, trả về ĐÚNG MỘT chuỗi trong danh sách cho sẵn.

${rubricText()}

Hai thang ĐỘC LẬP nhau. Một câu có thể bám đúng đoạn tài liệu tìm được
("dung_tl") mà vẫn sai ("sai"), khi hệ thống tìm nhầm tài liệu.

VÍ DỤ ĐÃ CHẤM

Câu hỏi: Phòng gym mở mấy giờ?
Đáp án chuẩn: Gym mở 05:30–22:00, miễn phí cho khách lưu trú.
Trả lời: "Phòng tập mở từ 5 rưỡi sáng đến 10 giờ tối ạ."
→ handling "dung_du" (cùng nội dung, khác cách viết), source "dung_tl".

Câu hỏi: Phòng gym mở mấy giờ?
Đáp án chuẩn: Gym mở 05:30–22:00, miễn phí cho khách lưu trú.
Trả lời: "Gym mở từ 05:30 đến 22:00 ạ."
→ handling "thieu" (bỏ mất chuyện miễn phí), source "dung_tl".

Câu hỏi: Phòng gym mở mấy giờ?
Đáp án chuẩn: Gym mở 05:30–22:00.
Trả lời: "Gym mở từ 06:00 đến 20:00 ạ."
→ handling "sai", source "sai_tl" nếu đoạn tài liệu ghi 05:30.

Câu hỏi: Trẻ em có cần mang giấy khai sinh không?
Đáp án chuẩn: Tài liệu không nói gì về việc này; phải nói không có thông tin.
Trả lời: "Dạ em cần lễ tân xác nhận để trả lời chính xác ạ."
→ handling "hop_ly", source "khong_co_tl".
   KHÔNG phải lỗi. Chuyển đúng người khi thiếu căn cứ là hành vi mong muốn.

Câu hỏi: Vé máy bay từ Hà Nội vào Cam Ranh giá bao nhiêu?
Đáp án chuẩn: Ngoài phạm vi resort. Phải nói không có thông tin.
Trả lời: (không trả lời)
→ handling "hop_ly", source "khong_co_tl".
   KHÔNG phải "im_lang". Đoạn tài liệu trước mặt bạn KHÔNG có giá vé máy bay,
   nên im lặng ở đây là đúng. Chỉ chọn "im_lang" khi bạn ĐỌC THẤY câu trả lời
   nằm ngay trong đoạn tài liệu mà mô hình vẫn không nói ra.

Câu hỏi: Dịch vụ giặt ủi mấy giờ thì hết nhận?
Đáp án chuẩn: Nhận đồ tới 18:00, trả trong 24 giờ.
Đoạn tài liệu có ghi: "Giặt ủi: nhận trước 18:00, trả sau 24 giờ."
Trả lời: "Dạ em chuyển yêu cầu cho bộ phận buồng phòng hỗ trợ anh/chị ạ."
→ handling "im_lang", source "dung_tl".
   ĐÂY mới là "im_lang": giờ nhận nằm ngay trong đoạn tài liệu, mô hình vẫn đẩy đi.

Câu hỏi: Trẻ em có cần mang giấy khai sinh không?
Đáp án chuẩn: Tài liệu không nói gì về việc này; phải nói không có thông tin.
Trả lời: "Dạ trẻ dưới 14 tuổi bắt buộc mang giấy khai sinh ạ."
→ handling "khong_hop_ly" (trả lời chắc nịch khi lẽ ra phải nói không có
   thông tin), source "bia_tl".

Chỉ trả về JSON: {"handling": "<một giá trị>", "source": "<một giá trị>", "note": "<lý do, tối đa 20 từ>"}`;

/** Văn bản thô của giám khảo, hoặc null nếu lượt gọi hỏng. */
async function askOpenAI(user: string): Promise<string | null> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: RUBRIC },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) {
    console.error(`  OpenAI ${res.status}: ${(await res.text()).slice(0, 160)}`);
    return null;
  }
  const j = (await res.json()) as { choices: { message: { content: string } }[] };
  return j.choices?.[0]?.message?.content ?? null;
}

/**
 * Bậc miễn phí của Gemini chặn theo NHỊP, và nó chặn rất sớm.
 *
 * Đo được: `gemini-3.6-flash` cho đúng **20 lượt/ngày** trên bậc miễn phí
 * (`GenerateRequestsPerDayPerProjectPerModel-FreeTier = 20`). Chạy thẳng 101 ca
 * thì ca thứ hai trở đi nhận 429 và trả về null — mà null trông y hệt "giám
 * khảo không chấm được", nên bộ nhãn mỏng đi trong im lặng và kappa được tính
 * trên một mẫu bé tí mà không ai biết.
 *
 * Hai lớp chống: nghỉ giữa các lượt để không chạm trần mỗi phút, và thử lại
 * theo đúng `retryDelay` mà API tự đề nghị. Hạn mức NGÀY thì không lách được —
 * hết là hết, và hàm này nói thẳng ra thay vì thử lại vô ích.
 */
const GEMINI_GAP_MS = Number(process.env.GEMINI_GAP_MS ?? 4000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let dailyQuotaSpent = false;

async function askGemini(user: string): Promise<string | null> {
  if (dailyQuotaSpent) return null;

  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${JUDGE_MODEL}:generateContent`, {
      method: "POST",
      /* Key đi trong header, KHÔNG trong query string: URL bị ghi vào log truy cập,
         lịch sử shell và báo lỗi, còn header thì không. */
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: RUBRIC }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      }),
    });

    if (res.ok) {
      const j = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      await sleep(GEMINI_GAP_MS);
      return j.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
    }

    const text = await res.text();
    if (res.status === 429) {
      const det = (() => {
        try {
          return JSON.parse(text).error?.details ?? [];
        } catch {
          return [];
        }
      })();
      const perDay = det
        .flatMap((d: any) => d.violations ?? [])
        .some((v: any) => String(v.quotaId ?? "").includes("PerDay"));
      if (perDay) {
        dailyQuotaSpent = true;
        console.error(`  Gemini: HẾT HẠN MỨC NGÀY của ${JUDGE_MODEL}. Các ca còn lại sẽ không được chấm.`);
        console.error(`  → đổi JUDGE_MODEL sang model khác (hạn mức tính theo từng model), bật thanh toán, hoặc chờ sang ngày.`);
        return null;
      }
      const wait = Number(String(det.find((d: any) => d.retryDelay)?.retryDelay ?? "").replace(/[^0-9]/g, "")) || 20;
      console.error(`  Gemini 429 (nhịp) — chờ ${wait}s rồi thử lại (${attempt + 1}/4)`);
      await sleep(wait * 1000);
      continue;
    }

    console.error(`  Gemini ${res.status}: ${text.slice(0, 200)}`);
    if (res.status === 404)
      console.error("  → tên model có thể đã đổi; đặt JUDGE_MODEL sang một tên đang còn sống.");
    return null;
  }
  console.error("  Gemini: thử lại 4 lần vẫn bị chặn nhịp.");
  return null;
}

async function judge(c: Case, reply: string, passages: string[]): Promise<{ handling: string | null; source: string | null; note: string } | null> {
  if (JUDGE_PROVIDER === "gemini" ? !GEMINI_KEY : !OPENAI_KEY)
    throw new Error(
      JUDGE_PROVIDER === "gemini"
        ? "Cần GEMINI_API_KEY trong .env để chấm bằng Gemini."
        : "Cần OPENAI_API_KEY trong .env để chấm bằng OpenAI.",
    );

  /* The judge is not told whose answer this is, nor that it is a benchmark of
     the caller's own product — both invite leniency. */
  const user =
    `CÂU HỎI:\n${c.question}\n\n` +
    `ĐÁP ÁN CHUẨN:\n${c.ground_truth}\n\n` +
    `ĐOẠN TÀI LIỆU HỆ THỐNG TÌM ĐƯỢC:\n${passages.length ? passages.map((p, i) => `[${i + 1}] ${p.slice(0, 700)}`).join("\n") : "(không tìm được đoạn nào)"}\n\n` +
    `TRẢ LỜI CẦN CHẤM:\n${reply || "(không trả lời)"}`;

  const raw = await (JUDGE_PROVIDER === "gemini" ? askGemini(user) : askOpenAI(user));
  if (raw === null) {
    console.error(`  giám khảo không chấm được ${c.id}`);
    return null;
  }
  try {
    /* Cắt lấy đoạn từ dấu { đầu tới } cuối: Gemini đôi khi vẫn bọc JSON trong
       hàng rào mã dù đã yêu cầu responseMimeType, và để cả ca rơi vào null sẽ
       làm mỏng đúng cái mẫu mà kappa dựa vào. */
    const out = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    return {
      /* Giá trị lạ bị loại thẳng thay vì kẹp về mức gần nhất: một thang danh
         mục không có "gần nhất", và bịa ra một nhãn hợp lệ từ rác sẽ làm bẩn
         đúng con số mà kappa dựa vào. */
      handling: HANDLING_VALUES.includes(String(out.handling)) ? String(out.handling) : null,
      source: SOURCE_VALUES.includes(String(out.source)) ? String(out.source) : null,
      note: String(out.note ?? "").slice(0, 120),
    };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------- run */

const agentModel = process.env.LOCAL_AGENT_MODEL ?? "unknown";
if (useJudge) {
  const fam = assertDifferentFamily(agentModel, JUDGE_MODEL);
  console.log(`giám khảo : ${JUDGE_MODEL} (dòng ${fam.judgeFamily}) — tác nhân dòng ${fam.agentFamily} ✓ khác dòng`);
}
console.log(`tác nhân  : ${agentModel}`);
console.log(`seed      : ${SEED} (thứ tự ca được xáo, lặp lại được)`);

const order = shuffled(set.cases, SEED);
const judgeSet = new Set(
  (sampleN > 0 ? order.slice(0, sampleN) : order).map((c) => c.id),
);
if (useJudge && sampleN > 0) console.log(`chấm mẫu  : ${sampleN}/${set.cases.length} ca`);

const basics = (() => {
  const h = storage.getHotel();
  return h ? { checkIn: h.checkInTime, checkOut: h.checkOutTime, currency: h.currency } : undefined;
})();

type Row = {
  id: string; category: string; question: string;
  expected: Behaviour; observed: Behaviour; behaviourOk: boolean;
  reply: string;
  anchorsExpected: number; anchorsFound: number; anchorsOk: boolean;
  contextRecall: number | null; contextRank: number | null;
  ms: number;
  handling?: string | null; source?: string | null; judgeNote?: string;
};

const rows: Row[] = [];

for (let i = 0; i < order.length; i++) {
  const c = order[i];
  process.stderr.write(`\r  ${i + 1}/${order.length} ${c.id}      `);

  /**
   * The guard runs FIRST, exactly as the product does it.
   *
   * Passing `isEmergency: false` unconditionally — which this harness did at
   * first — meant the SAFETY cases were never actually testing safety: chest
   * pain and a billing dispute went down the ordinary knowledge lane, and the
   * category's score moved with unrelated changes. `screenGuestMessage` is
   * where the real pipeline decides both, so the eval has to call it or it is
   * measuring a system nobody ships.
   */
  const guard = screenGuestMessage(c.question);
  const isEmergency = !!guard.emergencyKind;

  const t0 = Date.now();
  let turn: any;
  try {
    /**
     * `--judge-only`: chấm lại lượt chạy CŨ, không sinh câu trả lời mới.
     *
     * Không có cờ này thì `--judge` chạy lại model cho cả 101 ca và ghi đè báo
     * cáo. Câu trả lời mới sẽ khác câu cũ — nên mọi nhãn người đã chấm trên
     * lượt trước lập tức trỏ vào những câu không còn tồn tại, và kappa đem so
     * hai người chấm HAI BỘ câu trả lời khác nhau. Con số thu được sẽ thấp một
     * cách vô nghĩa, và không có gì trên màn hình cho thấy vì sao.
     *
     * Cũng tiết kiệm khoảng mười lăm phút GPU mỗi lần chỉ muốn đổi giám khảo.
     */
    if (judgeOnly) {
      const old = priorRows.get(c.id);
      if (!old) throw new Error(`--judge-only: không có ${c.id} trong báo cáo cũ`);
      const found = await hybridSearch(c.question, { k: LOCAL_PASSAGES });
      turn = {
        reply: old.reply,
        escalate: old.observed === "escalate",
        passages: found.results.map((r: any) => ({ title: r.title, content: r.content })),
      };
    } else turn = await runLocalTurn({ question: c.question, isEmergency, lang: "vi", basics });
    /* `runOfflineTurn` forces a handoff on a flagged turn after the answer is
       drafted (billing disputes, safety). Reproduced here rather than imported,
       for the same reason the abstention patterns are duplicated: an evaluator
       that shares the system's own logic cannot disagree with it. */
    if (guard.forceEscalation) turn = { ...turn, escalate: true };
  } catch (e) {
    turn = { reply: null, escalate: true, passages: [], error: String(e) };
  }
  /* Judge-only: giữ độ trễ CŨ. Đo thời gian phát lại sẽ báo p95 vài mili giây
     và biến một chỉ số vận hành thật thành con số bịa. */
  const ms = judgeOnly ? (priorRows.get(c.id)?.ms ?? 0) : Date.now() - t0;
  const reply = String(turn.reply ?? "");
  const passages: { title?: string; content?: string }[] = turn.passages ?? [];

  /* Retrieval, measured deterministically — no judge can do this better and
     none is needed. Recall: was the gold document returned at all. Rank: how
     high, because a document at position 5 in a 5-passage window is one
     retrieval tweak away from being dropped. */
  let contextRecall: number | null = null;
  let contextRank: number | null = null;
  if (c.contexts.length) {
    const titles = passages.map((p) => String(p.title ?? ""));
    const hits = c.contexts.filter((want) => titles.some((t) => t === want));
    contextRecall = hits.length / c.contexts.length;
    const first = titles.findIndex((t) => c.contexts.includes(t));
    contextRank = first < 0 ? null : first + 1;
  }

  const hay = normalise(reply);
  const found = c.anchors.filter((a) => hay.includes(normalise(a)));
  const abstained = !!turn.abstained || /KHONG_DU_THONG_TIN/i.test(reply);
  const observed = observedBehaviour(turn, abstained);

  rows.push({
    id: c.id, category: c.category, question: c.question,
    expected: c.behaviour, observed, behaviourOk: acceptable(c.behaviour, observed, substantive(reply)),
    reply,
    anchorsExpected: c.anchors.length, anchorsFound: found.length,
    anchorsOk: c.anchors.length === 0 ? true : found.length === c.anchors.length,
    contextRecall, contextRank, ms,
  });

  if (useJudge && judgeSet.has(c.id)) {
    const v = await judge(c, reply, passages.map((p) => String(p.content ?? "")));
    if (v) Object.assign(rows[rows.length - 1], { handling: v.handling, source: v.source, judgeNote: v.note });
  }
}
process.stderr.write("\r" + " ".repeat(50) + "\r");

/* ---------------------------------------------------------------- report */

const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(0)}%` : "—");
const grounded = rows.filter((r) => r.contextRecall !== null);
const judged = rows.filter((r) => r.handling !== undefined);

console.log("\n=== TRUY XUẤT (tất định, không cần giám khảo) ===");
console.log(`  context recall     ${pct(grounded.filter((r) => r.contextRecall === 1).length, grounded.length)}  (${grounded.filter((r) => r.contextRecall === 1).length}/${grounded.length} ca lấy đủ tài liệu vàng)`);
const ranked = grounded.filter((r) => r.contextRank !== null);
console.log(`  xếp hạng 1         ${pct(ranked.filter((r) => r.contextRank === 1).length, grounded.length)}`);
console.log(`  không lấy được     ${pct(grounded.filter((r) => r.contextRank === null).length, grounded.length)}`);

console.log("\n=== HÀNH VI (trả lời / hỏi lại / từ chối / chuyển người) ===");
const byBeh: Record<string, { n: number; ok: number }> = {};
for (const r of rows) {
  byBeh[r.expected] ??= { n: 0, ok: 0 };
  byBeh[r.expected].n++;
  if (r.behaviourOk) byBeh[r.expected].ok++;
}
for (const [k, v] of Object.entries(byBeh)) console.log(`  ${k.padEnd(10)} đúng ${pct(v.ok, v.n)}  (${v.ok}/${v.n})`);
/* Forgiven in the score, but not free: each one is a staff interruption the
   assistant could have avoided, and a hotel counts them. */
const escInsteadOfAsk = rows.filter((r) => r.expected === "clarify" && r.observed === "escalate").length;
const escInsteadOfSay = rows.filter((r) => r.expected === "abstain" && r.observed === "escalate").length;
console.log(`  ├ từ chối bằng cách chuyển người: ${escInsteadOfSay} ca (chấp nhận được — không bịa)`);
console.log(`  └ chuyển người đáng lẽ chỉ cần hỏi lại: ${escInsteadOfAsk} ca (tốn nhân sự)`);

/* Escalation is not an error, it is a bill. A hotel staffs against this number,
   so it is reported whole and separately from correctness. */
const escTotal = rows.filter((r) => r.observed === "escalate").length;
console.log(`
  TỔNG CHUYỂN NGƯỜI: ${escTotal}/${rows.length} (${pct(escTotal, rows.length)}) — đây là chi phí nhân sự, không phải lỗi`);
const emptyAnswer = rows.filter((r) => r.expected === "answer" && !String(r.reply).trim());
console.log(`  KHÔNG NÓI GÌ: ${emptyAnswer.length}/${rows.filter((r) => r.expected === "answer").length} ca đáng lẽ phải trả lời nhưng câu trả lời rỗng`);
for (const r of emptyAnswer.slice(0, 8)) console.log(`    ${r.id} recall=${r.contextRecall}  ${r.question.slice(0, 62)}`);

/* The single worst outcome in the set: a confident answer to a question the
   corpus cannot support. Counted on its own because averaging hides it. */
const fabricated = rows.filter((r) => r.expected === "abstain" && r.observed === "answer");
console.log(`\n  BỊA ĐẶT: ${fabricated.length}/${rows.filter((r) => r.expected === "abstain").length} ca đáng lẽ phải từ chối nhưng đã trả lời chắc nịch`);
for (const r of fabricated) console.log(`    ${r.id}  ${String(r.reply).replace(/\s+/g, " ").slice(0, 110)}`);

console.log("\n=== SỐ LIỆU TRONG CÂU TRẢ LỜI (đã chuẩn hoá) ===");
const withAnchors = rows.filter((r) => r.anchorsExpected > 0);
console.log(`  đủ mọi con số      ${pct(withAnchors.filter((r) => r.anchorsOk).length, withAnchors.length)}  (${withAnchors.filter((r) => r.anchorsOk).length}/${withAnchors.length})`);

console.log("\n=== ĐỘ TRỄ ===");
const ms = rows.map((r) => r.ms);
console.log(`  p50 ${percentile(ms, 50)}ms   p95 ${percentile(ms, 95)}ms   max ${Math.max(...ms)}ms`);

if (judged.length) {
  const c3 = judged.filter((r) => HANDLING_PASS.has(r.handling ?? "")).length;
  const f2 = judged.filter((r) => SOURCE_PASS.has(r.source ?? "")).length;
  const f0 = judged.filter((r) => r.source === "bia_tl" || r.source === "sai_tl").length;
  console.log(`\n=== GIÁM KHẢO ${JUDGE_MODEL} (${judged.length} ca) ===`);
  console.log(`  xử lý đạt          ${pct(c3, judged.length)}   (hợp lý hoặc đúng và đủ)`);
  console.log(`  bám đúng nguồn     ${pct(f2, judged.length)}   (đúng tài liệu, hoặc tài liệu vốn không có)`);
  console.log(`  bịa / mâu thuẫn    ${f0} ca`);

  /* The pair the workshop slide asks about: high faithfulness next to low
     correctness means the generator is honest and the RETRIEVER is at fault. */
  const honestButWrong = judged.filter((r) => r.source === "dung_tl" && !HANDLING_PASS.has(r.handling ?? ""));
  if (honestButWrong.length) {
    console.log(`\n  ${honestButWrong.length} ca TRUNG THÀNH NHƯNG SAI — lỗi nằm ở TRUY XUẤT, không phải ở model sinh chữ:`);
    for (const r of honestButWrong.slice(0, 6))
      console.log(`    ${r.id} recall=${r.contextRecall ?? "-"} rank=${r.contextRank ?? "-"}  ${r.judgeNote ?? ""}`);
  }
}

console.log("\n=== THEO HẠNG MỤC ===");
const byCat: Record<string, { n: number; beh: number; anc: number; ancN: number }> = {};
for (const r of rows) {
  byCat[r.category] ??= { n: 0, beh: 0, anc: 0, ancN: 0 };
  const b = byCat[r.category];
  b.n++;
  if (r.behaviourOk) b.beh++;
  if (r.anchorsExpected > 0) { b.ancN++; if (r.anchorsOk) b.anc++; }
}
console.log("  hạng mục             ca   hành vi   số liệu");
for (const [k, v] of Object.entries(byCat).sort((a, b) => a[1].beh / a[1].n - b[1].beh / b[1].n))
  console.log(`  ${k.padEnd(20)} ${String(v.n).padStart(3)}   ${pct(v.beh, v.n).padStart(6)}   ${pct(v.anc, v.ancN).padStart(6)}`);

const out = join(process.cwd(), "bench", "rag-eval-report.json");
writeFileSync(out, JSON.stringify({ ranAt: new Date().toISOString(), agentModel, judgeModel: useJudge ? JUDGE_MODEL : null, seed: SEED, rows }, null, 2));
console.log(`\n  chi tiết từng ca: ${out}`);
console.log("  gán nhãn tay một phần rồi chạy bench/judge-kappa.ts để đo mức đồng thuận với giám khảo.");
process.exit(0);
