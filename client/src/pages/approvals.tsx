import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, X, ShieldCheck } from "lucide-react";
import { StaffShell } from "@/components/staff-shell";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/queryClient";
import { relative } from "@/lib/format";
import { useSession } from "@/lib/session";
import type { ServiceApproval } from "@/lib/types";
import { cn } from "@/lib/utils";

const KIND_LABELS: Record<ServiceApproval["kind"], string> = {
  book_service: "Đặt dịch vụ",
  cancel_service_booking: "Hủy dịch vụ",
  order_room_service: "Đặt món tại phòng",
  cancel_reservation: "Hủy đặt phòng",
  request_late_checkout: "Trả phòng muộn",
  request_early_checkin: "Nhận phòng sớm",
};

function ApprovalCard({ a }: { a: ServiceApproval }) {
  const qc = useQueryClient();
  const { staff } = useSession();
  const [reason, setReason] = useState("");
  const [showReject, setShowReject] = useState(false);

  const act = useMutation({
    mutationFn: async (action: "approve" | "reject") => {
      await apiRequest("POST", `/api/approvals/${a.id}/${action}`, {
        staffName: staff?.name ?? "Staff",
        reason: action === "reject" ? reason : undefined,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/approvals"] });
      qc.invalidateQueries({ queryKey: ["/api/tasks"] });
    },
  });

  return (
    <article
      data-testid={`approval-${a.id}`}
      className="rounded-md border border-card-border bg-card p-3"
    >
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-sm font-medium leading-snug">{a.summary}</p>
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          {KIND_LABELS[a.kind]}
        </span>
      </div>
      {a.amount != null && (
        <p className="mt-1 text-xs text-muted-foreground">
          Số tiền liên quan: <span className="font-medium text-foreground">{a.amount.toLocaleString("vi-VN")}₫</span>
        </p>
      )}
      <div className="mt-1.5 text-[10px] text-muted-foreground">yêu cầu {relative(a.createdAt)}</div>

      {a.status === "pending" && (
        <>
          {!showReject ? (
            <div className="mt-2.5 flex items-center gap-1.5">
              <Button
                size="sm"
                className="h-7 flex-1 text-[11px]"
                onClick={() => act.mutate("approve")}
                disabled={act.isPending}
                data-testid={`button-approve-${a.id}`}
              >
                <Check className="mr-1 h-3.5 w-3.5" /> Duyệt
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 flex-1 text-[11px]"
                onClick={() => setShowReject(true)}
                disabled={act.isPending}
                data-testid={`button-reject-${a.id}`}
              >
                <X className="mr-1 h-3.5 w-3.5" /> Từ chối
              </Button>
            </div>
          ) : (
            <div className="mt-2.5 space-y-1.5">
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Lý do từ chối (tuỳ chọn)"
                rows={2}
                className="text-xs"
                data-testid={`input-reject-reason-${a.id}`}
              />
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-7 flex-1 text-[11px]"
                  onClick={() => act.mutate("reject")}
                  disabled={act.isPending}
                  data-testid={`button-confirm-reject-${a.id}`}
                >
                  Xác nhận từ chối
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-[11px]"
                  onClick={() => setShowReject(false)}
                >
                  Huỷ
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {a.status !== "pending" && (
        <div
          className={cn(
            "mt-2.5 rounded px-2 py-1 text-[11px]",
            a.status === "approved" ? "bg-chart-2/15 text-chart-2" : "bg-destructive/15 text-destructive",
          )}
        >
          {a.status === "approved" ? "Đã duyệt" : "Đã từ chối"} bởi {a.resolvedBy ?? "—"}
          {a.rejectionReason ? ` — ${a.rejectionReason}` : ""}
        </div>
      )}
    </article>
  );
}

export default function ApprovalsPage() {
  const { data: approvals, isLoading } = useQuery<ServiceApproval[]>({
    queryKey: ["/api/approvals"],
    refetchInterval: 8000,
  });

  const pending = (approvals ?? []).filter((a) => a.status === "pending");
  const resolved = (approvals ?? []).filter((a) => a.status !== "pending").slice(0, 30);

  return (
    <StaffShell
      title="Approvals"
      description="Mọi yêu cầu đặt/hủy dịch vụ AI tạo ra dừng ở đây — chưa ghi folio, chưa có hiệu lực cho tới khi được duyệt"
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="min-w-0">
          <div className="mb-2 flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold">Đang chờ duyệt</h2>
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {pending.length}
            </span>
          </div>
          <div className="space-y-2">
            {isLoading && [0, 1].map((i) => <Skeleton key={i} className="h-24 w-full" />)}
            {pending.map((a) => (
              <ApprovalCard key={a.id} a={a} />
            ))}
            {!isLoading && pending.length === 0 && (
              <div className="rounded-md border border-dashed border-border px-3 py-8 text-center text-xs text-muted-foreground">
                Không có yêu cầu nào đang chờ.
              </div>
            )}
          </div>
        </section>

        <section className="min-w-0">
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-sm font-semibold">Đã xử lý gần đây</h2>
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {resolved.length}
            </span>
          </div>
          <div className="space-y-2">
            {resolved.map((a) => (
              <ApprovalCard key={a.id} a={a} />
            ))}
            {!isLoading && resolved.length === 0 && (
              <div className="rounded-md border border-dashed border-border px-3 py-8 text-center text-xs text-muted-foreground">
                Chưa có gì.
              </div>
            )}
          </div>
        </section>
      </div>
    </StaffShell>
  );
}
