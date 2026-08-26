import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Info, Sparkles, X, ChevronLeft, ChevronRight, Tag } from "lucide-react";

export type ServiceGroupRef = { key: string; name: string };

export type ServiceGroupDetail = {
  key: string;
  name: string;
  images: string[];
  items: Array<{ id: number; name: string; description: string; price: number; unit: string }>;
};

export function readServiceReference(toolTrace: string | null): ServiceGroupRef[] {
  if (!toolTrace) return [];
  try {
    const calls = JSON.parse(toolTrace) as Array<{ name: string; result: unknown }>;
    const hit = calls.find((c) => c.name === "services_referenced");
    const r = hit?.result as { serviceGroups?: ServiceGroupRef[] } | undefined;
    return r?.serviceGroups ?? [];
  } catch {
    return [];
  }
}

const vnd = (n: number) => `${n.toLocaleString("vi-VN")}₫`;

function ServiceGroupModal({ groupKey, onClose, lang }: { groupKey: string; onClose: () => void; lang: string }) {
  const vi = lang === "vi";
  const [imgIndex, setImgIndex] = useState(0);
  const { data: groups, isLoading, isError } = useQuery<ServiceGroupDetail[]>({ queryKey: ["/api/service-groups"] });
  const g = groups?.find((x) => x.key === groupKey);
  const notFound = !isLoading && !isError && !g;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-3 sm:p-4 backdrop-blur-xs" onClick={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-background shadow-2xl border border-border/80"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/60 px-5 py-3.5 bg-card/50">
          <div className="min-w-0 pr-2 truncate text-base font-bold text-foreground flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary shrink-0" />
            <span>{g?.name ?? "..."}</span>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            data-testid="button-close-service-modal"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {isLoading && <div className="p-8 text-center text-xs text-muted-foreground">{vi ? "Đang tải thông tin..." : "Loading..."}</div>}
          {isError && (
            <div className="p-8 text-center text-xs text-destructive">
              {vi ? "Không tải được thông tin dịch vụ. Vui lòng thử lại." : "Couldn't load service details."}
            </div>
          )}
          {notFound && (
            <div className="p-8 text-center text-xs text-muted-foreground">
              {vi ? "Dịch vụ này hiện chưa có thông tin chi tiết." : "No details available."}
            </div>
          )}

          {g && (
            <div className="space-y-4 p-4 sm:p-5">
              {/* Carousel */}
              {g.images.length > 0 && (
                <div className="relative overflow-hidden rounded-xl bg-black/10 shadow-inner group">
                  <img src={g.images[imgIndex]} alt={g.name} className="h-52 w-full object-cover transition-all duration-300" />
                  
                  <span className="absolute top-2.5 right-2.5 rounded-full bg-black/65 px-2.5 py-1 text-[11px] font-semibold text-white backdrop-blur-md border border-white/20">
                    📷 {imgIndex + 1}/{g.images.length}
                  </span>

                  {g.images.length > 1 && (
                    <>
                      <button
                        onClick={() => setImgIndex((i) => (i === 0 ? g.images.length - 1 : i - 1))}
                        className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/80 transition-all opacity-80 group-hover:opacity-100"
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => setImgIndex((i) => (i === g.images.length - 1 ? 0 : i + 1))}
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/80 transition-all opacity-80 group-hover:opacity-100"
                      >
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </>
                  )}
                </div>
              )}

              {/* Service Items List */}
              <ul className="space-y-2.5">
                {g.items.map((it) => (
                  <li key={it.id} className="rounded-xl border border-border/70 bg-card p-3.5 shadow-2xs">
                    <div className="flex items-start justify-between gap-3">
                      <span className="text-xs sm:text-sm font-bold text-foreground leading-snug">{it.name}</span>
                      <span className="shrink-0 rounded-full bg-primary/10 border border-primary/20 px-2.5 py-0.5 font-extrabold text-primary text-xs flex items-center gap-1">
                        <Tag className="h-3 w-3" />
                        {vnd(it.price)} <span className="text-[10px] font-normal text-muted-foreground">/{it.unit}</span>
                      </span>
                    </div>
                    {it.description && <p className="mt-2 text-xs leading-relaxed text-foreground/80">{it.description}</p>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function ServiceActions({ groups, lang }: { groups: ServiceGroupRef[]; lang: string }) {
  const vi = lang === "vi";
  const [openKey, setOpenKey] = useState<string | null>(null);
  const { data: serviceDetails } = useQuery<ServiceGroupDetail[]>({ queryKey: ["/api/service-groups"] });

  if (!groups.length) return null;

  return (
    <div className="mt-3 flex flex-col gap-2.5">
      {/* Rich Service Cards */}
      <div className="grid grid-cols-1 gap-2.5">
        {groups.map((g) => {
          const detail = serviceDetails?.find((x) => x.key === g.key || x.name === g.name);
          const topItems = detail?.items?.slice(0, 4) ?? [];

          return (
            <div
              key={g.key}
              className="flex flex-col overflow-hidden rounded-xl border border-primary/25 bg-card/90 shadow-xs hover:border-primary/60 transition-all p-3.5 gap-2.5"
            >
              <div className="flex items-center justify-between border-b border-border/40 pb-2">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-primary shrink-0" />
                  <h4 className="text-xs font-bold text-foreground">{g.name}</h4>
                </div>
                <button
                  type="button"
                  onClick={() => setOpenKey(g.key)}
                  data-testid={`button-view-service-${g.key}`}
                  className="inline-flex items-center gap-1 rounded-lg bg-primary/10 hover:bg-primary/20 text-primary px-2.5 py-1 text-[11px] font-semibold transition-all"
                >
                  {vi ? "Xem tất cả liệu trình & Đặt" : "View all & Book"} ➔
                </button>
              </div>

              {/* Treatment Items Preview with Prices */}
              {topItems.length > 0 && (
                <div className="space-y-1.5 pt-0.5">
                  {topItems.map((item) => (
                    <div key={item.id} className="flex justify-between items-center text-xs py-0.5 border-b border-dashed border-border/30 last:border-none">
                      <span className="text-foreground/90 font-medium truncate max-w-[220px] sm:max-w-[320px]">{item.name}</span>
                      <span className="font-bold text-amber-600 dark:text-amber-400 shrink-0">{vnd(item.price)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {openKey && <ServiceGroupModal groupKey={openKey} lang={lang} onClose={() => setOpenKey(null)} />}
    </div>
  );
}
