/**
 * The guest-request board.
 *
 * `guest_requests` has been written to since the table was added and had no API
 * and no page — every row was invisible, and the paired TASK was the only thing
 * anyone saw. That made the request row look like duplication, which it is not:
 * the task carries the work, the request carries what the guest actually asked
 * for, the time they wanted it, and a status they can be told about.
 *
 * Scheduled requests sort first and by time, because a wake-up call at 06:30 is
 * not urgent at 21:00 and is the most urgent thing in the hotel at 06:25.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { StaffShell } from "@/components/staff-shell";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";
import { BellRing, Sparkles, Shirt, Luggage, ClipboardList, Clock, Check } from "lucide-react";

type GuestRequestRow = {
  id: number;
  kind: string;
  dept: string;
  summary: string;
  payload: Record<string, unknown>;
  scheduledFor: string | null;
  status: string;
  guestName: string | null;
  room: string | null;
  confirmationCode: string | null;
  taskStatus: string | null;
  dueAt: string | null;
  createdAt: string;
};

const KIND_ICON: Record<string, typeof BellRing> = {
  wake_up: BellRing,
  housekeeping: Sparkles,
  amenity: Sparkles,
  laundry: Shirt,
  luggage: Luggage,
};

const KIND_VI: Record<string, string> = {
  wake_up: "Báo thức",
  housekeeping: "Dọn phòng",
  amenity: "Đồ dùng",
  laundry: "Giặt là",
  luggage: "Hành lý",
  transport: "Đưa đón",
  lost_item: "Đồ thất lạc",
  room_move: "Đổi phòng",
  maintenance: "Kỹ thuật",
  babysitting: "Trông trẻ",
  medical: "Y tế",
  meeting_room: "Phòng họp",
  tour: "Tour",
  lodging_declaration: "Khai báo lưu trú",
};

const DEPT_VI: Record<string, string> = {
  front_desk: "Lễ tân",
  housekeeping: "Buồng phòng",
  fnb: "Nhà hàng",
  engineering: "Kỹ thuật",
  spa: "Spa",
  security: "An ninh",
  concierge: "Concierge",
};

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";

/** Late is the only thing that changes what someone does next. */
const late = (r: GuestRequestRow) =>
  r.status !== "done" && r.status !== "cancelled" && !!r.dueAt && Date.parse(r.dueAt) < Date.now();

function Row({ r }: { r: GuestRequestRow }) {
  const qc = useQueryClient();
  const Icon = KIND_ICON[r.kind] ?? ClipboardList;
  const move = useMutation({
    mutationFn: async (status: string) => {
      const res = await apiRequest("PATCH", `/api/requests/${r.id}`, { status });
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/requests"] }),
  });

  const detail = Object.entries(r.payload ?? {})
    .filter(([, v]) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`)
    .join(" · ");

  return (
    <div
      data-testid={`request-row-${r.id}`}
      className={`rounded-xl border p-3.5 ${late(r) ? "border-destructive/50 bg-destructive/5" : "border-border bg-card"}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Icon className="h-4 w-4 shrink-0 text-primary" />
            <span className="text-sm font-semibold">{KIND_VI[r.kind] ?? r.kind}</span>
            <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {DEPT_VI[r.dept] ?? r.dept}
            </span>
            {r.status === "done" && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-400">
                <Check className="h-3 w-3" /> xong
              </span>
            )}
            {r.status === "in_progress" && (
              <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary">đang làm</span>
            )}
            {late(r) && <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-semibold text-destructive">trễ hạn</span>}
          </div>
          <div className="mt-1 text-xs text-foreground/85">{r.summary}</div>
          {detail && <div className="mt-0.5 text-[11px] text-muted-foreground">{detail}</div>}
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {r.guestName ?? "—"}
            {r.room && ` · phòng ${r.room}`}
            {r.confirmationCode && ` · ${r.confirmationCode}`}
            {r.scheduledFor && (
              <>
                {" · "}
                <Clock className="inline h-3 w-3" /> hẹn {fmt(r.scheduledFor)}
              </>
            )}
          </div>
        </div>
        {r.status !== "done" && r.status !== "cancelled" && (
          <div className="flex shrink-0 gap-1.5">
            {r.status === "open" && (
              <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => move.mutate("in_progress")} data-testid={`req-start-${r.id}`}>
                Nhận
              </Button>
            )}
            <Button size="sm" className="h-7 text-[11px]" onClick={() => move.mutate("done")} data-testid={`req-done-${r.id}`}>
              Xong
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function RequestsPage() {
  const [showDone, setShowDone] = useState(false);
  const { data, isLoading } = useQuery<GuestRequestRow[]>({ queryKey: ["/api/requests"], refetchInterval: 20_000 });
  const rows = data ?? [];

  const sorted = useMemo(() => {
    const live = rows.filter((r) => r.status !== "done" && r.status !== "cancelled");
    const closed = rows.filter((r) => r.status === "done" || r.status === "cancelled");
    /* Scheduled work sorts by when it is due; unscheduled work by age. */
    live.sort((a, b) => {
      if (late(a) !== late(b)) return late(a) ? -1 : 1;
      const aw = a.dueAt ?? a.createdAt;
      const bw = b.dueAt ?? b.createdAt;
      return aw.localeCompare(bw);
    });
    return showDone ? [...live, ...closed] : live;
  }, [rows, showDone]);

  const open = rows.filter((r) => r.status !== "done" && r.status !== "cancelled").length;
  const overdue = rows.filter(late).length;

  return (
    <StaffShell title="Yêu cầu của khách">
      <div className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <ClipboardList className="h-4 w-4 text-primary" />
            {open} yêu cầu đang mở
            {overdue > 0 && <span className="text-destructive">· {overdue} trễ hạn</span>}
          </div>
          <Button size="sm" variant="ghost" onClick={() => setShowDone((v) => !v)} data-testid="toggle-done">
            {showDone ? "Ẩn việc đã xong" : "Hiện việc đã xong"}
          </Button>
        </div>

        {isLoading && <p className="text-xs text-muted-foreground">Đang tải…</p>}
        {!isLoading && sorted.length === 0 && (
          <p className="rounded-xl border border-dashed border-border p-8 text-center text-xs text-muted-foreground">
            Chưa có yêu cầu nào. Khách gửi từ mục “Yêu cầu nhanh” trên màn hình concierge.
          </p>
        )}

        <div className="grid gap-2">
          {sorted.map((r) => (
            <Row key={r.id} r={r} />
          ))}
        </div>
      </div>
    </StaffShell>
  );
}
