import { storage } from "./storage";

/**
 * Detects which service group(s) a reply's retrieval evidence actually
 * grounds, same principle as detectReferencedVenues/detectReferencedRoomTypes:
 * match retrieved KB chunk titles against each service's verified
 * `linkedKbTitles` (set only for real, curated articles — see migration 014).
 * Rows sharing a `serviceGroup` (e.g. 7 Akoya Spa treatments) collapse into
 * one card so the guest doesn't see 7 near-identical buttons.
 */
export function detectReferencedServices(passages: { title: string; category: string }[]): { key: string; name: string }[] {
  const all = storage.listServices();
  const titles = new Set(passages.map((p) => p.title));
  const seen = new Set<string>();
  const out: { key: string; name: string }[] = [];
  for (const s of all) {
    const linked = JSON.parse(s.linkedKbTitles || "[]") as string[];
    if (!linked.length || !s.serviceGroup) continue;
    if (!linked.some((t) => titles.has(t))) continue;
    const key = s.serviceGroup;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, name: s.serviceGroup });
  }
  return out;
}
