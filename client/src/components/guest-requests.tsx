/**
 * The requests a guest raises by picking: wake-up call, housekeeping, laundry,
 * luggage.
 *
 * These already worked as TOOLS, so they ran only on the hosted path. On the
 * offline path they did not vanish — an escalation opens a task routed to the
 * right department — but everything that makes them a product was lost: WHEN
 * (a wake-up at 06:30), WHAT (three shirts), and a status a guest can be told
 * about. A picker carries all three; free text carries none of them reliably.
 *
 * No model is involved. The server calls the same ops tool the hosted path
 * calls, so the time format, the checkout bound and the department routing are
 * validated in exactly one place.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { BellRing, Sparkles, Shirt, Luggage, Loader2, Check } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

type Kind = "wake_up" | "housekeeping" | "laundry" | "luggage";

const T = {
  title: { vi: "Yêu cầu nhanh", en: "Quick requests", ko: "빠른 요청", ja: "クイックリクエスト", zh: "快捷请求", ru: "Быстрые запросы" },
  wake_up: { vi: "Báo thức", en: "Wake-up call", ko: "모닝콜", ja: "モーニングコール", zh: "叫醒服务", ru: "Будильник" },
  housekeeping: { vi: "Dọn phòng / đồ dùng", en: "Housekeeping", ko: "객실 정비", ja: "ハウスキーピング", zh: "客房服务", ru: "Уборка" },
  laundry: { vi: "Giặt là", en: "Laundry", ko: "세탁", ja: "ランドリー", zh: "洗衣", ru: "Прачечная" },
  luggage: { vi: "Hành lý", en: "Luggage", ko: "수하물", ja: "手荷物", zh: "行李", ru: "Багаж" },
  time: { vi: "Giờ", en: "Time", ko: "시간", ja: "時刻", zh: "时间", ru: "Время" },
  items: { vi: "Món đồ (mỗi dòng một món)", en: "Items (one per line)", ko: "품목 (한 줄에 하나)", ja: "品目（1行に1つ）", zh: "物品（每行一项）", ru: "Предметы (по одному в строке)" },
  send: { vi: "Gửi yêu cầu", en: "Send request", ko: "요청 보내기", ja: "リクエスト送信", zh: "发送请求", ru: "Отправить" },
  sent: { vi: "Đã chuyển tới bộ phận phụ trách", en: "Sent to the right team", ko: "담당 부서에 전달됨", ja: "担当部署に送信しました", zh: "已转交相关部门", ru: "Передано ответственной службе" },
  close: { vi: "Đóng", en: "Close", ko: "닫기", ja: "閉じる", zh: "关闭", ru: "Закрыть" },
  failed: { vi: "Không gửi được.", en: "Could not send.", ko: "보낼 수 없습니다.", ja: "送信できませんでした。", zh: "无法发送。", ru: "Не удалось отправить." },
  note: { vi: "Ghi chú (không bắt buộc)", en: "Note (optional)", ko: "메모 (선택)", ja: "メモ（任意）", zh: "备注（可选）", ru: "Примечание" },
} as const;

type Lang = keyof (typeof T)["title"];
const tr = (lang: string, k: keyof typeof T): string => T[k][(lang in T.title ? lang : "en") as Lang];

const KINDS: Array<{ key: Kind; icon: typeof BellRing; needsTime: boolean; needsItems: boolean }> = [
  { key: "wake_up", icon: BellRing, needsTime: true, needsItems: false },
  { key: "housekeeping", icon: Sparkles, needsTime: false, needsItems: true },
  { key: "laundry", icon: Shirt, needsTime: false, needsItems: true },
  { key: "luggage", icon: Luggage, needsTime: true, needsItems: false },
];

export function GuestRequestsPanel({ code, lang }: { code: string | null; lang: string }) {
  const t = (k: keyof typeof T) => tr(lang, k);
  const [open, setOpen] = useState<Kind | null>(null);
  const [time, setTime] = useState("");
  const [items, setItems] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = { code, kind: open };
      if (time) body.time = time;
      const list = items.split("\n").map((x) => x.trim()).filter(Boolean);
      if (list.length) body.items = list;
      if (note.trim()) body.note = note.trim();
      if (open === "housekeeping") body.serviceType = list.length ? "amenities" : "cleaning";
      if (open === "luggage") body.action = "pickup";
      const r = await apiRequest("POST", "/api/guest/request", body);
      return r.json();
    },
    onError: (e: any) => setError(e?.message ?? t("failed")),
  });

  const reset = () => {
    setOpen(null);
    setTime("");
    setItems("");
    setNote("");
    setError(null);
    send.reset();
  };

  if (!code) return null;

  if (send.data?.request_id)
    return (
      <div className="mt-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3.5 text-xs" data-testid="request-sent">
        <div className="flex items-center gap-1.5 font-bold text-emerald-700 dark:text-emerald-400">
          <Check className="h-3.5 w-3.5" />
          {t("sent")}
        </div>
        <p className="mt-1.5 text-foreground/80">{String(send.data.summary ?? "")}</p>
        <button onClick={reset} className="mt-2 text-[11px] font-semibold text-primary underline underline-offset-2">
          {t("close")}
        </button>
      </div>
    );

  const cfg = KINDS.find((k) => k.key === open);

  return (
    <div className="mt-3 rounded-xl border border-primary/25 bg-card/90 p-3.5" data-testid="guest-requests-panel">
      <h4 className="border-b border-border/40 pb-2 text-xs font-bold text-foreground">{t("title")}</h4>

      <div className="flex flex-wrap gap-1.5 pt-2.5">
        {KINDS.map(({ key, icon: Icon }) => (
          <button
            key={key}
            onClick={() => {
              setOpen(open === key ? null : key);
              setError(null);
            }}
            data-testid={`request-kind-${key}`}
            className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-semibold transition-colors ${
              open === key ? "bg-primary text-primary-foreground" : "border border-border/70 bg-card hover:border-primary/50"
            }`}
          >
            <Icon className="h-3 w-3" />
            {tr(lang, key)}
          </button>
        ))}
      </div>

      {cfg && (
        <div className="mt-2.5 space-y-2 border-t border-border/40 pt-2.5">
          {cfg.needsTime && (
            <label className="block">
              <span className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">{t("time")}</span>
              <input
                type="time"
                value={time}
                onChange={(e) => {
                  setTime(e.target.value);
                  setError(null);
                }}
                data-testid="request-time"
                className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
              />
            </label>
          )}
          {cfg.needsItems && (
            <label className="block">
              <span className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">{t("items")}</span>
              <textarea
                value={items}
                onChange={(e) => {
                  setItems(e.target.value);
                  setError(null);
                }}
                rows={3}
                data-testid="request-items"
                className="mt-1 w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-xs"
              />
            </label>
          )}
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("note")}
            data-testid="request-note"
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
          />

          {error && (
            <div className="text-[11px] font-medium text-destructive" data-testid="request-error">
              {error}
            </div>
          )}

          <button
            /* A wake-up with no time and a laundry bag with nothing in it are
               the two ways this becomes a task nobody can action. */
            disabled={send.isPending || (cfg.needsTime && !time) || (cfg.needsItems && !items.trim())}
            onClick={() => {
              setError(null);
              send.mutate();
            }}
            data-testid="button-send-request"
            className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-bold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {send.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t("send")}
          </button>
        </div>
      )}
    </div>
  );
}
