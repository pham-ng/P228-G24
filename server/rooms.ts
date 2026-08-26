import { storage } from "./storage";
import { fold, damerauLevenshtein } from "./retrieval";

/**
 * Dynamically detects which room type(s) a turn's retrieved evidence grounds:
 * Reads retrieved passages, category mappings, and token-level fuzzy similarity
 * against published room types in storage.
 * 100% data-driven, multilingual, and tolerant of typos & paraphrasing without hardcoded keywords.
 */
export function detectReferencedRoomTypes(passages: { title: string; category: string; content?: string; body?: string }[]): { code: string; name: string }[] {
  const types = storage.listRoomTypes();
  const seen = new Set<string>();
  const out: { code: string; name: string }[] = [];

  for (const p of passages) {
    const fullText = fold(`${p.title} ${p.content || p.body || ""}`);
    const tokens = fullText.split(/\s+/);

    for (const r of types) {
      if (seen.has(r.code)) continue;
      const foldedVi = fold(r.nameVi);
      const foldedCode = fold(r.code);

      // 1. Direct category match or substring match
      if (
        (p.category === "room_type" && p.title.startsWith(r.nameVi)) ||
        fullText.includes(foldedVi) ||
        fullText.includes(foldedCode)
      ) {
        seen.add(r.code);
        out.push({ code: r.code, name: r.nameVi });
        continue;
      }

      // 2. Token-level fuzzy match for typos (e.g., "deluxue" vs "deluxe", "executiv" vs "executive")
      const roomTokens = `${foldedVi} ${foldedCode}`.split(/\s+/);
      let match = false;
      for (const t of tokens) {
        if (t.length < 4) continue;
        for (const rt of roomTokens) {
          if (rt.length < 4) continue;
          if (damerauLevenshtein(t, rt) <= 1) {
            match = true;
            break;
          }
        }
        if (match) break;
      }

      if (match) {
        seen.add(r.code);
        out.push({ code: r.code, name: r.nameVi });
      }
    }
  }

  return out;
}
