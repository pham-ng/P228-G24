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
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi
          label="AI deflection"
          value={`${k.aiDeflectionRate}%`}
          sub={`${k.conversations} conversations handled`}
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
          sub={`SLA target ${k.slaMinutes}m to acknowledge`}
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

        <Panel title="Guest sentiment" description="Classified per conversation by the model">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data.sentiment}
                dataKey="count"
                nameKey="sentiment"
                innerRadius={45}
                outerRadius={75}
                paddingAngle={2}
              >
                {data.sentiment.map((s) => (
                  <Cell key={s.sentiment} fill={SENTIMENT_COLORS[s.sentiment]} />
                ))}
              </Pie>
              <Tooltip {...tooltipStyle()} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        </Panel>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section className="rounded-md border border-card-border bg-card p-4">
          <h2 className="text-sm font-semibold">What guests ask about</h2>
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
          <p className="mt-0.5 text-xs text-muted-foreground">
            Open assignments and completions per person
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
