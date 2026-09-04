import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FlaskConical, AlertTriangle } from "lucide-react";
import { StaffShell } from "@/components/staff-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { stamp } from "@/lib/format";

/**
 * What the assistant was tested on, and how it did.
 *
 * This page used to render `bench/report.json` — five hand-picked cases in one
 * category, 5/5 passed, last run 2026-08-21, `judgePassed: 0`. Shown to a
 * hotel group, "100%" over five cases is the least informative number the
 * product could publish: true, unfalsifiable, and gone the moment anyone asks
 * what the five were.
 *
 * It now renders the 101-case Vietnamese golden set, whose every expected answer
 * is verified to exist in the property's own documents before the set is
 * allowed to grade anything (`bench/golden-verify.ts`). A quarter of the set —
 * 25 of 101 — is questions the assistant must NOT answer: ambiguous ones it
 * should ask back on, and ones the documents genuinely do not cover. It
 * currently answers three of them anyway, and that number is on the page.
 *
 * The last section is the part a buyer trusts most, because we did not choose
 * the questions: real guest ratings from production, each anchored to the exact
 * reply that was rated. The `feedback` table held that verdict all along and
 * nothing ever read it back.
 *
 * The weaknesses are on the page on purpose. A buyer who sees "we test eight
 * questions the system must refuse, and it currently answers two of them
 * anyway" learns that hallucination is measured here. A buyer who sees 100%
 * learns nothing and assumes the worst.
 *
 * 2026-09-04: the same 384-case set now exists in 6 languages (VI/EN/KO/JA/
 * ZH/RU) — hand-translated from one source, run through the same stack, and
 * hand-judged independently per language (see [[aurea-rag-eval]] in memory).
 * The switcher in the header re-points this exact page at
 * `bench/rag-eval-report-{lang}.json` via `?lang=`; nothing below needed to
 * change except reading that one extra field, because the shape of a
 * language's report is identical to Vietnamese's. A tab the server has no
 * file for renders disabled rather than a 404 — the point of showing this to
 * a buyer is "here is what we measured", not "here is a broken button".
 */

type Feedback = {
  total: number;
  negative: number;
  /** Bao nhiêu dòng neo được vào một câu trả lời cụ thể. */
  anchored: number;
  items: Array<{
    id: number;
    createdAt: string;
    rating: number | null;
    comment: string;
    conversationId: number | null;
    messageId: number | null;
    question: string | null;
    answer: string | null;
    usedTools: boolean | null;
    latencyMs: number | null;
  }>;
};

type Bench = {
  lang: string;
  /** Các mã ngôn ngữ mà server thực sự có file báo cáo — dùng để khoá tab chưa có dữ liệu. */
  available: string[];
  ranAt: string;
  agentModel: string;
  judgeModel: string | null;
  cases: number;
  judgeCalibrated: boolean;
  retrieval: { recall: number | null; rank1: number | null; missed: number | null };
  integrity: { fabricated: number; mustRefuse: number; silent: number; mustAnswer: number; escalated: number };
  numbers: number | null;
  latencyP50: number;
  latencyP95: number;
  byCategory: Record<string, { cases: number; behaviourOk: number; anchorCases: number; anchorOk: number }>;
  judge: { n: number; correct: number | null; faithful: number | null } | null;
  quality4: { n: number; correctness: number | null; completeness: number | null; relevance: number | null; coherence: number | null } | null;
};

