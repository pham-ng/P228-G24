/**
 * In-room dining, ordered from a basket.
 *
 * The dishes were in `services` all along (category `roomservice`) and no guest
 * could ever see them: `/api/service-groups` only returns rows that carry a
 * `serviceGroup`, and these carry none. Meanwhile `order_room_service` is a
 * TOOL, so on the offline path the product ships with, "cho tôi gọi 2 phần phở
 * bò lên phòng" was answered with an abstention and a handoff.
 *
 * A food order is a BASKET — several dishes, each with a quantity — which is
 * exactly what free text cannot carry reliably and what a picker carries
 * trivially. No model is involved in the order.
 *
 * The kitchen's hours come from the ROOM_SERVICE policy, so a closed kitchen
 * greys the whole panel out rather than letting a guest fill a basket and be
 * refused on submit.
 */
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { UtensilsCrossed, Loader2, Check, Clock } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

type MenuItem = { id: number; name: string; description: string; price: number; unit: string };
type Menu = {
  currency: string;
  open: boolean;
  hours: string;
  etaMinutes: number;
  peak: boolean;
  minOrder: number;
  items: MenuItem[];
};

const vnd = (n: number) => `${n.toLocaleString("vi-VN")}₫`;

/* Six languages, matching what the concierge replies in. English is the
   fallback: a guest who opened the menu wants the menu. */
