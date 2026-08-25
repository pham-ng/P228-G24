import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Info, UtensilsCrossed, X, ChevronLeft, ChevronRight } from "lucide-react";

/**
 * Tappable "xem chi tiết / xem menu" buttons for a dining venue the reply
 * actually used as evidence.
 *
 * Deliberately data-driven, not keyword-matched: `readDiningReference` reads
 * the same trace entry `server/agent.ts` writes from real retrieval evidence
 * (`detectReferencedVenues`), and the venue's own images/menu file come from
 * `GET /api/dining-venues` — the same source of truth the KB is built from.
 * A new venue added to the database needs no change here at all, unlike the
 * old per-dish/per-room `if (text.includes("..."))` chain this replaces.
 */

export type DiningVenueRef = { slug: string; name: string };

export type DiningVenueDetail = {
  slug: string;
  code: string;
  nameVi: string;
  kind: string;
  description: string | null;
  images: string[];
  menuFile: string | null;
  hoursText: string;
  location: string | null;
  phone: string | null;
  capacity: number | null;
  cuisine: string[];
  menu: Array<{ group: string | null; items: Array<{ name_vi: string; name_en: string | null; price: number | null }> }>;
};

export function readDiningReference(toolTrace: string | null): DiningVenueRef[] {
  if (!toolTrace) return [];
  try {
    const calls = JSON.parse(toolTrace) as Array<{ name: string; result: unknown }>;
    const hit = calls.find((c) => c.name === "dining_venues_referenced");
    const r = hit?.result as { venues?: DiningVenueRef[] } | undefined;
    return r?.venues ?? [];
  } catch {
    return [];
  }
}

const vnd = (n: number) => `${n.toLocaleString("vi-VN")}₫`;

function isPdf(path: string) {
  return /\.pdf($|\?)/i.test(path);
}

function VenueModal({ slug, onClose, lang }: { slug: string; onClose: () => void; lang: string }) {
  const vi = lang === "vi";
  const [tab, setTab] = useState<"info" | "menu">("info");
  const [imgIndex, setImgIndex] = useState(0);

  const { data: venues, isLoading, isError } = useQuery<DiningVenueDetail[]>({ queryKey: ["/api/dining-venues"] });
  const v = venues?.find((x) => x.slug === slug);
  const notFound = !isLoading && !isError && !v;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{v?.nameVi ?? "..."}</div>
            {v?.hoursText && <div className="text-[11px] text-muted-foreground">{v.hoursText}</div>}
          </div>
          <button onClick={onClose} className="shrink-0 rounded-full p-1 hover:bg-muted" data-testid="button-close-venue-modal">
            <X className="h-4 w-4" />
          </button>
        </div>

        {v && (
          <div className="flex border-b border-border text-xs font-medium">
            <button
              onClick={() => setTab("info")}
              className={`flex-1 border-b-2 py-2 ${tab === "info" ? "border-primary text-primary" : "border-transparent text-muted-foreground"}`}
              data-testid="tab-venue-info"
            >
              {vi ? "Giới thiệu" : "About"}
            </button>
            <button
              onClick={() => setTab("menu")}
              disabled={!v.menuFile && !v.menu.length}
              className={`flex-1 border-b-2 py-2 disabled:opacity-40 ${tab === "menu" ? "border-primary text-primary" : "border-transparent text-muted-foreground"}`}
              data-testid="tab-venue-menu"
            >
              {vi ? "Menu" : "Menu"}
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {isLoading && <div className="p-6 text-center text-xs text-muted-foreground">{vi ? "Đang tải..." : "Loading..."}</div>}
          {isError && (
            <div className="p-6 text-center text-xs text-destructive">
              {vi ? "Không tải được thông tin. Vui lòng thử lại." : "Couldn't load this. Please try again."}
            </div>
          )}
          {notFound && (
            <div className="p-6 text-center text-xs text-muted-foreground">
              {vi ? "Nhà hàng này hiện chưa có thông tin chi tiết." : "No details available for this venue yet."}
            </div>
          )}

          {v && tab === "info" && (
            <div className="space-y-3 p-4">
              {v.images.length > 0 && (
                <div className="relative overflow-hidden rounded-lg bg-black/5">
                  <img src={v.images[imgIndex]} alt={v.nameVi} className="h-48 w-full object-cover" />
                  {v.images.length > 1 && (
                    <>
                      <button
                        onClick={() => setImgIndex((i) => (i === 0 ? v.images.length - 1 : i - 1))}
                        className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-1.5 text-white hover:bg-black/60"
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => setImgIndex((i) => (i === v.images.length - 1 ? 0 : i + 1))}
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-1.5 text-white hover:bg-black/60"
                      >
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </>
                  )}
                </div>
              )}
              {v.description && <p className="text-sm leading-relaxed text-foreground/90">{v.description}</p>}
              <dl className="grid grid-cols-2 gap-2 text-xs">
                {v.location && (
                  <div className="col-span-2">
                    <dt className="text-muted-foreground">{vi ? "Vị trí" : "Location"}</dt>
                    <dd>{v.location}</dd>
                  </div>
                )}
                {v.phone && (
                  <div>
                    <dt className="text-muted-foreground">{vi ? "Điện thoại" : "Phone"}</dt>
                    <dd>{v.phone}</dd>
                  </div>
                )}
                {v.capacity != null && (
                  <div>
                    <dt className="text-muted-foreground">{vi ? "Sức chứa" : "Capacity"}</dt>
                    <dd>{v.capacity}</dd>
                  </div>
                )}
              </dl>
            </div>
          )}

          {v && tab === "menu" && (
            <div className="p-4">
              {v.menuFile && (
                <div className="mb-4 overflow-hidden rounded-lg border border-border">
                  {isPdf(v.menuFile) ? (
                    <embed src={v.menuFile} type="application/pdf" className="h-[60vh] w-full" />
                  ) : (
                    <img src={v.menuFile} alt="Menu" className="w-full" />
                  )}
                </div>
              )}
              {!v.menuFile &&
                v.menu.map((g, gi) => (
                  <div key={gi} className="mb-3">
                    {g.group && <div className="mb-1 text-xs font-semibold text-primary">{g.group}</div>}
                    <ul className="space-y-1">
                      {g.items.map((it, ii) => (
                        <li key={ii} className="flex items-baseline justify-between gap-2 text-xs">
                          <span>{it.name_vi}</span>
                          {it.price != null && <span className="shrink-0 font-medium text-muted-foreground">{vnd(it.price)}</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function DiningActions({ venues, lang }: { venues: DiningVenueRef[]; lang: string }) {
  const vi = lang === "vi";
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  if (!venues.length) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {venues.map((v) => (
        <button
          key={v.slug}
          type="button"
          onClick={() => setOpenSlug(v.slug)}
          data-testid={`button-view-venue-${v.slug}`}
          className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/5 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/10"
        >
          <UtensilsCrossed className="h-3.5 w-3.5" />
          {vi ? `Xem ${v.name}` : `View ${v.name}`}
          <Info className="h-3 w-3 opacity-60" />
        </button>
      ))}
      {openSlug && <VenueModal slug={openSlug} lang={lang} onClose={() => setOpenSlug(null)} />}
    </div>
  );
}
