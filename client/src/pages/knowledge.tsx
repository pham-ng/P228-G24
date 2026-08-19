import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Save, Trash2 } from "lucide-react";
import { StaffShell } from "@/components/staff-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiRequest } from "@/lib/queryClient";
import { relative, titleCase } from "@/lib/format";
import type { KbArticle } from "@/lib/types";
import { cn } from "@/lib/utils";

const CATEGORIES = ["property", "policy", "dining", "neighborhood", "wayfinding"];

export default function KnowledgePage() {
  const qc = useQueryClient();
  const { data: articles, isLoading } = useQuery<KbArticle[]>({ queryKey: ["/api/kb"] });
  const [activeId, setActiveId] = useState<number | "new" | null>(null);
  const [form, setForm] = useState({ category: "policy", title: "", body: "", tags: "" });

  const openArticle = (a: KbArticle) => {
    setActiveId(a.id);
    setForm({ category: a.category, title: a.title, body: a.body, tags: a.tags.join(", ") });
  };

  const openNew = () => {
    setActiveId("new");
    setForm({ category: "policy", title: "", body: "", tags: "" });
  };

  const done = () => {
    qc.invalidateQueries({ queryKey: ["/api/kb"] });
    qc.invalidateQueries({ queryKey: ["/api/events"] });
  };

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        category: form.category,
        title: form.title,
        body: form.body,
        tags: form.tags
          .split(",")
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean),
      };
      if (activeId === "new") await apiRequest("POST", "/api/kb", payload);
      else await apiRequest("PATCH", `/api/kb/${activeId}`, payload);
    },
    onSuccess: () => {
      done();
      setActiveId(null);
    },
  });

  const remove = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/kb/${id}`);
    },
    onSuccess: () => {
      done();
      setActiveId(null);
    },
  });

  return (
    <StaffShell
      title="Knowledge"
      description="The only facts the AI is allowed to state. Edits apply to the next reply."
      actions={
        <Button size="sm" onClick={openNew} data-testid="button-new-article">
          <Plus className="mr-1.5 h-3.5 w-3.5" /> New article
        </Button>
      }
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="space-y-2">
          {isLoading &&
            Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
          {(articles ?? []).map((a) => (
            <button
              key={a.id}
              onClick={() => openArticle(a)}
              data-testid={`article-${a.id}`}
              className={cn(
                "hover-elevate w-full rounded-md border border-card-border bg-card p-3 text-left",
                activeId === a.id && "border-primary/50",
              )}
            >
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{a.title}</span>
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {titleCase(a.category)}
                </span>
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{a.body}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                {a.tags.slice(0, 5).map((t) => (
                  <span key={t} className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                    {t}
                  </span>
                ))}
                <span className="ml-auto text-[10px] text-muted-foreground">
                  updated {relative(a.updatedAt)}
                </span>
              </div>
            </button>
          ))}
        </div>

        <aside className="lg:sticky lg:top-0 lg:self-start">
          {activeId == null ? (
            <div className="rounded-md border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
              Select an article to edit, or add a new one. The concierge retrieves from this set on
              every question — it is instructed never to answer property facts from its own memory.
            </div>
          ) : (
            <div className="space-y-3 rounded-md border border-card-border bg-card p-4">
              <div className="space-y-1.5">
                <Label>Category</Label>
                <Select
                  value={form.category}
                  onValueChange={(category) => setForm((f) => ({ ...f, category }))}
                >
                  <SelectTrigger data-testid="select-kb-category">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {titleCase(c)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Title</Label>
                <Input
                  value={form.title}
                  onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                  data-testid="input-kb-title"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Body</Label>
                <Textarea
                  value={form.body}
                  onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
                  rows={10}
                  data-testid="input-kb-body"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Retrieval tags</Label>
                <Input
                  value={form.tags}
                  onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))}
                  placeholder="breakfast, hours, restaurant"
                  data-testid="input-kb-tags"
                />
              </div>
              <div className="flex gap-2">
                <Button
                  className="flex-1"
                  onClick={() => save.mutate()}
                  disabled={form.title.trim().length < 3 || form.body.trim().length < 10 || save.isPending}
                  data-testid="button-save-article"
                >
                  <Save className="mr-1.5 h-3.5 w-3.5" />
                  {activeId === "new" ? "Publish" : "Save"}
                </Button>
                {activeId !== "new" && (
                  <Button
                    variant="outline"
                    onClick={() => remove.mutate(activeId as number)}
                    disabled={remove.isPending}
                    data-testid="button-delete-article"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
                <Button variant="ghost" onClick={() => setActiveId(null)} data-testid="button-cancel-article">
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </aside>
      </div>
    </StaffShell>
  );
}
