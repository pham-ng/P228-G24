import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BedDouble, Info, X, ChevronLeft, ChevronRight, Maximize2, Users, Compass, CheckCircle2, Tag } from "lucide-react";

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
  /** Cheapest bookable package; see the note in /api/room-types. */
  packageFrom?: number;
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

function parseDescription(desc: string | null) {
  if (!desc) return { body: null, prices: null };

  const pricePattern = /(Giá công bố|Giá chỉ từ)[^]*$/i;
  const match = desc.match(pricePattern);

  if (match) {
    const body = desc.replace(pricePattern, "").trim();
    const priceText = match[0].trim();
    return { body, prices: priceText };
  }

  return { body: desc, prices: null };
}

function RoomModal({ code, onClose, lang }: { code: string; onClose: () => void; lang: string }) {
  const vi = lang === "vi";
  const [imgIndex, setImgIndex] = useState(0);
  const { data: types, isLoading, isError } = useQuery<RoomTypeDetail[]>({ queryKey: ["/api/room-types"] });
  const r = types?.find(
    (x) => x.code === code || x.nameVi === code || x.code.toLowerCase() === code.toLowerCase() || x.nameVi?.toLowerCase() === code.toLowerCase()
  );
  const notFound = !isLoading && !isError && !r;

  const { body, prices } = parseDescription(r?.description ?? null);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-3 sm:p-4 backdrop-blur-xs" onClick={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-background shadow-2xl border border-border/80"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/60 px-5 py-3.5 bg-card/50">
          <div className="min-w-0 pr-2">
            <div className="truncate text-base font-bold text-foreground">{r?.nameVi ?? code}</div>
            {/* Prefer the cheapest PACKAGE — that is the figure the concierge
                quotes and the one the guest can actually book. Falling back to
                the room-only inventory rate keeps a price on the card for a
                category with no packages published. */}
            {(r?.packageFrom || r?.rate) ? (
              <div className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-primary/10 border border-primary/20 px-2.5 py-0.5 text-xs font-bold text-primary">
                <Tag className="h-3 w-3" />
                <span className="text-[10px] font-normal text-muted-foreground">{r?.packageFrom ? (vi ? "gói từ" : "packages from") : (vi ? "phòng từ" : "room only from")}</span>
                <span>{vnd(r.packageFrom || r.rate)}</span>
                <span className="text-[10px] font-normal text-muted-foreground">/{vi ? "đêm" : "night"}</span>
              </div>
            ) : null}
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            data-testid="button-close-room-modal"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto">
          {isLoading && <div className="p-8 text-center text-xs text-muted-foreground">{vi ? "Đang tải thông tin..." : "Loading..."}</div>}
          {isError && (
            <div className="p-8 text-center text-xs text-destructive">
              {vi ? "Không tải được thông tin phòng. Vui lòng thử lại." : "Couldn't load room details."}
            </div>
          )}
          {notFound && (
            <div className="p-8 text-center text-xs text-muted-foreground">
              {vi ? "Loại phòng này hiện chưa có thông tin chi tiết." : "No details available."}
            </div>
          )}

          {r && (
            <div className="space-y-4 p-4 sm:p-5">
              {/* Image Gallery Carousel */}
              {r.images.length > 0 && (
                <div className="relative overflow-hidden rounded-xl bg-black/10 shadow-inner group">
                  <img src={r.images[imgIndex]} alt={r.nameVi ?? code} className="h-52 w-full object-cover transition-all duration-300" />
                  
                  {/* Photo Counter Pill */}
                  <span className="absolute top-2.5 right-2.5 rounded-full bg-black/65 px-2.5 py-1 text-[11px] font-semibold text-white backdrop-blur-md border border-white/20">
                    📷 {imgIndex + 1}/{r.images.length}
                  </span>

                  {r.images.length > 1 && (
                    <>
                      <button
                        onClick={() => setImgIndex((i) => (i === 0 ? r.images.length - 1 : i - 1))}
                        className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/80 transition-all opacity-80 group-hover:opacity-100"
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => setImgIndex((i) => (i === r.images.length - 1 ? 0 : i + 1))}
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/80 transition-all opacity-80 group-hover:opacity-100"
                      >
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </>
                  )}
                </div>
              )}

              {/* 4-Card Feature Highlights Grid */}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {r.areaSqm != null && (
                  <div className="flex items-center gap-2.5 rounded-xl border border-border/70 bg-card p-2.5 shadow-2xs">
                    <div className="rounded-lg bg-primary/10 p-1.5 text-primary">
                      <Maximize2 className="h-4 w-4" />
                    </div>
                    <div>
                      <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{vi ? "Diện tích" : "Size"}</div>
                      <div className="text-xs font-bold text-foreground">{r.areaSqm} m²</div>
                    </div>
                  </div>
                )}
                {r.maxGuests != null && (
                  <div className="flex items-center gap-2.5 rounded-xl border border-border/70 bg-card p-2.5 shadow-2xs">
                    <div className="rounded-lg bg-primary/10 p-1.5 text-primary">
                      <Users className="h-4 w-4" />
                    </div>
                    <div>
                      <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{vi ? "Sức chứa" : "Capacity"}</div>
                      <div className="text-xs font-bold text-foreground">{r.maxGuests} {vi ? "khách" : "guests"}</div>
                    </div>
                  </div>
                )}
                {r.bed && (
                  <div className="flex items-center gap-2.5 rounded-xl border border-border/70 bg-card p-2.5 shadow-2xs">
                    <div className="rounded-lg bg-primary/10 p-1.5 text-primary">
                      <BedDouble className="h-4 w-4" />
                    </div>
                    <div>
                      <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{vi ? "Loại giường" : "Bed"}</div>
                      <div className="text-xs font-bold text-foreground capitalize truncate max-w-[70px]">{r.bed}</div>
                    </div>
                  </div>
                )}
                <div className="flex items-center gap-2.5 rounded-xl border border-border/70 bg-card p-2.5 shadow-2xs">
                  <div className="rounded-lg bg-primary/10 p-1.5 text-primary">
                    <Compass className="h-4 w-4" />
                  </div>
                  <div>
                    <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{vi ? "Tầm nhìn" : "View"}</div>
                    <div className="text-xs font-bold text-foreground">{r.oceanView ? (vi ? "Hướng biển" : "Ocean") : (vi ? "Hướng vườn" : "Garden")}</div>
                  </div>
                </div>
              </div>

              {/* Description Body */}
              {body && (
                <div className="rounded-xl border border-border/60 bg-card/40 p-3.5">
                  <p className="text-xs sm:text-sm leading-relaxed text-foreground/90">{body}</p>
                </div>
              )}

              {/* Highlighted Price Callout Box */}
              {prices && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5 shadow-2xs">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-amber-700 dark:text-amber-300 mb-1">
                    <Tag className="h-3.5 w-3.5" />
                    <span>{vi ? "Thông tin mức giá tham khảo" : "Rate Information"}</span>
                  </div>
                  <p className="text-xs leading-normal font-medium text-amber-900/90 dark:text-amber-200/90">{prices}</p>
                </div>
              )}

              {/* Amenities Badges */}
              {r.amenities.length > 0 && (
                <div className="pt-1">
                  <div className="mb-2 text-xs font-bold text-foreground flex items-center gap-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
                    <span>{vi ? "Trang thiết bị & Tiện ích phòng" : "Room Amenities"}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {r.amenities.map((a, i) => (
                      <span
                        key={i}
                        className="inline-flex items-center gap-1 rounded-lg border border-border/50 bg-card px-2.5 py-1 text-[11px] font-medium text-foreground/85 shadow-2xs hover:bg-accent hover:text-accent-foreground transition-colors"
                      >
                        <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />
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
  const { data: types } = useQuery<RoomTypeDetail[]>({ queryKey: ["/api/room-types"] });

  if (!rooms.length) return null;

  const hasDeluxe = rooms.some((r) => r.name.toLowerCase().includes("deluxe"));

  return (
    <div className="mt-3 flex flex-col gap-2.5">
      {/* Rich Room Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        {rooms.map((r) => {
          const detail = types?.find(
            (x) => x.code === r.code || x.nameVi === r.name || x.code.toLowerCase() === r.code.toLowerCase() || x.nameVi?.toLowerCase() === r.name.toLowerCase()
          );
          const coverImg = detail?.images?.[0];

          return (
            <div
              key={r.code}
              className="group flex flex-col overflow-hidden rounded-xl border border-primary/25 bg-card/90 shadow-xs hover:border-primary/60 transition-all hover:shadow-md"
            >
              {coverImg && (
                <div className="relative h-28 w-full overflow-hidden bg-muted">
                  <img
                    src={coverImg}
                    alt={r.name}
                    className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
                  <span className="absolute bottom-2 left-2 rounded-md bg-black/60 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur-xs">
                    📐 {detail.areaSqm}m² • {detail.oceanView ? (vi ? "Hướng biển" : "Ocean view") : (vi ? "Hướng vườn" : "Garden view")}
                  </span>
                </div>
              )}
              <div className="p-3 flex flex-col justify-between flex-1 gap-2">
                <div>
                  <h4 className="text-xs font-bold text-foreground leading-snug">{r.name}</h4>
                  {/* Ternary, not `&&`: with `detail?.rate && (...)` a rate of
                      0 makes the expression evaluate to the number 0, which
                      React renders as a literal "0" where the price should be.
                      Seen live on the Grand Deluxe Hướng Biển Giường Đôi card.
                      Line 73 above already used a ternary; this one did not. */}
                  {(detail?.packageFrom || detail?.rate) ? (
                    <p className="text-xs font-bold text-amber-600 dark:text-amber-400 mt-1">
                      {detail?.packageFrom
                        ? (vi ? "Gói từ " : "Packages from ")
                        : (vi ? "Giá phòng từ " : "Room only from ")}
                      {vnd(detail.packageFrom || detail.rate)}/{vi ? "đêm" : "night"}
                    </p>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => setOpenCode(r.code)}
                  data-testid={`button-view-room-${r.code}`}
                  className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary/10 hover:bg-primary/20 text-primary px-3 py-1.5 text-xs font-semibold transition-all hover:scale-[1.01]"
                >
                  <BedDouble className="h-3.5 w-3.5" />
                  {vi ? "Xem ảnh & chi tiết đầy đủ" : "View photos & details"}
                  <Info className="h-3 w-3 opacity-60" />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {onSend && (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {hasDeluxe && (
            <>
              <button
                type="button"
                onClick={() => onSend(vi ? "Giá Deluxe giường đôi bao nhiêu?" : "Deluxe double bed price?")}
                className="rounded-full border border-border bg-card px-3 py-1 text-[11px] font-medium hover:border-primary/50 hover:bg-primary/5 hover:text-primary transition-all shadow-2xs"
              >
                🛏️ {vi ? "Deluxe Giường Đôi" : "Deluxe Double"}
              </button>
              <button
                type="button"
                onClick={() => onSend(vi ? "Giá Deluxe 2 giường đơn bao nhiêu?" : "Deluxe twin bed price?")}
                className="rounded-full border border-border bg-card px-3 py-1 text-[11px] font-medium hover:border-primary/50 hover:bg-primary/5 hover:text-primary transition-all shadow-2xs"
              >
                🛏️ {vi ? "Deluxe 2 Giường Đơn" : "Deluxe Twin"}
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => onSend(vi ? "So sánh các hạng phòng Deluxe và Villa" : "Compare Deluxe vs Villa")}
            className="rounded-full border border-border bg-card px-3 py-1 text-[11px] font-medium hover:border-primary/50 hover:bg-primary/5 hover:text-primary transition-all shadow-2xs"
          >
            ⚖️ {vi ? "So sánh hạng phòng" : "Compare room types"}
          </button>
        </div>
      )}

      {openCode && <RoomModal code={openCode} lang={lang} onClose={() => setOpenCode(null)} />}
    </div>
  );
}
