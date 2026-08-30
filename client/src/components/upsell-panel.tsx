import { useQuery } from "@tanstack/react-query";
import { money } from "@/lib/format";

/**
 * What the upsell suggestions actually sold.
 *
 * Every other number about the recommender was descriptive — how it ranks, what
 * signals it uses. None of them answered the question a hotel buys this for,
 * which is whether it makes money. Attach rate and per-offer conversion do.
 *
 * The empty state is deliberately explicit rather than a zero. Zero looks like
 * a broken panel; "no suggestion has been made yet" is the truth on a fresh
 * install, and it tells the reader the number will fill in on its own.
 */
export type UpsellMetricsDto = {
  impressions: number;
  guestsShown: number;
  guestsBooked: number;
  attachRate: number;
  conversions: number;
  revenue: number;
  perOffer: Array<{
    serviceId: number;
    name: string;
    shown: number;
    booked: number;
    conversion: number;
    revenue: number;
    avgScore: number;
    avgPosition: number;
  }>;
  byPosition: Array<{ position: number; shown: number; booked: number; conversion: number }>;
  byContext: Array<{ context: string; shown: number; booked: number; conversion: number }>;
};

const CONTEXT_LABELS: Record<string, string> = {
  rain: "trời mưa",
  morning: "buổi sáng",
  afternoon: "buổi chiều",
  evening: "buổi tối",
  night: "đêm",
};

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-card-border bg-card p-3">
      <div className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

/* Currency is not threaded in: every other amount on this page calls money()
   with its default, and a second source of truth for it would be one more thing
   to keep in sync for no gain. */
export function UpsellPanel() {
  const { data } = useQuery<UpsellMetricsDto>({
    queryKey: ["/api/insights/upsell"],
    refetchInterval: 30000,
  });

  if (!data) return null;

  if (data.impressions === 0) {
    return (
      <section className="rounded-md border border-card-border bg-card p-4">
        <h2 className="text-sm font-semibold">Upsell performance</h2>
        <p className="mt-2 text-xs text-muted-foreground">
          Chưa có gợi ý nào được đưa ra, nên chưa có gì để đo. Mỗi lần trợ lý gợi ý một dịch vụ, hệ
          thống ghi lại dịch vụ đó, điểm số và lý do; khi khách đặt đúng dịch vụ đã được gợi ý, lượt
          đó được tính là chuyển đổi. Bảng này sẽ tự có số.
        </p>
      </section>
    );
  }

  /* Below roughly a hundred impressions the per-offer rates move several points
     on a single booking. Saying so is cheaper than having someone act on noise. */
  const thin = data.impressions < 100;

  return (
    <section className="rounded-md border border-card-border bg-card p-4">
      <h2 className="text-sm font-semibold">Upsell performance</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Gợi ý đã đưa ra, và bao nhiêu trong số đó thành đơn thật
      </p>

      {thin && (
        <div className="mt-3 rounded-md border border-card-border bg-muted/40 p-2 text-[11px] text-muted-foreground">
          Mới {data.impressions} lượt gợi ý — tỉ lệ từng dịch vụ còn nhiễu, một đơn cũng làm lệch
          vài điểm phần trăm. Đọc cột “đã gợi ý / đã đặt” trước, tỉ lệ sau.
        </div>
      )}

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Attach rate"
          value={pct(data.attachRate)}
          sub={`${data.guestsBooked}/${data.guestsShown} khách được gợi ý đã đặt`}
        />
        <Stat label="Lượt gợi ý" value={String(data.impressions)} sub={`${data.conversions} lượt thành đơn`} />
        <Stat label="Doanh thu ghi nhận" value={money(data.revenue)} sub="từ các đơn khớp gợi ý" />
        <Stat
          label="Vị trí 1"
          value={data.byPosition[0] ? pct(data.byPosition[0].conversion) : "—"}
          sub="tỉ lệ chuyển đổi của gợi ý đầu tiên"
        />
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-card-border text-left text-muted-foreground">
              <th className="py-1.5 pr-3 font-medium">Dịch vụ</th>
              <th className="py-1.5 pr-3 text-right font-medium">Đã gợi ý</th>
              <th className="py-1.5 pr-3 text-right font-medium">Đã đặt</th>
              <th className="py-1.5 pr-3 text-right font-medium">Tỉ lệ</th>
              <th className="py-1.5 pr-3 text-right font-medium">Doanh thu</th>
              <th className="py-1.5 pr-3 text-right font-medium">Điểm TB</th>
            </tr>
          </thead>
          <tbody>
            {data.perOffer.map((o) => (
              <tr key={o.serviceId} className="border-b border-card-border/50">
                <td className="py-1.5 pr-3">{o.name}</td>
                <td className="py-1.5 pr-3 text-right font-mono tabular-nums">{o.shown}</td>
                <td className="py-1.5 pr-3 text-right font-mono tabular-nums">{o.booked}</td>
                <td className="py-1.5 pr-3 text-right font-mono tabular-nums">{pct(o.conversion)}</td>
                <td className="py-1.5 pr-3 text-right font-mono tabular-nums">{money(o.revenue)}</td>
                <td className="py-1.5 pr-3 text-right font-mono tabular-nums text-muted-foreground">
                  {o.avgScore}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* The context split is what turns the ranking's weights into something
          arguable: if "rain" converts no better than a dry afternoon, the +4 for
          rain is not earning its place. */}
      <div className="mt-4 flex flex-wrap gap-2">
        {data.byContext.map((c) => (
          <div key={c.context} className="rounded-md border border-card-border px-2.5 py-1.5 text-[11px]">
            <span className="text-muted-foreground">{CONTEXT_LABELS[c.context] ?? c.context}</span>{" "}
            <span className="font-mono tabular-nums">
              {c.booked}/{c.shown}
            </span>{" "}
            <span className="text-muted-foreground">({pct(c.conversion)})</span>
          </div>
        ))}
      </div>
    </section>
  );
}
