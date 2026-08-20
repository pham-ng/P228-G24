import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  ChevronDown,
  Loader2,
  Send,
  Sparkles,
  UserRound,
  Wrench,
} from "lucide-react";
import { StaffShell } from "@/components/staff-shell";
import { MarkdownBody } from "@/components/markdown-body";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/queryClient";
import { useSession } from "@/lib/session";
import { clock, money, relative, seconds, titleCase } from "@/lib/format";
import {
  DEPT_LABELS,
  LANG_LABELS,
  type ConversationDetail,
  type ConversationRow,
  type Message,
  type ToolTrace,
} from "@/lib/types";
import { cn } from "@/lib/utils";

const SENTIMENT_STYLES: Record<string, string> = {
  positive: "bg-chart-2/15 text-chart-2",
  neutral: "bg-muted text-muted-foreground",
  negative: "bg-destructive/15 text-destructive",
};

function TraceBlock({ trace }: { trace: ToolTrace[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2 rounded-md border border-border bg-muted/40">
      <button
        onClick={() => setOpen((o) => !o)}
        className="hover-elevate flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left"
        data-testid="button-trace"
      >
        <Wrench className="h-3 w-3 shrink-0 text-primary" />
        <span className="flex-1 truncate font-mono text-[11px]">
          {trace.map((t) => t.name).join(" → ")}
        </span>
        <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="space-y-2 border-t border-border px-2.5 py-2">
          {trace.map((t, i) => (
            <div key={i} className="font-mono text-[10.5px] leading-relaxed">
              <div className="font-semibold text-primary">
                {t.name} <span className="font-normal text-muted-foreground">{t.ms}ms</span>
              </div>
              <div className="mt-0.5 whitespace-pre-wrap break-all text-muted-foreground">
                ← {JSON.stringify(t.args)}
              </div>
              <div className="mt-0.5 whitespace-pre-wrap break-all">
                → {JSON.stringify(t.result)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MessageRow({ m }: { m: Message }) {
  const trace: ToolTrace[] = m.toolTrace ? JSON.parse(m.toolTrace) : [];
  if (m.role === "system") {
    return (
      <div className="py-1 text-center text-[11px] text-muted-foreground">{m.body}</div>
    );
  }
  const isGuest = m.role === "guest";
  return (
    <div className={cn("flex gap-2.5", isGuest ? "justify-start" : "justify-end")}>
      {isGuest && (
        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-secondary">
          <UserRound className="h-3 w-3" />
        </div>
      )}
      <div className={cn("min-w-0 max-w-[78%]", !isGuest && "items-end")}>
        <div className="mb-1 flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
          {!isGuest && (m.role === "ai" ? <Bot className="h-3 w-3" /> : <UserRound className="h-3 w-3" />)}
          <span>
            {isGuest ? "Guest" : m.role === "ai" ? "AI concierge" : (m.authorName ?? "Staff")}
          </span>
          <span>· {clock(m.createdAt)}</span>
          {m.latencyMs != null && <span>· {(m.latencyMs / 1000).toFixed(1)}s</span>}
        </div>
        <div
          data-testid={`row-message-${m.role}`}
          className={cn(
            "rounded-lg px-3 py-2 text-sm leading-relaxed",
            isGuest
              ? "whitespace-pre-wrap border border-card-border bg-card"
              : m.role === "ai"
                ? "bg-primary/10"
                : "whitespace-pre-wrap bg-secondary",
          )}
        >
          {isGuest ? m.body : <MarkdownBody text={m.body} />}
        </div>
        {trace.length > 0 && <TraceBlock trace={trace} />}
      </div>
    </div>
  );
}

function ContextPanel({ detail }: { detail: ConversationDetail }) {
  const { guest, reservation, room, charges, folioTotal, tasks } = detail;
  return (
    <div className="space-y-5 text-sm">
      <div>
        <div className="text-base font-semibold tracking-tight">{guest.name}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {guest.country} · {LANG_LABELS[guest.lang] ?? guest.lang} · {guest.staysCount} stay
          {guest.staysCount === 1 ? "" : "s"}
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {guest.vipTier !== "none" && (
            <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
              {guest.vipTier}
            </span>
          )}
          {guest.preferences.map((p) => (
            <span key={p} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {p}
            </span>
          ))}
        </div>
        {guest.notes && (
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{guest.notes}</p>
        )}
      </div>

      {reservation && (
        <div className="rounded-md border border-card-border bg-card p-3">
          <div className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
            Stay
          </div>
          <dl className="mt-2 space-y-1 text-xs">
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Room</dt>
              <dd className="font-medium">
                {room?.number ?? "—"} {room ? `· ${titleCase(room.type)}` : ""}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Dates</dt>
              <dd className="font-medium">
                {reservation.checkIn} → {reservation.checkOut}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Departure time</dt>
              <dd className="font-medium">{reservation.checkOutTime}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Confirmation</dt>
              <dd className="font-mono text-[11px]">{reservation.confirmationCode}</dd>
            </div>
          </dl>
        </div>
      )}

      <div>
        <div className="flex items-baseline justify-between">
          <div className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
            Folio
          </div>
          <div className="font-mono text-sm font-semibold">{money(folioTotal)}</div>
        </div>
        <ul className="mt-2 space-y-1">
          {charges.map((c) => (
            <li key={c.id} className="flex justify-between gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{c.description}</span>
              <span className="font-mono">{money(c.amount)}</span>
            </li>
          ))}
          {charges.length === 0 && <li className="text-xs text-muted-foreground">No charges yet.</li>}
        </ul>
      </div>

      <div>
        <div className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
          Tasks from this thread
        </div>
        <ul className="mt-2 space-y-1.5">
          {tasks.map((t) => (
            <li key={t.id} className="rounded-md border border-card-border bg-card px-2.5 py-2">
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 flex-1 text-xs font-medium">{t.title}</span>
                <span
                  className={cn(
                    "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
                    t.status === "done"
                      ? "bg-chart-2/15 text-chart-2"
                      : t.status === "in_progress"
                        ? "bg-chart-4/20 text-chart-4"
                        : "bg-muted text-muted-foreground",
                  )}
                >
                  {titleCase(t.status)}
                </span>
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                {DEPT_LABELS[t.dept] ?? t.dept} · {relative(t.createdAt)}
              </div>
            </li>
          ))}
          {tasks.length === 0 && (
            <li className="text-xs text-muted-foreground">Nothing dispatched yet.</li>
          )}
        </ul>
      </div>
    </div>
  );
}

export default function InboxPage() {
  const qc = useQueryClient();
  const { staff } = useSession();
  const [activeId, setActiveId] = useState<number | null>(null);
  const [filter, setFilter] = useState<"all" | "needs_human" | "ai">("all");
  const [draft, setDraft] = useState("");
  const [showContext, setShowContext] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const list = useQuery<ConversationRow[]>({
    queryKey: ["/api/conversations"],
    refetchInterval: 6000,
  });

  const rows = (list.data ?? []).filter((c) =>
    filter === "all" ? true : filter === "needs_human" ? c.mode === "human" : c.mode === "ai",
  );

  useEffect(() => {
    if (activeId == null && rows.length) setActiveId(rows[0].id);
  }, [rows, activeId]);

  const detail = useQuery<ConversationDetail>({
    queryKey: [`/api/conversations/${activeId}`],
    enabled: activeId != null,
    refetchInterval: 5000,
  });

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [detail.data?.messages.length]);

  useEffect(() => {
    if (activeId != null && detail.data?.conversation.unreadForStaff === 1) {
      apiRequest("POST", `/api/conversations/${activeId}/read`).then(() =>
        qc.invalidateQueries({ queryKey: ["/api/conversations"] }),
      );
    }
  }, [activeId, detail.data?.conversation.unreadForStaff, qc]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["/api/conversations"] });
    qc.invalidateQueries({ queryKey: ["/api/tasks"] });
    qc.invalidateQueries({ queryKey: ["/api/events"] });
  };

  const reply = useMutation({
    mutationFn: async (body: string) => {
      const res = await apiRequest("POST", `/api/conversations/${activeId}/messages`, {
        from: "staff",
        body,
        staffId: staff?.id,
      });
      return res.json() as Promise<ConversationDetail>;
    },
    onSuccess: (data) => {
      qc.setQueryData([`/api/conversations/${activeId}`], data);
      setDraft("");
      invalidate();
    },
  });

  const setMode = useMutation({
    mutationFn: async (mode: "ai" | "human" | "closed") => {
      await apiRequest("POST", `/api/conversations/${activeId}/mode`, { mode, staffId: staff?.id });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/conversations/${activeId}`] });
      invalidate();
    },
  });

  const suggest = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/conversations/${activeId}/suggest`);
      return res.json() as Promise<{ draft: string }>;
    },
    onSuccess: (d) => setDraft(d.draft),
  });

  const conv = detail.data;
  const human = conv?.conversation.mode === "human";

  return (
    <StaffShell
      title="Inbox"
      description="Every guest thread, with the AI's reasoning on the record"
      padded={false}
      actions={
        <div className="flex gap-1">
          {(["all", "needs_human", "ai"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              data-testid={`filter-${f}`}
              className={cn(
                "hover-elevate rounded-md px-2.5 py-1.5 text-xs",
                filter === f ? "bg-secondary font-medium" : "text-muted-foreground",
              )}
            >
              {f === "all" ? "All" : f === "needs_human" ? "With staff" : "AI handled"}
            </button>
          ))}
        </div>
      }
    >
      <div className="flex h-full min-h-0">
        {/* conversation list */}
        <div className="w-full shrink-0 overflow-y-auto border-r border-border sm:w-72 lg:w-80">
          {list.isLoading && (
            <div className="space-y-2 p-3">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          )}
          {rows.map((c) => (
            <button
              key={c.id}
              onClick={() => {
                setActiveId(c.id);
                setShowContext(false);
              }}
              data-testid={`conversation-${c.id}`}
              className={cn(
                "hover-elevate w-full border-b border-border px-3 py-2.5 text-left",
                activeId === c.id && "bg-secondary",
              )}
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.guestName}</span>
                {c.unreadForStaff === 1 && (
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                )}
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {relative(c.lastMessageAt)}
                </span>
              </div>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {c.lastMessageRole === "guest" ? "" : "↩ "}
                {c.lastMessage}
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {c.roomNumber ? `Rm ${c.roomNumber}` : c.channel}
                </span>
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] font-medium",
                    c.mode === "human" ? "bg-chart-4/20 text-chart-4" : "bg-primary/12 text-primary",
                  )}
                >
                  {c.mode === "human" ? "Staff" : "AI"}
                </span>
                {c.vipTier !== "none" && (
                  <span className="rounded bg-primary/12 px-1.5 py-0.5 text-[10px] uppercase text-primary">
                    {c.vipTier}
                  </span>
                )}
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px]",
                    SENTIMENT_STYLES[c.sentiment] ?? SENTIMENT_STYLES.neutral,
                  )}
                >
                  {c.sentiment}
                </span>
                {c.openTasks > 0 && (
                  <span className="rounded bg-chart-3/15 px-1.5 py-0.5 text-[10px] text-chart-3">
                    {c.openTasks} open
                  </span>
                )}
              </div>
            </button>
          ))}
          {!list.isLoading && rows.length === 0 && (
            <div className="p-6 text-center text-xs text-muted-foreground">
              No conversations in this filter.
            </div>
          )}
        </div>

        {/* thread */}
        <div className="hidden min-w-0 flex-1 flex-col sm:flex">
          {!conv ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              Select a conversation
            </div>
          ) : (
            <>
              <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {conv.guest.name}
                    <span className="ml-2 font-normal text-muted-foreground">
                      Room {conv.room?.number ?? "—"} ·{" "}
                      {LANG_LABELS[conv.guest.lang] ?? conv.guest.lang}
                    </span>
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {conv.conversation.topic ? `${titleCase(conv.conversation.topic)} · ` : ""}
                    {conv.conversation.firstResponseSeconds != null
                      ? `first reply ${seconds(conv.conversation.firstResponseSeconds)}`
                      : "awaiting first reply"}
                    {conv.assignedStaff ? ` · with ${conv.assignedStaff.name}` : ""}
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="lg:hidden"
                  onClick={() => setShowContext((s) => !s)}
                  data-testid="button-context"
                >
                  Guest
                </Button>
                {human ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setMode.mutate("ai")}
                    disabled={setMode.isPending}
                    data-testid="button-return-ai"
                  >
                    <Bot className="mr-1.5 h-3.5 w-3.5" /> Hand back to AI
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => setMode.mutate("human")}
                    disabled={setMode.isPending}
                    data-testid="button-takeover"
                  >
                    <UserRound className="mr-1.5 h-3.5 w-3.5" /> Take over
                  </Button>
                )}
              </div>

              {human && (
                <div className="shrink-0 border-b border-chart-4/30 bg-chart-4/10 px-4 py-1.5 text-[11px] text-chart-4">
                  AI replies are paused for this guest. Everything you send goes out under the hotel's
                  name.
                </div>
              )}

              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4" data-testid="staff-thread">
                {conv.messages.map((m) => (
                  <MessageRow key={m.id} m={m} />
                ))}
                <div ref={endRef} />
              </div>

              <div className="shrink-0 border-t border-border p-3">
                <div className="flex items-end gap-2">
                  <Textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        if (draft.trim()) reply.mutate(draft.trim());
                      }
                    }}
                    rows={2}
                    placeholder={
                      staff ? "Reply as the hotel…" : "Sign in to reply"
                    }
                    className="max-h-40 min-h-[56px] resize-none"
                    data-testid="input-staff-reply"
                  />
                  <div className="flex shrink-0 flex-col gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => suggest.mutate()}
                      disabled={suggest.isPending}
                      data-testid="button-suggest"
                    >
                      {suggest.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="h-3.5 w-3.5" />
                      )}
                      <span className="ml-1.5 text-xs">Draft</span>
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => draft.trim() && reply.mutate(draft.trim())}
                      disabled={!draft.trim() || reply.isPending}
                      data-testid="button-staff-send"
                    >
                      {reply.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Send className="h-3.5 w-3.5" />
                      )}
                      <span className="ml-1.5 text-xs">Send</span>
                    </Button>
                  </div>
                </div>
                <p className="mt-1.5 text-[10px] text-muted-foreground">
                  Sending a reply takes the thread over from the AI. Draft uses the model with the
                  guest's profile and the brand voice — nothing is sent until you press Send.
                </p>
              </div>
            </>
          )}
        </div>

        {/* guest context */}
        {conv && (
          <aside
            className={cn(
              "w-72 shrink-0 overflow-y-auto border-l border-border p-4 xl:w-80",
              showContext ? "block" : "hidden lg:block",
            )}
          >
            <ContextPanel detail={conv} />
          </aside>
        )}
      </div>
    </StaffShell>
  );
}
