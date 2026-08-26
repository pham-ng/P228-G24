import { storage } from "./storage";
import { fold } from "./retrieval";

/**
 * Detects which service group(s) a reply's retrieval evidence actually
 * grounds: matches retrieved KB chunk titles, categories, or names against
 * services (e.g. Akoya Spa, Cable car, Buggy) to render interactive service cards.
 */
export function detectReferencedServices(passages: { title: string; category: string; content?: string; body?: string }[]): { key: string; name: string }[] {
  const all = storage.listServices();
  const titles = new Set(passages.map((p) => p.title));
  const fullPassageText = fold(passages.map((p) => `${p.title} ${p.content || p.body || ""}`).join(" "));
  const seen = new Set<string>();
  const out: { key: string; name: string }[] = [];

  for (const s of all) {
    const key = s.serviceGroup || s.name;
    if (seen.has(key)) continue;

    const linked = JSON.parse(s.linkedKbTitles || "[]") as string[];
    const isLinkedMatch = linked.some((t) => titles.has(t));
    const isSpaQuery = fullPassageText.includes("spa") && (s.category === "spa" || fold(s.name).includes("spa"));
    const isNameMatch = fullPassageText.includes(fold(s.name));

    if (isLinkedMatch || isSpaQuery || isNameMatch) {
      seen.add(key);
      out.push({ key, name: key });
    }
  }
  return out;
}
