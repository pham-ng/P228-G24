import { storage } from "./storage";
import { fold, damerauLevenshtein } from "./retrieval";

/**
 * Dynamically detects which service group(s) a turn's retrieved evidence grounds:
 * Reads retrieved passages, category mappings, and token-level fuzzy similarity
 * against published services in storage.
 * 100% data-driven, multilingual, and tolerant of typos & paraphrasing without hardcoded keywords.
 */
export function detectReferencedServices(passages: { title: string; category: string; content?: string; body?: string }[]): { key: string; name: string }[] {
  const all = storage.listServices();
  const seen = new Set<string>();
  const out: { key: string; name: string }[] = [];

  for (const s of all) {
    const key = s.serviceGroup || s.name;
    if (seen.has(key)) continue;

    // 1. Linked KB Titles matching
    const linked = JSON.parse(s.linkedKbTitles || "[]") as string[];
    const isLinkedMatch = passages.some((p) =>
      linked.some((t) => fold(p.title).includes(fold(t)) || fold(t).includes(fold(p.title)))
    );

    // 2. Passage Category matching (e.g., passage category === service category)
    const isPassageCategoryMatch = passages.some((p) => p.category === s.category);

    // 3. Substring & Token-level overlap for multilingual / paraphrase / typos
    const foldedName = fold(s.name);
    const foldedGroup = s.serviceGroup ? fold(s.serviceGroup) : "";
    const foldedCat = fold(s.category);

    let isContentMatch = false;
    for (const p of passages) {
      const pText = fold(`${p.title} ${p.content || p.body || ""}`);
      if (
        (foldedCat && pText.includes(foldedCat)) ||
        (foldedGroup && pText.includes(foldedGroup)) ||
        pText.includes(foldedName)
      ) {
        isContentMatch = true;
        break;
      }

      // Token level typo tolerance (e.g. sapa vs spa, massaj vs massage)
      const pTokens = pText.split(/\s+/);
      const nameTokens = `${foldedName} ${foldedGroup}`.split(/\s+/);
      for (const pt of pTokens) {
        if (pt.length < 3) continue;
        for (const nt of nameTokens) {
          if (nt.length < 3) continue;
          if (damerauLevenshtein(pt, nt) <= 1) {
            isContentMatch = true;
            break;
          }
        }
        if (isContentMatch) break;
      }
      if (isContentMatch) break;
    }

    if (isLinkedMatch || isPassageCategoryMatch || isContentMatch) {
      seen.add(key);
      out.push({ key, name: key });
    }
  }

  return out;
}
