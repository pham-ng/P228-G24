import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Info, UtensilsCrossed, X, ChevronLeft, ChevronRight, MapPin, Phone, Users, Clock, Tag } from "lucide-react";

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
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-3 sm:p-4 backdrop-blur-xs" onClick={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-background shadow-2xl border border-border/80"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/60 px-5 py-3.5 bg-card/50">
          <div className="min-w-0 pr-2">
            <div className="truncate text-base font-bold text-foreground">{v?.nameVi ?? "..."}</div>
            {v?.hoursText && (
              <div className="mt-0.5 inline-flex items-center gap-1 text-xs font-semibold text-primary">
                <Clock className="h-3 w-3 shrink-0" />
                <span>{v.hoursText}</span>
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            data-testid="button-close-venue-modal"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tabs */}
        {v && (
          <div className="flex border-b border-border/60 bg-muted/20 text-xs font-semibold">
            <button
              onClick={() => setTab("info")}
              className={`flex-1 border-b-2 py-2.5 transition-colors ${
                tab === "info" ? "border-primary text-primary bg-card/40" : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
              data-testid="tab-venue-info"
            >
              {vi ? "Giới thiệu & Vị trí" : "About & Details"}
            </button>
            <button
              onClick={() => setTab("menu")}
              disabled={!v.menuFile && !v.menu.length}
              className={`flex-1 border-b-2 py-2.5 transition-colors disabled:opacity-40 ${
                tab === "menu" ? "border-primary text-primary bg-card/40" : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
              data-testid="tab-venue-menu"
            >
              {vi ? "Thực đơn (Menu)" : "Menu"}
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {isLoading && <div className="p-8 text-center text-xs text-muted-foreground">{vi ? "Đang tải thông tin..." : "Loading..."}</div>}
          {isError && (
            <div className="p-8 text-center text-xs text-destructive">
              {vi ? "Không tải được thông tin nhà hàng. Vui lòng thử lại." : "Couldn't load venue details."}
            </div>
          )}
          {notFound && (
            <div className="p-8 text-center text-xs text-muted-foreground">
              {vi ? "Nhà hàng này hiện chưa có thông tin chi tiết." : "No details available."}
            </div>
          )}

          {v && tab === "info" && (
            <div className="space-y-4 p-4 sm:p-5">
              {/* Carousel */}
              {v.images.length > 0 && (
                <div className="relative overflow-hidden rounded-xl bg-black/10 shadow-inner group">
                  <img src={v.images[imgIndex]} alt={v.nameVi} className="h-52 w-full object-cover transition-all duration-300" />
                  
                  <span className="absolute top-2.5 right-2.5 rounded-full bg-black/65 px-2.5 py-1 text-[11px] font-semibold text-white backdrop-blur-md border border-white/20">
                    📷 {imgIndex + 1}/{v.images.length}
                  </span>

                  {v.images.length > 1 && (
                    <>
                      <button
                        onClick={() => setImgIndex((i) => (i === 0 ? v.images.length - 1 : i - 1))}
                        className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/80 transition-all opacity-80 group-hover:opacity-100"
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => setImgIndex((i) => (i === v.images.length - 1 ? 0 : i + 1))}
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/80 transition-all opacity-80 group-hover:opacity-100"
                      >
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </>
                  )}
                </div>
              )}

              {/* Description */}
              {v.description && (
                <div className="rounded-xl border border-border/60 bg-card/40 p-3.5">
                  <p className="text-xs sm:text-sm leading-relaxed text-foreground/90">{v.description}</p>
                </div>
              )}

              {/* Info Badges Grid */}
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {v.location && (
                  <div className="flex items-start gap-2.5 rounded-xl border border-border/70 bg-card p-3 shadow-2xs">
                    <div className="rounded-lg bg-primary/10 p-2 text-primary shrink-0 mt-0.5">
                      <MapPin className="h-4 w-4" />
                    </div>
                    <div>
                      <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{vi ? "Vị trí" : "Location"}</div>
                      <div className="text-xs font-semibold text-foreground leading-snug">{v.location}</div>
                    </div>
                  </div>
                )}
                {v.phone && (
                  <div className="flex items-start gap-2.5 rounded-xl border border-border/70 bg-card p-3 shadow-2xs">
                    <div className="rounded-lg bg-primary/10 p-2 text-primary shrink-0 mt-0.5">
                      <Phone className="h-4 w-4" />
                    </div>
                    <div>
                      <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{vi ? "Liên hệ" : "Phone"}</div>
                      <div className="text-xs font-semibold text-foreground leading-snug">{v.phone}</div>
                    </div>
                  </div>
                )}
                {v.capacity != null && (
                  <div className="flex items-start gap-2.5 rounded-xl border border-border/70 bg-card p-3 shadow-2xs sm:col-span-2">
                    <div className="rounded-lg bg-primary/10 p-2 text-primary shrink-0 mt-0.5">
                      <Users className="h-4 w-4" />
                    </div>
                    <div>
                      <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{vi ? "Sức chứa" : "Capacity"}</div>
                      <div className="text-xs font-semibold text-foreground leading-snug">{v.capacity} {vi ? "chỗ ngồi" : "seats"}</div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {v && tab === "menu" && (
            <div className="p-4 sm:p-5">
              {v.menuFile && (
                <div className="mb-4 overflow-hidden rounded-xl border border-border shadow-xs">
                  {isPdf(v.menuFile) ? (
                    <embed src={v.menuFile} type="application/pdf" className="h-[60vh] w-full" />
                  ) : (
                    <img src={v.menuFile} alt="Menu" className="w-full object-contain" />
                  )}
                </div>
              )}
              {!v.menuFile &&
                v.menu.map((g, gi) => (
                  <div key={gi} className="mb-4 rounded-xl border border-border/70 bg-card p-3.5 shadow-2xs">
                    {g.group && <div className="mb-2 text-xs font-bold text-primary flex items-center gap-1.5"><UtensilsCrossed className="h-3.5 w-3.5" />{g.group}</div>}
                    <ul className="space-y-2 divide-y divide-border/40">
                      {g.items.map((it, ii) => (
                        <li key={ii} className="flex items-baseline justify-between gap-3 pt-2 first:pt-0 text-xs">
                          <span className="font-medium text-foreground/90">{it.name_vi}</span>
                          {it.price != null && (
                            <span className="shrink-0 rounded-full bg-primary/10 border border-primary/20 px-2.5 py-0.5 font-bold text-primary text-xs">
                              {vnd(it.price)}
                            </span>
                          )}
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
    <div className="mt-2.5 flex flex-wrap gap-1.5">
      {venues.map((v) => (
        <button
          key={v.slug}
          type="button"
          onClick={() => setOpenSlug(v.slug)}
          data-testid={`button-view-venue-${v.slug}`}
          className="inline-flex items-center gap-1.5 rounded-full border border-primary/35 bg-primary/8 px-3.5 py-1.5 text-xs font-semibold text-primary hover:bg-primary/15 transition-all hover:scale-[1.02] shadow-2xs"
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
