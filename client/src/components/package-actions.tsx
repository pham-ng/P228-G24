import { useState } from "react";
import { ChevronDown, ChevronUp, Sparkles, Check } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Tappable follow-ups for a package recommendation.
 *
 * The concierge already answers in prose. This adds the two moments where a
 * tap beats typing: choosing what matters to you when the agent asked, and
 * looking at what a little more money buys without having to ask for it.
 *
 * Everything rendered here is read from the tool result the agent actually used,
 * so a price on a card is the same figure the reply quoted — the UI never
 * recomputes or reformats an amount into something the agent did not say.
 */

type PackageView = {
  room_name: string;
  package_name: string;
  public_price: number;
  member_price: number | null;
  includes: string[];
  extra_cost?: number;
  adds?: string[];
  suits_traveller?: boolean;
  conditions: string[];
  has_blackout: boolean;
};

export type PackageRecommendation = {
  mode: "quote" | "clarify" | "empty";
  base?: PackageView;
  upsells: PackageView[];
  /** Present when the guest pushed back on price. */
  cheaper?: PackageView[];
  celebration?: string;
  clarify: Array<{ key: string; label: string }>;
};

const vnd = (n: number) => `${n.toLocaleString("vi-VN")}₫`;

/**
 * Pull the recommendation out of a message's tool trace. Returns null for every
 * other kind of turn, which is most of them — the component then renders nothing.
 */
export function readRecommendation(toolTrace: string | null): PackageRecommendation | null {
  if (!toolTrace) return null;
  try {
    const calls = JSON.parse(toolTrace) as Array<{ name: string; result: unknown }>;
    // Last one wins: a turn may probe more than once while narrowing.
    const hit = [...calls].reverse().find((c) => c.name === "recommend_room_packages");
    const r = hit?.result as PackageRecommendation | undefined;
    if (!r || typeof r !== "object" || !("mode" in r)) return null;
    return r;
  } catch {
    return null;
  }
}

export function PackageActions({
  rec,
  lang,
  onSend,
  disabled,
}: {
  rec: PackageRecommendation;
  lang: string;
  onSend: (text: string) => void;
  disabled?: boolean;
}) {
  const vi = lang === "vi";
  const [picked, setPicked] = useState<string[]>([]);
  const [open, setOpen] = useState(false);

  /* The agent asked what matters to the guest. Chips are multi-select so a
     family can say "buffet" and "fits four" in one go, which is how people
     actually think about a room. */
  if (rec.mode === "clarify" || (rec.mode === "empty" && rec.clarify.length)) {
    const toggle = (key: string) =>
      setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));
    const labels = rec.clarify.filter((c) => picked.includes(c.key)).map((c) => c.label);
    return (
      <div className="mt-2 space-y-2">
        <div className="flex flex-wrap gap-1.5">
          {rec.clarify.map((c) => {
            const on = picked.includes(c.key);
            return (
              <button
                key={c.key}
                type="button"
                disabled={disabled}
                onClick={() => toggle(c.key)}
                data-testid={`chip-${c.key}`}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs transition-colors disabled:opacity-50",
                  on
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card hover:bg-muted",
                )}
              >
                {on && <Check className="h-3 w-3" />}
                {c.label}
              </button>
            );
          })}
        </div>
        {picked.length > 0 && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              onSend(vi ? `Tôi muốn: ${labels.join(", ")}` : `I would like: ${labels.join(", ")}`);
              setPicked([]);
            }}
            data-testid="button-send-preferences"
            className="rounded-full bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {vi ? `Tìm gói phù hợp (${picked.length})` : `Find matching packages (${picked.length})`}
          </button>
        )}
      </div>
    );
  }

  if (rec.mode !== "quote") return null;

  /* Price pushback gets its own, quieter treatment: a guest who just said "too
     expensive" should see what costs less before anything that costs more, and
     the trade-off has to be on the card, not buried in the prose. */
  const cheaper = rec.cheaper ?? [];
  if (cheaper.length) {
    return (
      <div className="mt-2 space-y-2">
        {cheaper.map((c, i) => (
          <div key={i} data-testid={`cheaper-card-${i}`} className="rounded-xl border border-border bg-card p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-medium">{c.package_name}</div>
                <div className="text-[11px] text-muted-foreground">{c.room_name}</div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-sm font-semibold">{vnd(c.public_price)}</div>
                <div className="text-[10px] text-emerald-600">
                  {vi ? "tiết kiệm" : "saves"} {vnd(Math.abs(c.extra_cost ?? 0))}
                </div>
              </div>
            </div>
            {!!c.adds?.length && (
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                {vi ? "Đánh đổi: " : "Trade-off: "}
                {c.adds.join(", ")}
              </p>
            )}
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                onSend(vi ? `Tôi muốn chọn ${c.package_name} — ${c.room_name}` : `I'll take the ${c.package_name} — ${c.room_name}`)
              }
              data-testid={`button-choose-cheaper-${i}`}
              className="mt-2 rounded-full border border-border px-3 py-1 text-[11px] font-medium hover:bg-muted disabled:opacity-50"
            >
              {vi ? "Chọn gói này" : "Choose this"}
            </button>
          </div>
        ))}
      </div>
    );
  }

  if (!rec.upsells.length) return null;

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        data-testid="button-view-upsells"
        className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/5 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/10"
      >
        <Sparkles className="h-3.5 w-3.5" />
        {vi ? `Xem ${rec.upsells.length} gói tốt hơn` : `See ${rec.upsells.length} better packages`}
        {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          {rec.upsells.map((u, i) => (
            <div
              key={i}
              data-testid={`upsell-card-${i}`}
              className={cn(
                "rounded-xl border p-3",
                u.suits_traveller ? "border-primary/40 bg-primary/5" : "border-border bg-card",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium">{u.package_name}</span>
                    {u.suits_traveller && (
                      <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                        {vi ? "Hợp với bạn" : "Suits you"}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-muted-foreground">{u.room_name}</div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-sm font-semibold text-primary">+{vnd(u.extra_cost ?? 0)}</div>
                  <div className="text-[10px] text-muted-foreground">{vi ? "mỗi đêm" : "per night"}</div>
                </div>
              </div>

              {!!u.adds?.length && (
                <ul className="mt-2 space-y-0.5">
                  {u.adds.map((a, j) => (
                    <li key={j} className="flex items-start gap-1.5 text-xs">
                      <Check className="mt-0.5 h-3 w-3 shrink-0 text-primary" />
                      <span>{a}</span>
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-[11px] text-muted-foreground">
                  {vi ? "Tổng" : "Total"} {vnd(u.public_price)}
                  {u.member_price ? ` · ${vi ? "hội viên" : "member"} ${vnd(u.member_price)}` : ""}
                </span>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    onSend(
                      vi
                        ? `Tôi muốn tìm hiểu gói ${u.package_name} cho ${u.room_name}`
                        : `Tell me more about the ${u.package_name} package for ${u.room_name}`,
                    )
                  }
                  data-testid={`button-choose-upsell-${i}`}
                  className="rounded-full bg-primary px-3 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-50"
                >
                  {vi ? "Tìm hiểu" : "Learn more"}
                </button>
              </div>

              {/* Date-bound rules travel with the card so a tap never hides a condition. */}
              {(u.has_blackout || u.conditions.length > 0) && (
                <p className="mt-2 border-t border-border pt-1.5 text-[10px] leading-snug text-muted-foreground">
                  {u.conditions[0] ??
                    (vi ? "Có điều kiện áp dụng theo mùa/lễ tết." : "Seasonal and holiday conditions apply.")}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