const T = {
  title: { vi: "Gọi đồ lên phòng", en: "In-room dining", ko: "룸서비스", ja: "ルームサービス", zh: "客房送餐", ru: "Обслуживание в номере" },
  closed: {
    vi: "Bếp đang đóng. Giờ phục vụ",
    en: "The kitchen is closed. Serving hours",
    ko: "주방이 닫혀 있습니다. 운영 시간",
    ja: "厨房は閉まっています。提供時間",
    zh: "厨房已关闭。供餐时间",
    ru: "Кухня закрыта. Часы работы",
  },
  eta: { vi: "Dự kiến", en: "Around", ko: "예상", ja: "目安", zh: "预计", ru: "Примерно" },
  minutes: { vi: "phút", en: "min", ko: "분", ja: "分", zh: "分钟", ru: "мин" },
  total: { vi: "Tạm tính", en: "Subtotal", ko: "소계", ja: "小計", zh: "小计", ru: "Итого" },
  send: { vi: "Gửi yêu cầu gọi đồ", en: "Request order", ko: "주문 요청", ja: "注文をリクエスト", zh: "提交订单请求", ru: "Отправить заказ" },
  desk: {
    vi: "Bếp sẽ xác nhận trước khi tính phí.",
    en: "The kitchen confirms before anything is charged.",
    ko: "요금이 청구되기 전에 주방에서 확인합니다.",
    ja: "料金が発生する前に厨房が確認いたします。",
    zh: "厨房确认后才会产生费用。",
    ru: "Кухня подтвердит до списания средств.",
  },
  sent: {
    vi: "Đã gửi tới bếp — đang chờ xác nhận",
    en: "Sent to the kitchen — awaiting confirmation",
    ko: "주방에 전달됨 — 확인 대기 중",
    ja: "厨房に送信しました — 確認をお待ちください",
    zh: "已发送至厨房 — 等待确认",
    ru: "Отправлено на кухню — ожидает подтверждения",
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
  failed: { vi: "Không gửi được.", en: "Could not send.", ko: "보낼 수 없습니다.", ja: "送信できませんでした。", zh: "无法发送。", ru: "Не удалось отправить." },
} as const;

type Lang = keyof (typeof T)["title"];
const tr = (lang: string, k: keyof typeof T): string => T[k][(lang in T.title ? lang : "en") as Lang];

export function RoomServicePanel({ code, lang }: { code: string | null; lang: string }) {
  const t = (k: keyof typeof T) => tr(lang, k);
  const [cart, setCart] = useState<Record<number, number>>({});
  const [error, setError] = useState<string | null>(null);

  const { data: menu } = useQuery<Menu>({
    queryKey: ["/api/guest/menu?code=" + encodeURIComponent(code ?? "")],
    enabled: !!code,
  });

  const order = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/guest/order", {
        code,
        items: Object.entries(cart)
          .filter(([, q]) => q > 0)
          .map(([id, q]) => ({ serviceId: Number(id), quantity: q })),
      });
      return r.json();
    },
    onError: (e: any) => setError(e?.message ?? t("failed")),
  });

  if (!code || !menu) return null;

  const items = menu.items;
  const subtotal = items.reduce((n, it) => n + it.price * (cart[it.id] ?? 0), 0);
  const count = Object.values(cart).reduce((n, q) => n + q, 0);
  const belowMin = menu.minOrder > 0 && subtotal < menu.minOrder;

  if (order.data?.pending_approval)
    return (
      <div className="mt-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3.5 text-xs" data-testid="order-pending">
        <div className="flex items-center gap-1.5 font-bold text-emerald-700 dark:text-emerald-400">
          <Check className="h-3.5 w-3.5" />
          {t("sent")}
        </div>
        <p className="mt-1.5 leading-relaxed text-foreground/80">
          {(order.data.items as string[]).join(", ")} · {vnd(order.data.pending_amount)} · {t("eta")}{" "}
          {order.data.eta_minutes} {t("minutes")}
        </p>
        <p className="mt-1 text-[11px] font-medium text-emerald-800/80 dark:text-emerald-300/80">{t("not_yet")}</p>
        <button
          onClick={() => {
            setCart({});
            order.reset();
          }}
          className="mt-2 text-[11px] font-semibold text-primary underline underline-offset-2"
        >
          {t("close")}
        </button>
      </div>
    );

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-primary/25 bg-card/90 p-3.5" data-testid="room-service-panel">
      <div className="flex items-center justify-between border-b border-border/40 pb-2">
        <div className="flex items-center gap-2">
          <UtensilsCrossed className="h-4 w-4 shrink-0 text-primary" />
          <h4 className="text-xs font-bold text-foreground">{t("title")}</h4>
        </div>
        <span className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
          <Clock className="h-3 w-3" />
          {menu.open ? `${t("eta")} ${menu.etaMinutes} ${t("minutes")}` : menu.hours}
        </span>
      </div>

      {/* A closed kitchen is stated once, at the top, instead of letting the
          guest build a basket the server will refuse. */}
      {!menu.open ? (
        <p className="pt-2.5 text-xs font-medium text-muted-foreground" data-testid="kitchen-closed">
          {t("closed")} {menu.hours}.
        </p>
      ) : (
        <>
          <ul className="space-y-1.5 pt-2">
            {items.map((it) => {
              const q = cart[it.id] ?? 0;
              return (
                <li key={it.id} className="flex items-center gap-2 border-b border-dashed border-border/30 py-1 last:border-none">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-foreground/90">{it.name.replace(/^In-room dining — /, "")}</div>
                    <div className="text-[11px] font-bold text-amber-600 dark:text-amber-400">{vnd(it.price)}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      onClick={() => setCart((c) => ({ ...c, [it.id]: Math.max(0, (c[it.id] ?? 0) - 1) }))}
                      disabled={q === 0}
                      data-testid={"dish-minus-" + it.id}
                      className="h-6 w-6 rounded-md border border-border/70 bg-card text-xs font-bold disabled:opacity-30 hover:border-primary/50"
                    >
                      −
                    </button>
                    <span className="w-5 text-center text-xs font-bold" data-testid={"dish-qty-" + it.id}>
                      {q}
                    </span>
                    <button
                      onClick={() => setCart((c) => ({ ...c, [it.id]: Math.min(20, (c[it.id] ?? 0) + 1) }))}
                      data-testid={"dish-plus-" + it.id}
                      className="h-6 w-6 rounded-md border border-border/70 bg-card text-xs font-bold hover:border-primary/50"
                    >
                      +
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>

          {count > 0 && (
            <div className="mt-2.5 space-y-2 border-t border-border/40 pt-2.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-bold uppercase tracking-wide text-muted-foreground">{t("total")}</span>
                <span className="font-bold text-amber-600 dark:text-amber-400" data-testid="order-subtotal">
                  {vnd(subtotal)}
                </span>
              </div>
              {error && (
                <div className="text-[11px] font-medium text-destructive" data-testid="order-error">
                  {error}
                </div>
              )}
              <button
                disabled={order.isPending || belowMin}
                onClick={() => {
                  setError(null);
                  order.mutate();
                }}
                data-testid="button-send-order"
                className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-bold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                {order.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UtensilsCrossed className="h-3.5 w-3.5" />}
                {t("send")}
              </button>
              {/* Says request, not order, because that is what it does. */}
              <p className="text-center text-[10px] leading-tight text-muted-foreground">{t("desk")}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
