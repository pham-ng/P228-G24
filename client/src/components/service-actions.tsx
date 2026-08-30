import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Sparkles, X, ChevronLeft, ChevronRight, Tag, CalendarCheck, Loader2, Check } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

export type ServiceGroupRef = { key: string; name: string };

export type ServiceGroupDetail = {
  key: string;
  name: string;
  images: string[];
  items: Array<{
    id: number;
    name: string;
    description: string;
    price: number;
    unit: string;
    slots: string[];
    bookable: boolean;
  }>;
};

type Availability = {
  serviceId: number;
  name: string;
  date: string;
  currency: string;
  memberPrice: number;
  rackPrice: number;
  discountPercent: number;
  capacityPerSlot: number;
  slots: Array<{ slot: string; seatsLeft: number }>;
};

/**
 * The booking form, in the six languages the concierge answers in.
 *
 * Found by running it: Yuki Tanaka's profile is `ja`, the concierge had just
 * answered her in Japanese, and the booking form underneath came up entirely in
 * English — the same shape of defect this project already hit once, where a
 * Japanese reply carried an English sales line. It matters more here than on a
 * label, because this form is where a guest commits to a spend.
 *
 * English is the fallback for an unsupported language, and that is the opposite
 * of the rule used for an unsolicited upsell line (no template means no offer).
 * The difference is who started it: a guest who has tapped "Book this" wants the
 * form, so showing it in English beats not showing it. An offer nobody asked for
 * in a language they did not choose is just noise.
 */
const T = {
  book_this: { vi: "Đặt dịch vụ này", en: "Book this", ko: "예약하기", ja: "予約する", zh: "预订", ru: "Забронировать" },
  date: { vi: "Ngày", en: "Date", ko: "날짜", ja: "日付", zh: "日期", ru: "Дата" },
  time: { vi: "Khung giờ", en: "Time", ko: "시간", ja: "時間", zh: "时间", ru: "Время" },
  guests: { vi: "Số khách", en: "Guests", ko: "인원", ja: "人数", zh: "人数", ru: "Гостей" },
  checking: {
    vi: "Đang xem chỗ trống...",
    en: "Checking availability...",
    ko: "예약 가능 여부 확인 중...",
    ja: "空き状況を確認しています...",
    zh: "正在查询空位...",
    ru: "Проверяем наличие мест...",
  },
  left: { vi: "còn", en: "left", ko: "남음", ja: "残り", zh: "剩余", ru: "ост." },
  request: {
    vi: "Gửi yêu cầu đặt",
    en: "Request booking",
    ko: "예약 요청",
    ja: "予約をリクエスト",
    zh: "提交预订请求",
    ru: "Отправить запрос",
  },
  desk_confirms: {
    vi: "Lễ tân sẽ xác nhận trước khi tính phí.",
    en: "The front desk confirms before anything is charged.",
    ko: "요금이 청구되기 전에 프런트에서 확인합니다.",
    ja: "料金が発生する前にフロントが確認いたします。",
    zh: "前台确认后才会产生费用。",
    ru: "Стойка регистрации подтвердит до списания средств.",
  },
  sent: {
    vi: "Đã gửi tới lễ tân — đang chờ xác nhận",
    en: "Sent to the front desk — awaiting confirmation",
    ko: "프런트에 전달됨 — 확인 대기 중",
    ja: "フロントに送信しました — 確認をお待ちください",
    zh: "已发送至前台 — 等待确认",
    ru: "Отправлено на стойку регистрации — ожидает подтверждения",
  },
  not_yet: {
    vi: "Đây chưa phải xác nhận. Chưa có khoản nào bị tính.",
    en: "Not a confirmation yet. Nothing has been charged.",
    ko: "아직 확정이 아닙니다. 청구된 금액은 없습니다.",
    ja: "これはまだ確定ではありません。料金は発生していません。",
    zh: "这还不是确认。尚未产生任何费用。",
    ru: "Это ещё не подтверждение. Средства не списаны.",
  },
  close: { vi: "Đóng", en: "Close", ko: "닫기", ja: "閉じる", zh: "关闭", ru: "Закрыть" },
  party_of: { vi: "khách", en: "guest(s)", ko: "명", ja: "名", zh: "位", ru: "гостей" },
  failed: {
    vi: "Không đặt được.",
    en: "Could not book.",
    ko: "예약할 수 없습니다.",
    ja: "予約できませんでした。",
    zh: "无法预订。",
    ru: "Не удалось забронировать.",
  },
} as const;

type Lang = keyof (typeof T)["date"];
const tr = (lang: string, key: keyof typeof T): string => T[key][(lang in T.date ? lang : "en") as Lang];

/** The next seven days — as far ahead as an in-house guest ever books. */
function nextDays(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(new Date(Date.now() + i * 86400000).toISOString().slice(0, 10));
  return out;
}

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

