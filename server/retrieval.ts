/**
 * Hybrid retrieval over the knowledge base and the policy register.
 *
 * Two independent rankers are fused with Reciprocal Rank Fusion:
 *   - BM25 over tokenised chunk text (diacritic-folded, so Vietnamese queries
 *     match whether or not the guest typed the accents)
 *   - cosine similarity over `text-embedding-3-small` vectors, which is what
 *     lets a Vietnamese question retrieve an English policy chunk
 *
 * If the embedding endpoint is unavailable the vector leg is skipped and the
 * lexical leg alone answers — retrieval degrades, it never fabricates.
 */
import { storage, nowIso } from "./storage";
import { listVenues, hoursText } from "./dining";
import { embed, MODEL_EMBED } from "./openai";
import { EMBED_PROVIDER } from "./llm";
import { EMBEDDING_VERSION } from "./index-health";
import { hydeEnabled, shouldUseHyde, hypotheticalDocument, fuseVectors } from "./hyde";
import { rerankEnabled, rerankDepth, getRerankScores, applyRerank } from "./rerank";
import type { DocChunk } from "@shared/schema";

const CHUNK_CHARS = 900;
const CHUNK_OVERLAP = 150;
const RRF_K = 60;

/**
 * Fusion weights for the two retrieval legs.
 *
 * Both weights are measured, not assumed, and the measurement was decisive twice
 * in opposite directions:
 *
 *   1. With the quantised multilingual-e5-small served by Ollama, the vector leg
 *      ranked near-randomly on this corpus (34.6% hit@5 alone) and dragged the
 *      fused result down to 73% — worse than lexical search on its own. Every
 *      non-zero weight lost accuracy monotonically, so it was switched off.
 *   2. Re-tested with text-embedding-3-small, the same leg scores 94.2% hit@5
 *      alone, and fusing it at 0.5 lifts the system to 100% hit@5 / 0.941 MRR —
 *      better than either leg by itself. A sweep put the optimum squarely at 0.5
 *      (0.25 → 98.1%, 0.5 → 100%, 0.75+ → falls back).
 *
 * So the honest default is not a constant but a function of the model actually
 * indexed. Setting a flat 0.5 would silently degrade any deployment still on
 * e5-small from 98% to 73%; setting a flat 0 would throw away the best result
 * this system has measured. RRF_VEC_WEIGHT overrides either way.
 *
 * Re-run bench/retrieval-eval.ts after changing embedding model and keep the
 * weight that wins — that is the whole point of having the benchmark.
 */
/* Read per call, not once at import, so an operator or a test can change the
   weighting at runtime without a restart. */
function rrfLexWeight(): number {
  return Number(process.env.RRF_LEX_WEIGHT ?? 1);
}
function rrfVecWeight(): number {
  if (process.env.RRF_VEC_WEIGHT != null && process.env.RRF_VEC_WEIGHT !== "") {
    return Number(process.env.RRF_VEC_WEIGHT);
  }
  return /e5-small/i.test(MODEL_EMBED) ? 0 : 0.5;
}

/* ------------------------------------------------------------------ *
 * Tokenising
 * ------------------------------------------------------------------ */

/** Fold diacritics so "muộn" and "muon" tokenise identically. */
export function fold(s: string) {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    /* Re-compose. NFD decomposes Hangul into jamo (U+1100-U+11FF), which the
       combining-mark strip above does not remove, so a Korean syllable came out
       as two code points and every Korean pattern matched against folded text
       silently stopped matching. Found when diacritic folding was extended to
       the routing rules: the Korean extra-night case went complex -> knowledge.
       Latin diacritics are still stripped; CJK now survives unchanged. */
    .normalize("NFC")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

/**
 * Did the writer of this text use Vietnamese diacritics at all?
 *
 * Folding diacritics away is what lets an unaccented "toi muon huy phong"
 * reach the same safety rules as "tôi muốn huỷ phòng". It is also lossy, and
 * the loss is not theoretical: "đôi" (a pair — as in "giường đôi", a double
 * bed) and "đổi" (to change) both fold to "doi", and "đổi" is a write verb.
 * Folding unconditionally therefore routed EVERY double-bed question —
 * "Giá Deluxe giường đôi bao nhiêu?" — to the transaction lane as if the
 * guest had asked to change something.
 *
 * A guest who types accents has already disambiguated for us. So fold only
 * when there is nothing to lose: if the message carries no Vietnamese
 * diacritic, match folded and accept the over-matching (which errs toward
 * escalation, the cheap failure); if it does, match exactly and keep the
 * precision the accents were carrying.
 */
const VIETNAMESE_DIACRITICS =
  /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;

export function hasVietnameseDiacritics(s: string): boolean {
  return VIETNAMESE_DIACRITICS.test(s);
}

/**
 * Generalized Damerau-Levenshtein distance calculation for typo tolerance.
 * Handles insertions, deletions, substitutions, and single-character transpositions.
 */
export function damerauLevenshtein(a: string, b: string): number {
  const lenA = a.length;
  const lenB = b.length;
  if (a === b) return 0;
  if (lenA === 0) return lenB;
  if (lenB === 0) return lenA;

  const d: number[][] = [];
  for (let i = 0; i <= lenA; i++) {
    d[i] = [];
    d[i][0] = i;
  }
  for (let j = 0; j <= lenB; j++) {
    d[0][j] = j;
  }

  for (let i = 1; i <= lenA; i++) {
    for (let j = 1; j <= lenB; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,      // deletion
        d[i][j - 1] + 1,      // insertion
        d[i - 1][j - 1] + cost // substitution
      );
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost); // transposition
      }
    }
  }
  return d[lenA][lenB];
}

/** Canonical resort domain terms for dynamic typo resolution across room/venue/service queries. */
const DOMAIN_DICTIONARY = [
  "deluxe", "executive", "suite", "villa", "superior", "ocean", "view", "grand",
  "king", "twin", "bedroom", "lotus", "jasmine", "bach", "giai", "halal", "vietflavors",
  "ozone", "buffet", "restaurant", "akoya", "spa", "massage", "sauna", "cable",
  "car", "pool", "swimming", "beach", "vinwonders", "harbour", "shuttle", "checkout", "checkin"
];

/** Find canonical domain token if rawToken contains minor typos (distance <= 2). */
export function findFuzzyCanonicalToken(rawToken: string): string | null {
  if (rawToken.length < 4) return null;
  let bestMatch: string | null = null;
  let minDistance = 3;

  for (const term of DOMAIN_DICTIONARY) {
    if (Math.abs(term.length - rawToken.length) > 2) continue;
    const dist = damerauLevenshtein(rawToken, term);
    if (dist > 0 && dist <= 2 && dist < minDistance) {
      const maxLen = Math.max(rawToken.length, term.length);
      const similarity = (maxLen - dist) / maxLen;
      if (similarity >= 0.65) {
        minDistance = dist;
        bestMatch = term;
      }
    }
  }
  return bestMatch;
}

/**
 * E5-family models are trained with asymmetric prefixes: documents must be
 * embedded as "passage: …" and questions as "query: …", and omitting them costs
 * real accuracy. No other model expects them — prefixing an OpenAI embedding
 * with "passage:" just embeds the literal word — so the prefix follows the model
 * actually in use rather than being hard-coded.
 */
function isE5(model: string): boolean {
  return /e5/i.test(model);
}
function asPassage(text: string, model: string): string {
  return isE5(model) ? `passage: ${text}` : text;
}
function asQuery(text: string, model: string): string {
  return isE5(model) ? `query: ${text}` : text;
}

const STOP = new Set(
  ("the a an and or of to for in on at is are be was were i you we they it this that with from " +
    "la va cua cho trong tai thi khi nao co the duoc mot nhung nay do voi tu den ve se da " +
    "what how when where which why do does can could would should my our your")
    .split(" "),
);

