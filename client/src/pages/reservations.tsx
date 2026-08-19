import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ExternalLink } from "lucide-react";
import { StaffShell } from "@/components/staff-shell";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { money, titleCase } from "@/lib/format";
import type { ReservationRow, ServiceRow } from "@/lib/types";
import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<string, string> = {
  in_house: "bg-chart-2/15 text-chart-2",
  confirmed: "bg-primary/12 text-primary",
  checked_out: "bg-muted text-muted-foreground",
  cancelled: "bg-destructive/15 text-destructive",
};

export default function ReservationsPage() {
  const { data: rows, isLoading } = useQuery<ReservationRow[]>({
    queryKey: ["/api/reservations"],
  });
  const { data: services } = useQuery<ServiceRow[]>({ queryKey: ["/api/services"] });

  return (
    <StaffShell
      title="Reservations"
      description="The PMS view the AI reads and writes — folios update as requests land"
    >
      <div className="space-y-8">
        <section>
          <div className="overflow-x-auto rounded-md border border-card-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Guest</TableHead>
                  <TableHead>Room</TableHead>
                  <TableHead>Stay</TableHead>
                  <TableHead>Departure</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Rate</TableHead>
                  <TableHead className="text-right">Folio</TableHead>
                  <TableHead className="text-right">Chat</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading &&
                  Array.from({ length: 6 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={8}>
                        <Skeleton className="h-5 w-full" />
                      </TableCell>
                    </TableRow>
                  ))}
                {(rows ?? []).map((r) => (
                  <TableRow key={r.id} data-testid={`reservation-${r.confirmationCode}`}>
                    <TableCell>
                      <div className="text-sm font-medium">{r.guestName}</div>
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {r.confirmationCode}
                        {r.vipTier !== "none" && ` · ${r.vipTier}`}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-sm">{r.roomNumber ?? "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {r.checkIn} → {r.checkOut}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{r.checkOutTime}</TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[10px] font-medium",
                          STATUS_STYLES[r.status] ?? "bg-muted",
                        )}
                      >
                        {titleCase(r.status)}
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {money(r.ratePerNight)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs font-semibold">
                      {money(r.folioTotal)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Link
                        href={`/?code=${r.confirmationCode}`}
                        className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                        data-testid={`link-guest-${r.confirmationCode}`}
                      >
                        Open <ExternalLink className="h-3 w-3" />
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>

        <section>
          <h2 className="mb-1 text-sm font-semibold">Service inventory</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            Live capacity for today. The AI checks these numbers before it promises anything.
          </p>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {(services ?? []).map((s) => (
              <article
                key={s.id}
                className="rounded-md border border-card-border bg-card p-3"
                data-testid={`service-${s.id}`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="min-w-0 flex-1 truncate text-sm font-medium">{s.name}</h3>
                  <span className="font-mono text-xs">{money(s.price)}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{s.description}</p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {s.availability.map((a) => (
                    <span
                      key={a.slot}
                      className={cn(
                        "rounded px-1.5 py-0.5 font-mono text-[10px]",
                        a.seatsLeft === 0
                          ? "bg-destructive/15 text-destructive line-through"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      {a.slot} · {a.seatsLeft}
                    </span>
                  ))}
                  {s.availability.length === 0 && (
                    <span className="text-[10px] text-muted-foreground">
                      On demand · {s.unit.replace("_", " ")}
                    </span>
                  )}
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    </StaffShell>
  );
}
