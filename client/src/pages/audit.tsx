import { useQuery } from "@tanstack/react-query";
import { Bot, UserRound } from "lucide-react";
import { StaffShell } from "@/components/staff-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { stamp } from "@/lib/format";
import type { AuditEvent } from "@/lib/types";

export default function AuditPage() {
  const { data: events, isLoading } = useQuery<AuditEvent[]>({
    queryKey: ["/api/events"],
    refetchInterval: 10000,
  });

  return (
    <StaffShell
      title="Activity"
      description="Every write the AI or the team made, in order"
    >
      <div className="mx-auto max-w-3xl">
        {isLoading && (
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        )}
        <ol className="relative space-y-0 border-l border-border pl-0">
          {(events ?? []).map((e) => {
            const byAi = e.actor.startsWith("ai");
            return (
              <li key={e.id} className="relative pb-4 pl-6" data-testid={`event-${e.id}`}>
                <span className="absolute -left-[7px] top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-border bg-background">
                  <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                </span>
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 shrink-0 text-muted-foreground">
                    {byAi ? <Bot className="h-3.5 w-3.5" /> : <UserRound className="h-3.5 w-3.5" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm leading-snug">{e.summary}</p>
                    <p className="mt-0.5 font-mono text-[10.5px] text-muted-foreground">
                      {e.type} · {e.actor} · {stamp(e.createdAt)}
                    </p>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
        {!isLoading && (events ?? []).length === 0 && (
          <div className="rounded-md border border-dashed border-border px-3 py-10 text-center text-xs text-muted-foreground">
            No activity recorded yet.
          </div>
        )}
      </div>
    </StaffShell>
  );
}