export function tokenise(s: string): string[] {
  const rawTokens = fold(s)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));

  const result: string[] = [];
  for (const t of rawTokens) {
    result.push(t);
    const fuzzy = findFuzzyCanonicalToken(t);
    if (fuzzy && fuzzy !== t && !result.includes(fuzzy)) {
      result.push(fuzzy);
    }
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Chunking + indexing
 * ------------------------------------------------------------------ */

function chunkText(text: string): string[] {
  const clean = text.replace(/\r/g, "").trim();
  if (clean.length <= CHUNK_CHARS) return [clean];
  const out: string[] = [];
  let i = 0;
  while (i < clean.length) {
    let end = Math.min(clean.length, i + CHUNK_CHARS);
    if (end < clean.length) {
      // prefer a sentence or newline boundary inside the tail of the window
      const window = clean.slice(i, end);
      const cut = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(". "));
      if (cut > CHUNK_CHARS * 0.5) end = i + cut + 1;
    }
    out.push(clean.slice(i, end).trim());
    if (end >= clean.length) break;
    i = end - CHUNK_OVERLAP;
  }
  return out.filter(Boolean);
}

/** Pull `Source: <url>` out of an article body so retrieval results can cite it. */
function sourceFromBody(body: string): string | null {
  const m = body.match(/Source:\s*(https?:\/\/\S+)/i);
  return m ? m[1] : null;
}

/**
 * Rebuild the chunk table from kb_articles + policies, then embed every chunk.
 * Returns counts so the caller (and the staff UI) can see what happened.
 */
/**
 * Một chunk mà lượt dựng này MUỐN có trong chỉ mục.
 *
 * Cùng hình dạng với đối số của `storage.createChunk`, nên nó vừa dùng để chèn
 * mới vừa dùng để ghi đè cái đang có — không có bước chuyển đổi nào ở giữa để
 * mà lệch.
 */
type DesiredChunk = Parameters<typeof storage.createChunk>[0];

