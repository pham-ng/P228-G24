export const HOTEL_TZ = "Asia/Bangkok";

export function clock(iso: string) {
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: HOTEL_TZ,
  });
}

export function dayMonth(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: HOTEL_TZ,
  });
}

export function stamp(iso: string) {
  return `${dayMonth(iso)} · ${clock(iso)}`;
}

export function relative(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Minutes remaining until `dueAt`; negative when the SLA has been breached. */
export function minutesUntil(iso: string | null) {
  if (!iso) return null;
  return Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
}

export function money(amount: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
  }).format(amount);
}

export function seconds(n: number) {
  if (n < 60) return `${n}s`;
  const m = Math.floor(n / 60);
  return `${m}m ${n % 60}s`;
}

export function titleCase(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

/** Compact human duration from a minute count: 45m, 3h 20m, 5d 4h. */
export function duration(mins: number): string {
  const m = Math.abs(Math.round(mins));
  if (m < 60) return `${m}m`;
  if (m < 1440) {
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? `${h}h ${r}m` : `${h}h`;
  }
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return h ? `${d}d ${h}h` : `${d}d`;
}
