import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, RefreshCw, Search, ShieldAlert } from "lucide-react";
import { StaffShell } from "@/components/staff-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/queryClient";
import { relative, titleCase } from "@/lib/format";
import type { Policy, RetrievalResult, RetrievalStats } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Render a nested rules object as readable rows without dumping raw JSON. */
function RuleRows({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return (
      <span className="text-foreground">
        {value.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v))).join(" · ")}
      </span>
    );
  }
  if (typeof value === "object") {
    return (
      <dl className={cn("space-y-1", depth > 0 && "mt-1 border-l border-border pl-3")}>
        {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
          <div key={k} className="flex flex-wrap gap-x-2 text-xs">
            <dt className="shrink-0 font-medium text-muted-foreground">{k.replace(/_/g, " ")}</dt>
            <dd className="min-w-0 flex-1 break-words text-foreground">
              {typeof v === "object" && v !== null ? (
                <RuleRows value={v} depth={depth + 1} />
              ) : typeof v === "number" ? (
                v.toLocaleString("vi-VN")
              ) : (
                String(v)
              )}
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return <span className="text-foreground">{String(value)}</span>;
}

export default function PoliciesPage() {
  const qc = useQueryClient();
  const { data: policies, isLoading } = useQuery<Policy[]>({ queryKey: ["/api/policies"] });
  const { data: stats } = useQuery<RetrievalStats>({ queryKey: ["/api/retrieval"] });
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<RetrievalResult | null>(null);

  const reindex = useMutation({
    mutationFn: async () => await apiRequest("POST", "/api/retrieval/reindex", {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/retrieval"] });
      qc.invalidateQueries({ queryKey: ["/api/events"] });
    },
  });

  const search = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/retrieval/search", { query, kind: "all", k: 5 });
      return (await r.json()) as RetrievalResult;
    },
    onSuccess: (r) => setHits(r),
  });

  const internal = (policies ?? []).filter((p) => p.sourceUrl.startsWith("internal://"));
  const published = (policies ?? []).filter((p) => !p.sourceUrl.startsWith("internal://"));

  return (
    <StaffShell
      title="Policies & retrieval"
      description="The numeric rules the concierge computes from, and the index it retrieves through."
      actions={
        <Button
          size="sm"
          variant="outline"
          onClick={() => reindex.mutate()}
          disabled={reindex.isPending}
          data-testid="button-reindex"
        >
          <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", reindex.isPending && "animate-spin")} />
          Rebuild index
        </Button>
      }
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="space-y-3">
          {isLoading && Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 w-full" />)}

          {published.map((p) => (
            <article
              key={p.id}
              className="rounded-md border border-card-border bg-card p-4"
              data-testid={`policy-${p.code}`}
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <h3 className="text-sm font-medium">{p.title}</h3>
                <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary">
                  {p.code}
                </span>
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {titleCase(p.topic)}
                </span>
                <span className="ml-auto text-[10px] text-muted-foreground">
                  updated {relative(p.updatedAt)}
                </span>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{p.summary}</p>
              <div className="mt-3 rounded border border-border bg-background/60 p-3">
                <RuleRows value={p.rules} />
              </div>
              <a
                href={p.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                data-testid={`source-${p.code}`}
              >
                <ExternalLink className="h-3 w-3" />
                {p.sourceTitle}
              </a>
            </article>
          ))}

          {internal.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 pt-2 text-xs font-medium text-muted-foreground">
                <ShieldAlert className="h-3.5 w-3.5" />
                Internal rules — not published by the property
              </div>
              {internal.map((p) => (
                <article
                  key={p.id}
                  className="rounded-md border border-dashed border-card-border bg-card p-4"
                  data-testid={`policy-${p.code}`}
                >
                  <div className="flex flex-wrap items-baseline gap-2">
                    <h3 className="text-sm font-medium">{p.title}</h3>
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {p.code}
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{p.summary}</p>
                  <div className="mt-3 rounded border border-border bg-background/60 p-3">
                    <RuleRows value={p.rules} />
                  </div>
                  <p className="mt-2 text-[11px] text-muted-foreground">{p.sourceTitle}</p>
                </article>
              ))}
            </div>
          )}
        </div>

        <aside className="space-y-4 lg:sticky lg:top-0 lg:self-start">
          <div className="rounded-md border border-card-border bg-card p-4">
            <h3 className="text-sm font-medium">Retrieval index</h3>
            <dl className="mt-3 space-y-1.5 text-xs">
              {[
                ["Chunks indexed", stats ? stats.chunks.toString() : "—"],
                ["With embeddings", stats ? stats.embedded.toString() : "—"],
                ["From knowledge base", stats ? stats.kb_chunks.toString() : "—"],
                ["From policy register", stats ? stats.policy_chunks.toString() : "—"],
                ["Embedding model", stats?.model ?? "—"],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="font-mono text-[11px]">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
              Retrieval fuses BM25 keyword scoring with embedding similarity, so a question in
              Vietnamese still finds the English source passage. If embeddings are unavailable the
              keyword leg answers alone rather than the agent guessing.
            </p>
          </div>

          <div className="rounded-md border border-card-border bg-card p-4">
            <h3 className="text-sm font-medium">Test what the AI would retrieve</h3>
            <div className="mt-3 flex gap-2">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && query.trim().length > 1) search.mutate();
                }}
                placeholder="ra muộn 2 tiếng có mất phí không"
                data-testid="input-retrieval-query"
              />
              <Button
                size="icon"
                onClick={() => search.mutate()}
                disabled={query.trim().length < 2 || search.isPending}
                data-testid="button-retrieval-search"
              >
                <Search className="h-3.5 w-3.5" />
              </Button>
            </div>

            {hits && (
              <div className="mt-3 space-y-2" data-testid="retrieval-results">
                <p className="text-[11px] text-muted-foreground">
                  Strategy: <span className="font-mono">{hits.strategy}</span>
                </p>
                {hits.note && <p className="text-[11px] text-muted-foreground">{hits.note}</p>}
                {hits.results.map((h, i) => (
                  <div key={i} className="rounded border border-border p-2.5">
                    <div className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 text-xs font-medium">{h.title}</span>
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                        {h.matched_by} · {h.relevance.toFixed(4)}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-4 text-[11px] leading-relaxed text-muted-foreground">
                      {h.content}
                    </p>
                    {h.source_url && !h.source_url.startsWith("internal://") && (
                      <a
                        href={h.source_url}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 inline-flex items-center gap-1 text-[10px] text-primary hover:underline"
                      >
                        <ExternalLink className="h-2.5 w-2.5" />
                        source
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>
    </StaffShell>
  );
}