export async function reindex(): Promise<{
  chunks: number;
  /** Số chunk NHÚNG LẠI lượt này — không phải tổng số vector trong chỉ mục. */
  embedded: number;
  model: string;
  embedError: string | null;
  added: number;
  changed: number;
  /** Dùng lại nguyên vector cũ. Con số này càng lớn thì lượt dựng càng rẻ. */
  kept: number;
  removed: number;
  /** Tổng số chunk đang mang vector của model hiện tại. */
  vectorCount: number;
}> {
  /**
   * Đối chiếu, KHÔNG xoá-rồi-dựng.
   *
   * Bản trước mở đầu bằng `clearChunks()`. Đo được hậu quả: rebuild mất **65
   * giây**, và trong quãng đó chỉ mục có 136 chunk nhưng **0 vector** suốt ~15
   * giây đầu, rồi đầy dần theo lô 32. Tìm kiếm từ khoá vẫn chạy nên không ai
   * thấy hỏng — nhưng tìm kiếm ngữ nghĩa tắt gần một phút sau MỖI lần sửa một
   * bài viết, kể cả khi 134 trong 136 chunk không đổi một ký tự.
   *
   * Giờ: dựng danh sách mong muốn trong bộ nhớ, so với cái đang có, rồi chỉ
   * đụng vào phần khác. Chunk không đổi giữ nguyên cả vector, nên chỉ mục
   * không bao giờ có khoảng trống — không cần bảng đệm hay bước hoán đổi.
   */
  const desired: DesiredChunk[] = [];
  const add = (c: DesiredChunk) => desired.push(c);
  const ts = nowIso();

  for (const a of storage.listKb()) {
    // Quarantined articles (Phase A hygiene) stay in the DB but out of the index.
    if (a.retrievable === 0) continue;
    const tags: string[] = JSON.parse(a.tags || "[]");
    const src = a.sourceUrl ?? sourceFromBody(a.body);
    const pieces = chunkText(a.body);
    // Most curated KB articles are written in English; the retrieval benchmark
    // showed Vietnamese queries could not reach them lexically (a guest asking
    // "xông hơi kiểu Hàn Quốc" never hit the "Korean sauna" page). A short block
    // of Vietnamese search aliases rides along in the indexed text — the same
    // trick VI_ALIASES already uses for the policy register — so the keyword leg
    // matches how guests actually ask. Aliases are for search only; no fact lives here.
    const aliases = kbAliasesFor(a.title, a.category);
    pieces.forEach((body, ordinal) => {
      add({
        kind: "kb",
        refId: a.id,
        ordinal,
        title: a.title,
        category: a.category,
        sourceUrl: src,
        // tags + Vietnamese aliases ride along so keyword hits on them still work
        body: `${a.title}\n${tags.join(", ")}${aliases ? `\n${aliases}` : ""}\n${body}`,
        tokens: tokenise(body).length,
        embedding: null,
        embedModel: null,
        quality: a.quality,
        verified: a.verified,
        contentClass: a.contentClass,
        updatedAt: ts,
      });
    });
  }

  for (const p of storage.listPolicies()) {
    const rules = JSON.parse(p.rules || "{}");
    /* facilities gets its own clean rendering (see renderFacilities' comment);
       flattenRules still handles every other key in the same policy normally. */
    const facilitiesText = renderFacilities(rules.facilities);
    const { facilities: _facilities, ...restRules } = rules;
    const flat = [facilitiesText, flattenRules(restRules)].filter(Boolean).join("\n");
    /* The alias block used to be appended once to the full pre-chunk text, so a
       policy long enough to split (e.g. CONDUCT) could land its aliases in a
       different chunk than the fact they name — "chó" (dog) never co-occurs
       with "pets: not allowed" in the same chunk, so BM25 could not match a
       guest asking about their dog even though the fact and the alias both
       exist in the document. Injected per-chunk instead, same as kbAliasesFor
       already does for KB articles below, so every chunk of a split policy
       carries its own alias line. */
    const aliasStr = VI_ALIASES_BY_CODE[p.code] ?? VI_ALIASES[p.topic];
    const vi = aliasStr ? `\nAlso asked as: ${aliasStr}` : "";
    chunkText(`${p.summary}\n${flat}`).forEach((body, ordinal) => {
      add({
        kind: "policy",
        refId: p.id,
        ordinal,
        title: `${p.title} (${p.code})`,
        category: `policy/${p.topic}`,
        sourceUrl: p.sourceUrl,
        body: `${p.title}\n${body}${vi}`,
        tokens: tokenise(body).length,
        embedding: null,
        embedModel: null,
        updatedAt: ts,
      });
    });
  }

  // The room catalogue is indexed too, so a guest question phrased as prose
  // ("phòng nào có bồn tắm?") can find the category page even when the model
  // does not reach for get_room_type_facts.
  for (const r of storage.listRoomTypes()) {
    const amenities: string[] = JSON.parse(r.amenities || "[]");
    const combos: Array<{ adults: number; children: number }> = JSON.parse(r.combinations || "[]");
    const facts = [
      `${r.nameVi} (${r.code})`,
      r.areaSqm != null ? `Diện tích ${r.areaSqm} m².` : null,
      r.bedrooms != null ? `${r.bedrooms} phòng ngủ.` : null,
      r.bed === "twin" ? "2 giường đơn." : r.bed === "double" ? "Giường đôi." : null,
      r.oceanView ? "Hướng biển." : null,
      r.privatePool ? "Có hồ bơi riêng." : null,
      r.maxGuests != null
        ? `Tối đa ${r.maxGuests} khách (${combos.map((c) => `${c.adults} người lớn + ${c.children} trẻ em`).join(" hoặc ")}).`
        : null,
      /**
       * ĐÃ THỬ bỏ `r.description` khỏi đây (2026-09-04) để giảm dilution cho
       * câu hỏi tổng hợp về phòng (BM-DIAG-056/059) — chẩn đoán ĐÚNG (mọi
       * room_type có chung một đoạn văn quảng cáo gần giống hệt nhau, cùng
       * lớp lỗi "search-alias dilution" báo cáo Phase 6.5 mô tả cho
       * rate_package), nhưng đo hồi quy đầy đủ (520 ca, so passages + outcome
       * trước/sau, tách khỏi nhiễu sinh ngẫu nhiên của model — 121/520 câu
       * trả lời đổi lời giữa hai lượt chạy dù không đổi gì, đã lọc riêng 18
       * ca có CẢ passages đổi LẪN kết quả đổi) cho kết quả 9 ca cải thiện / 9
       * ca hồi quy (BM-DIAG-078/081 đã đúng từ trước, quay về trả lời RỖNG) —
       * và chính BM-DIAG-056 vẫn KHÔNG được sửa. Đúng hiện tượng "sửa một ca
       * thì hỏng một ca khác" mà 06-RRF-REMEDIATION.md đã cảnh báo cho
       * category cap — xác nhận lần hai, qua một đòn bẩy khác (rút gọn nội
       * dung thay vì giới hạn category). ĐÃ LÙI LẠI, giữ nguyên description.
       * Hướng thử sau nên tinh vi hơn: chỉ rút câu mẫu lặp × chữ, không rút
       * cả field — hoặc tăng LOCAL_PASSAGES riêng cho câu hỏi dạng tổng hợp,
       * không đụng nội dung từng phòng.
       */
      r.description,
      `Tiện ích công bố: ${amenities.join(", ")}.`,
    ]
      .filter(Boolean)
      .join(" ");
    chunkText(facts).forEach((body, ordinal) => {
      add({
        kind: "room",
        refId: r.id,
        ordinal,
        title: `${r.nameVi} — phòng`,
        category: "room_type",
        sourceUrl: r.sourceUrl,
        body: `${r.nameVi} ${r.code}\n${body}`,
        tokens: tokenise(body).length,
        embedding: null,
        embedModel: null,
        updatedAt: ts,
      });
    });
  }

  // Dining pages join the index too, so "ăn tối ở đâu", "có món chay không" or
  // "quán nào mở lúc 22h" retrieves the real outlet page rather than being
  // answered from the model's idea of a resort restaurant.
  for (const v of listVenues()) {
    /* One line per menu group, not one flat comma-joined blob of every dish.
     * Found live: asked "Cá tầm giá bao nhiêu?" against a passage whose
     * evidence WAS correct (score/coverage/gate all fine, "Cá Tầm 460.000đ"
     * genuinely present in the text) the model still missed it — Ozone's 18
     * dishes across 3 groups had been flattened into one run-on sentence, and
     * the model's answer skimmed only the first few items. Grouped, shorter
     * lines are the same fix as the Lotus hours case: preserve structure the
     * source data already has instead of flattening it away. Venues with a
     * handful of items in one group (e.g. Jasmine's "Signature") render
     * identically to before — this only changes venues with several groups. */
    const menuLines = v.menu
      .filter((g) => g.items.length)
      .map((g) => {
        const items = g.items.map((d) => (d.price ? `${d.name_vi} ${d.price.toLocaleString("vi-VN")}đ` : d.name_vi)).join(", ");
        return g.group ? `${g.group}: ${items}` : items;
      });
    const facts = [
      `${v.row.nameVi} (${v.row.code}) — ${v.row.kind === "bar" ? "quầy bar" : "nhà hàng"}.`,
      v.hours.length ? `Giờ mở cửa: ${hoursText(v)}.` : null,
      v.row.lastOrder ? `Nhận khách cuối: ${v.row.lastOrder}.` : null,
      v.row.location ? `Vị trí: ${v.row.location}.` : null,
      v.row.phone ? `Điện thoại: ${v.row.phone}.` : null,
      v.row.capacity != null ? `Sức chứa ${v.row.capacity} khách.` : null,
      v.row.priceRange ? `Khoảng giá: ${v.row.priceRange}.` : null,
      v.cuisine.length ? `Ẩm thực: ${v.cuisine.join(", ")}.` : null,
      v.dishesServed.length ? `Nhóm món: ${v.dishesServed.join(", ")}.` : null,
      menuLines.length ? `Món tiêu biểu công bố:\n${menuLines.join("\n")}` : null,
      v.row.priceNote,
      v.row.description,
    ]
      .filter(Boolean)
      .join(" ");
    chunkText(facts).forEach((body, ordinal) => {
      add({
        kind: "dining",
        refId: v.row.id,
        ordinal,
        title: `${v.row.nameVi} — ẩm thực`,
        category: "dining_venue",
        sourceUrl: v.row.sourceUrl,
        body: `${v.row.nameVi} ${v.row.code}\n${body}`,
        tokens: tokenise(body).length,
        embedding: null,
        embedModel: null,
        updatedAt: ts,
      });
    });
  }

  /* --- đối chiếu: giữ cái không đổi, sửa cái đổi, xoá cái thừa --- */

  /**
   * Khoá định danh một chunk qua các lần dựng lại.
   *
   * `(kind, refId, ordinal)` là thứ duy nhất bền: id tự tăng thì đổi mỗi lần
   * chèn, còn tiêu đề thì người ta sửa. Sai khoá ở đây nghĩa là mọi chunk đều
   * trông như mới, và cả kho bị nhúng lại — đúng cái đang muốn tránh.
   */
  const keyOf = (c: { kind: string; refId: number; ordinal: number }) => `${c.kind}:${c.refId}:${c.ordinal}`;

  const existing = storage.listChunks();
  const byKey = new Map(existing.map((c) => [keyOf(c), c]));
  const seen = new Set<string>();
  let added = 0,
    changed = 0,
    kept = 0;

  for (const d of desired) {
    const k = keyOf(d);
    seen.add(k);
    const old = byKey.get(k);
    if (!old) {
      storage.createChunk(d);
      added++;
      continue;
    }
    /**
     * Giữ lại chỉ khi MỌI thứ đọc được đều khớp VÀ vector còn dùng được.
     *
     * `embedModel !== MODEL_EMBED` buộc nhúng lại toàn bộ khi đổi model — vector
     * của hai model khác nhau không so sánh được với nhau, và một chỉ mục trộn
     * hai loại vector sẽ xếp hạng sai mà không báo lỗi gì.
     */
    const dungDuoc =
      old.body === d.body &&
      old.title === d.title &&
      old.category === d.category &&
      (old.sourceUrl ?? null) === (d.sourceUrl ?? null) &&
      old.quality === (d.quality ?? old.quality) &&
      old.verified === (d.verified ?? old.verified) &&
      old.contentClass === (d.contentClass ?? old.contentClass) &&
      old.embedding !== null &&
      old.embedModel === MODEL_EMBED;
    if (dungDuoc) {
      kept++;
      continue;
    }
    storage.replaceChunk(old.id, d);
    changed++;
  }

  /* Bài viết bị xoá, hoặc bài dài bị rút ngắn còn ít đoạn hơn. Không dọn thì
     đoạn cũ nằm lại trong chỉ mục và vẫn được tìm thấy — một chính sách đã bỏ
     vẫn trả lời khách. */
  const thua = existing.filter((c) => !seen.has(keyOf(c))).map((c) => c.id);
  storage.deleteChunks(thua);

  const pending = storage.chunksWithoutEmbedding();
  let embedded = 0;
  let embedError: string | null = null;
  for (let i = 0; i < pending.length; i += 32) {
    const batch = pending.slice(i, i + 32);
    try {
      const vectors = await embed(batch.map((c) => asPassage(c.body, MODEL_EMBED)));
      batch.forEach((c, j) => {
        const v = vectors[j];
        if (v?.length) {
          storage.setChunkEmbedding(c.id, JSON.stringify(v), MODEL_EMBED);
          embedded++;
        }
      });
    } catch (e: any) {
      embedError = e?.message ?? String(e);
      break;
    }
  }
  /* Stamp the index with what built it, so the next process start can prove
     compatibility instead of assuming it. Only stamped when the whole corpus
     embedded cleanly: a half-finished index must not carry a certificate saying
     it is whole, and an errored run leaves the previous stamp in place so the
     mismatch is still reported. */
  /**
   * `embedded` giờ là số chunk MỚI nhúng lượt này, không phải tổng số.
   *
   * Điều kiện cũ `embedded === chunkCount` đúng khi mỗi lượt đều nhúng lại cả
   * kho. Với dựng tăng dần thì nó sai hẳn: sửa một bài, nhúng 2 chunk, so 2 với
   * 136 rồi kết luận chỉ mục chưa toàn vẹn — và không lần nào đóng dấu nữa.
   *
   * Bất biến đúng là: MỌI chunk đang có đều mang vector của model HIỆN TẠI.
   * Đếm trực tiếp thay vì suy từ số lượt nhúng.
   */
  const tatCa = storage.listChunks();
  const chunkCount = tatCa.length;
  const vectorCount = tatCa.filter((c) => c.embedding != null && c.embedModel === MODEL_EMBED).length;
  const toanVen = !embedError && chunkCount > 0 && vectorCount === chunkCount;
  if (toanVen) {
    const dim = (() => {
      const c = tatCa.find((x) => x.embedding != null);
      try {
        return c ? (JSON.parse(c.embedding!) as number[]).length : 0;
      } catch {
        return 0;
      }
    })();
    if (dim > 0) {
      storage.setIndexMeta({
        provider: EMBED_PROVIDER,
        model: MODEL_EMBED,
        dimension: dim,
        embeddingVersion: EMBEDDING_VERSION,
        chunkCount,
        vectorCount,
      });
    }
  }

  return { chunks: chunkCount, embedded, model: MODEL_EMBED, embedError, added, changed, kept, removed: thua.length, vectorCount };
}

