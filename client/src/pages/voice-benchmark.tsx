import { useQuery } from "@tanstack/react-query";
import { Mic, AlertTriangle } from "lucide-react";
import { StaffShell } from "@/components/staff-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { stamp } from "@/lib/format";

/**
 * STT/TTS theo ngôn ngữ — chưa từng có độ đo cụ thể trước trang này.
 *
 * Renders `bench/voice-eval-report.json` (bench/voice-eval.ts). Cùng triết lý
 * với trang Benchmark (RAG): công bố số, kể cả số xấu, và nói RÕ số đó đo được
 * gì và KHÔNG đo được gì — một hệ thống không công bố chỗ yếu là một hệ thống
 * chưa đo.
 *
 * ĐIỂM KHÁC BIỆT LỚN VỚI TRANG BENCHMARK RAG, và vì sao: không có kho ghi âm
 * khách thật, và MOS (người nghe chấm giọng đọc 1-5) không script nào làm thay
 * được. Số ở đây là VÒNG KHÉP KÍN — tổng hợp câu tham chiếu bằng chính TTS sản
 * xuất, đọc lại bằng chính STT sản xuất, so với câu gốc — nên nó đo được "hai
 * nửa pipeline có hiểu nhau không", KHÔNG đo được "một người Hàn thật nói vào
 * mic thì sao". Coi đây là SÀN so sánh giữa các ngôn ngữ, không phải con số
 * đưa cho khách hàng thay ghi âm thật.
 *
 * 2026-09-05: dựng từ đầu. Bộ câu test mở rộng từ 22 ca (10 vi, 2-4 ngôn ngữ
 * khác) lên 60 ca (10 mỗi ngôn ngữ, cùng 10 tình huống dịch song song) — lặp
 * lại đúng bài học đã rút ra từ benchmark RAG: so sánh n=10 với n=10, không so
 * n=10 với n=2. Tiếng Nhật hiện KHÔNG chạy được trên máy đo (thiếu venv Python
 * .venv-tts-ja) — trang này nói thẳng điều đó thay vì im lặng bỏ qua.
 */

type VoiceLang = {
  cases: number;
  ttsUnavailable?: boolean;
  note?: string;
  voice?: string;
  wer?: number;
  cer?: number;
  numberAccuracy?: number;
  polarityAccuracy?: number;
  ttsRtfP50?: number;
  ttsRtfP95?: number;
  ttsMsP50?: number;
  sttRtfP50?: number;
  sttRtfP95?: number;
  cases_detail?: Array<{ id: string; ref: string; hyp: string; wer: number; cer: number; numbersRight: boolean; polarityRight: boolean }>;
};

type VoiceBench = {
  ranAt: string;
  source: string;
  perLanguage: Record<string, VoiceLang>;
};

const LANG_LABEL: Record<string, { flag: string; label: string; hasSpaces: boolean }> = {
  vi: { flag: "🇻🇳", label: "Tiếng Việt", hasSpaces: true },
  en: { flag: "🇬🇧", label: "Tiếng Anh", hasSpaces: true },
  ko: { flag: "🇰🇷", label: "Tiếng Hàn", hasSpaces: true },
  ja: { flag: "🇯🇵", label: "Tiếng Nhật", hasSpaces: false },
  zh: { flag: "🇨🇳", label: "Tiếng Trung", hasSpaces: false },
  ru: { flag: "🇷🇺", label: "Tiếng Nga", hasSpaces: true },
};
/* Ngôn ngữ có WER đo được xếp trước; hai ngôn ngữ WER không có ý nghĩa
   (không khoảng trắng — xem `hasSpaces` ở LANG_LABEL) xếp cuối cùng, để cách
   trình bày khớp với ghi chú * bên dưới bảng thay vì xen kẽ khó theo dõi. */
const LANG_ORDER = ["vi", "en", "ko", "ru", "zh", "ja"];

