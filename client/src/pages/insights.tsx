import { useQuery } from "@tanstack/react-query";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { StaffShell } from "@/components/staff-shell";
import { UpsellPanel } from "@/components/upsell-panel";
import { Skeleton } from "@/components/ui/skeleton";
import { money, seconds, titleCase } from "@/lib/format";
import { DEPT_LABELS, type Insights } from "@/lib/types";

const AXIS = { fontSize: 11, fill: "hsl(var(--muted-foreground))" };

function tooltipStyle() {
  return {
    contentStyle: {
      background: "hsl(var(--popover))",
      border: "1px solid hsl(var(--popover-border))",
      borderRadius: 6,
      fontSize: 12,
      color: "hsl(var(--popover-foreground))",
    },
    labelStyle: { color: "hsl(var(--muted-foreground))", fontSize: 11 },
  };
}

function Kpi({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-md border border-card-border bg-card p-3" data-testid={`kpi-${label}`}>
      <div className="text-[11px] uppercase tracking-[0.1em] text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Panel({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-md border border-card-border bg-card p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      <div className="mt-3 h-56">{children}</div>
    </section>
  );
}

const SENTIMENT_COLORS: Record<string, string> = {
  positive: "hsl(var(--chart-2))",
  neutral: "hsl(var(--muted-foreground))",
  negative: "hsl(var(--destructive))",
};

/* Staff need to know how much to trust each row. A thumbs-down is the guest's
   own words; the realtime head is an inference off one message; the LLM pass
   read the whole transcript but costs a generation call and often never ran. */
const SENTIMENT_SOURCE_LABELS: Record<string, string> = {
  model_realtime: "mô hình đọc tin nhắn",
  model_llm: "LLM đọc hội thoại",
  thumbs_down: "khách bấm 👎",
  unknown: "nguồn cũ, không rõ",
};