/** Turn a nested rules object into readable "key: value" lines for the index. */
/**
 * Guests write in Vietnamese; the policy register is written in English. A short
 * Vietnamese phrase block per topic gives the keyword leg something to match and
 * pulls the embedding closer to how the question is actually asked. These are
 * search aliases only — no rule, number or fact lives here.
 */
const VI_ALIASES: Record<string, string> = {
  checkout:
    "trả phòng muộn, ra muộn, ra phòng muộn, check out muộn, quá giờ trả phòng, phụ thu trả phòng muộn, phí trả muộn, mất bao nhiêu tiền khi ra muộn, giờ trả phòng",
  checkin:
    "nhận phòng sớm, vào phòng sớm, check in sớm, đến sớm, tới sớm buổi sáng, phí nhận phòng sớm, giờ nhận phòng",
  occupancy:
    "số người tối đa trong phòng, ở được mấy người, kê thêm giường, giường phụ, trẻ em, tính tuổi trẻ em theo chiều cao, phụ thu thêm người, villa mấy phòng ngủ",
  deposit: "tiền cọc, đặt cọc khi nhận phòng, hoàn cọc, tạm giữ tiền",
  payment:
    "thanh toán, chuyển khoản, số tài khoản, thẻ tín dụng, quét mã QR, tiền mặt, hoá đơn, nội dung chuyển khoản",
  /* "chó" and "mèo" (dog/cat) were absent from this list and from the corpus
     entirely — a guest asking "mang theo chó nhỏ được không?" shares no token
     with "mang thú nuôi" (bring pets), so BM25 could not match on the animal
     itself, only on the generic verb "mang". Verified via corpus grep before
     adding: the fact ("pets: not allowed anywhere on the property") exists,
     only the guest's actual word for it was missing from the index. */
  conduct:
    "nội quy, quy định trong phòng, hút thuốc bị phạt, mang thú nuôi, mang chó, mang mèo, chó mèo, đồ ăn bên ngoài, sầu riêng, khách đến thăm, giờ đóng cửa hồ bơi, tắm biển, tiếng ồn ban đêm, về khuya, về muộn, ra vào ban đêm, khách lưu trú ra vào, mang bếp, nấu ăn trong phòng, đun nấu",
  booking:
    "loại gói, mã gói phòng, khách lẻ, khách đoàn, rời sớm, voucher, chuyển phòng, hoàn tiền, danh sách khách, đổi tên khách",
  dispute: "khiếu nại, phản hồi, tranh chấp, hotline, thời gian trả lời khiếu nại",
  privacy: "dữ liệu cá nhân, quyền riêng tư, thông tin khách, bảo mật thẻ, dữ liệu trẻ em",
};

/* Three service policies (room service, laundry, transport) share topic
   "booking" with the package/booking-code policies, so the topic-keyed aliases
   above tagged them with "mã gói phòng, đổi tên khách…" — words a guest asking
   "đặt đồ ăn lên phòng" never uses, while the words they DO use were absent.
   Measured effect: "gọi đồ ăn lên phòng" happened to match and retrieved
   ROOM_SERVICE, but "đặt đồ ăn lên phòng món gì" surfaced LAUNDRY instead.
   Keyed by CODE so the fix rides only these three and does not touch the topic
   field, which drives routing elsewhere. Preferred over the topic aliases when
   present. */
const VI_ALIASES_BY_CODE: Record<string, string> = {
  ROOM_SERVICE:
    "đặt đồ ăn lên phòng, gọi đồ ăn lên phòng, gọi món lên phòng, ăn tại phòng, phục vụ tại phòng, room service, thực đơn phòng, đồ ăn tận phòng, gọi đồ ăn, đặt món ăn, giờ phục vụ đồ ăn, ship đồ ăn lên phòng, order đồ ăn",
  LAUNDRY:
    "giặt là, giặt ủi, giặt đồ, giặt quần áo, giặt khô, là ủi, bảng giá giặt, giặt nhanh, giặt hoả tốc, giặt lấy trong ngày, giá giặt một bộ, giặt bao nhiêu tiền",
  TRANSPORT:
    "đưa đón, xe đưa đón, đón sân bay, taxi, thuê xe, di chuyển, đi lại, xe điện, cáp treo, tàu ra đảo, đón từ sân bay Cam Ranh, ra đảo bằng gì",
};

/**
 * Vietnamese search aliases for the curated (mostly English) KB articles, keyed
 * by a distinctive substring of the article title. Added because the retrieval
 * benchmark measured Vietnamese guests failing to reach English pages the
 * embedding leg was supposed to bridge but does not. Search hints only — every
 * fact still comes from the article body.
 */
const KB_ALIASES: Array<{ match: RegExp; aliases: string }> = [
  { match: /Akoya Spa|spa/i, aliases: "spa, mát xa, massage, xông hơi, liệu trình, trị liệu, chăm sóc da, giá spa, đặt lịch spa" },
  { match: /Korean sauna|Aquafield/i, aliases: "xông hơi, tắm hơi, phòng xông hơi kiểu Hàn Quốc, jjimjilbang, onsen, tắm khoáng" },
  { match: /Beach, pool and water sports/i, aliases: "hồ bơi, bể bơi, bãi biển, tắm biển, thể thao dưới nước, lặn biển, chèo thuyền, kayak, mô tô nước, bơi lội" },
  { match: /Breakfast and buffet/i, aliases: "ăn sáng, bữa sáng, buffet sáng, giá ăn sáng, suất ăn sáng, buffet" },
  { match: /Restaurants and bars — hours/i, aliases: "nhà hàng, quán bar, giờ mở cửa, giờ hoạt động, ăn uống, giờ phục vụ" },
  { match: /Payment methods and bank transfer/i, aliases: "thanh toán, chuyển khoản, số tài khoản ngân hàng, thẻ tín dụng, tiền mặt, quét mã QR, nội dung chuyển khoản" },
  { match: /Cable car and Vinpearl Harbour/i, aliases: "cáp treo, vé cáp treo, qua đảo, bến tàu, giá vé cáp treo, đi cáp treo" },
  { match: /VinWonders.*tickets|tickets and shows/i, aliases: "vé VinWonders, giá vé công viên, công viên giải trí, show diễn, biểu diễn, vé vào cổng" },
  { match: /Cam Ranh Airport/i, aliases: "sân bay Cam Ranh, đưa đón sân bay, xe đón sân bay, di chuyển về resort, đi từ sân bay, taxi sân bay" },
  { match: /golf on Hon Tre|Entertainment and golf/i, aliases: "sân golf, chơi golf, giải trí trên đảo, trò chơi, khu vui chơi" },
  { match: /Meetings and events|MICE/i, aliases: "phòng họp, hội nghị, hội thảo, sự kiện, tổ chức tiệc, phòng hội nghị, teambuilding" },
  { match: /Pearl Club member/i, aliases: "thành viên, hội viên, ưu đãi thành viên, giảm giá hội viên, tích điểm, hạng thẻ, quyền lợi" },
  { match: /Families and children/i, aliases: "trẻ em, trẻ nhỏ, gia đình có con nhỏ, phụ thu trẻ em, giường cho bé" },
  { match: /Rooms and room types/i, aliases: "loại phòng, hạng phòng, các loại phòng, kiểu phòng, phòng nghỉ" },
  /* Part 6 retrieval diagnosis: this article had zero alias coverage — the only
     KB title in KB_ALIASES with no entry at all — so a Vietnamese guest asking
     about ID requirements or a room total could not reach it lexically despite
     bge-m3 ranking it well (dense rank 1-5) on its own. */
  { match: /Check-in, check-out and identification/i, aliases: "giấy tờ, căn cước, cccd, hộ chiếu, passport, chứng minh nhân dân, nhận phòng cần giấy tờ gì, giấy tờ tùy thân" },
];

