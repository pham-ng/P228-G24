import { fold } from "./retrieval";

/**
 * Put a catalogue name and the words a guest uses for it into the same
 * vocabulary, so "did this turn name this room?" can be answered by comparing
 * tokens instead of by hoping two strings match character for character.
 *
 * Every room type and service in this property is stored under TWO names that
 * mean the same thing in different languages — `code` and `name_vi`:
 *
 *     code    "Villa 3-Bedroom Ocean View"
 *     name_vi "Biệt Thự 3 Phòng Ngủ Hướng Biển"
 *
 * A guest, and the model answering them, freely mix the two: "Villa 3 phòng
 * ngủ hướng biển". That string is not a substring of either stored name, so
 * a guest who asked about that villa by name got no villa card at all — the
 * opposite failure from the one this file's callers were written to fix, and
 * just as wrong. The same gap hid the cable car: the group is stored
 * "Vinpearl cable car" and the whole conversation says "cáp treo".
 *
 * Normalising both sides collapses the two stored names onto ONE token set,
 * which is what makes this work in either direction:
 *
 *     "Villa 3-Bedroom Ocean View"      → villa 3 bedroom oceanview
 *     "Biệt Thự 3 Phòng Ngủ Hướng Biển" → villa 3 bedroom oceanview
 *
 * This is a vocabulary, not a per-entity rule: nothing here names a specific
 * room, venue or service, so a room added tomorrow is covered by the same
 * dozen equivalences. Multi-word phrases are joined into single tokens
 * ("oceanview") on purpose — it keeps "hướng biển" a DISCRIMINATOR between
 * Deluxe and Deluxe Hướng Biển rather than two loose words that either name
 * could pick up separately.
 *
 * Order matters: longer phrases are replaced before the shorter phrases they
 * contain, so "2 giường đơn" becomes twinbed rather than "2" + a stray match.
 */
const EQUIVALENCES: [RegExp, string][] = [
  // bed configurations — the code says it in English, name_vi in Vietnamese
  [/\b2\s*giuong\s*don\b/g, " twinbed "],
  [/\btwin\s*bed\b/g, " twinbed "],
  [/\bgiuong\s*don\b/g, " twinbed "],
  [/\bgiuong\s*doi\b/g, " queenbed "],
  [/\bqueen\s*bed\b/g, " queenbed "],
  // outlook
  [/\bhuong\s*bien\b/g, " oceanview "],
  [/\bocean\s*view\b/g, " oceanview "],
  [/\bsea\s*view\b/g, " oceanview "],
  // layout
  [/\bphong\s*ngu\b/g, " bedroom "],
  [/\bbed\s*room\b/g, " bedroom "],
  // property vocabulary
  [/\bbiet\s*thu\b/g, " villa "],
  [/\bcap\s*treo\b/g, " cablecar "],
  [/\bcable\s*car\b/g, " cablecar "],
];

/**
 * Fold, flatten punctuation to spaces, then apply the vocabulary above.
 *
 * Punctuation matters here because `fold()` deliberately leaves it alone:
 * without this, "Villa 3-Bedroom Ocean View" tokenises as the single token
 * "3-bedroom" and never lines up with "3 phòng ngủ".
 */
export function normaliseName(text: string): string {
  let s = ` ${fold(text).replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  for (const [re, to] of EQUIVALENCES) s = s.replace(re, to);
  return s.replace(/\s+/g, " ").trim();
}

/** The distinctive tokens of `name`, with generic words removed. */
export function distinctiveTokens(name: string, stop: Set<string>): string[] {
  return [
    ...new Set(
      normaliseName(name)
        .split(" ")
        .filter((w) => w.length > 0 && !stop.has(w)),
    ),
  ];
}

const tokens = (s: string) => normaliseName(s).split(" ").filter(Boolean);

/** Whether `needle` occurs in `hay` as a run of whole, adjacent tokens. */
function containsRun(hay: string[], needle: string[]): boolean {
  if (!needle.length || needle.length > hay.length) return false;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * Which of `entities` the text actually names — matching whole adjacent
 * tokens, and keeping only the MOST SPECIFIC name when several fit.
 *
 * Plain substring matching is not enough in either direction, and both
 * failures are real:
 *
 *  - Not contiguous: "Deluxe Giường Đôi" normalises to `deluxe queenbed`,
 *    which is a token SUBSET of "Deluxe Hướng Biển Giường Đôi"
 *    (`deluxe oceanview queenbed`). Requiring adjacency separates them.
 *  - Not specific: `deluxe queenbed` IS an adjacent run inside
 *    `grand deluxe queenbed`, so asking about the Grand Deluxe matched the
 *    plain Deluxe too. Live consequence, found while tracing a wrong price:
 *    "Grand Deluxe giường đôi giá bao nhiêu?" was answered "khoảng 4.600.000
 *    VNĐ/đêm" — the plain Deluxe's rate — because the plain Deluxe's record
 *    had been pulled into the prompt alongside it. Dropping a match that
 *    sits entirely inside a longer match fixes it without naming any room.
 *
 * Each entity may carry two aliases (`name` and `alt`, i.e. name_vi and
 * code); whichever matches is the one measured for specificity.
 */
export function namedEntities<T>(
  focusText: string,
  entities: { name: string; alt?: string; item: T }[],
): T[] {
  const hay = tokens(focusText);
  if (!hay.length) return [];

  const hits: { seq: string[]; item: T }[] = [];
  for (const e of entities) {
    const candidates = [tokens(e.name), ...(e.alt ? [tokens(e.alt)] : [])].filter((t) => t.length);
    const matched = candidates.filter((c) => containsRun(hay, c));
    if (!matched.length) continue;
    /* Measure specificity by the LONGEST alias that matched. */
    matched.sort((a, b) => b.length - a.length);
    hits.push({ seq: matched[0], item: e.item });
  }

  return hits
    .filter(
      (h) =>
        !hits.some(
          (other) => other !== h && other.seq.length > h.seq.length && containsRun(other.seq, h.seq),
        ),
    )
    .map((h) => h.item);
}