export default function InsightsPage() {
  const { data, isLoading } = useQuery<Insights>({
    queryKey: ["/api/insights"],
    refetchInterval: 20000,
  });

  if (isLoading || !data) {
    return (
      <StaffShell title="Insights" description="Operational intelligence across the last 14 days">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      </StaffShell>
    );
  }

  const k = data.kpis;

  return (
    <StaffShell
      title="Insights"
      description="Operational intelligence across the last 14 days"
    >
      {/* Most of this page is computed over `seed.ts` demo history. That is
          fine for a demo and useless for a decision, and staff cannot tell the
          difference by looking — so say it once, at the top, with the number. */}
      {k.conversations > k.conversationsEngaged && (
        <div className="mb-4 rounded-md border border-card-border bg-muted/40 p-3 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Dữ liệu demo:</span>{" "}
          {k.conversations - k.conversationsEngaged}/{k.conversations} hội thoại là lịch sử mẫu
          (không có tin nhắn, cảm xúc và chủ đề do <code>seed.ts</code> gán ngẫu nhiên). Các panel
          “What guests ask about”, “Workload by department” và “Team load” chủ yếu đọc dữ liệu này.
          Chỉ “Guest sentiment”, “Khách đang không hài lòng” và “AI deflection” đã loại nó ra.
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi
          label="AI deflection"
          value={`${k.aiDeflectionRate}%`}
          /* Out of threads a guest actually wrote in — the old caption said
             "103 conversations handled" while 95 of those contained no messages
             at all. */
          sub={`trên ${k.conversationsEngaged} hội thoại có khách nhắn`}
        />
        <Kpi
          label="First response"
          value={seconds(k.avgFirstResponseSeconds)}
          sub={`AI ${seconds(k.aiFirstResponseSeconds)} · staff ${seconds(k.humanFirstResponseSeconds)}`}
        />
        <Kpi
          label="Resolution rate"
          value={`${k.resolutionRate}%`}
          sub={`${k.tasksOpen} open of ${k.tasksTotal} tasks`}
        />
        <Kpi
          label="Avg resolution"
          value={`${k.avgResolutionMinutes}m`}
          /* Two different promises, and the card used to name only the first
             while the breach count graded the second. */
          sub={`mục tiêu ${k.resolutionTargetMinutes}m để xử lý xong · ${k.slaMinutes}m để tiếp nhận`}
        />
        <Kpi label="Occupancy" value={`${k.occupancy}%`} sub={`${k.roomsOutOfOrder} out of order`} />
        <Kpi label="Arrivals today" value={String(k.arrivalsToday)} sub={`${k.departuresToday} departures`} />
        <Kpi
          label="Ancillary revenue"
          value={money(k.ancillaryRevenue)}
          sub="Posted to folios, incl. AI-driven upsells"
        />
        <Kpi
          label="Open workload"
          value={String(k.tasksOpen)}
          sub={`across ${data.byDept.filter((d) => d.open > 0).length} departments`}
        />
      </div>

      {/* Full width and directly under the KPIs: this is the only panel on the
          page computed entirely from live behaviour rather than seeded history,
          and it is the one a hotel is buying. */}
      <div className="mt-4">
        <UpsellPanel />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel
          title="Conversation volume & AI coverage"
          description="Daily threads, and how many the AI closed without a human"
        >
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data.series}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="date" tick={AXIS} stroke="hsl(var(--border))" />
              <YAxis tick={AXIS} stroke="hsl(var(--border))" width={28} />
              <Tooltip {...tooltipStyle()} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Area
                type="monotone"
                name="Conversations"
                dataKey="conversations"
                stroke="hsl(var(--chart-1))"
                fill="hsl(var(--chart-1))"
                fillOpacity={0.18}
                strokeWidth={2}
              />
              <Area
                type="monotone"
                name="AI handled"
                dataKey="aiHandled"
                stroke="hsl(var(--chart-2))"
                fill="hsl(var(--chart-2))"
                fillOpacity={0.18}
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        </Panel>

        <Panel title="Average resolution time" description="Minutes from request to resolved">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data.series}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="date" tick={AXIS} stroke="hsl(var(--border))" />
              <YAxis tick={AXIS} stroke="hsl(var(--border))" width={28} unit="m" />
              <Tooltip {...tooltipStyle()} />
              <Line
                type="monotone"
                name="Minutes"
                dataKey="avgResolutionMinutes"
                stroke="hsl(var(--chart-3))"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </Panel>

        <Panel title="Workload by department" description="Total raised vs still open">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={data.byDept.map((d) => ({ ...d, label: DEPT_LABELS[d.dept] ?? d.dept }))}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="label" tick={{ ...AXIS, fontSize: 10 }} stroke="hsl(var(--border))" interval={0} />
              <YAxis tick={AXIS} stroke="hsl(var(--border))" width={28} />
              <Tooltip {...tooltipStyle()} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar name="Total" dataKey="total" fill="hsl(var(--chart-1))" radius={[3, 3, 0, 0]} />
              <Bar name="Open" dataKey="open" fill="hsl(var(--chart-4))" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Panel>

        {/* Counts only what the model actually labelled. The old chart summed
            every conversation, which meant staff were mostly reading `seed.ts`
            fixtures — their mood is assigned by rand(), not classified. */}
        <Panel
          title="Guest sentiment"
          description={
            data.sentimentClassifiedTotal > 0
              ? `${data.sentimentClassifiedTotal} hội thoại được mô hình phân loại` +
                (data.sentimentSeededTotal > 0
                  ? ` · ${data.sentimentSeededTotal} hội thoại seed không tính`
                  : "")
              : "Chưa có hội thoại nào được mô hình phân loại"
          }
        >
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data.sentimentClassified}
                dataKey="count"
                nameKey="sentiment"
                innerRadius={45}
                outerRadius={75}
                paddingAngle={2}
              >
                {data.sentimentClassified.map((s) => (
                  <Cell key={s.sentiment} fill={SENTIMENT_COLORS[s.sentiment]} />
                ))}
              </Pie>
              <Tooltip {...tooltipStyle()} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        </Panel>
      </div>

      {/* A slice of a pie is not something staff can act on. This names the
          guests behind the negative slice and links into the thread. */}
      <div className="mt-4">
        <section className="rounded-md border border-card-border bg-card p-4">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">Khách đang không hài lòng</h2>
            <span className="text-xs text-muted-foreground">
              {data.unhappyGuests.length} hội thoại · bấm để mở
            </span>
          </div>
          {data.unhappyGuests.length === 0 ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Không có khách nào bị đánh dấu tiêu cực. Danh sách này chỉ tính hội thoại có tin nhắn
              thật, nên dữ liệu seed không xuất hiện ở đây.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {data.unhappyGuests.map((g) => (
                <li key={g.conversationId}>
                  <a
                    /* Hash route — the app runs on useHashLocation, so a bare
                       "/staff?c=5" would leave the SPA and reload onto the
                       guest kiosk instead of opening the thread. */
                    href={`#/staff?c=${g.conversationId}`}
                    className="block rounded-md border border-card-border p-3 hover:bg-secondary"
                    data-testid={`unhappy-${g.conversationId}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{g.guestName}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        {SENTIMENT_SOURCE_LABELS[g.source] ?? g.source}
                      </span>
                      {g.room && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                          Phòng {g.room}
                        </span>
                      )}
                      {g.vipTier && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                          {titleCase(g.vipTier)}
                        </span>
                      )}
                      {g.taskId ? (
                        <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[11px] text-destructive">
                          Task #{g.taskId} · {g.taskStatus === "open" ? "chưa nhận" : "đang xử lý"}
                        </span>
                      ) : (
                        /* Negative but nothing dispatched — either the label came
                           from the LLM conversation analyser rather than the
                           realtime head, or the task was already closed. */
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                          chưa có task
                        </span>
                      )}
                      <span className="ml-auto text-[11px] text-muted-foreground">
                        {new Date(g.at).toLocaleString()}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">“{g.message}”</p>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section className="rounded-md border border-card-border bg-card p-4">
          <h2 className="text-sm font-semibold">What guests ask about</h2>
          {/* The bars are dominated by seed history — say so here rather than
              letting the reader assume every bar is a guest who asked. */}
          <p className="mt-0.5 text-xs text-muted-foreground">
            {data.topicsRealTotal}/{data.topicsTotal} nhãn đến từ hội thoại có tin nhắn thật
          </p>
          <ul className="mt-3 space-y-2">
            {data.topics.map((t) => {
              const max = Math.max(...data.topics.map((x) => x.count), 1);
              return (
                <li key={t.topic} className="text-xs">
                  <div className="flex justify-between">
                    <span>{titleCase(t.topic)}</span>
                    <span className="font-mono text-muted-foreground">{t.count}</span>
                  </div>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${(t.count / max) * 100}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="rounded-md border border-card-border bg-card p-4">
          <h2 className="text-sm font-semibold">Team load</h2>
          {/* Tasks raised by the AI are created unassigned — there is no routing
              by department, only the manual dropdown on the tasks board. So this
              panel measures what people claimed, and says how much of that came
              from a real conversation. */}
          <p className="mt-0.5 text-xs text-muted-foreground">
            {data.staffLoadAssignedReal}/{data.staffLoadAssigned} task đã giao đến từ hội thoại thật
            {data.tasksUnassigned > 0 && (
              <> · {data.tasksUnassigned} task đang mở chưa có người nhận</>
            )}
          </p>
          <ul className="mt-3 space-y-2">
            {data.staffLoad.map((s) => (
              <li key={s.name} className="flex items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate">
                  {s.name}
                  <span className="ml-1.5 text-muted-foreground">
                    {DEPT_LABELS[s.dept] ?? s.dept}
                  </span>
                </span>
                <span className="rounded bg-chart-4/20 px-1.5 py-0.5 font-mono text-[10px] text-chart-4">
                  {s.open} open
                </span>
                <span className="rounded bg-chart-2/15 px-1.5 py-0.5 font-mono text-[10px] text-chart-2">
                  {s.done} done
                </span>
              </li>
            ))}
          </ul>
          <h3 className="mt-5 text-sm font-semibold">SLA pressure</h3>
          <ul className="mt-2 space-y-1.5">
            {data.byDept.map((d) => (
              <li key={d.dept} className="flex items-center justify-between gap-2 text-xs">
                <span>{DEPT_LABELS[d.dept] ?? d.dept}</span>
                <span className="text-muted-foreground">
                  avg <span className="font-mono">{d.avgMinutes}m</span>
                  {d.slaBreaches > 0 && (
                    <span className="ml-2 rounded bg-destructive/15 px-1.5 py-0.5 font-mono text-[10px] text-destructive">
                      {d.slaBreaches} slow
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </StaffShell>
  );
}