const CATEGORY_VI: Record<string, { label: string; blurb: string }> = {
  FACT_SIMPLE: { label: "Sự kiện đơn giản", blurb: "Một dữ kiện, một câu trả lời" },
  FACT_MULTI: { label: "Nhiều dữ kiện", blurb: "Phải gom 2–4 dữ kiện trong một câu" },
  PRICING: { label: "Giá tiền", blurb: "Con số phải khớp tuyệt đối với tài liệu" },
  POLICY_CONDITIONAL: { label: "Chính sách có bậc", blurb: "Chọn đúng bậc phí theo giờ hoặc theo ngày" },
  AMBIGUOUS: { label: "Câu mơ hồ", blurb: "Phải hỏi lại, không được đoán" },
  UNANSWERABLE: { label: "Ngoài tài liệu", blurb: "Phải nói không có thông tin" },
  TRAP_NO_INVENT: { label: "Bẫy bịa số", blurb: "Tài liệu tự nói là thiếu số — không được tự suy" },
  TRAP_INTERNAL: { label: "Bẫy lộ nội bộ", blurb: "Quy tắc nội bộ, không được hứa với khách" },
  SAFETY: { label: "An toàn", blurb: "Cấp cứu, an ninh, tranh chấp hoá đơn" },
  /* Thêm khi bộ đề mở rộng 101 → 384 ca (xem [[aurea-rag-eval]]) — 12 hạng
     mục mới từ các ID DIAG/MULTI/ADV/NUM, giống hệt nhau ở mọi ngôn ngữ vì
     category không dịch, chỉ câu hỏi mới dịch. */
  "Dates & temporal logic": { label: "Ngày giờ", blurb: "Ngày đã qua, tháng không tồn tại, 0 đêm" },
  "Incomplete requests": { label: "Thiếu thông tin", blurb: "Phải hỏi lại trước khi báo giá hay tên phòng" },
  "Rate-calendar restrictions": { label: "Ngoài lịch giá", blurb: "Không có giá lễ/cuối tuần — không được bịa" },
  "Booking execution": { label: "Thực thi đặt phòng", blurb: "Ngày giờ hợp lệ — phải chốt đúng giá, đúng hạng phòng" },
  "Safety & escalation": { label: "An toàn & chuyển cấp", blurb: "Cấp cứu, đột nhập, giả danh — phải chuyển người ngay" },
  "Money & grounding": { label: "Tiền & căn cứ", blurb: "Số tiền đúng tài liệu, không lẫn hạng phòng/villa" },
  "Room facts & amenities": { label: "Thông tin phòng", blurb: "Diện tích, tiện nghi đúng đúng loại phòng được hỏi" },
  "Dining venues": { label: "Nhà hàng & quầy bar", blurb: "Giờ mở cửa, món ăn, giá đúng từng nơi" },
  "New Critical Tools": { label: "Thao tác nghiệp vụ", blurb: "Huỷ, đổi phòng, ghi chú — qua đúng công cụ" },
  MULTI_TURN: { label: "Nhiều lượt hội thoại", blurb: "Phải giữ đúng ngữ cảnh qua các lượt hỏi tiếp" },
  ADVERSARIAL: { label: "Câu gài bẫy", blurb: "Khách khẳng định sai — phải cải chính, không xác nhận theo" },
  NUMERIC_FACT: { label: "Số liệu thuần", blurb: "Diện tích, sức chứa, mốc giờ, phần trăm" },
};

/** Tên hiển thị của từng ngôn ngữ đã có benchmark — cờ để nhận diện nhanh khi trình bày, mã 2 chữ để gọn trong header. */
const LANGS: { code: string; flag: string; short: string; label: string }[] = [
  { code: "vi", flag: "🇻🇳", short: "VI", label: "Tiếng Việt" },
  { code: "en", flag: "🇬🇧", short: "EN", label: "Tiếng Anh" },
  { code: "ko", flag: "🇰🇷", short: "KO", label: "Tiếng Hàn" },
  { code: "ja", flag: "🇯🇵", short: "JA", label: "Tiếng Nhật" },
  { code: "zh", flag: "🇨🇳", short: "ZH", label: "Tiếng Trung" },
  { code: "ru", flag: "🇷🇺", short: "RU", label: "Tiếng Nga" },
];
/** "Tiếng Việt" → "tiếng Việt", để chèn giữa câu ("384 câu hỏi tiếng Việt"). */
const lc = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

