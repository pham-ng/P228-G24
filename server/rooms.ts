import { storage } from "./storage";
import { fold } from "./retrieval";

/**
 * Which room types a turn's real retrieved evidence actually named —
 * reads the retrieved passages (category "room_type", "room_package", or general body text)
 * and matches against published room categories for rich UI rendering.
 */
export function detectReferencedRoomTypes(passages: { title: string; category: string; content?: string; body?: string }[]): { code: string; name: string }[] {
  const types = storage.listRoomTypes();
  const seen = new Set<string>();
  const out: { code: string; name: string }[] = [];

  for (const p of passages) {
    const fullText = fold(`${p.title} ${p.content || p.body || ""}`);
    for (const r of types) {
      if (seen.has(r.code)) continue;
      const foldedVi = fold(r.nameVi);
      const foldedCode = fold(r.code);

      // Category matching or substring matching in title/body
      if (
        (p.category === "room_type" && p.title.startsWith(r.nameVi)) ||
        fullText.includes(foldedVi) ||
        fullText.includes(foldedCode)
      ) {
        seen.add(r.code);
        out.push({ code: r.code, name: r.nameVi });
      }
    }
  }

  // Fallback: If passages mention generic "deluxe" or "villa", include top matching categories
  if (out.length === 0 && passages.length > 0) {
    const allPassageText = fold(passages.map((p) => `${p.title} ${p.content || p.body || ""}`).join(" "));
    for (const r of types) {
      if (seen.has(r.code)) continue;
      const foldedVi = fold(r.nameVi);
      if (allPassageText.includes("deluxe") && foldedVi.includes("deluxe")) {
        seen.add(r.code);
        out.push({ code: r.code, name: r.nameVi });
      } else if (allPassageText.includes("villa") && foldedVi.includes("villa")) {
        seen.add(r.code);
        out.push({ code: r.code, name: r.nameVi });
      }
    }
  }

  return out;
}
