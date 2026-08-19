import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { StaffShell } from "@/components/staff-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest } from "@/lib/queryClient";
import type { Hotel } from "@/lib/types";

export default function SettingsPage() {
  const qc = useQueryClient();
  const { data: hotel } = useQuery<Hotel>({ queryKey: ["/api/hotel"] });
  const [brandVoice, setBrandVoice] = useState("");
  const [sla, setSla] = useState(10);
  const [aiEnabled, setAiEnabled] = useState(true);

  useEffect(() => {
    if (hotel) {
      setBrandVoice(hotel.brandVoice);
      setSla(hotel.slaMinutes);
      setAiEnabled(hotel.aiEnabled === 1);
    }
  }, [hotel]);

  const save = useMutation({
    mutationFn: async () => {
      await apiRequest("PATCH", "/api/hotel", {
        brandVoice,
        slaMinutes: sla,
        aiEnabled: aiEnabled ? 1 : 0,
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/hotel"] }),
  });

  const health = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/ai/health");
      return res.json() as Promise<{ ok: boolean; reply?: string; message?: string }>;
    },
  });

  return (
    <StaffShell title="Settings" description="Brand voice, escalation policy and model connectivity">
      <div className="mx-auto max-w-2xl space-y-6">
        <section className="space-y-3 rounded-md border border-card-border bg-card p-4">
          <div>
            <h2 className="text-sm font-semibold">Brand voice</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Injected verbatim into the concierge's system prompt on every turn.
            </p>
          </div>
          <Textarea
            value={brandVoice}
            onChange={(e) => setBrandVoice(e.target.value)}
            rows={8}
            data-testid="input-brand-voice"
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Acknowledgement SLA (minutes)</Label>
              <Input
                type="number"
                min={1}
                max={240}
                value={sla}
                onChange={(e) => setSla(Number(e.target.value))}
                data-testid="input-sla"
              />
            </div>
            <div className="flex items-end justify-between gap-3 rounded-md border border-border px-3 py-2">
              <div>
                <div className="text-sm font-medium">AI concierge</div>
                <div className="text-[11px] text-muted-foreground">
                  Off routes every new message to the front desk.
                </div>
              </div>
              <Switch
                checked={aiEnabled}
                onCheckedChange={setAiEnabled}
                data-testid="switch-ai"
              />
            </div>
          </div>
          <Button onClick={() => save.mutate()} disabled={save.isPending} data-testid="button-save-settings">
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save
          </Button>
          {save.isSuccess && (
            <p className="text-xs text-chart-2" data-testid="text-saved">
              Saved. The next guest message uses these settings.
            </p>
          )}
        </section>

        <section className="space-y-3 rounded-md border border-card-border bg-card p-4">
          <div>
            <h2 className="text-sm font-semibold">Model connectivity</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Sends one real completion request through the configured credential.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              onClick={() => health.mutate()}
              disabled={health.isPending}
              data-testid="button-health"
            >
              {health.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Run check
            </Button>
            {health.data?.ok && (
              <span className="flex items-center gap-1.5 text-xs text-chart-2" data-testid="text-health-ok">
                <CheckCircle2 className="h-4 w-4" /> Model replied "{health.data.reply}"
              </span>
            )}
            {(health.isError || health.data?.ok === false) && (
              <span className="flex items-center gap-1.5 text-xs text-destructive" data-testid="text-health-fail">
                <XCircle className="h-4 w-4" />
                {health.data?.message ?? (health.error as Error)?.message}
              </span>
            )}
          </div>
        </section>

        <section className="rounded-md border border-card-border bg-card p-4">
          <h2 className="text-sm font-semibold">Property</h2>
          <dl className="mt-2 grid gap-1.5 text-xs sm:grid-cols-2">
            {[
              ["Name", hotel?.name],
              ["City", hotel?.city],
              ["Timezone", hotel?.timezone],
              ["Currency", hotel?.currency],
              ["Check-in", hotel?.checkInTime],
              ["Check-out", hotel?.checkOutTime],
            ].map(([k, v]) => (
              <div key={k as string} className="flex justify-between gap-2 border-b border-border py-1">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="font-medium">{v ?? "—"}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </StaffShell>
  );
}