function LangSwitcher({
  lang,
  onChange,
  available,
}: {
  lang: string;
  onChange: (lang: string) => void;
  available?: string[];
}) {
  return (
    <ToggleGroup
      type="single"
      value={lang}
      onValueChange={(v) => v && onChange(v)}
      className="shrink-0"
      data-testid="bench-lang-switcher"
    >
      {LANGS.map((l) => {
        /* available === undefined nghĩa là chưa tải lượt đầu — cho bấm hết,
           kết quả tự lộ ra 404 nếu thật sự chưa có thay vì khoá nhầm một
           ngôn ngữ đang có sẵn. */
        const known = available === undefined || available.includes(l.code);
        return (
          <ToggleGroupItem
            key={l.code}
            value={l.code}
            disabled={!known}
            title={known ? l.label : `${l.label} — chưa có báo cáo`}
            data-testid={`bench-lang-${l.code}`}
            className="gap-1 px-2 text-xs"
          >
            <span aria-hidden="true">{l.flag}</span>
            <span className="font-mono font-semibold">{l.short}</span>
          </ToggleGroupItem>
        );
      })}
    </ToggleGroup>
  );
}

const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "warn" }) {
  return (
    <div className="rounded-md border border-card-border bg-card p-3">
      <div className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">{label}</div>
      <div
        className={`mt-1 font-mono text-xl font-semibold tabular-nums ${
          tone === "warn" ? "text-destructive" : tone === "good" ? "text-chart-2" : ""
        }`}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Bar({ value }: { value: number | null }) {
  const v = value === null ? 0 : Math.round(value * 100);
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full"
        style={{
          width: `${v}%`,
          background: v >= 90 ? "hsl(var(--chart-2))" : v >= 65 ? "hsl(var(--chart-4))" : "hsl(var(--destructive))",
        }}
      />
    </div>
  );
}

export default function BenchmarkPage() {
  /* Mặc định tiếng Việt — bộ đầu tiên, và là ngôn ngữ chủ của đội quản lý
     đang xem trang này. Đổi tab chỉ đổi khoá query; react-query giữ cache
     riêng cho từng ngôn ngữ (staleTime: Infinity ở queryClient.ts) nên bấm
     qua lại giữa các ngôn ngữ đã tải không phải chờ lại. */
  const [lang, setLang] = useState("vi");
  const { data, isLoading, error } = useQuery<Bench>({ queryKey: [`/api/bench/rag?lang=${lang}`] });
  /* Bộ golden nói hệ thống ĐÃ ĐƯỢC KIỂM thế nào. Cái này nói khách thật nghĩ
     gì. Hai con số đó lệch nhau là tin hữu ích nhất trên trang. Phản hồi
     khách chỉ có ở đường sản xuất tiếng Việt nên KHÔNG đổi theo tab ngôn ngữ. */
  const { data: fb } = useQuery<Feedback>({ queryKey: ["/api/feedback"] });

  const langMeta = LANGS.find((l) => l.code === lang) ?? LANGS[0];
  const switcher = <LangSwitcher lang={lang} onChange={setLang} available={data?.available} />;

  if (isLoading) {
    return (
      <StaffShell title="Benchmark" description={`Bộ câu hỏi vàng ${lc(langMeta.label)}`} actions={switcher}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      </StaffShell>
    );
  }

  if (error || !data) {
    return (
      <StaffShell title="Benchmark" description={`Bộ câu hỏi vàng ${lc(langMeta.label)}`} actions={switcher}>
        <div className="rounded-md border border-card-border bg-card p-6 text-sm text-muted-foreground">
          <FlaskConical className="mb-2 h-5 w-5" />
          Chưa chạy bộ eval cho {lc(langMeta.label)}. Chạy{" "}
          <code className="font-mono text-xs">npx tsx bench/run461.ts --lang {lang}</code> rồi tải lại trang.
        </div>
      </StaffShell>
    );
  }

  const i = data.integrity;
  const cats = Object.entries(data.byCategory).sort(
    (a, b) => a[1].behaviourOk / a[1].cases - b[1].behaviourOk / b[1].cases,
  );

  return (
    <StaffShell
      title="Benchmark"
      description={`${data.cases} câu hỏi ${lc(langMeta.label)} · ${data.agentModel} · chạy ${stamp(data.ranAt)}`}
      actions={switcher}
    >
      {/* Scope before numbers. Every figure below is about one property's own
          documents, in one language, on one model — and a reader who takes it
          for a general claim will be disappointed by their own pilot. */}
      <div className="mb-4 rounded-md border border-card-border bg-muted/40 p-3 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Phạm vi:</span> {data.cases} câu {lc(langMeta.label)}, dịch tay
        từ cùng một bộ câu hỏi gốc dựa trên chính tài liệu của resort này — nên {data.available.length} ngôn ngữ đang
        có ở đây so sánh được với nhau. Mỗi đáp án chuẩn đều được kiểm tra là <b>có thật trong tài liệu</b> trước khi
        bộ này được dùng để chấm.{" "}
        <b>
          {i.mustRefuse} trong {data.cases} ca là câu hệ thống KHÔNG được trả lời
        </b>{" "}
        (phải hỏi lại, hoặc phải nói là không có thông tin). Đây là số của một khách sạn, một model — đổi theo tab là
        ngôn ngữ khách dùng để hỏi, không phải đổi tài liệu hay đổi hệ thống.
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Lấy đúng tài liệu"
          value={pct(data.retrieval.recall)}
          sub={`xếp hạng 1: ${pct(data.retrieval.rank1)}`}
          tone={(data.retrieval.recall ?? 0) >= 0.85 ? "good" : undefined}
        />
        <Stat
          label="Số liệu chính xác"
          value={pct(data.numbers)}
          sub="giá, giờ, phần trăm — đã chuẩn hoá cách viết"
        />
        <Stat
          label="Bịa khi không có dữ liệu"
          value={`${i.fabricated}/${i.mustRefuse}`}
          sub="ca phải từ chối nhưng đã trả lời chắc nịch"
          tone={i.fabricated > 0 ? "warn" : "good"}
        />
        <Stat
          label="Chuyển nhân viên"
          value={`${Math.round((i.escalated / data.cases) * 100)}%`}
          sub={`${i.escalated}/${data.cases} lượt — chi phí nhân sự, không phải lỗi`}
        />
      </div>

      <section className="mt-4 rounded-md border border-card-border bg-card p-4">
        <h2 className="text-sm font-semibold">Theo loại câu hỏi</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Cột <b>hành vi</b>: có làm đúng việc cần làm không (trả lời / hỏi lại / từ chối / chuyển người).
          Cột <b>số liệu</b>: mọi con số trong câu trả lời có khớp tài liệu không.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-card-border text-left text-muted-foreground">
                <th className="py-1.5 pr-3 font-medium">Loại</th>
                <th className="py-1.5 pr-3 text-right font-medium">Ca</th>
                <th className="py-1.5 pr-3 font-medium" style={{ width: "34%" }}>Hành vi</th>
                <th className="py-1.5 pr-3 text-right font-medium">Số liệu</th>
              </tr>
            </thead>
            <tbody>
              {cats.map(([key, v]) => {
                const meta = CATEGORY_VI[key] ?? { label: key, blurb: "" };
                return (
                  <tr key={key} className="border-b border-card-border/50">
                    <td className="py-2 pr-3">
                      <div className="font-medium">{meta.label}</div>
                      <div className="text-[11px] text-muted-foreground">{meta.blurb}</div>
                    </td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums">{v.cases}</td>
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-2">
                        <Bar value={v.behaviourOk / v.cases} />
                        <span className="w-9 shrink-0 text-right font-mono tabular-nums">
                          {Math.round((v.behaviourOk / v.cases) * 100)}%
                        </span>
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums text-muted-foreground">
                      {v.anchorCases ? `${Math.round((v.anchorOk / v.anchorCases) * 100)}%` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section className="rounded-md border border-card-border bg-card p-4">
          <h2 className="text-sm font-semibold">Những chỗ còn yếu</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Để ở đây có chủ đích. Một hệ thống không công bố chỗ yếu là một hệ thống chưa đo.
          </p>
          <ul className="mt-3 space-y-2 text-xs">
            <li className="flex gap-2">
              <AlertTriangle className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${i.fabricated ? "text-destructive" : "text-muted-foreground"}`} />
              <span>
                <b>{i.fabricated}/{i.mustRefuse}</b> ca đáng lẽ phải nói &ldquo;không có thông tin&rdquo; nhưng đã
                trả lời như thật.
              </span>
            </li>
            <li className="flex gap-2">
              <AlertTriangle className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${i.silent ? "text-chart-4" : "text-muted-foreground"}`} />
              <span>
                <b>{i.silent}/{i.mustAnswer}</b> ca trả lời được nhưng hệ thống im lặng và chuyển nhân viên.
              </span>
            </li>
            <li className="flex gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span>
                Truy xuất trượt <b>{pct(data.retrieval.missed)}</b> số ca — tài liệu có trong kho nhưng không được
                lấy lên.
              </span>
            </li>
          </ul>
        </section>

        <section className="rounded-md border border-card-border bg-card p-4">
          <h2 className="text-sm font-semibold">Thời gian trả lời</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Chạy hoàn toàn trên máy của khách sạn, không gửi ra ngoài.</p>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Stat label="Trung vị" value={`${(data.latencyP50 / 1000).toFixed(1)}s`} />
            <Stat label="p95" value={`${(data.latencyP95 / 1000).toFixed(1)}s`} sub="lượt chậm nhất trong 20 lượt" />
          </div>
        </section>
      </div>

      {/* The judge is a second model reading the answers. Its numbers are worth
          nothing until someone has checked it agrees with a person, so they are
          not rendered until that check exists. */}
      <section className="mt-4 rounded-md border border-card-border bg-card p-4">
        <h2 className="text-sm font-semibold">Chấm ngữ nghĩa bằng model độc lập</h2>
        {data.judge && data.judgeCalibrated ? (
          <>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {data.judgeModel} chấm {data.judge.n} ca — khác dòng model với trợ lý, và đã được đối chiếu với người
              chấm tay.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Stat label="Xử lý đạt" value={pct(data.judge.correct)} sub="đúng và đủ, hoặc chuyển đúng người" />
              <Stat label="Bám đúng nguồn" value={pct(data.judge.faithful)} sub="không bịa, không nói ngược tài liệu" />
            </div>
          </>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            {data.judge
              ? `${data.judgeModel} đã chấm ${data.judge.n} ca, nhưng kết quả CHƯA được hiển thị: chưa ai đối chiếu nó với người chấm tay.`
              : "Chưa chạy phần chấm bằng model."}{" "}
            Một giám khảo chưa hiệu chuẩn chỉ là một ý kiến có dấu thập phân. Cần gán nhãn tay ≥40 ca rồi chạy{" "}
            <code className="font-mono">bench/judge-kappa.ts</code>; đạt κ ≥ 0,61 thì số mới hiện ở đây.
          </p>
        )}
      </section>

      {/**
        * "4 Chiều Chất Lượng Output" (Correctness/Completeness/Relevance/
        * Coherence — khung AICB·Evaluation). Correctness/Completeness quy ra
        * từ đúng-nguồn/đúng-đủ đã chấm ở trên; Relevance/Coherence là 2 trục
        * MỚI, chấm tay riêng trên toàn bộ 384 ca (xem
        * bench/data/relevance-coherence-audit.json). Không đặt sau cùng gate
        * judgeCalibrated (kappa với người chấm tay ĐỘC LẬP THỨ HAI) vì đây là
        * một lượt đọc trực tiếp của chính chúng tôi, không phải một model
        * đang được kiểm định — nói rõ điều đó thay vì giấu số.
        */}
      {data.quality4 && (
        <section className="mt-4 rounded-md border border-card-border bg-card p-4">
          <h2 className="text-sm font-semibold">4 chiều chất lượng output</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Chấm tay trực tiếp trên {data.quality4.n} ca — chưa đối chiếu với người chấm tay độc lập thứ hai (khác gate
            với "Chấm ngữ nghĩa" ở trên). Coherence tính trên đường local-agent.ts thuần; sản xuất luôn điền lại câu rõ
            ràng trước khi khách thấy nên số thật ở production cao hơn số này.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-4">
            <Stat label="Correctness" value={pct(data.quality4.correctness)} sub="đúng sự thật, không hallucinate" />
            <Stat label="Completeness" value={pct(data.quality4.completeness)} sub="đủ ý, không bỏ sót" />
            <Stat label="Relevance" value={pct(data.quality4.relevance)} sub="đúng câu hỏi, không lạc đề" />
            <Stat label="Coherence" value={pct(data.quality4.coherence)} sub="dễ đọc, có cấu trúc" />
          </div>
        </section>
      )}

      {/**
        * Điểm khách chấm trong vận hành thật.
        *
        * Bộ golden là 101 câu do chúng tôi chọn; phần này là những câu khách
        * thật sự hỏi và thật sự chê. Một sản phẩm chỉ trưng bộ đề tự ra thì
        * người mua có quyền nghi ngờ — chỗ này là nơi cái nghi ngờ đó được
        * trả lời, kể cả khi câu trả lời chưa đẹp.
        */}
      <section className="mt-4 rounded-md border border-card-border bg-card p-4">
        <h2 className="text-sm font-semibold">Khách chấm gì trong thực tế</h2>
        {lang !== "vi" && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            Phần này luôn là dữ liệu sản xuất tiếng Việt — resort đang vận hành ở một ngôn ngữ, nên nó không đổi theo
            tab benchmark bên trên.
          </p>
        )}
        {!fb ? (
          <p className="mt-2 text-xs text-muted-foreground">Đang tải…</p>
        ) : fb.total === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Chưa có khách nào chấm câu trả lời. Đây không phải điểm tốt hay xấu — chỉ là chưa có dữ liệu. Nút đánh giá
            nằm dưới mỗi câu trả lời trong màn hình khách.
          </p>
        ) : (
          <>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <Stat label="Lượt chấm" value={String(fb.total)} />
              <Stat
                label="Chấm sai"
                value={String(fb.negative)}
                sub={fb.total ? `${Math.round((fb.negative / fb.total) * 100)}% số lượt` : undefined}
                tone={fb.negative > 0 ? "warn" : "good"}
              />
              <Stat
                label="Neo được vào câu trả lời"
                value={`${fb.anchored}/${fb.total}`}
                sub={fb.anchored < fb.total ? "phần còn lại chấm trước khi có cột message_id" : undefined}
              />
            </div>

            {fb.items.filter((i) => (i.rating ?? 3) < 3).length > 0 && (
              <div className="mt-4 space-y-2">
                <p className="text-xs font-medium text-muted-foreground">Những câu trả lời bị chê</p>
                {fb.items
                  .filter((i) => (i.rating ?? 3) < 3)
                  .slice(0, 8)
                  .map((i) => (
                    <div key={i.id} className="rounded border border-card-border p-2.5 text-xs" data-testid="fb-row">
                      {i.question ? (
                        <p className="font-medium text-foreground">Khách hỏi: {i.question}</p>
                      ) : (
                        <p className="italic text-muted-foreground">
                          Không biết khách hỏi gì — lượt chấm này không neo vào câu trả lời nào.
                        </p>
                      )}
                      {i.answer && (
                        <p className="mt-1 line-clamp-3 text-muted-foreground">
                          Trợ lý đáp: {i.answer}
                        </p>
                      )}
                      {i.comment && <p className="mt-1 text-destructive">Khách nói: {i.comment}</p>}
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {stamp(i.createdAt)}
                        {i.usedTools === false && " · trả lời không tra tài liệu"}
                        {i.latencyMs != null && ` · ${(i.latencyMs / 1000).toFixed(1)}s`}
                        {i.conversationId != null && ` · hội thoại #${i.conversationId}`}
                      </p>
                    </div>
                  ))}
              </div>
            )}
          </>
        )}
      </section>
    </StaffShell>
  );
}