/**
 * Book one service by picking, not by typing.
 *
 * The card already said "View all & Book" and then showed a price list — the
 * label promised a booking the interface could not make. Everything needed was
 * on the server (`bookCatalogueService` prices, checks capacity, lead time and
 * clashes, and opens a staff approval) and unreachable, because its only caller
 * was a TOOL and tools do not run on the offline path the product ships with.
 *
 * Every field is chosen from what the hotel published, so the request is valid
 * before it is sent and no model touches the transaction. The reply is worded
 * as PENDING throughout: the server writes `pending_approval` and posts no
 * charge, so telling the guest it is booked would be a claim the folio later
 * contradicts.
 */
function BookPanel({
  item,
  code,
  lang,
  onDone,
}: {
  item: ServiceGroupDetail["items"][number];
  code: string;
  lang: string;
  onDone: () => void;
}) {
  const t = (k: keyof typeof T) => tr(lang, k);
  const days = nextDays(7);
  const [date, setDate] = useState(days[0]);
  const [slot, setSlot] = useState<string>("");
  const [party, setParty] = useState(1);
  const [error, setError] = useState<string | null>(null);

  const { data: avail, isLoading } = useQuery<Availability>({
    queryKey: [
      "/api/guest/availability?code=" + encodeURIComponent(code) + "&serviceId=" + item.id + "&date=" + date,
    ],
    enabled: !!code,
  });

  const book = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/guest/book", {
        code,
        serviceId: item.id,
        date,
        slot,
        partySize: party,
      });
      return r.json();
    },
    onError: (e: any) => setError(e?.message ?? t("failed")),
  });

  const hasSlots = (avail?.slots.length ?? item.slots.length) > 0;
  const canBook = !!date && (!hasSlots || !!slot) && !book.isPending;

  if (book.data?.pending_approval)
    return (
      <div
        className="mt-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs"
        data-testid="booking-pending"
      >
        <div className="flex items-center gap-1.5 font-bold text-emerald-700 dark:text-emerald-400">
          <Check className="h-3.5 w-3.5" />
          {t("sent")}
        </div>
        <p className="mt-1.5 leading-relaxed text-foreground/80">
          {book.data.service} · {book.data.date}
          {book.data.slot ? " · " + book.data.slot : ""} ·{" "}
          {book.data.party_size + " " + t("party_of")} ·{" "}
          {vnd(book.data.pending_amount)}
        </p>
        {/* Stated in code, never by a model: a guest who reads "booked" will
            plan their evening around a slot nobody has approved. */}
        <p className="mt-1 text-[11px] font-medium text-emerald-800/80 dark:text-emerald-300/80">
          {t("not_yet")}
        </p>
        <button onClick={onDone} className="mt-2 text-[11px] font-semibold text-primary underline underline-offset-2">
          {t("close")}
        </button>
      </div>
    );

  return (
    <div className="mt-2.5 space-y-2.5 rounded-lg border border-primary/25 bg-primary/5 p-3">
      <div>
        <div className="mb-1 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
          {t("date")}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {days.map((d) => (
            <button
              key={d}
              onClick={() => {
                setDate(d);
                setSlot("");
                setError(null);
              }}
              data-testid={"book-date-" + d}
              className={
                "rounded-md px-2 py-1 text-[11px] font-semibold transition-colors " +
                (d === date
                  ? "bg-primary text-primary-foreground"
                  : "bg-card border border-border/70 hover:border-primary/50")
              }
            >
              {d.slice(5)}
            </button>
          ))}
        </div>
      </div>

      {hasSlots && (
        <div>
          <div className="mb-1 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
            {t("time")}
          </div>
          {isLoading ? (
            <div className="text-[11px] text-muted-foreground">
              {t("checking")}
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {(avail?.slots ?? item.slots.map((sl) => ({ slot: sl, seatsLeft: 99 }))).map((sl) => {
                /* Disabled rather than hidden: the guest can see the slot exists
                   and try a smaller party instead of wondering where it went. */
                const full = sl.seatsLeft < party;
                return (
                  <button
                    key={sl.slot}
                    disabled={full}
                    onClick={() => {
                      setSlot(sl.slot);
                      setError(null);
                    }}
                    data-testid={"book-slot-" + sl.slot}
                    className={
                      "rounded-md px-2 py-1 text-[11px] font-semibold transition-colors " +
                      (full
                        ? "cursor-not-allowed bg-muted text-muted-foreground/50 line-through"
                        : sl.slot === slot
                          ? "bg-primary text-primary-foreground"
                          : "bg-card border border-border/70 hover:border-primary/50")
                    }
                  >
                    {sl.slot}
                    {!full && sl.seatsLeft <= 3 && (
                      <span className="ml-1 text-[9px] font-normal opacity-70">
                        {lang === "vi" ? t("left") + " " + sl.seatsLeft : sl.seatsLeft + " " + t("left")}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <span className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
          {t("guests")}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setParty((n) => Math.max(1, n - 1))}
            className="h-6 w-6 rounded-md border border-border/70 bg-card text-xs font-bold hover:border-primary/50"
            data-testid="book-party-minus"
          >
            −
          </button>
          <span className="w-6 text-center text-xs font-bold" data-testid="book-party">
            {party}
          </span>
          <button
            onClick={() => setParty((n) => Math.min(20, n + 1))}
            className="h-6 w-6 rounded-md border border-border/70 bg-card text-xs font-bold hover:border-primary/50"
            data-testid="book-party-plus"
          >
            +
          </button>
        </div>
        {avail && (
          <span className="ml-auto text-[11px] font-bold text-amber-600 dark:text-amber-400">
            {vnd(avail.memberPrice * party)}
            {avail.discountPercent > 0 && (
              <span className="ml-1 text-[9px] font-normal text-muted-foreground">−{avail.discountPercent}%</span>
            )}
          </span>
        )}
      </div>

      {error && (
        <div className="text-[11px] font-medium text-destructive" data-testid="book-error">
          {error}
        </div>
      )}

      <button
        disabled={!canBook}
        onClick={() => {
          setError(null);
          book.mutate();
        }}
        data-testid="button-confirm-booking"
        className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-bold text-primary-foreground disabled:opacity-40 hover:opacity-90 transition-opacity"
      >
        {book.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CalendarCheck className="h-3.5 w-3.5" />}
        {t("request")}
      </button>
      {/* The button says request, not book, because that is what it does. */}
      <p className="text-center text-[10px] leading-tight text-muted-foreground">
        {t("desk_confirms")}
      </p>
    </div>
  );
}

function ServiceGroupModal({
  groupKey,
  onClose,
  lang,
  code,
}: {
  groupKey: string;
  onClose: () => void;
  lang: string;
  code: string | null;
}) {
  const vi = lang === "vi";
  const [imgIndex, setImgIndex] = useState(0);
  /* Which item's booking form is open. One at a time: two half-filled forms
     side by side is how a guest sends the wrong one. */
  const [bookingId, setBookingId] = useState<number | null>(null);
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

                    {/* No code means no session — the kiosk cannot book on
                        behalf of a guest it cannot identify, and the server
                        would refuse anyway. Showing a button that always fails
                        is worse than showing none. */}
                    {it.bookable && code && (
                      bookingId === it.id ? (
                        <BookPanel item={it} code={code} lang={lang} onDone={() => setBookingId(null)} />
                      ) : (
                        <button
                          type="button"
                          onClick={() => setBookingId(it.id)}
                          data-testid={"button-book-service-" + it.id}
                          className="mt-2 inline-flex items-center gap-1 rounded-lg bg-primary/10 px-2.5 py-1 text-[11px] font-semibold text-primary transition-colors hover:bg-primary/20"
                        >
                          <CalendarCheck className="h-3 w-3" />
                          {tr(lang, "book_this")}
                        </button>
                      )
                    )}
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

export function ServiceActions({
  groups,
  lang,
  code,
}: {
  groups: ServiceGroupRef[];
  lang: string;
  code: string | null;
}) {
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

              {/**
               * NHÓM 4 — ảnh ngay trên thẻ, không chỉ trong modal.
               *
               * Ảnh đã có sẵn trong `services.images` (3/5 nhóm có ảnh) nhưng
               * chỉ hiện sau khi khách bấm mở modal — nên khung chat của một
               * resort nghỉ dưỡng là một cột chữ. Thứ khách sạn bán là hình
               * ảnh; một tấm ảnh spa thật thuyết phục hơn ba dòng mô tả.
               *
               * `loading="lazy"` vì thẻ này nằm giữa hội thoại có thể rất dài,
               * và `onError` ẩn hẳn ảnh hỏng: một ô vỡ có icon rách nhìn tệ hơn
               * là không có ảnh nào.
               */}
              {(detail?.images?.length ?? 0) > 0 && (
                <div className="-mx-0.5 flex gap-1.5 overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {detail!.images.slice(0, 4).map((src) => (
                    <img
                      key={src}
                      src={src}
                      alt=""
                      loading="lazy"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display = "none";
                      }}
                      className="h-20 w-28 shrink-0 rounded-lg object-cover"
                      data-testid="service-card-image"
                    />
                  ))}
                </div>
              )}

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

      {openKey && (
        <ServiceGroupModal groupKey={openKey} lang={lang} code={code} onClose={() => setOpenKey(null)} />
      )}
    </div>
  );
}
