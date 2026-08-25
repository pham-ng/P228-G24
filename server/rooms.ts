import { storage } from "./storage";

/**
 * Which room types a turn's real retrieved evidence actually named — same
 * principle as `detectReferencedVenues` in dining.ts: read the retrieval
 * chunks the server itself fetched (category "room_type", titled exactly
 * `${nameVi} — phòng` by reindex()), never the model's own reply text.
 */
export function detectReferencedRoomTypes(passages: { title: string; category: string }[]): { code: string; name: string }[] {
  const types = storage.listRoomTypes();
  const seen = new Set<string>();
  const out: { code: string; name: string }[] = [];
  for (const p of passages) {
    if (p.category !== "room_type") continue;
    const r = types.find((x) => p.title.startsWith(x.nameVi));
    if (r && !seen.has(r.code)) {
      seen.add(r.code);
      out.push({ code: r.code, name: r.nameVi });
    }
  }
  return out;
}
