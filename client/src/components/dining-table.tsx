import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DiningVenueRow } from "@/lib/types";

/**
 * The published dining pages, shown exactly as parsed. A dash means the outlet
 * page does not publish that field — the same dash the concierge turns into
 * "not published" instead of an estimate. Clicking a row opens the sample menu
 * the page prints, which is the only menu the agent is allowed to quote.
 */
export function DiningTable() {
  const { data: venues, isLoading } = useQuery<DiningVenueRow[]>({
    queryKey: ["/api/dining-venues"],
  });
  const [open, setOpen] = useState<string | null>(null);
  const rows = venues ?? [];

  return (
    <section className="mb-6" data-testid="section-dining">
      <h2 className="mb-1 text-sm font-semibold">Dining venues</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Restaurants and bars parsed from the property's own outlet pages. The concierge quotes hours,
        prices and dishes only from here; a dash is a field the page leaves out.
      </p>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[760px] text-xs">
          <thead className="bg-muted/40 text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Venue</th>
              <th className="px-3 py-2 text-left font-medium">Published hours</th>
              <th className="px-3 py-2 text-left font-medium">Price range</th>
              <th className="px-3 py-2 text-right font-medium">Seats</th>
              <th className="px-3 py-2 text-right font-medium">Menu sample</th>
              <th className="px-3 py-2 text-right font-medium">Bookable slots</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={6} className="px-3 py-3 text-muted-foreground">
                  Loading published outlets…
                </td>
              </tr>
            )}
            {!isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-3 text-muted-foreground">
                  No outlet pages indexed yet.
                </td>
              </tr>
            )}
            {rows.map((v) => (
              <>
                <tr
                  key={v.code}
                  onClick={() => setOpen(open === v.code ? null : v.code)}
                  className="cursor-pointer border-t border-border hover:bg-muted/30"
                  data-testid={`venue-${v.code.replace(/\s+/g, "-")}`}
                >
                  <td className="px-3 py-2">
                    <span className="font-medium">{v.nameVi || v.code}</span>
                    <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {v.kind}
                    </span>
                  </td>
                  <td className="px-3 py-2">{v.hoursText || "—"}</td>
                  <td className="px-3 py-2">{v.priceRange || "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{v.capacity ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{v.menuSampleSize || "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {v.bookable.reduce((n, b) => n + b.slots.length, 0) || "—"}
                  </td>
                </tr>
                {open === v.code && (
                  <tr key={`${v.code}-detail`} className="border-t border-border bg-muted/20">
                    <td colSpan={6} className="px-3 py-3">
                      <div className="mb-2 grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2">
                        <span>Location: {v.location || "not published"}</span>
                        <span>Phone: {v.phone || "not published"}</span>
                        <span>Last order: {v.lastOrder || "not published"}</span>
                        <span>
                          Meal services:{" "}
                          {v.mealWindows.length
                            ? v.mealWindows.map((m) => `${m.meal} ${m.open}–${m.close}`).join(", ")
                            : "not published"}
                        </span>
                      </div>
                      {v.priceNote && <p className="mb-2 text-[11px]">{v.priceNote}</p>}
                      {(v.cuisine.length > 0 || v.dishCategories.length > 0) && (
                        <div className="mb-2 flex flex-wrap gap-1.5">
                          {[...v.cuisine, ...v.dishCategories].map((c) => (
                            <span
                              key={c}
                              className="rounded border border-border bg-background px-1.5 py-0.5 text-[11px]"
                            >
                              {c}
                            </span>
                          ))}
                        </div>
                      )}
                      {v.menu.length > 0 ? (
                        <div className="grid gap-3 sm:grid-cols-2">
                          {v.menu.map((g, gi) => (
                            <div key={`${v.code}-g${gi}`}>
                              {g.group && (
                                <p className="mb-1 text-[11px] font-semibold">{g.group}</p>
                              )}
                              <ul className="space-y-0.5">
                                {g.items.map((it, ii) => (
                                  <li
                                    key={`${v.code}-g${gi}-i${ii}`}
                                    className="flex justify-between gap-3 text-[11px]"
                                  >
                                    <span>
                                      {it.name_vi}
                                      {it.name_en && (
                                        <span className="ml-1 text-muted-foreground">
                                          {it.name_en}
                                        </span>
                                      )}
                                    </span>
                                    <span className="tabular-nums text-muted-foreground">
                                      {it.price ? `${it.price.toLocaleString("vi-VN")}đ` : "—"}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-[11px] text-muted-foreground">
                          This page prints no individual dishes or prices, so the concierge says the
                          menu is not published and offers to call the outlet.
                        </p>
                      )}
                      {v.bookable.length > 0 && (
                        <p className="mt-2 text-[11px] text-muted-foreground">
                          Bookable:{" "}
                          {v.bookable
                            .map((b) => `${b.name} (${b.slots.join(", ") || "no slots"})`)
                            .join(" · ")}
                        </p>
                      )}
                      {v.sourceUrl && (
                        <a
                          href={v.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-2 inline-block text-[11px] text-primary underline"
                          data-testid={`link-venue-source-${v.code.replace(/\s+/g, "-")}`}
                        >
                          Source page
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
  );
}