function kbAliasesFor(title: string, _category: string): string {
  const hit = KB_ALIASES.find((k) => k.match.test(title));
  return hit ? `Cũng được hỏi là: ${hit.aliases}` : "";
}

/**
 * Special-cased rendering for a `facilities: [{key,name,from,to,note}]` array
 * (currently only FACILITY_HOURS), instead of the generic flattener below.
 *
 * Found live: asked "Bãi biển riêng mở cửa mấy giờ?" (when does the beach
 * close?), the model answered with the POOL's closing time (20:00) instead
 * of the beach's own (18:30) — both numbers sit in the same chunk, four
 * lines apart, inside a flat "facilities key: X / facilities name: Y /
 * facilities from: Z / facilities to: W" dump repeated seven times running
 * generic JSON-flattening over the array. A small model loses track of which
 * key/from/to triple belongs to which facility across that much repeated
 * structure — the same failure class Lotus's multi-slot schedule hit,
 * addressed the same way: put the fact and its own name on one line instead
 * of splitting them across a generic template.
 */
function renderFacilities(facilities: unknown): string | null {
  if (!Array.isArray(facilities)) return null;
  const lines = facilities
    .map((f: any) => {
      if (!f || typeof f !== "object" || !f.name || !f.from || !f.to) return null;
      const note = f.note ? ` (${f.note})` : "";
      return `${f.name}: ${f.from}–${f.to}${note}`;
    })
    .filter((l): l is string => l !== null);
  return lines.length ? lines.join("\n") : null;
}

function flattenRules(obj: unknown, prefix = ""): string {
  if (obj === null || obj === undefined) return "";
  if (Array.isArray(obj)) return obj.map((v) => flattenRules(v, prefix)).join("\n");
  if (typeof obj === "object") {
    return Object.entries(obj as Record<string, unknown>)
      .map(([k, v]) => flattenRules(v, prefix ? `${prefix} ${k.replace(/_/g, " ")}` : k.replace(/_/g, " ")))
      .join("\n");
  }
  return `${prefix}: ${String(obj)}`;
}

/* ------------------------------------------------------------------ *
 * Ranking
 * ------------------------------------------------------------------ */

type Scored = { chunk: DocChunk; score: number };

/**
 * Extra weight for a query term found in a document's TITLE.
 *
 * Plain BM25 scores one flat bag of words, so "Nhà hàng Lotus phục vụ món gì?"
 * was answered with the Bách Giai page: the generic terms (nhà hàng, món) it
 * matched repeatedly outweighed the one term that actually identified the
 * subject. A title is the document's own statement of what it is about, so a
 * match there is stronger evidence than the same match in prose — the standard
 * fielded-BM25 idea, kept to a single extra field rather than a full BM25F.
 *
 * Deliberately modest: this reorders near-ties, it does not let a title match
 * beat a genuinely more relevant body.
 *
 * Only DISCRIMINATIVE terms are boosted. Rewarding every title match made things
 * worse, not better: "Nhà hàng Bách Giai (món Trung Hoa)" collects a bonus for
 * "nhà", "hàng" and "món" on any restaurant question, so it beat the Lotus page
 * even when the guest named Lotus. A title match only means something when the
 * term distinguishes documents — which is exactly what IDF measures — so the
 * bonus applies above an IDF floor and common words earn nothing.
 */
const TITLE_BOOST = Number(process.env.BM25_TITLE_BOOST ?? 0.6);

/** IDF a term must clear before a title match counts. Roughly: the term appears
 *  in under a fifth of the corpus, so it says something about this document. */
const TITLE_IDF_FLOOR = Number(process.env.BM25_TITLE_IDF_FLOOR ?? 1.6);

/** Contiguous 2-token phrases, in order — order is exactly what a per-term
 *  Set throws away, and a compound Vietnamese term ("cáp treo") is only
 *  recognisable as a unit if adjacency is preserved. */
function bigrams(tokens: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 1 < tokens.length; i++) out.add(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}

/**
 * Flat bonus when a query BIGRAM matches a title bigram exactly, independent
 * of either token's own IDF. Live-found bug: "cáp treo" — one of exactly two
 * words in the dedicated article's own title — still lost to room-package
 * chunks that merely list "cáp treo" among many other perks, because
 * TITLE_BOOST scores "cáp" and "treo" as two independent unigrams, and
 * "treo" alone is too common (df 25/136) to clear TITLE_IDF_FLOOR — so the
 * multi-word subject name.title match was worth less than its two halves
 * suggest. A bigram match is rare enough by construction (few titles share a
 * two-word run with an arbitrary query) that it does not need an IDF gate
 * the way single words do.
 */
const PHRASE_BOOST = Number(process.env.BM25_PHRASE_BOOST ?? 1.2);

function bm25(query: string, chunks: DocChunk[]): Scored[] {
  const qTerms = tokenise(query);
  if (!qTerms.length) return [];
  const docs = chunks.map((c) => tokenise(c.body));
  const titleTokens = chunks.map((c) => tokenise(c.title ?? ""));
  const titles = titleTokens.map((t) => new Set(t));
  const titleBigramSets = titleTokens.map((t) => bigrams(t));
  const qBigrams = bigrams(qTerms);
  const N = docs.length || 1;
  const avgdl = docs.reduce((n, d) => n + d.length, 0) / N || 1;
  const df = new Map<string, number>();
  for (const term of new Set(qTerms)) {
    df.set(term, docs.filter((d) => d.includes(term)).length);
  }
  const k1 = 1.5;
  const b = 0.75;
  return chunks
    .map((chunk, i) => {
      const d = docs[i];
      const title = titles[i];
      let score = 0;
      for (const term of qTerms) {
        const n = df.get(term) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        const f = d.filter((t) => t === term).length;
        if (f) score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avgdl)));
        /* Scaled by the term's own IDF, and only for terms rare enough to
           identify a subject — naming "Lotus" counts, saying "nhà hàng" does not. */
        if (title.has(term) && idf >= TITLE_IDF_FLOOR) score += TITLE_BOOST * idf;
      }
      for (const bg of qBigrams) {
        if (titleBigramSets[i].has(bg)) score += PHRASE_BOOST;
      }
      return { chunk, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b2) => b2.score - a.score);
}

function cosine(a: number[], b: number[]) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const queryCache = new Map<string, number[]>();

/**
 * The embedding already computed for a query this turn, if any.
 *
 * Retrieval embeds every query it serves. The intent net needs exactly the
 * same vector — `asQuery()` is a no-op for bge-m3, so there is nothing to
 * recompute — and reading it back here is what makes that safety layer cost
 * a cosine (0.04ms) instead of a second embedding call (116ms).
 *
 * Returns undefined when the query was never embedded (an escalating route
 * that returned before retrieval, or a HyDE run keyed differently); the
 * caller must treat that as "no opinion", never as "no risk".
 */
