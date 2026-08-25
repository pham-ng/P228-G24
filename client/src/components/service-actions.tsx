import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Info, Sparkles, X, ChevronLeft, ChevronRight } from "lucide-react";

/**
 * "Xem chi tiết" button for a service group (cable car, Akoya Spa, VinWonders...)
 * the reply actually used as evidence. Same data-driven principle as
 * dining-actions.tsx/room-actions.tsx: reads `services_referenced` (real
 * retrieval evidence, written server-side by detectReferencedServices) and
 * fetches the group's own images/items from GET /api/service-groups. A new
 * service linked via migration needs no change here.
 */

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
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="min-w-0 truncate text-sm font-semibold">{g?.name ?? "..."}</div>
          <button onClick={onClose} className="shrink-0 rounded-full p-1 hover:bg-muted" data-testid="button-close-service-modal">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {isLoading && <div className="p-6 text-center text-xs text-muted-foreground">{vi ? "Đang tải..." : "Loading..."}</div>}
          {isError && (
            <div className="p-6 text-center text-xs text-destructive">
              {vi ? "Không tải được thông tin. Vui lòng thử lại." : "Couldn't load this. Please try again."}
            </div>
          )}
          {notFound && (
            <div className="p-6 text-center text-xs text-muted-foreground">
              {vi ? "Dịch vụ này hiện chưa có thông tin chi tiết." : "No details available for this service yet."}
            </div>
          )}

          {g && (
            <div className="space-y-3 p-4">
              {g.images.length > 0 && (
                <div className="relative overflow-hidden rounded-lg bg-black/5">
                  <img src={g.images[imgIndex]} alt={g.name} className="h-48 w-full object-cover" />
                  {g.images.length > 1 && (
                    <>
                      <button
                        onClick={() => setImgIndex((i) => (i === 0 ? g.images.length - 1 : i - 1))}
                        className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-1.5 text-white hover:bg-black/60"
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => setImgIndex((i) => (i === g.images.length - 1 ? 0 : i + 1))}
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-1.5 text-white hover:bg-black/60"
                      >
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </>
                  )}
                </div>
              )}
              <ul className="space-y-2">
                {g.items.map((it) => (
                  <li key={it.id} className="rounded-lg border border-border p-2.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-medium">{it.name}</span>
                      <span className="shrink-0 text-xs font-medium text-muted-foreground">
                        {vnd(it.price)}/{it.unit}
                      </span>
                    </div>
                    {it.description && <p className="mt-1 text-xs text-foreground/80">{it.description}</p>}
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
  if (!groups.length) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {groups.map((g) => (
        <button
          key={g.key}
          type="button"
          onClick={() => setOpenKey(g.key)}
          data-testid={`button-view-service-${g.key}`}
          className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/5 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/10"
        >
          <Sparkles className="h-3.5 w-3.5" />
          {vi ? `Xem ${g.name}` : `View ${g.name}`}
          <Info className="h-3 w-3 opacity-60" />
        </button>
      ))}
      {openKey && <ServiceGroupModal groupKey={openKey} lang={lang} onClose={() => setOpenKey(null)} />}
    </div>
  );
}
