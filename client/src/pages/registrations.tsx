/**
 * Khai báo lưu trú — the front desk's legal worklist.
 *
 * This is deliberately a STAFF page and not a kiosk form. The declaration
 * carries passport number, nationality, date of birth, visa and permanent
 * address — the set `guestSafeDetail` exists to keep off a surface whose only
 * credential is a confirmation code. More importantly the declaration is the
 * hotel's obligation, discharged with the physical document in hand: a guest
 * typing a passport number nobody checked produces a record that looks filed
 * and verifies nothing.
 *
 * The page IS the worklist — no task is raised per row. A task could be closed
 * independently of the filing, which is exactly how a legal deadline gets
 * marked done while nothing was actually submitted.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { StaffShell } from "@/components/staff-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiRequest } from "@/lib/queryClient";
import { AlertTriangle, Check, Clock, FileText, Plus } from "lucide-react";

type Registration = {
  id: number;
  reservationId: number;
  fullName: string;
  idType: string;
  idNumber: string;
  nationality: string;
  dob: string | null;
  visaNumber: string | null;
  entryDate: string | null;
  entryPort: string | null;
  permanentAddress: string | null;
  arrivalAt: string;
  isForeigner: number;
  status: string;
  channel: string | null;
  receiptRef: string | null;
  submittedAt: string | null;
  note: string | null;
  missing: string[];
  room: string | null;
  confirmationCode: string | null;
  dueAt: string | null;
};

type Requirements = {
  required: string[];
  deadlineHours: number;
  deadlineNote: string;
  channels: Array<{ key: string; label: string; url: string }>;
  penaltyNote: string;
};

type Reservation = { id: number; confirmationCode: string; status: string; guestId: number };

const FIELD_VI: Record<string, string> = {
  full_name: "họ tên",
  id_number: "số giấy tờ",
  nationality: "quốc tịch",
  dob: "ngày sinh",
  permanent_address: "địa chỉ thường trú",
  visa_number: "số thị thực",
  entry_date: "ngày nhập cảnh",
  entry_port: "cửa khẩu nhập cảnh",
  arrival_at: "giờ đến",
};

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";

/** Overdue is the only status that changes what someone does next. */
function overdue(r: Registration) {
  return r.status !== "submitted" && !!r.dueAt && Date.parse(r.dueAt) < Date.now();
}

function StatusPill({ r }: { r: Registration }) {
  if (r.status === "submitted")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
        <Check className="h-3 w-3" /> Đã nộp
      </span>
    );
  if (r.status === "rejected")
    return <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-[11px] font-semibold text-destructive">Bị từ chối</span>;
  if (r.missing.length)
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-400">
        <AlertTriangle className="h-3 w-3" /> Thiếu {r.missing.length} mục
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-semibold text-primary">
      <Clock className="h-3 w-3" /> Chờ nộp
    </span>
  );
}

function SubmitRow({ r, channels }: { r: Registration; channels: Requirements["channels"] }) {
  const qc = useQueryClient();
  const [channel, setChannel] = useState(channels[0]?.key ?? "police_portal");
  const [receipt, setReceipt] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const submit = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", `/api/registrations/${r.id}`, { action: "submit", channel, receiptRef: receipt.trim() });
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/registrations"] }),
    onError: (e: any) => setErr(e?.message ?? "Không nộp được."),
  });

  if (r.missing.length)
    return (
      <div className="text-[11px] text-amber-700 dark:text-amber-400">
        Bổ sung {r.missing.map((m) => FIELD_VI[m] ?? m).join(", ")} trước khi nộp.
      </div>
    );

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <select
        value={channel}
        onChange={(e) => setChannel(e.target.value)}
        data-testid={`reg-channel-${r.id}`}
        className="rounded-md border border-border bg-card px-2 py-1 text-[11px]"
      >
        {channels.map((c) => (
          <option key={c.key} value={c.key}>
            {c.label}
          </option>
        ))}
      </select>
      {/* Required, not optional: "submitted" with nothing to show an inspector
          is the same as not filed, only harder to notice. */}
      <Input
        value={receipt}
        onChange={(e) => { setReceipt(e.target.value); setErr(null); }}
        placeholder="Mã biên nhận"
        className="h-7 w-36 text-[11px]"
        data-testid={`reg-receipt-${r.id}`}
      />
      <Button
        size="sm"
        className="h-7 text-[11px]"
        disabled={!receipt.trim() || submit.isPending}
        onClick={() => submit.mutate()}
        data-testid={`reg-submit-${r.id}`}
      >
        Đánh dấu đã nộp
      </Button>
      {err && <span className="text-[11px] text-destructive">{err}</span>}
    </div>
  );
}

function NewForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const { data: reservations } = useQuery<Reservation[]>({ queryKey: ["/api/reservations"] });
  const [f, setF] = useState({
    reservationId: 0, fullName: "", idType: "passport", idNumber: "", nationality: "",
    dob: "", permanentAddress: "", visaNumber: "", entryDate: "", entryPort: "",
  });
  const [err, setErr] = useState<string | null>(null);

  const inHouse = (reservations ?? []).filter((r) => r.status === "in_house" || r.status === "confirmed");

  const create = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = { reservationId: f.reservationId, fullName: f.fullName, idType: f.idType, idNumber: f.idNumber, nationality: f.nationality };
      for (const k of ["dob", "permanentAddress", "visaNumber", "entryDate", "entryPort"] as const)
        if (f[k].trim()) body[k] = f[k].trim();
      const res = await apiRequest("POST", "/api/registrations", body);
      return res.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/registrations"] }); onDone(); },
    onError: (e: any) => setErr(e?.message ?? "Không lưu được."),
  });

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((p) => ({ ...p, [k]: e.target.value }));
  const ready = f.reservationId > 0 && f.fullName.trim() && f.idNumber.trim() && f.nationality.trim();

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-semibold">Ghi nhận khai báo mới</h3>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Nhập từ giấy tờ gốc của khách. Các trường bỏ trống sẽ được ghi nhận là còn thiếu, không phải là không cần.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <select
          value={f.reservationId}
          onChange={(e) => setF((p) => ({ ...p, reservationId: Number(e.target.value) }))}
          data-testid="reg-new-reservation"
          className="rounded-md border border-border bg-background px-2 py-2 text-xs"
        >
          <option value={0}>— Chọn đặt phòng —</option>
          {inHouse.map((r) => (
            <option key={r.id} value={r.id}>{r.confirmationCode}</option>
          ))}
        </select>
        <select
          value={f.idType}
          onChange={(e) => setF((p) => ({ ...p, idType: e.target.value }))}
          className="rounded-md border border-border bg-background px-2 py-2 text-xs"
        >
          <option value="passport">Hộ chiếu</option>
          <option value="national_id">CCCD / CMND</option>
          <option value="other">Giấy tờ khác</option>
        </select>
        <Input value={f.fullName} onChange={set("fullName")} placeholder="Họ tên như trên giấy tờ" className="text-xs" data-testid="reg-new-name" />
        <Input value={f.idNumber} onChange={set("idNumber")} placeholder="Số giấy tờ" className="font-mono text-xs" data-testid="reg-new-id" />
        <Input value={f.nationality} onChange={set("nationality")} placeholder="Quốc tịch (vd: Việt Nam, Japan)" className="text-xs" data-testid="reg-new-nat" />
        <Input value={f.dob} onChange={set("dob")} placeholder="Ngày sinh YYYY-MM-DD" className="text-xs" />
        <Input value={f.permanentAddress} onChange={set("permanentAddress")} placeholder="Địa chỉ thường trú" className="text-xs" />
        <Input value={f.visaNumber} onChange={set("visaNumber")} placeholder="Số thị thực (khách nước ngoài)" className="text-xs" />
        <Input value={f.entryDate} onChange={set("entryDate")} placeholder="Ngày nhập cảnh YYYY-MM-DD" className="text-xs" />
        <Input value={f.entryPort} onChange={set("entryPort")} placeholder="Cửa khẩu nhập cảnh" className="text-xs" />
      </div>
      {err && <p className="mt-2 text-[11px] text-destructive">{err}</p>}
      <div className="mt-3 flex gap-2">
        <Button size="sm" disabled={!ready || create.isPending} onClick={() => create.mutate()} data-testid="reg-new-save">
          Lưu
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>Huỷ</Button>
      </div>
    </div>
  );
}