const pct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${Math.round(n * 100)}%`);

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

export default function VoiceBenchmarkPage() {
  const { data, isLoading, error } = useQuery<VoiceBench>({ queryKey: ["/api/bench/voice"] });

  if (isLoading) {
    return (
      <StaffShell title="Giọng nói" description="Đo STT + TTS theo ngôn ngữ">
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
      <StaffShell title="Giọng nói" description="Đo STT + TTS theo ngôn ngữ">
        <div className="rounded-md border border-card-border bg-card p-6 text-sm text-muted-foreground">
          <Mic className="mb-2 h-5 w-5" />
          Chưa chạy bộ đo. Chạy <code className="font-mono text-xs">npx tsx bench/voice-eval.ts</code> rồi tải lại
          trang.
        </div>
      </StaffShell>
    );
  }

  const langs = LANG_ORDER.filter((l) => data.perLanguage[l]);
  const active = langs.filter((l) => (data.perLanguage[l]?.cases ?? 0) > 0);
  const avgWerActive =
    active.length > 0
      ? active.reduce((s, l) => s + (data.perLanguage[l].wer ?? 0), 0) / active.length
      : null;

  return (
    <StaffShell
      title="Giọng nói"
      description={`STT + TTS, ${active.length}/${langs.length} ngôn ngữ đo được · chạy ${stamp(data.ranAt)}`}
    >
      <div className="mb-4 rounded-md border border-card-border bg-muted/40 p-3 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Phạm vi:</span> {data.source}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Ngôn ngữ đo được"
          value={`${active.length}/${langs.length}`}
          sub={active.length < langs.length ? "xem cột 'Sẵn sàng' bên dưới" : "cả 6 ngôn ngữ có TTS máy chủ"}
          tone={active.length < langs.length ? "warn" : "good"}
        />
        <Stat
          label="WER trung bình"
          value={pct(avgWerActive)}
          sub="chỉ trên các ngôn ngữ đo được — xem ghi chú về tiếng Trung/Nhật"
        />
        <Stat
          label="TTS RTF (điển hình)"
          value={active.length ? (data.perLanguage[active[0]].ttsRtfP50 ?? 0).toFixed(2) : "—"}
          sub="giây tổng hợp / giây âm thanh — Piper, không GPU"
        />
        <Stat
          label="STT RTF (điển hình)"
          value={active.length ? (data.perLanguage[active[0]].sttRtfP50 ?? 0).toFixed(2) : "—"}
          sub="Whisper đệm lên 30s — số này là sàn, không phải độ trễ thật"
        />
      </div>

      <section className="mt-4 rounded-md border border-card-border bg-card p-4">
        <h2 className="text-sm font-semibold">Theo ngôn ngữ</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          <b>WER/CER</b>: câu tham chiếu tự tổng hợp rồi đọc lại có khớp không — càng thấp càng tốt.{" "}
          <b>Số liệu/Phủ định</b>: con số dictate (giờ, số phòng) và câu phủ định (&ldquo;không mát&rdquo;) có sống
          sót qua vòng khép kín không — đây là hai lỗi tốn tiền nhất, không phải hai điểm phần trăm.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-card-border text-left text-muted-foreground">
                <th className="py-1.5 pr-3 font-medium">Ngôn ngữ</th>
                <th className="py-1.5 pr-3 text-right font-medium">Ca</th>
                <th className="py-1.5 pr-3 text-right font-medium">WER</th>
                <th className="py-1.5 pr-3 text-right font-medium">CER</th>
                <th className="py-1.5 pr-3 text-right font-medium">Số liệu</th>
                <th className="py-1.5 pr-3 text-right font-medium">Phủ định</th>
                <th className="py-1.5 pr-3 text-right font-medium">TTS RTF</th>
                <th className="py-1.5 pr-3 text-right font-medium">STT RTF</th>
              </tr>
            </thead>
            <tbody>
              {langs.map((code) => {
                const v = data.perLanguage[code];
                const meta = LANG_LABEL[code] ?? { flag: "", label: code, hasSpaces: true };
                if (!v.cases) {
                  return (
                    <tr key={code} className="border-b border-card-border/50">
                      <td className="py-2 pr-3">
                        <span className="mr-1.5">{meta.flag}</span>
                        {meta.label}
                      </td>
                      <td colSpan={7} className="py-2 pr-3 text-muted-foreground">
                        <span className="inline-flex items-center gap-1.5">
                          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-chart-4" />
                          {v.note ?? "Không đo được."}
                        </span>
                      </td>
                    </tr>
                  );
                }
                return (
                  <tr key={code} className="border-b border-card-border/50">
                    <td className="py-2 pr-3">
                      <span className="mr-1.5">{meta.flag}</span>
                      {meta.label}
                      {v.voice && <div className="text-[11px] text-muted-foreground">{v.voice}</div>}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums">{v.cases}</td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums">
                      {!meta.hasSpaces ? (
                        <span className="text-muted-foreground" title="Không có khoảng trắng phân từ — WER không đo được cho ngôn ngữ này, xem CER">
                          — *
                        </span>
                      ) : (
                        pct(v.wer)
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums">{pct(v.cer)}</td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums">{pct(v.numberAccuracy)}</td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums">{pct(v.polarityAccuracy)}</td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums text-muted-foreground">
                      {v.ttsRtfP50?.toFixed(2) ?? "—"}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums text-muted-foreground">
                      {v.sttRtfP50?.toFixed(2) ?? "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          * Tiếng Trung và tiếng Nhật không có khoảng trắng giữa các từ, nên WER (đo theo &ldquo;từ&rdquo;) không có ý
          nghĩa — một câu sai một chữ bị tính hỏng nguyên câu. CER (đo theo ký tự) là con số đáng tin cho hai ngôn ngữ
          này, giống hệt lý do CER quan trọng hơn WER với dấu thanh tiếng Việt.
        </p>
      </section>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section className="rounded-md border border-card-border bg-card p-4">
          <h2 className="text-sm font-semibold">Những chỗ còn yếu</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Để ở đây có chủ đích. Một hệ thống không công bố chỗ yếu là một hệ thống chưa đo.
          </p>
          <ul className="mt-3 space-y-2 text-xs">
            <li className="flex gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-chart-4" />
              <span>
                <b>Giọng đọc tiếng Nhật chậm hơn hẳn 5 ngôn ngữ kia</b> — RTF ~1,0 (bằng đúng độ dài câu nói) so với
                ~0,1-0,17 của Piper, vì phải qua một bước phiên âm Python riêng trước khi đưa vào Kokoro. Một câu dài
                6 giây thì khách đợi 6 giây mới nghe tiếng đầu tiên.
              </span>
            </li>
            <li className="flex gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-chart-4" />
              <span>
                <b>Số liệu/phủ định của KO/ZH/RU chấm khắt khe hơn thật tế.</b> Bộ chấm chuẩn hoá số đọc thành chữ
                ("bảy giờ" ≡ "7 giờ") chỉ cho tiếng Việt và tiếng Anh; tiếng Hàn/Trung/Nga chưa có bảng quy đổi tương
                ứng, nên một câu trả lời ĐÚNG nhưng viết số theo cách khác ("두 명" so với "2명") vẫn bị tính là khớp
                sai. Số ở các ngôn ngữ này là SÀN — số thật cao hơn số hiển thị.
              </span>
            </li>
            <li className="flex gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span>
                Tên riêng nước ngoài phiên âm sai khi đi qua giọng bản xứ — ví dụ nhà hàng "Lotus" ra "Латас" trong bản
                tiếng Nga, "루터스" thay vì đúng cách phiên âm trong bản tiếng Hàn. Đây là giới hạn chung của TTS đa
                ngôn ngữ với tên riêng ngoại lai, không phải lỗi riêng của hệ thống này.
              </span>
            </li>
          </ul>
        </section>

        <section className="rounded-md border border-card-border bg-card p-4">
          <h2 className="text-sm font-semibold">Đã sửa / đã đo và quyết định</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Phát hiện khi đọc lại đường đi thật của một câu đọc, và khi thử tìm model chuyên biệt cho từng ngôn ngữ.</p>
          <ul className="mt-3 space-y-2 text-xs">
            <li className="flex gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-chart-2" />
              <span>
                <b>Tiếng Nhật giờ có giọng máy chủ</b> — trước đây thiếu môi trường Python trên đúng máy phục vụ khách
                (<code className="font-mono">.venv-tts-ja</code> + trọng số Kokoro), đã dựng lại. Nhưng STT tiếng Nhật
                VẪN dùng model đa ngôn ngữ chung — đã thử model chuyên biệt (moonshine-base-ja) và nó THUA (CER 28%
                so với 19,5% hiện tại), nên không đổi. Không phải ngôn ngữ nào cũng có model chuyên biệt tốt hơn.
              </span>
            </li>
            <li className="flex gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-chart-2" />
              <span>
                Nút đọc bằng giọng máy chủ gửi thẳng văn bản có markdown (không lọc <code className="font-mono">**đậm**</code>,
                bảng, gạch đầu dòng) — trong khi nhánh giọng thiết bị đã lọc từ trước. Chưa gây hại vì model hiện không
                sinh markdown, nhưng đã vá trước khi nó gây hại.
              </span>
            </li>
            <li className="flex gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-chart-2" />
              <span>
                Câu trả lời dài hơn 600 ký tự (~1% câu trả lời thật) từng bị từ chối thẳng 400 thay vì được đọc 600 ký
                tự đầu — dù hàm tổng hợp đã tự cắt đúng độ dài đó nếu request lọt qua được. Trên ngôn ngữ không có
                giọng thiết bị dự phòng, nút đọc bị câm hoàn toàn. Đã tách ranh giới xác thực khỏi ranh giới đọc.
              </span>
            </li>
            <li className="flex gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-chart-2" />
              <span>
                Tiếng Hàn/Trung đổi sang model STT chuyên biệt (đo trực tiếp, chỉ đổi vì tốt hơn thật): CER tiếng Hàn
                17,6%→14,5%, tiếng Trung 21,4%→13,9% (kèm chuẩn hoá phồn thể/giản thể). Việc nới ngân sách token để
                hết cắt cụt câu tiếng Hàn từng gây lặp nguyên câu ở một ca — đã vá thêm một luật chung trong bộ lọc
                transcript, áp dụng cho mọi ngôn ngữ.
              </span>
            </li>
          </ul>
        </section>
      </div>
    </StaffShell>
  );
}
