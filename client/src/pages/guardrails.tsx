import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, ShieldOff, Lock } from "lucide-react";
import { StaffShell } from "@/components/staff-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { apiRequest } from "@/lib/queryClient";
import type { AuditEvent } from "@/lib/types";

type Layer = { key: string; label: string; description: string; enabled: boolean };
type AlwaysOn = { key: string; label: string; description: string };
type Payload = { layers: Layer[]; alwaysOn: AlwaysOn[] };

/**
 * Turning a protection off is a supported action here, and that is the point:
 * a customer believes a defence exists when they watch the attack land without
 * it and stop with it. What must never be switchable is the life-safety path,
 * so those layers are listed separately and rendered locked rather than hidden
 * — a customer who cannot see them would reasonably assume they were forgotten.
 */
export default function GuardrailsPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Payload>({
    queryKey: ["/api/guardrails"],
    refetchInterval: 15000,
  });

  /* The audit trail is the observability half. A disabled guard is a state
     someone has to be able to discover later, especially the "we turned it off
     for the demo and forgot" case this switch creates. */
  const events = useQuery<AuditEvent[]>({ queryKey: ["/api/events"], refetchInterval: 10000 });

  const toggle = useMutation({
    mutationFn: async ({ key, enabled }: { key: string; enabled: boolean }) =>
      apiRequest("PATCH", `/api/guardrails/${key}`, { enabled }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/guardrails"] });
      qc.invalidateQueries({ queryKey: ["/api/events"] });
    },
  });

  if (isLoading || !data) {
    return (
      <StaffShell title="Guardrails" description="Các lớp bảo vệ và trạng thái">
        <div className="grid gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      </StaffShell>
    );
  }

  const off = data.layers.filter((l) => !l.enabled);
  const guardEvents = (events.data ?? []).filter((e) => e.type === "guardrail.toggled").slice(0, 12);

  return (
    <StaffShell title="Guardrails" description="Bật/tắt từng lớp để quan sát và demo">
      {off.length > 0 && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs">
          <span className="font-medium text-destructive">
            {off.length} lớp đang TẮT: {off.map((l) => l.label).join(", ")}.
          </span>{" "}
          Nhớ bật lại sau khi demo — trạng thái này được lưu vào cơ sở dữ liệu và giữ nguyên qua các lần
          khởi động lại.
        </div>
      )}

      <div className="grid gap-3">
        {data.layers.map((l) => (
          <section
            key={l.key}
            className="flex items-start gap-3 rounded-md border border-card-border bg-card p-4"
            data-testid={`guardrail-${l.key}`}
          >
            <div className={l.enabled ? "text-chart-2" : "text-muted-foreground"}>
              {l.enabled ? <ShieldCheck className="h-5 w-5" /> : <ShieldOff className="h-5 w-5" />}
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold">{l.label}</h2>
              <p className="mt-1 text-xs text-muted-foreground">{l.description}</p>
            </div>
            <Switch
              checked={l.enabled}
              disabled={toggle.isPending}
              onCheckedChange={(enabled) => toggle.mutate({ key: l.key, enabled })}
              data-testid={`toggle-${l.key}`}
            />
          </section>
        ))}
      </div>

      <h2 className="mt-6 text-sm font-semibold">Không thể tắt</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Đường an toàn tính mạng. Không có cấu hình, biến môi trường hay lệnh API nào tắt được — cái giá
        của việc quên bật lại sau một buổi demo được tính bằng con người, không phải bằng phiếu hỗ trợ.
      </p>
      <div className="mt-3 grid gap-3">
        {data.alwaysOn.map((l) => (
          <section
            key={l.key}
            className="flex items-start gap-3 rounded-md border border-card-border bg-muted/30 p-4"
          >
            <Lock className="h-5 w-5 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-medium">{l.label}</h3>
              <p className="mt-1 text-xs text-muted-foreground">{l.description}</p>
            </div>
          </section>
        ))}
      </div>

      <h2 className="mt-6 text-sm font-semibold">Lịch sử bật/tắt</h2>
      {guardEvents.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">Chưa có thay đổi nào được ghi nhận.</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {guardEvents.map((e) => (
            <li key={e.id} className="rounded-md border border-card-border bg-card px-3 py-2 text-xs">
              <span className="text-muted-foreground">{new Date(e.createdAt).toLocaleString()}</span>{" "}
              — {e.summary}
            </li>
          ))}
        </ul>
      )}
    </StaffShell>
  );
}
