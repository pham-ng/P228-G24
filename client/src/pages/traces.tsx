import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleX,
  ExternalLink,
  Radar,
  Wrench,
  Cpu,
  Search,
  ShieldCheck,
  Route as RouteIcon,
  FileText,
} from "lucide-react";
import { StaffShell } from "@/components/staff-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { stamp } from "@/lib/format";
import { signalLabel, signalHelp, SEVERITY_VI } from "@/lib/signals";

type Severity = "info" | "warn" | "error";
type Signal = { code: string; severity: Severity; detail?: string };

type TurnRow = {
  traceId: string;
  conversationId: number;
  status: "ok" | "warn" | "error";
  durationMs: number | null;
  provider: string | null;
  model: string | null;
  createdAt: string;
  signals: Signal[];
  attributes: Record<string, unknown> | null;
};

type SpanRow = {
  id: string;
  parentId: string | null;
  name: string;
  kind: "turn" | "llm" | "tool" | "retrieval" | "guard" | "wizard" | "router";
  status: "ok" | "warn" | "error";
  durationMs: number | null;
  provider: string | null;
  model: string | null;
  startedAt: string;
  signals: Signal[];
  attributes: Record<string, unknown> | null;
  error: string | null;
};

type Aggregate = {
  windowHours: number;
  turns: number;
  warnTurns: number;
  errorTurns: number;
  cleanRate: number;
  latencyMs: { p50: number; p95: number; p99: number };
  signalCounts: Record<string, number>;
  toolTrouble: Record<string, { calls: number; faults: number }>;
  langfuse: { enabled: boolean; baseUrl: string | null };
};

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

function sevClasses(sev: Severity): string {
  if (sev === "error") return "border-destructive/40 bg-destructive/10 text-destructive";
  if (sev === "warn") return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400";
  return "border-border bg-muted text-muted-foreground";
}

function StatusDot({ status }: { status: "ok" | "warn" | "error" }) {
  if (status === "error") return <CircleX className="h-4 w-4 text-destructive" />;
  if (status === "warn") return <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />;
  return <CircleCheck className="h-4 w-4 text-emerald-600" />;
}

const KIND_ICON: Record<SpanRow["kind"], typeof Cpu> = {
  turn: Activity,
  llm: Cpu,
  tool: Wrench,
  retrieval: Search,
  guard: ShieldCheck,
  router: RouteIcon,
  wizard: FileText,
};

