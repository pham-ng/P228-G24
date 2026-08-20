import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { StaffShell } from "@/components/staff-shell";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiRequest } from "@/lib/queryClient";
import { titleCase } from "@/lib/format";
import type { RoomRow, RoomTypeRow } from "@/lib/types";
import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<string, string> = {
  clean: "border-chart-2/40 bg-chart-2/10",
  inspected: "border-primary/40 bg-primary/10",
  dirty: "border-chart-4/50 bg-chart-4/10",
  out_of_order: "border-destructive/40 bg-destructive/10",
};

export default function RoomsPage() {
  const qc = useQueryClient();
  const { data: rooms, isLoading } = useQuery<RoomRow[]>({
    queryKey: ["/api/rooms"],
    refetchInterval: 15000,
  });

  const update = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: string }) => {
      await apiRequest("PATCH", `/api/rooms/${id}`, { status });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/rooms"] }),
  });

  const { data: catalogue } = useQuery<RoomTypeRow[]>({ queryKey: ["/api/room-types"] });
  const [openType, setOpenType] = useState<string | null>(null);

  const floors = Array.from(new Set((rooms ?? []).map((r) => r.floor))).sort((a, b) => b - a);

  return (
    <StaffShell
      title="Rooms"
      description="Housekeeping status, occupancy and open work per key"
    >
      {isLoading && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      )}
      <section className="mb-8">
        <h2 className="mb-1 text-sm font-semibold">Room catalogue</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Published facts the concierge is allowed to quote — parsed from the property's own room
          pages. A dash means the page does not publish that field, so the agent says so instead of
          estimating.
        </p>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[760px] text-xs">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Category</th>
                <th className="px-3 py-2 text-right font-medium">Area</th>
                <th className="px-3 py-2 text-left font-medium">Max party</th>
                <th className="px-3 py-2 text-right font-medium">Rate / night</th>
                <th className="px-3 py-2 text-right font-medium">Keys</th>
                <th className="px-3 py-2 text-right font-medium">Amenities</th>
              </tr>
            </thead>
            <tbody>
              {(catalogue ?? []).map((c) => (
                <>
                  <tr
                    key={c.code}
                    onClick={() => setOpenType(openType === c.code ? null : c.code)}
                    className="cursor-pointer border-t border-border hover:bg-muted/30"
                    data-testid={`room-type-${c.code.replace(/\s+/g, "-")}`}
                  >
                    <td className="px-3 py-2">
                      <span className="font-medium">{c.nameVi ?? c.code}</span>
                      <span className="ml-2 text-muted-foreground">{c.code}</span>
                      {!c.published && (
                        <span className="ml-2 rounded bg-chart-4/15 px-1.5 py-0.5 text-[10px] text-chart-4">
                          no published page
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {c.areaSqm ? `${c.areaSqm} m²` : "—"}
                    </td>
                    <td className="px-3 py-2">
                      {c.maxGuests
                        ? `${c.maxGuests} — ${c.combinations
                            .map((x) => `${x.adults}A+${x.children}C`)
                            .join(" or ")}`
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {c.rate ? c.rate.toLocaleString("vi-VN") : "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{c.rooms}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {c.amenities.length || "—"}
                    </td>
                  </tr>
                  {openType === c.code && (
                    <tr key={`${c.code}-detail`} className="border-t border-border bg-muted/20">
                      <td colSpan={6} className="px-3 py-3">
                        {c.description ? (
                          <p className="mb-2 max-w-3xl leading-relaxed text-muted-foreground">
                            {c.description}
                          </p>
                        ) : (
                          <p className="mb-2 text-muted-foreground">
                            No room page published for this category — the concierge answers that the
                            details are not published and offers to confirm with reception.
                          </p>
                        )}
                        {c.amenities.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {c.amenities.map((a) => (
                              <span
                                key={a}
                                className="rounded border border-border bg-background px-1.5 py-0.5 text-[11px]"
                              >
                                {a}
                              </span>
                            ))}
                          </div>
                        )}
                        {c.sourceUrl && (
                          <a
                            href={c.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-2 inline-block text-[11px] text-primary underline"
                          >
                            Source: booking.vinpearl.com
                          </a>
                        )}
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="space-y-6">
        {floors.map((floor) => (
          <section key={floor}>
            <h2 className="mb-2 text-sm font-semibold">Floor {floor}</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {(rooms ?? [])
                .filter((r) => r.floor === floor)
                .map((r) => (
                  <article
                    key={r.id}
                    data-testid={`room-${r.number}`}
                    className={cn("rounded-md border p-3", STATUS_STYLES[r.status] ?? "border-card-border bg-card")}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-mono text-base font-semibold">{r.number}</span>
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        {titleCase(r.type)}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {r.guestName ? (
                        <>
                          <span className="font-medium text-foreground">{r.guestName}</span>
                          {r.vipTier && r.vipTier !== "none" && (
                            <span className="ml-1.5 rounded bg-primary/15 px-1 py-0.5 text-[9px] uppercase text-primary">
                              {r.vipTier}
                            </span>
                          )}
                        </>
                      ) : r.arrivingToday ? (
                        "Arriving today"
                      ) : (
                        "Vacant"
                      )}
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      {r.departure
                        ? `Departs ${r.departure}`
                        : `${
                            (catalogue ?? []).find((c) => c.code === r.type)?.oceanView ||
                            /ocean/i.test(r.type)
                              ? "Ocean"
                              : "Garden"
                          } view`}
                    </div>
                    {r.housekeepingNote && (
                      <p className="mt-1 text-[11px] italic text-muted-foreground">
                        {r.housekeepingNote}
                      </p>
                    )}
                    <div className="mt-2 flex items-center gap-1.5">
                      <Select
                        value={r.status}
                        onValueChange={(status) => update.mutate({ id: r.id, status })}
                      >
                        <SelectTrigger
                          className="h-7 flex-1 text-[11px]"
                          data-testid={`select-room-status-${r.number}`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {["clean", "inspected", "dirty", "out_of_order"].map((s) => (
                            <SelectItem key={s} value={s}>
                              {titleCase(s)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {r.openTasks > 0 && (
                        <span className="rounded bg-chart-3/15 px-1.5 py-0.5 text-[10px] text-chart-3">
                          {r.openTasks} task{r.openTasks === 1 ? "" : "s"}
                        </span>
                      )}
                    </div>
                  </article>
                ))}
            </div>
          </section>
        ))}
      </div>
    </StaffShell>
  );
}