export function cachedQueryVector(query: string): number[] | undefined {
  return queryCache.get(query);
}

async function vectorRank(
  query: string,
  chunks: DocChunk[],
  opts: { useHyde?: boolean } = {},
): Promise<Scored[]> {
  const withVec = chunks.filter((c) => c.embedding);
  if (!withVec.length) return [];
  /* HyDE changes the vector, so it must not share a cache entry with the plain
     query — otherwise an A/B run reads back whichever variant ran first. */
  const useHyde = opts.useHyde ?? (hydeEnabled() && shouldUseHyde(query));
  const cacheKey = useHyde ? `hyde:${query}` : query;
  let qv = queryCache.get(cacheKey);
  if (!qv) {
    const [v] = await embed([asQuery(query, MODEL_EMBED)]);
    if (!v?.length) return [];
    qv = v;
    if (useHyde) {
      /* The hypothesis only ever contributes a direction in vector space; its
         text is discarded here and never reaches the guest or the generator. */
      const hypo = await hypotheticalDocument(query);
      if (hypo) {
        const [hv] = await embed([asPassage(hypo, MODEL_EMBED)]);
        if (hv?.length) qv = fuseVectors(qv, hv);
      }
    }
    if (queryCache.size > 200) queryCache.clear();
    queryCache.set(cacheKey, qv);
  }

  // Dimension Guard: Check dimension consistency between DB vector and query vector
  for (const chunk of withVec) {
    if (chunk.embedding) {
      const dbVec: number[] = JSON.parse(chunk.embedding);
      if (dbVec.length !== qv.length) {
        throw new Error(
          `Embedding dimension mismatch: DB has ${dbVec.length} dimensions (${chunk.embedModel}), but provider returned ${qv.length} dimensions (${MODEL_EMBED}). Please run reindex.ts.`,
        );
      }
    }
  }


  return withVec
    .map((chunk) => ({ chunk, score: cosine(qv!, JSON.parse(chunk.embedding!) as number[]) }))
    .filter((x) => x.score > 0.15)
    .sort((a, b) => b.score - a.score);
}

export type Retrieved = {
  title: string;
  category: string;
  source_url: string | null;
  content: string;
  relevance: number;
  matched_by: string;
  /**
   * Fraction of the query's content words that actually appear in this passage,
   * 0..1 — a direct measure of "did this match", independent of ranking.
   *
   * `relevance` cannot serve that purpose. It is the reciprocal-rank-fusion
   * score, which is 1/(60+rank) summed over the legs that fired, so with a
   * single leg the top three results score 0.0164, 0.0161 and 0.0159 for EVERY
   * query ever asked. The offline gate was thresholding those constants at
   * 0.012 and therefore passing everything with at least one result: "Tôi mang
   * theo chó nhỏ được không?" sailed through to the model on a lodging-
   * declaration notice and a Chinese-restaurant page.
   *
   * Coverage is deliberately dumb — no model, no index, no configuration — and
   * it is a floor, not a ranking signal: ordering is left entirely to fusion.
   * It cannot see synonyms, so a passage can be right and score low; that costs
   * an escalation. It cannot tokenise Korean, Chinese or Japanese, so it reports
   * -1 (unknown) there rather than a wrong number the gate would act on.
   */
  coverage: number;
  /** Phase A provenance so the generator knows how far to trust a passage. */
  quality: string;
  verified: string;
  content_class: string;
};

/**
 * Query-term coverage of a passage. Returns -1 when the query is written in a
 * script this cannot tokenise, so callers can tell "no overlap" apart from "no
 * opinion".
 */
