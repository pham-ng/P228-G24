import { storage } from "./storage";

import { distinctiveTokens, normaliseName } from "./name-alias";

/**
 * Which service groups this turn is actually ABOUT — the ones that earn a card.
 *
 * Like detectReferencedRoomTypes, the signal is the guest's question plus the
 * reply we just wrote, not the retrieved passages. Two separate defects made
 * the previous passage-driven version emit 10-17 service cards on every single
 * turn — cable car, VinWonders and airport transfer offered to a guest asking
 * what time breakfast starts:
 *
 *  - `passages.some(p => p.category === s.category)` matched a whole CATEGORY.
 *    One passage of category "dining" surfaced every dining service in the
 *    catalogue; one "spa" passage surfaced all seven Akoya treatments. A
 *    category is not a reference.
 *  - The typo-tolerance loop ran Damerau-Levenshtein ≤1 over tokens of only
 *    ≥3 characters, so "spa" matched "sao", "sáng" and anything else three
 *    letters away from nothing.
 *
 * A third defect was silent: the emitted key was `serviceGroup || name`, but
 * /api/service-groups only serves entries that HAVE a serviceGroup. Every
 * group-less service therefore rendered as a card with no items, no prices,
 * and a modal reading "Dịch vụ này hiện chưa có thông tin chi tiết." Those are
 * not offers, they are dead ends, so they are no longer emitted at all.
 *
 * `passages` is still accepted so the call signature and the trace entry are
 * unchanged, but it is deliberately not consulted.
 */
/**
 * Generic halves of a service-group name. "Akoya Spa" is stored that way and
 * the model answers "Spa Akoya" — reversed — so a contiguous substring test
 * finds nothing and a guest asking what treatments the spa offers gets no spa
 * card. The distinctive half ("akoya") survives both orderings and both
 * languages; the generic half never identified anything on its own.
 */
const SERVICE_STOP = new Set([
  "spa", "restaurant", "nha", "hang", "bar", "dining", "service", "services",
  "vinpearl", "resort", "nha trang", "the", "and", "va", "cua", "desk", "transfer",
]);

function focusNamesGroup(focus: string, group: string): boolean {
  const distinctive = distinctiveTokens(group, SERVICE_STOP);
  /* A group whose name is ENTIRELY generic ("Beach & water sports") keeps the
     strict whole-name test rather than matching on nothing at all. */
  if (!distinctive.length) return focus.includes(normaliseName(group));
  return distinctive.every((w) => focus.includes(w));
}

export function detectReferencedServices(
  _passages: { title: string; category: string; content?: string; body?: string }[],
  focusText = "",
): { key: string; name: string; category: string | null }[] {
  /* Normalised, not merely folded, so the vocabulary in name-alias.ts lines
     the guest's "cáp treo" up with the group stored as "Vinpearl cable car". */
  const focus = normaliseName(focusText);
  if (!focus.trim()) return [];

  const seen = new Set<string>();
  const out: { key: string; name: string; category: string | null }[] = [];

  for (const s of storage.listServices()) {
    /* Only groups the detail endpoint can actually resolve — see above. */
    const key = s.serviceGroup;
    if (!key || seen.has(key)) continue;

    /* A group is named when the turn names the GROUP or one of its ITEMS.
     *
     * Group-only matching was too narrow in a common shape: asked "giá dịch
     * vụ spa", the answer listed seven Akoya treatments by name — "Hot Stone
     * Therapy 90'", "Balinese Massage 90'" — and never wrote the word
     * "Akoya", so the guest got a wall of prices with no way to book any of
     * them. Naming a treatment IS naming the spa that sells it; this is still
     * a specific reference, not the category match that produced 17 cards a
     * turn (see the note above). Item names are stored as
     * "Akoya Spa — Hot Stone Therapy 90'", so the group prefix is stripped
     * before matching or every item would trivially contain it. */
    let named = focusNamesGroup(focus, key);
    if (!named) {
      named = storage.listServices().some((it) => {
        if (it.serviceGroup !== key) return false;
        const item = normaliseName(it.name.replace(/^.*?—\s*/, ""));
        /* Long enough to be a real name, not a fragment like "60". */
        return item.length > 6 && focus.includes(item);
      });
    }
    /* A curated KB article named in the answer counts as naming the service
       it documents — this is the link the data already models, and unlike a
       bare category it is specific to one group. */
    let linkedNamed = false;
    if (!named) {
      let linked: string[] = [];
      try {
        linked = JSON.parse(s.linkedKbTitles || "[]") as string[];
      } catch {
        linked = [];
      }
      linkedNamed = linked.some((t) => {
        const ft = normaliseName(t);
        return ft.length > 3 && focus.includes(ft);
      });
    }

    if (named || linkedNamed) {
      seen.add(key);
      /* Kèm loại dịch vụ: kiosk chọn động từ trên nút theo nó ("Xem tuyến" cho
         cáp treo, "Xem liệu trình" cho spa). `key` là tên thương hiệu nên tự nó
         không nói được đây là loại gì. */
      out.push({ key, name: key, category: s.category ?? null });
    }
  }

  return out;
}
