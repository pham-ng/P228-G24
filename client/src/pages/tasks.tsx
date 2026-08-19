import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlarmClock, Bot, Plus, UserRound } from "lucide-react";
import { StaffShell } from "@/components/staff-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiRequest } from "@/lib/queryClient";
import { minutesUntil, relative, titleCase } from "@/lib/format";
import { DEPT_LABELS, type Hotel, type Staff, type Task } from "@/lib/types";
import { cn } from "@/lib/utils";

const COLUMNS: { key: Task["status"]; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "in_progress", label: "In progress" },
  { key: "done", label: "Done" },
];

const PRIORITY_STYLES: Record<string, string> = {
  urgent: "bg-destructive/15 text-destructive",
  high: "bg-chart-3/15 text-chart-3",
  normal: "bg-muted text-muted-foreground",
  low: "bg-muted text-muted-foreground",
};

function SlaChip({ task, sla }: { task: Task; sla: number }) {
  if (task.status === "done") {
    const mins = task.resolvedAt
      ? Math.round(
          (new Date(task.resolvedAt).getTime() - new Date(task.createdAt).getTime()) / 60_000,
        )
      : null;
    return (
      <span className="text-[10px] text-muted-foreground">
        resolved in {mins != null ? `${Math.abs(mins)}m` : "—"}
      </span>
    );
  }
  const left = minutesUntil(task.dueAt);
  if (left == null) return null;
  const breached = left < 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
        breached ? "bg-destructive/15 text-destructive" : left <= sla ? "bg-chart-4/20 text-chart-4" : "bg-muted text-muted-foreground",
      )}
      data-testid="chip-sla"
    >
      <AlarmClock className="h-2.5 w-2.5" />
      {breached ? `${Math.abs(left)}m over` : `${left}m left`}
    </span>
  );
}

