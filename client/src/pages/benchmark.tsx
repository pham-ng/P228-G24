import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, XCircle, ChevronDown, ChevronRight, FlaskConical } from "lucide-react";
import { StaffShell } from "@/components/staff-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { stamp } from "@/lib/format";

type Check = { name: string; ok: boolean; detail?: string };
type Judge = {
  verdict?: string;
  reason?: string;
  grounded?: number;
  correct_handling?: number;
  asked_for_missing?: number;
  no_overpromise?: number;
  tone?: number;
};
type Result = {
  id: string;
  title: string;
  category: string;
  channel: string;
  conversationId?: number;
  turns: { guest: string; ai: string }[];
  tools: string[];
  checks: Check[];
  deterministicPass: boolean;
  judge: (Judge & { votes?: string }) | null;
  pass: boolean;
};
type Report = {
  ranAt: string;
  hotelDate: string;
  timezone: string;
  total: number;
  passed: number;
  deterministicPassed: number;
  judgePassed: number;
  byCategory: Record<string, { passed: number; total: number }>;
  results: Result[];
};

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-border px-3 py-2.5">
      <p className="text-[10.5px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-xl font-medium tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

export default function BenchmarkPage() {
  const [open, setOpen] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery<Report>({
    queryKey: ["/api/bench/report"],
    retry: false,
  });

  return (
    <StaffShell
      title="Benchmark"
      description="How the agent scores on hotel edge cases — reversed dates, missing facts, restrictions, safety"
    >
      <div className="mx-auto max-w-5xl space-y-4">
        {isLoading && (
          <div className="grid gap-2 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        )}

        {error && (
          <div className="rounded-md border border-dashed border-border px-4 py-10 text-center">
            <FlaskConical className="mx-auto h-5 w-5 text-muted-foreground" />
            <p className="mt-2 text-sm">No benchmark run on record.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Run <span className="font-mono">node bench/run.mjs</span> against this server; every case talks to the
              live agent and the live database, then the report appears here.
            </p>
          </div>
        )}

        {data && (
          <>
            <div className="grid gap-2 sm:grid-cols-4">
              <Stat
                label="Cases passed"
                value={`${data.passed}/${data.total}`}
                hint={`${Math.round((data.passed / data.total) * 100)}% of the suite`}
              />
              <Stat
                label="Deterministic"
                value={`${data.deterministicPassed}/${data.total}`}
                hint="tools, validation codes, database end state"
              />
              <Stat label="LLM judge" value={`${data.judgePassed}/${data.total}`} hint="grounding, handling, tone" />
              <Stat label="Run" value={data.hotelDate} hint={`${stamp(data.ranAt)} · ${data.timezone}`} />
            </div>

            <div className="flex flex-wrap gap-1.5">
              {Object.entries(data.byCategory).map(([cat, v]) => (
                <Badge
                  key={cat}
                  variant={v.passed === v.total ? "secondary" : "outline"}
                  className="font-normal"
                  data-testid={`category-${cat}`}
                >
                  {cat} {v.passed}/{v.total}
                </Badge>
              ))}
            </div>

            <div className="overflow-hidden rounded-md border border-border">
              {data.results.map((r) => {
                const isOpen = open === r.id;
                return (
                  <div key={r.id} className="border-b border-border last:border-b-0">
                    <button
                      type="button"
                      onClick={() => setOpen(isOpen ? null : r.id)}
                      className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left hover:bg-muted/40"
                      data-testid={`case-${r.id}`}
                    >
                      <span className="mt-0.5 shrink-0">
                        {r.pass ? (
                          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                        ) : (
                          <XCircle className="h-4 w-4 text-destructive" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="font-mono text-[11px] text-muted-foreground">{r.id}</span>
                          <span className="truncate text-sm">{r.title}</span>
                        </span>
                        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                          {r.category} · {r.tools.length ? [...new Set(r.tools)].join(", ") : "no tools"}
                        </span>
                      </span>
                      <span className="mt-0.5 shrink-0 text-muted-foreground">
                        {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </span>
                    </button>

                    {isOpen && (
                      <div className="space-y-3 border-t border-border bg-muted/20 px-3 py-3">
                        <div className="space-y-2">
                          {r.turns.map((t, i) => (
                            <div key={i} className="space-y-1">
                              <p className="text-xs">
                                <span className="text-muted-foreground">Guest · </span>
                                {t.guest}
                              </p>
                              <p className="whitespace-pre-line rounded-md border border-border bg-background px-2.5 py-2 text-xs">
                                {t.ai}
                              </p>
                            </div>
                          ))}
                        </div>

                        <ul className="space-y-1">
                          {r.checks.map((c, i) => (
                            <li key={i} className="flex items-start gap-1.5 text-[11px]">
                              {c.ok ? (
                                <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600" />
                              ) : (
                                <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />
                              )}
                              <span>
                                {c.name}
                                {c.detail ? <span className="text-muted-foreground"> — {c.detail}</span> : null}
                              </span>
                            </li>
                          ))}
                          {r.judge && (
                            <li className="flex items-start gap-1.5 text-[11px]">
                              {r.judge.verdict === "pass" ? (
                                <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600" />
                              ) : (
                                <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />
                              )}
                              <span>
                                judge: {r.judge.verdict}
                                {r.judge.votes ? (
                                  <span className="text-muted-foreground"> ({r.judge.votes})</span>
                                ) : null}
                                {r.judge.reason ? (
                                  <span className="text-muted-foreground"> — {r.judge.reason}</span>
                                ) : null}
                                {r.judge.grounded !== undefined && (
                                  <span className="ml-1 font-mono text-muted-foreground">
                                    [g{r.judge.grounded} h{r.judge.correct_handling} a{r.judge.asked_for_missing} o
                                    {r.judge.no_overpromise} t{r.judge.tone}]
                                  </span>
                                )}
                              </span>
                            </li>
                          )}
                        </ul>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </StaffShell>
  );
}