function SignalChip({ s }: { s: Signal }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`inline-flex cursor-help items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${sevClasses(s.severity)}`}
        >
          {signalLabel(s.code)}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <p className="text-xs font-medium">
          {signalLabel(s.code)} · {SEVERITY_VI[s.severity]}
        </p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{signalHelp(s.code)}</p>
        {s.detail && <p className="mt-0.5 text-[11px] text-muted-foreground">Chi tiết: {s.detail}</p>}
        <p className="mt-1 font-mono text-[10px] text-muted-foreground/70">{s.code}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-md border border-border px-3 py-2.5">
      <p className="text-[10.5px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={`mt-0.5 text-xl font-medium tabular-nums ${
          tone === "good" ? "text-emerald-600" : tone === "bad" ? "text-destructive" : ""
        }`}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** The nested span view for one expanded turn. */
function SpanTree({ traceId }: { traceId: string }) {
  const { data, isLoading } = useQuery<SpanRow[]>({
    queryKey: ["/api/traces", traceId],
    retry: false,
  });

  if (isLoading) return <Skeleton className="h-24 w-full" />;
  if (!data?.length) return <p className="text-xs text-muted-foreground">Chưa ghi được bước nào.</p>;

  // Depth from the parent chain, so children indent under their parent.
  const byId = new Map(data.map((s) => [s.id, s]));
  const depth = (s: SpanRow): number => {
    let d = 0;
    let cur = s.parentId;
    while (cur && byId.has(cur)) {
      d++;
      cur = byId.get(cur)!.parentId;
    }
    return d;
  };

  return (
    <div className="space-y-1">
      {data.map((s) => {
        const Icon = KIND_ICON[s.kind] ?? Activity;
        return (
          <div
            key={s.id}
            className="flex items-start gap-2 rounded-md border border-border bg-background px-2.5 py-1.5"
            style={{ marginLeft: `${depth(s) * 16}px` }}
          >
            <StatusDot status={s.status} />
            <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px]">{s.name}</span>
                {s.model && <span className="text-[10px] text-muted-foreground">{s.model}</span>}
                {typeof s.durationMs === "number" && (
                  <span className="text-[10px] tabular-nums text-muted-foreground">{s.durationMs}ms</span>
                )}
              </div>
              {(s.signals.length > 0 || s.error) && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {s.signals
                    .slice()
                    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
                    .map((sig, i) => (
                      <SignalChip key={i} s={sig} />
                    ))}
                </div>
              )}
              {s.error && <p className="mt-1 text-[11px] text-destructive">{s.error}</p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function TracesPage() {
  const [open, setOpen] = useState<string | null>(null);
  const { data: agg } = useQuery<Aggregate>({
    queryKey: ["/api/observability/signals"],
    refetchInterval: 15000,
  });
  const { data: turns, isLoading, error } = useQuery<TurnRow[]>({
    queryKey: ["/api/traces"],
    refetchInterval: 15000,
  });

  const langfuse = agg?.langfuse;
  const topSignals = agg
    ? Object.entries(agg.signalCounts).sort((a, b) => b[1] - a[1])
    : [];
  const troubledTools = agg
    ? Object.entries(agg.toolTrouble)
        .filter(([, v]) => v.faults > 0)
        .sort((a, b) => b[1].faults - a[1].faults)
    : [];

  return (
    <StaffShell
      title="Nhật ký agent (Traces)"
      description="Mỗi lượt agent hiện thành cây bước xử lý — đã gọi công cụ nào, có sai không, và vì sao"
      actions={
        langfuse?.enabled ? (
          <a
            href={langfuse.baseUrl ?? "#"}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-emerald-600/40 bg-emerald-600/10 px-2.5 py-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400"
            data-testid="link-langfuse"
          >
            <Radar className="h-3.5 w-3.5" />
            Đang gửi sang Langfuse
            <ExternalLink className="h-3 w-3" />
          </a>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground">
            <Radar className="h-3.5 w-3.5" />
            Langfuse: tắt
          </span>
        )
      }
    >
      <div className="mx-auto max-w-5xl space-y-4">
        {/* Rollup */}
        {agg && (
          <>
            <div className="grid gap-2 sm:grid-cols-4">
              <Stat
                label="Lượt sạch"
                value={`${Math.round(agg.cleanRate * 100)}%`}
                hint={`${agg.turns} lượt · ${agg.windowHours} giờ qua`}
                tone={agg.cleanRate >= 0.9 ? "good" : agg.cleanRate < 0.7 ? "bad" : undefined}
              />
              <Stat label="Cảnh báo" value={String(agg.warnTurns)} hint="lượt có tín hiệu cảnh báo" />
              <Stat
                label="Lỗi"
                value={String(agg.errorTurns)}
                hint="lượt có tín hiệu lỗi"
                tone={agg.errorTurns > 0 ? "bad" : "good"}
              />
              <Stat
                label="Độ trễ"
                value={`${agg.latencyMs.p95}ms`}
                hint={`p50 ${agg.latencyMs.p50} · p99 ${agg.latencyMs.p99}`}
              />
            </div>

            {(topSignals.length > 0 || troubledTools.length > 0) && (
              <div className="grid gap-3 md:grid-cols-2">
                {topSignals.length > 0 && (
                  <div className="rounded-md border border-border p-3">
                    <p className="mb-2 text-[10.5px] uppercase tracking-wide text-muted-foreground">
                      Tín hiệu · {agg.windowHours} giờ qua
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {topSignals.map(([code, n]) => (
                        <Tooltip key={code}>
                          <TooltipTrigger asChild>
                            <span className="inline-flex cursor-help items-center gap-1.5 rounded border border-border bg-muted px-1.5 py-0.5 text-[11px]">
                              <span className="font-medium">{signalLabel(code)}</span>
                              <span className="tabular-nums text-muted-foreground">{n}</span>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs">
                            <p className="text-[11px] text-muted-foreground">{signalHelp(code)}</p>
                            <p className="mt-1 font-mono text-[10px] text-muted-foreground/70">{code}</p>
                          </TooltipContent>
                        </Tooltip>
                      ))}
                    </div>
                  </div>
                )}
                {troubledTools.length > 0 && (
                  <div className="rounded-md border border-border p-3">
                    <p className="mb-2 text-[10.5px] uppercase tracking-wide text-muted-foreground">
                      Công cụ hay lỗi
                    </p>
                    <div className="space-y-1">
                      {troubledTools.map(([name, v]) => (
                        <div key={name} className="flex items-center justify-between text-[11px]">
                          <span className="font-mono">{name}</span>
                          <span className="tabular-nums text-muted-foreground">
                            <span className="text-destructive">{v.faults}</span> / {v.calls} lượt gọi
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {isLoading && (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        )}

        {error && (
          <div className="rounded-md border border-dashed border-border px-4 py-10 text-center">
            <Activity className="mx-auto h-5 w-5 text-muted-foreground" />
            <p className="mt-2 text-sm">Chưa có nhật ký nào.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Nhật ký sẽ xuất hiện ngay khi agent trả lời một khách.
            </p>
          </div>
        )}

        {/* Turn list */}
        {turns && turns.length > 0 && (
          <div className="overflow-hidden rounded-md border border-border">
            {turns.map((t) => {
              const isOpen = open === t.traceId;
              return (
                <div key={t.traceId} className="border-b border-border last:border-b-0">
                  <button
                    type="button"
                    onClick={() => setOpen(isOpen ? null : t.traceId)}
                    className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left hover:bg-muted/40"
                    data-testid={`turn-${t.traceId}`}
                  >
                    <span className="mt-0.5 shrink-0">
                      <StatusDot status={t.status} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm">Hội thoại #{t.conversationId}</span>
                        <span className="font-mono text-[10px] text-muted-foreground">{t.provider ?? "—"}</span>
                        {typeof t.durationMs === "number" && (
                          <span className="text-[10px] tabular-nums text-muted-foreground">{t.durationMs}ms</span>
                        )}
                        <span className="text-[10px] text-muted-foreground">{stamp(t.createdAt)}</span>
                      </span>
                      {t.signals.length > 0 && (
                        <span className="mt-1 flex flex-wrap gap-1">
                          {t.signals
                            .slice()
                            .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
                            .map((s, i) => (
                              <SignalChip key={i} s={s} />
                            ))}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 shrink-0 text-muted-foreground">
                      {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </span>
                  </button>

                  {isOpen && (
                    <div className="border-t border-border bg-muted/20 px-3 py-3">
                      <SpanTree traceId={t.traceId} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {turns && turns.length === 0 && !isLoading && (
          <div className="rounded-md border border-dashed border-border px-4 py-10 text-center">
            <Activity className="mx-auto h-5 w-5 text-muted-foreground" />
            <p className="mt-2 text-sm">Chưa có nhật ký nào.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Agent chưa trả lời khách nào kể từ khi bật ghi nhật ký.
            </p>
          </div>
        )}
      </div>
    </StaffShell>
  );
}