function NewTaskDialog() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [dept, setDept] = useState("front_desk");
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [priority, setPriority] = useState("normal");

  const create = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/tasks", { dept, title, detail, priority });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/tasks"] });
      setOpen(false);
      setTitle("");
      setDetail("");
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" data-testid="button-new-task">
          <Plus className="mr-1.5 h-3.5 w-3.5" /> New task
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Dispatch a task</DialogTitle>
          <DialogDescription>
            Goes onto the same board the AI writes to, with the same SLA clock.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Department</Label>
            <Select value={dept} onValueChange={setDept}>
              <SelectTrigger data-testid="select-dept">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(DEPT_LABELS).map(([k, v]) => (
                  <SelectItem key={k} value={k}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Title</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Replace minibar in 604"
              data-testid="input-task-title"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Detail</Label>
            <Textarea
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              rows={3}
              data-testid="input-task-detail"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Priority</Label>
            <Select value={priority} onValueChange={setPriority}>
              <SelectTrigger data-testid="select-priority">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["low", "normal", "high", "urgent"].map((p) => (
                  <SelectItem key={p} value={p}>
                    {titleCase(p)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={() => create.mutate()}
            disabled={title.trim().length < 3 || create.isPending}
            data-testid="button-create-task"
          >
            Dispatch
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function TasksPage() {
  const qc = useQueryClient();
  const [dept, setDept] = useState("all");
  const { data: tasks, isLoading } = useQuery<Task[]>({
    queryKey: ["/api/tasks"],
    refetchInterval: 8000,
  });
  const { data: hotel } = useQuery<Hotel>({ queryKey: ["/api/hotel"] });
  const { data: team } = useQuery<Staff[]>({ queryKey: ["/api/staff"] });

  const update = useMutation({
    mutationFn: async ({ id, patch }: { id: number; patch: Record<string, unknown> }) => {
      await apiRequest("PATCH", `/api/tasks/${id}`, patch);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/tasks"] });
      qc.invalidateQueries({ queryKey: ["/api/insights"] });
      qc.invalidateQueries({ queryKey: ["/api/events"] });
    },
  });

  const filtered = (tasks ?? [])
    .filter((t) => (dept === "all" ? true : t.dept === dept))
    .filter((t) => t.status !== "cancelled");

  const sla = hotel?.slaMinutes ?? 10;

  return (
    <StaffShell
      title="Tasks"
      description="Everything the AI dispatched, plus what the team raised"
      actions={
        <div className="flex items-center gap-2">
          <Select value={dept} onValueChange={setDept}>
            <SelectTrigger className="h-8 w-[150px] text-xs" data-testid="select-filter-dept">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All departments</SelectItem>
              {Object.entries(DEPT_LABELS).map(([k, v]) => (
                <SelectItem key={k} value={k}>
                  {v}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <NewTaskDialog />
        </div>
      }
    >
      <div className="grid gap-4 lg:grid-cols-3">
        {COLUMNS.map((col) => {
          const items = filtered
            .filter((t) => t.status === col.key)
            .sort((a, b) =>
              col.key === "done"
                ? new Date(b.resolvedAt ?? b.createdAt).getTime() -
                  new Date(a.resolvedAt ?? a.createdAt).getTime()
                : new Date(a.dueAt ?? a.createdAt).getTime() -
                  new Date(b.dueAt ?? b.createdAt).getTime(),
            )
            .slice(0, col.key === "done" ? 20 : 100);
          return (
            <section key={col.key} className="min-w-0">
              <div className="mb-2 flex items-center gap-2">
                <h2 className="text-sm font-semibold">{col.label}</h2>
                <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {filtered.filter((t) => t.status === col.key).length}
                </span>
              </div>
              <div className="space-y-2">
                {isLoading && [0, 1, 2].map((i) => <Skeleton key={i} className="h-24 w-full" />)}
                {items.map((t) => (
                  <article
                    key={t.id}
                    data-testid={`task-${t.id}`}
                    className="rounded-md border border-card-border bg-card p-3"
                  >
                    <div className="flex items-start gap-2">
                      <p className="min-w-0 flex-1 text-sm font-medium leading-snug">{t.title}</p>
                      <span
                        className={cn(
                          "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
                          PRIORITY_STYLES[t.priority],
                        )}
                      >
                        {t.priority}
                      </span>
                    </div>
                    {t.detail && (
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{t.detail}</p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {DEPT_LABELS[t.dept] ?? t.dept}
                      </span>
                      {t.roomNumber && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          Rm {t.roomNumber}
                        </span>
                      )}
                      <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {t.source === "ai" ? (
                          <Bot className="h-2.5 w-2.5" />
                        ) : (
                          <UserRound className="h-2.5 w-2.5" />
                        )}
                        {t.source === "ai" ? "AI" : "Staff"}
                      </span>
                      <SlaChip task={t} sla={sla} />
                    </div>
                    <div className="mt-2.5 flex items-center gap-1.5">
                      <Select
                        value={t.assignedStaffId ? String(t.assignedStaffId) : "none"}
                        onValueChange={(v) =>
                          update.mutate({
                            id: t.id,
                            patch: { assignedStaffId: v === "none" ? null : Number(v) },
                          })
                        }
                      >
                        <SelectTrigger
                          className="h-7 flex-1 text-[11px]"
                          data-testid={`select-assignee-${t.id}`}
                        >
                          <SelectValue placeholder="Unassigned" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Unassigned</SelectItem>
                          {(team ?? [])
                            .filter((s) => s.dept === t.dept || s.role === "Duty Manager")
                            .map((s) => (
                              <SelectItem key={s.id} value={String(s.id)}>
                                {s.name}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                      {t.status === "open" && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-[11px]"
                          onClick={() => update.mutate({ id: t.id, patch: { status: "in_progress" } })}
                          data-testid={`button-start-${t.id}`}
                        >
                          Start
                        </Button>
                      )}
                      {t.status !== "done" && (
                        <Button
                          size="sm"
                          className="h-7 text-[11px]"
                          onClick={() => update.mutate({ id: t.id, patch: { status: "done" } })}
                          data-testid={`button-done-${t.id}`}
                        >
                          Done
                        </Button>
                      )}
                      {t.status === "done" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-[11px]"
                          onClick={() => update.mutate({ id: t.id, patch: { status: "open" } })}
                          data-testid={`button-reopen-${t.id}`}
                        >
                          Reopen
                        </Button>
                      )}
                    </div>
                    <div className="mt-1.5 text-[10px] text-muted-foreground">
                      raised {relative(t.createdAt)}
                      {t.assignee ? ` · ${t.assignee}` : ""}
                    </div>
                  </article>
                ))}
                {!isLoading && items.length === 0 && (
                  <div className="rounded-md border border-dashed border-border px-3 py-8 text-center text-xs text-muted-foreground">
                    Nothing here.
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </StaffShell>
  );
}