export function termCoverage(query: string, passage: string): number {
  if (/[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(query)) return -1;

  /* Diacritics are stripped ONLY when the query has none to begin with.
     Vietnamese is a tonal language written with them, and folding both sides
     collapses distinct words onto each other: "chó" (dog) becomes "cho" (for),
     which occurs in almost every passage in the corpus. That is not a detail —
     it is what let "Tôi mang theo chó nhỏ được không?" score 0.67 against a
     Chinese-restaurant page. Guests who type without diacritics still get the
     lenient comparison, because for them precision is not on offer anyway. */
  const bare = !/[àáảãạăâằắẳẵặầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i.test(query);
  const fold = (s: string) => {
    const lower = s.toLowerCase();
    return bare ? lower.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d") : lower;
  };
  /* Function words carry no evidence — a passage sharing only "của" and "là"
     with the question has matched nothing. */
  const STOP = new Set([
    // vi — both spellings, since folding is conditional
    "của", "cua", "là", "la", "có", "co", "không", "khong", "được", "duoc", "tôi", "toi",
    "mình", "minh", "bạn", "ban", "cho", "và", "va", "với", "voi", "tại", "tai", "thì", "thi",
    "nào", "nao", "gì", "gi", "mấy", "may", "bao", "nhiêu", "nhieu", "vậy", "vay", "đến", "den",
    "từ", "tu", "ra", "vào", "vao", "một", "mot", "ạ", "a", "ở", "o", "các", "cac", "này", "nay",
    // en
    "the", "an", "of", "is", "are", "do", "does", "can", "my", "to", "in", "at", "on", "for",
    "what", "when", "how", "and", "or", "it", "you", "your", "me", "there", "any",
  ]);
  const tokens = (s: string) => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const terms = [...new Set(tokens(query).filter((t) => t.length > 1 && !STOP.has(t)))];
  if (!terms.length) return -1;
  /* Whole-token membership, not substring: "cho" must not match inside "chó"
     or "cho phép". Vietnamese is written one syllable per token, so a token set
     is the natural unit on both sides. */
  const body = new Set(tokens(passage));
  return terms.filter((t) => body.has(t)).length / terms.length;
}

export type RetrievalResult = {
  results: Retrieved[];
  strategy: string;
  note?: string;
};

/**
 * Hybrid search. `topic` optionally restricts to policy chunks of one topic.
 */
export async function hybridSearch(
  query: string,
  opts: { k?: number; kind?: "kb" | "policy" | "all"; useRerank?: boolean } = {},
): Promise<RetrievalResult> {
  const k = opts.k ?? 4;
  const kind = opts.kind ?? "all";
  let chunks = storage.listChunks();
  if (kind !== "all") chunks = chunks.filter((c) => c.kind === kind);
  if (!chunks.length)
    return { results: [], strategy: "empty-index", note: "The retrieval index is empty." };

  const lex = bm25(query, chunks);
  let vec: Scored[] = [];
  let strategy = "bm25+embedding-rrf";
  if (rrfVecWeight() <= 0) {
    // The vector leg is disabled by configuration (it failed the benchmark on
    // this corpus). Skip the embedding call entirely so no latency is spent on a
    // leg that would be multiplied by zero anyway.
    strategy = "bm25-only (vector leg disabled)";
  } else {
    try {
      vec = await vectorRank(query, chunks);
    } catch (err: any) {
      if (err?.message?.includes("Embedding dimension mismatch")) {
        throw err;
      }
      strategy = "bm25-only (embedding unavailable)";
    }
    if (!vec.length && strategy.startsWith("bm25+")) strategy = "bm25-only (no vectors indexed)";
  }

  // Weighted Reciprocal Rank Fusion (see RRF_*_WEIGHT for why the legs are not equal).
  //
  // Live-found bug: a generic query ("tôi muốn hỏi về dịch vụ cáp treo") that
  // names its real topic ("cáp treo") alongside filler words ("dịch vụ", "tôi
  // muốn hỏi về") let dozens of loosely-related chunks (room packages that
  // merely list "cáp treo" as one of several bundled perks) crowd the on-topic
  // article out of a top-20 cutoff, even though the on-topic article scores
  // higher head-to-head on BM25. retrievalRanking() (the eval/bench harness)
  // already uses a top-50 cutoff for exactly this reason; hybridSearch() — the
  // live path — did not. Traced directly: at top-20 the real cable-car article
  // ranked 22nd (never reaches the model); at top-50 it ranks 8th. Matching the
  // harness's depth here is the same fix, applied where guests actually feel
  // it. Verified against bench/retrieval-golden.json before shipping (see
  // bench/baselines/kiosk-validation/13-RRF-DEPTH-FIX.md).
  const RRF_CANDIDATE_DEPTH = Number(process.env.RRF_CANDIDATE_DEPTH || 50);
  const fused = new Map<number, { chunk: DocChunk; score: number; by: string[] }>();
  const lexW = rrfLexWeight();
  const vecW = rrfVecWeight();
  lex.slice(0, RRF_CANDIDATE_DEPTH).forEach((s, rank) => {
    const cur = fused.get(s.chunk.id) ?? { chunk: s.chunk, score: 0, by: [] };
    cur.score += lexW / (RRF_K + rank + 1);
    cur.by.push("keyword");
    fused.set(s.chunk.id, cur);
  });
  vec.slice(0, RRF_CANDIDATE_DEPTH).forEach((s, rank) => {
    const cur = fused.get(s.chunk.id) ?? { chunk: s.chunk, score: 0, by: [] };
    cur.score += vecW / (RRF_K + rank + 1);
    cur.by.push("semantic");
    fused.set(s.chunk.id, cur);
  });

  const ranked = [...fused.values()].sort((a, b) => b.score - a.score);

  /* Part 6.5 experiment: an optional cap on how many chunks from the same
   * `category` (policy/<topic>, room_type, rate_package, dining_venue, …)
   * survive into the final picked set, on top of the existing per-document
   * cap below. Off by default (Infinity) — measured in
   * bench/rrf-remediation.ts against the golden set and the 63-case
   * regression before being turned on for any deployment. See
   * bench/baselines/kiosk-validation/06-RRF-REMEDIATION.md for why this
   * exists: with it off, ten near-duplicate rate_package chunks can occupy
   * most of a 5-slot pick even when none of them answer the question. */
  /* `Number(process.env.X ?? Infinity)` không đủ an toàn: một biến đặt RỖNG
     (`RRF_CATEGORY_CAP=` trong .env) không phải nullish nên `??` bỏ qua, và
     `Number("")` = 0 — khiến `if (catN >= 0) continue` chặn MỌI đoạn, retrieval
     trả về rỗng, mọi câu bị đẩy cho nhân viên. Đã mắc lỗi này khi đo. Chỉ nhận
     một số hữu hạn dương; còn lại rơi về Infinity (không giới hạn). */
  const capRaw = Number(process.env.RRF_CATEGORY_CAP);
  const categoryCap = Number.isFinite(capRaw) && capRaw >= 1 ? capRaw : Infinity;

  // Deduplicate: at most two chunks per source document.
  const perDoc = new Map<string, number>();
  const perCategory = new Map<string, number>();
  const picked: typeof ranked = [];
  /**
   * Near-duplicate suppression.
   *
   * The per-document cap above stops one document flooding the list, but the
   * rate-package chunks are one document PER ROOM, so they pass it while
   * carrying almost the same text. Measured on "what's the golf discount for
   * pearl club members": the correct passage ("Pearl Club member benefits",
   * *33% off golf*) ranked FIRST, and three package chunks ranked 2, 3 and 5,
   * each repeating the package perk line *golf 20%*. The model answered 20%.
   * It went with frequency, not with rank — three votes against one.
   *
   * Two of those three said the same thing at a Jaccard of 0.96. Dropping a
   * passage that is nearly a copy of one already picked costs no information,
   * frees a slot for something genuinely different, and shortens the prompt.
   *
   * The threshold is deliberately high. Measured on the same corpus, two
   * package chunks for DIFFERENT rooms sit at 0.75-0.77 — those are not
   * duplicates, and a guest comparing two rooms needs both. 0.90 separates
   * "the same passage twice" from "two similar passages about different
   * things", with margin on each side.
   */
  const DUP_JACCARD = Number(process.env.LOCAL_DUP_JACCARD ?? 0.9);
  const pickedTokens: Set<string>[] = [];
  const jaccard = (a: Set<string>, b: Set<string>) => {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    return inter / (a.size + b.size - inter);
  };

  /**
   * Gom một nhóm SÂU HƠN k để reranker có cái xếp lại.
   *
   * Đo trên bộ golden: tài liệu đúng nằm trong top-10 tới 90% số ca, nhưng chỉ
   * đứng #1 ở 56% — tức 1/3 số câu, đáp án CÓ trong nhóm ứng viên mà bị đội
   * phòng đẩy xuống hạng 2-10. Cắt ngay còn k=5 rồi mới nghĩ tới rerank thì
   * reranker không bao giờ thấy hạng 6-10. Nên gom `rerankDepth` (mặc định
   * ~12) ứng viên đã lọc trùng, xếp lại bằng cross-encoder LLM, rồi mới lấy k.
   *
   * Khi rerank tắt, `poolSize === k` và vòng này hành xử y như cũ — thay đổi
   * này không đụng gì tới đường không-rerank.
   */
  const wantRerank = opts.useRerank ?? rerankEnabled();
  const poolSize = wantRerank ? Math.max(k, rerankDepth()) : k;

  for (const r of ranked) {
    const key = `${r.chunk.kind}:${r.chunk.refId}`;
    const n = perDoc.get(key) ?? 0;
    if (n >= 2) continue;
    const catN = perCategory.get(r.chunk.category) ?? 0;
    if (catN >= categoryCap) continue;
    const toks = new Set(tokenise(r.chunk.body));
    if (pickedTokens.some((p) => jaccard(toks, p) >= DUP_JACCARD)) continue;
    perDoc.set(key, n + 1);
    perCategory.set(r.chunk.category, catN + 1);
    pickedTokens.push(toks);
    picked.push(r);
    if (picked.length >= poolSize) break;
  }

  /**
   * Xếp lại bằng reranker, rồi cắt còn k.
   *
   * Cross-encoder đọc câu hỏi VÀ từng đoạn CÙNG LÚC, nên nó thấy được điều mà
   * chấm điểm độc lập từng đoạn không thấy: một trang "Gói giá phòng" liệt kê
   * "cáp treo" như một tiện ích kèm theo KHÔNG phải câu trả lời cho câu hỏi về
   * cáp treo. An toàn theo thiết kế: nó chỉ SẮP XẾP LẠI các đoạn retrieval đã
   * tìm — không thêm, không sửa, không bịa. Model lỗi thì giữ nguyên thứ tự cũ.
   */
  if (wantRerank && picked.length > 1) {
    const candidates = picked.map((r, i) => ({ id: i, title: r.chunk.title, text: r.chunk.body }));
    try {
      const scores = await getRerankScores(query, candidates);
      if (scores) {
        const reordered = applyRerank(
          picked.map((_, i) => ({ id: i })),
          scores,
        ).map((x) => picked[x.id]);
        picked.length = 0;
        picked.push(...reordered);
      }
    } catch {
      /* Giữ thứ tự first-stage — reranker chỉ là lớp cải thiện, không phải
         điểm hỏng chí mạng. */
    }
  }
  picked.length = Math.min(picked.length, k);

  if (!picked.length)
    return {
      results: [],
      strategy,
      note: "Nothing in the knowledge base or policy register matches. Do not invent an answer — say you will confirm, or escalate.",
    };

  const results: Retrieved[] = picked.map((r) => ({
    title: r.chunk.title,
    category: r.chunk.category,
    source_url: r.chunk.sourceUrl,
    content: r.chunk.body,
    relevance: Math.round(r.score * 10000) / 10000,
    coverage: Math.round(termCoverage(query, `${r.chunk.title} ${r.chunk.body}`) * 100) / 100,
    matched_by: [...new Set(r.by)].join("+"),
    quality: r.chunk.quality,
    verified: r.chunk.verified,
    content_class: r.chunk.contentClass,
  }));

  /* If the only support is an unverified placeholder, the honest answer is a
     deferral to staff — never a guess. Tell the generator so explicitly. */
  const note = results.every((r) => r.quality === "placeholder")
    ? "Only unverified placeholder entries matched. Do NOT state any specific fact. Tell the guest this information is not yet confirmed and offer to check with the front desk."
    : results.some((r) => r.verified !== "verified")
      ? "Some passages are not yet source-verified. State facts only from the retrieved text; if a figure or detail is missing, say you will confirm rather than inventing it."
      : undefined;

  return { results, strategy, note };
}

export function indexStats() {
  const chunks = storage.listChunks();
  return {
    chunks: chunks.length,
    embedded: chunks.filter((c) => c.embedding).length,
    kb_chunks: chunks.filter((c) => c.kind === "kb").length,
    policy_chunks: chunks.filter((c) => c.kind === "policy").length,
    model: MODEL_EMBED,
  };
}

/* ------------------------------------------------------------------ *
 * Evaluation surface
 *
 * hybridSearch() answers the agent: it fuses, dedupes and caps at k, which is
 * right for a tool call but wrong for measuring retrieval quality — you cannot
 * compute recall@10 from a list already truncated to 4. These exports give an
 * IR harness the two legs (lexical BM25, and the fused hybrid) as full
 * document-level rankings, plus a stable document index to label a golden set
 * against. They read the same rankers the agent uses, so the numbers describe
 * the real system, not a copy of it.
 * ------------------------------------------------------------------ */

/** A stable identity for one source document, independent of DB row ids inside a
 *  chunk. Every chunk of the same article/policy/room/venue shares it. */
export function chunkDocKey(kind: string, refId: number): string {
  return `${kind}/${refId}`;
}

export type RankedDoc = { docKey: string; kind: string; refId: number; score: number; by: string[] };

/** Collapse a chunk-level ranking to a document-level one: a document takes the
 *  score of its best-ranked chunk, and the order of first appearance. */
function collapseToDocs(scored: Scored[]): RankedDoc[] {
  const best = new Map<string, RankedDoc>();
  for (const s of scored) {
    const key = chunkDocKey(s.chunk.kind, s.chunk.refId);
    const prev = best.get(key);
    if (!prev || s.score > prev.score) {
      best.set(key, { docKey: key, kind: s.chunk.kind, refId: s.chunk.refId, score: s.score, by: prev?.by ?? [] });
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

export type RetrievalRanking = {
  lexical: RankedDoc[];
  /** The embedding leg alone. Empty when the endpoint is down. Exposed so the
   *  benchmark can tell "the vectors are bad" from "the fusion is bad". */
  vector: RankedDoc[];
  hybrid: RankedDoc[];
  vectorAvailable: boolean;
  note?: string;
};

/**
 * Rank the corpus for one query and return document-level orderings for both the
 * lexical leg alone and the fused hybrid. When the embedding endpoint is down the
 * vector leg is empty and hybrid equals lexical, which is exactly the degraded
 * behaviour the agent falls back to — the eval then measures that honestly.
 */
export async function retrievalRanking(
  query: string,
  opts: {
    kind?: "kb" | "policy" | "all";
    lexWeight?: number;
    vecWeight?: number;
    useHyde?: boolean;
    useRerank?: boolean;
    /** Test-only: rank over this chunk set instead of storage.listChunks(), so
     *  a corpus-variant experiment (dedup, ablation) can be measured without
     *  writing to the database. Never set in production code. */
    chunksOverride?: DocChunk[];
  } = {},
): Promise<RetrievalRanking> {
  const lexWeight = opts.lexWeight ?? rrfLexWeight();
  const vecWeight = opts.vecWeight ?? rrfVecWeight();
  const kind = opts.kind ?? "all";
  let chunks = opts.chunksOverride ?? storage.listChunks();
  if (kind !== "all") chunks = chunks.filter((c) => c.kind === kind);
  if (!chunks.length) return { lexical: [], vector: [], hybrid: [], vectorAvailable: false, note: "empty-index" };

  const lex = bm25(query, chunks);
  let vec: Scored[] = [];
  let vectorAvailable = true;
  /* Skip the embedding call entirely at zero weight, exactly as hybridSearch
     does. Without this the leg still ran and still hit the dimension guard, so
     asking for a lexical-only ranking crashed whenever the stored index and the
     configured model disagreed — the one situation where lexical-only is
     precisely what you want to measure. */
  if (vecWeight <= 0) {
    vectorAvailable = false;
  } else {
    try {
      vec = await vectorRank(query, chunks, { useHyde: opts.useHyde });
    } catch (err: any) {
      if (err?.message?.includes("Embedding dimension mismatch")) throw err;
      vectorAvailable = false;
    }
    if (!vec.length) vectorAvailable = false;
  }

  // Reciprocal Rank Fusion, identical to hybridSearch but kept at chunk depth so
  // the document collapse below sees the full ranking.
  const fused = new Map<number, { chunk: DocChunk; score: number }>();
  lex.slice(0, 50).forEach((s, rank) => {
    const cur = fused.get(s.chunk.id) ?? { chunk: s.chunk, score: 0 };
    cur.score += lexWeight / (RRF_K + rank + 1);
    fused.set(s.chunk.id, cur);
  });
  vec.slice(0, 50).forEach((s, rank) => {
    const cur = fused.get(s.chunk.id) ?? { chunk: s.chunk, score: 0 };
    cur.score += vecWeight / (RRF_K + rank + 1);
    fused.set(s.chunk.id, cur);
  });
  const fusedScored: Scored[] = [...fused.values()];

  let hybrid = collapseToDocs(fusedScored);

  /* Second stage. Only the head of the list is rescored: reranking a long tail
     the guest will never see spends tokens for nothing, and the tail keeps its
     first-stage order underneath. */
  if (opts.useRerank ?? rerankEnabled()) {
    const depth = rerankDepth();
    const head = hybrid.slice(0, depth);
    const byKey = new Map(head.map((d, i) => [i, d]));
    const chunkFor = (docKey: string) => chunks.find((c) => chunkDocKey(c.kind, c.refId) === docKey);
    const candidates = head.map((d, i) => {
      const c = chunkFor(d.docKey);
      return { id: i, title: c?.title ?? d.docKey, text: c?.body ?? "" };
    });
    const scores = await getRerankScores(query, candidates);
    if (scores) {
      const reordered = applyRerank(
        head.map((_, i) => ({ id: i })),
        scores,
      ).map((x) => byKey.get(x.id)!);
      hybrid = [...reordered, ...hybrid.slice(depth)];
    }
  }

  return {
    lexical: collapseToDocs(lex),
    vector: collapseToDocs(vec),
    hybrid,
    vectorAvailable,
  };
}

export type CorpusDoc = {
  docKey: string;
  kind: string;
  refId: number;
  title: string;
  category: string;
  /** Policy topic (checkout, occupancy…) for policy docs, else null. */
  topic: string | null;
  /** Room-type or dining-venue code for those docs, else null. */
  code: string | null;
};

/**
 * The set of source documents in the index, each with a stable key and the
 * natural attributes a golden set labels against (a policy topic, a room/venue
 * code, a title). Built by de-duplicating chunks to their parent document.
 */
export function corpusDocs(): CorpusDoc[] {
  const roomCodeById = new Map(storage.listRoomTypes().map((r) => [r.id, r.code]));
  const venueCodeById = new Map(listVenues().map((v) => [v.row.id, v.row.code]));

  const byDoc = new Map<string, CorpusDoc>();
  for (const c of storage.listChunks()) {
    const docKey = chunkDocKey(c.kind, c.refId);
    if (byDoc.has(docKey)) continue;
    const topic = c.kind === "policy" ? c.category.replace(/^policy\//, "") : null;
    const code =
      c.kind === "room" ? roomCodeById.get(c.refId) ?? null : c.kind === "dining" ? venueCodeById.get(c.refId) ?? null : null;
    byDoc.set(docKey, { docKey, kind: c.kind, refId: c.refId, title: c.title, category: c.category, topic, code });
  }
  return [...byDoc.values()];
}
