import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BedDouble, Info, X, ChevronLeft, ChevronRight } from "lucide-react";

/**
 * "Xem chi tiết" button for a room type the reply actually used as evidence.
 * Same data-driven principle as dining-actions.tsx: no per-room-name
 * hardcoding, reads `room_types_referenced` (real retrieval evidence,
 * written server-side by detectReferencedRoomTypes) and fetches the room's
 * own images/description from GET /api/room-types.
 */

export type RoomTypeRef = { code: string; name: string };

export type RoomTypeDetail = {
  code: string;
  nameVi: string | null;
  areaSqm: number | null;
  bedrooms: number | null;
  bed: string | null;
  oceanView: boolean;
  privatePool: boolean;
  maxGuests: number | null;
  combinations: Array<{ adults: number; children: number }>;
  amenities: string[];
  images: string[];
  description: string | null;
  rate: number;
};

export function readRoomReference(toolTrace: string | null): RoomTypeRef[] {
  if (!toolTrace) return [];
  try {
    const calls = JSON.parse(toolTrace) as Array<{ name: string; result: unknown }>;
    const hit = calls.find((c) => c.name === "room_types_referenced");
    const r = hit?.result as { roomTypes?: RoomTypeRef[] } | undefined;
    return r?.roomTypes ?? [];
  } catch {
    return [];
  }
}

const vnd = (n: number) => `${n.toLocaleString("vi-VN")}₫`;

function RoomModal({ code, onClose, lang }: { code: string; onClose: () => void; lang: string }) {
  const vi = lang === "vi";
  const [imgIndex, setImgIndex] = useState(0);
  const { data: types, isLoading, isError } = useQuery<RoomTypeDetail[]>({ queryKey: ["/api/room-types"] });
  const r = types?.find((x) => x.code === code);
  /* Never hang forever on a blank "Loading...": once the request itself has
     resolved, either the room is there or it genuinely is not — found live,
     a published room type with no physical inventory left a guest staring
     at a spinner with no way out. */
  const notFound = !isLoading && !isError && !r;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{r?.nameVi ?? code}</div>
            {r?.rate ? <div className="text-[11px] text-muted-foreground">{vnd(r.rate)}/{vi ? "đêm" : "night"}</div> : null}
          </div>
          <button onClick={onClose} className="shrink-0 rounded-full p-1 hover:bg-muted" data-testid="button-close-room-modal">
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
              {vi ? "Loại phòng này hiện chưa có thông tin chi tiết." : "No details available for this room type yet."}
            </div>
          )}
          {r && (
            <div className="space-y-3 p-4">
              {r.images.length > 0 && (
                <div className="relative overflow-hidden rounded-lg bg-black/5">
                  <img src={r.images[imgIndex]} alt={r.nameVi ?? code} className="h-48 w-full object-cover" />
                  {r.images.length > 1 && (
                    <>
                      <button
                        onClick={() => setImgIndex((i) => (i === 0 ? r.images.length - 1 : i - 1))}
                        className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-1.5 text-white hover:bg-black/60"
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => setImgIndex((i) => (i === r.images.length - 1 ? 0 : i + 1))}
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-1.5 text-white hover:bg-black/60"
                      >
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </>
                  )}
                </div>
              )}
              {r.description && <p className="text-sm leading-relaxed text-foreground/90">{r.description}</p>}
              <dl className="grid grid-cols-2 gap-2 text-xs">
                {r.areaSqm != null && (
                  <div>
                    <dt className="text-muted-foreground">{vi ? "Diện tích" : "Size"}</dt>
                    <dd>{r.areaSqm} m²</dd>
                  </div>
                )}
                {r.maxGuests != null && (
                  <div>
                    <dt className="text-muted-foreground">{vi ? "Sức chứa" : "Max guests"}</dt>
                    <dd>{r.maxGuests}</dd>
                  </div>
                )}
                {r.bed && (
                  <div>
                    <dt className="text-muted-foreground">{vi ? "Giường" : "Bed"}</dt>
                    <dd>{r.bed}</dd>
                  </div>
                )}
                <div>
                  <dt className="text-muted-foreground">{vi ? "Hướng biển" : "Ocean view"}</dt>
                  <dd>{r.oceanView ? (vi ? "Có" : "Yes") : (vi ? "Không" : "No")}</dd>
                </div>
              </dl>
              {r.amenities.length > 0 && (
                <div>
                  <div className="mb-1 text-xs font-semibold text-primary">{vi ? "Tiện ích" : "Amenities"}</div>
                  <div className="flex flex-wrap gap-1">
                    {r.amenities.map((a, i) => (
                      <span key={i} className="rounded-full bg-muted px-2 py-0.5 text-[11px]">
                        {a}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function RoomActions({ rooms, lang, onSend }: { rooms: RoomTypeRef[]; lang: string; onSend?: (text: string) => void }) {
  const vi = lang === "vi";
  const [openCode, setOpenCode] = useState<string | null>(null);
  if (!rooms.length) return null;

  const hasDeluxe = rooms.some((r) => r.name.toLowerCase().includes("deluxe"));

  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {rooms.map((r) => (
          <button
            key={r.code}
            type="button"
            onClick={() => setOpenCode(r.code)}
            data-testid={`button-view-room-${r.code}`}
            className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/5 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/10 transition-all hover:scale-105"
          >
            <BedDouble className="h-3.5 w-3.5" />
            {vi ? `Xem ảnh & chi tiết ${r.name}` : `View details for ${r.name}`}
            <Info className="h-3 w-3 opacity-60" />
          </button>
        ))}
      </div>

      {onSend && (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {hasDeluxe && (
            <>
              <button
                type="button"
                onClick={() => onSend(vi ? "Giá Deluxe giường đôi bao nhiêu?" : "Deluxe double bed price?")}
                className="rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-medium hover:border-primary/50 hover:bg-primary/5 hover:text-primary transition-all"
              >
                🛏️ {vi ? "Deluxe Giường Đôi" : "Deluxe Double"}
              </button>
              <button
                type="button"
                onClick={() => onSend(vi ? "Giá Deluxe 2 giường đơn bao nhiêu?" : "Deluxe twin bed price?")}
                className="rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-medium hover:border-primary/50 hover:bg-primary/5 hover:text-primary transition-all"
              >
                🛏️ {vi ? "Deluxe 2 Giường Đơn" : "Deluxe Twin"}
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => onSend(vi ? "So sánh các hạng phòng Deluxe và Villa" : "Compare Deluxe vs Villa")}
            className="rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-medium hover:border-primary/50 hover:bg-primary/5 hover:text-primary transition-all"
          >
            ⚖️ {vi ? "So sánh hạng phòng" : "Compare room types"}
          </button>
        </div>
      )}

      {openCode && <RoomModal code={openCode} lang={lang} onClose={() => setOpenCode(null)} />}
    </div>
  );
}