export default function RegistrationsPage() {
  const [adding, setAdding] = useState(false);
  const { data: rows, isLoading } = useQuery<Registration[]>({ queryKey: ["/api/registrations"] });
  const { data: reqs } = useQuery<Requirements>({ queryKey: ["/api/registrations/requirements?foreigner=1"] });

  const list = rows ?? [];
  /* Overdue first, then everything unfiled, then the filed ones. The order is
     the priority: an inspector asks about the ones nobody filed. */
  const sorted = useMemo(
    () =>
      [...list].sort((a, b) => {
        const rank = (r: Registration) => (overdue(r) ? 0 : r.status !== "submitted" ? 1 : 2);
        return rank(a) - rank(b) || (a.dueAt ?? "").localeCompare(b.dueAt ?? "");
      }),
    [list],
  );
  const pending = list.filter((r) => r.status !== "submitted" && r.status !== "rejected").length;
  const late = list.filter(overdue).length;

  return (
    <StaffShell title="Khai báo lưu trú">
      <div className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold">
              <FileText className="h-4 w-4 text-primary" />
              {pending} hồ sơ chưa nộp
              {late > 0 && <span className="text-destructive">· {late} đã quá hạn</span>}
            </div>
            {reqs && (
              <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-muted-foreground">
                Hạn {reqs.deadlineHours} giờ sau khi khách đến. {reqs.deadlineNote} {reqs.penaltyNote}
              </p>
            )}
          </div>
          <Button size="sm" onClick={() => setAdding((v) => !v)} data-testid="button-new-registration">
            <Plus className="mr-1 h-3.5 w-3.5" /> Ghi nhận mới
          </Button>
        </div>

        {adding && <NewForm onDone={() => setAdding(false)} />}

        {isLoading && <p className="text-xs text-muted-foreground">Đang tải…</p>}
        {!isLoading && sorted.length === 0 && (
          <p className="rounded-xl border border-dashed border-border p-8 text-center text-xs text-muted-foreground">
            Chưa có hồ sơ khai báo lưu trú nào. Ghi nhận khi khách nhận phòng, từ giấy tờ gốc.
          </p>
        )}

        <div className="grid gap-2">
          {sorted.map((r) => (
            <div
              key={r.id}
              data-testid={`registration-${r.id}`}
              className={`rounded-xl border p-3.5 ${overdue(r) ? "border-destructive/50 bg-destructive/5" : "border-border bg-card"}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{r.fullName}</span>
                    <StatusPill r={r} />
                    {r.isForeigner === 1 && (
                      <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        khách nước ngoài
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    {r.idType === "passport" ? "Hộ chiếu" : r.idType === "national_id" ? "CCCD" : "Giấy tờ"}{" "}
                    <span className="font-mono">{r.idNumber}</span> · {r.nationality}
                    {r.room && ` · phòng ${r.room}`}
                    {r.confirmationCode && ` · ${r.confirmationCode}`}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    Đến {fmt(r.arrivalAt)} · hạn {fmt(r.dueAt)}
                    {r.submittedAt && ` · nộp ${fmt(r.submittedAt)}`}
                    {r.receiptRef && ` · biên nhận ${r.receiptRef}`}
                  </div>
                </div>
                <div className="shrink-0">
                  {r.status !== "submitted" && reqs && <SubmitRow r={r} channels={reqs.channels} />}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </StaffShell>
  );
}
