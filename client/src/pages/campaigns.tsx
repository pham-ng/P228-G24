import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Send } from "lucide-react";
import { StaffShell } from "@/components/staff-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiRequest } from "@/lib/queryClient";
import { relative, titleCase } from "@/lib/format";
import { LANG_LABELS, type Campaign } from "@/lib/types";
import { cn } from "@/lib/utils";

const SEGMENTS = ["all", "in_house", "arriving", "departing", "vip", "repeat"];

export default function CampaignsPage() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [segment, setSegment] = useState("in_house");
  const [body, setBody] = useState("");

  const { data: campaigns } = useQuery<Campaign[]>({ queryKey: ["/api/campaigns"] });
  const { data: audience } = useQuery<{
    count: number;
    audience: { name: string; lang: string; code: string }[];
  }>({
    queryKey: ["campaign-audience", segment],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/campaigns/audience?segment=${segment}`);
      return res.json();
    },
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["/api/campaigns"] });
    qc.invalidateQueries({ queryKey: ["/api/conversations"] });
    qc.invalidateQueries({ queryKey: ["/api/events"] });
  };

  const create = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/campaigns", { name, segment, body });
      return res.json() as Promise<Campaign>;
    },
    onSuccess: () => {
      refresh();
      setName("");
      setBody("");
    },
  });

  const send = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("POST", `/api/campaigns/${id}/send`);
    },
    onSuccess: refresh,
  });

  return (
    <StaffShell
      title="Campaigns"
      description="Segmented broadcasts, rewritten per guest in their own language"
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        <section className="space-y-3 rounded-md border border-card-border bg-card p-4">
          <h2 className="text-sm font-semibold">New broadcast</h2>
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Terrace jazz — Friday"
              data-testid="input-campaign-name"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Segment</Label>
            <Select value={segment} onValueChange={setSegment}>
              <SelectTrigger data-testid="select-segment">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SEGMENTS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {titleCase(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground" data-testid="text-audience">
              {audience ? `${audience.count} guest(s) match this segment` : "Counting…"}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label>Message (English source)</Label>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={5}
              placeholder="Live jazz on the ninth-floor terrace tonight from 20:00. Complimentary for in-house guests."
              data-testid="input-campaign-body"
            />
            <p className="text-[11px] text-muted-foreground">
              Each recipient gets this rewritten in their language, addressed to them by name.
            </p>
          </div>
          <Button
            className="w-full"
            onClick={() => create.mutate()}
            disabled={name.trim().length < 3 || body.trim().length < 10 || create.isPending}
            data-testid="button-create-campaign"
          >
            Save as draft
          </Button>

          {audience && audience.audience.length > 0 && (
            <div className="pt-1">
              <div className="text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                Recipients
              </div>
              <ul className="mt-1.5 space-y-1">
                {audience.audience.map((a) => (
                  <li key={a.code} className="flex items-center justify-between gap-2 text-xs">
                    <span className="min-w-0 flex-1 truncate">{a.name}</span>
                    <span className="text-muted-foreground">{LANG_LABELS[a.lang] ?? a.lang}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Campaigns</h2>
          {(campaigns ?? []).map((c) => (
            <article
              key={c.id}
              className="rounded-md border border-card-border bg-card p-3"
              data-testid={`campaign-${c.id}`}
            >
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{c.name}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {titleCase(c.segment)} ·{" "}
                    {c.status === "sent"
                      ? `${c.recipients} sent ${c.sentAt ? relative(c.sentAt) : ""}`
                      : `draft, created ${relative(c.createdAt)}`}
                  </div>
                </div>
                <span
                  className={cn(
                    "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
                    c.status === "sent" ? "bg-chart-2/15 text-chart-2" : "bg-muted text-muted-foreground",
                  )}
                >
                  {titleCase(c.status)}
                </span>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                {c.body}
              </p>
              {c.status !== "sent" && (
                <Button
                  size="sm"
                  className="mt-2.5"
                  onClick={() => send.mutate(c.id)}
                  disabled={send.isPending}
                  data-testid={`button-send-campaign-${c.id}`}
                >
                  {send.isPending ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Send className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Send now
                </Button>
              )}
            </article>
          ))}
          {(campaigns ?? []).length === 0 && (
            <div className="rounded-md border border-dashed border-border px-3 py-8 text-center text-xs text-muted-foreground">
              No campaigns yet.
            </div>
          )}
        </section>
      </div>
    </StaffShell>
  );
}
