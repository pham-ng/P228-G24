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
import { embed, MODEL_EMBED } from "./openai";
import type { DocChunk } from "@shared/schema";

const CHUNK_CHARS = 900;
const CHUNK_OVERLAP = 150;
const RRF_K = 60;

/* ------------------------------------------------------------------ *
 * Tokenising
 * ------------------------------------------------------------------ */

/** Fold diacritics so "muộn" and "muon" tokenise identically. */
export function fold(s: string) {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

const STOP = new Set(
  ("the a an and or of to for in on at is are be was were i you we they it this that with from " +
    "la va cua cho trong tai thi khi nao co the duoc mot nhung nay do voi tu den ve se da " +
    "what how when where which why do does can could would should my our your")
    .split(" "),
);

function tokenise(s: string): string[] {
  return fold(s)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
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
export async function reindex(): Promise<{
  chunks: number;
  embedded: number;
  model: string;
  embedError: string | null;
}> {
  storage.clearChunks();
  const ts = nowIso();

  for (const a of storage.listKb()) {
    const tags: string[] = JSON.parse(a.tags || "[]");
    const src = sourceFromBody(a.body);
    const pieces = chunkText(a.body);
    pieces.forEach((body, ordinal) => {
      storage.createChunk({
        kind: "kb",
        refId: a.id,
        ordinal,
        title: a.title,
        category: a.category,
        sourceUrl: src,
        // tags ride along in the indexed text so keyword hits on them still work
        body: `${a.title}\n${tags.join(", ")}\n${body}`,
        tokens: tokenise(body).length,
        embedding: null,
        embedModel: null,
        updatedAt: ts,
      });
    });
  }

  for (const p of storage.listPolicies()) {
    const flat = flattenRules(JSON.parse(p.rules || "{}"));
    const vi = VI_ALIASES[p.topic] ? `\nAlso asked as: ${VI_ALIASES[p.topic]}` : "";
    const text = `${p.summary}\n${flat}${vi}`;
    chunkText(text).forEach((body, ordinal) => {
      storage.createChunk({
        kind: "policy",
        refId: p.id,
        ordinal,
        title: `${p.title} (${p.code})`,
        category: `policy/${p.topic}`,
        sourceUrl: p.sourceUrl,
        body: `${p.title}\n${body}`,
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
      r.description,
      `Tiện ích công bố: ${amenities.join(", ")}.`,
    ]
      .filter(Boolean)
      .join(" ");
    chunkText(facts).forEach((body, ordinal) => {
      storage.createChunk({
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

  const pending = storage.chunksWithoutEmbedding();
  let embedded = 0;
  let embedError: string | null = null;
  for (let i = 0; i < pending.length; i += 32) {
    const batch = pending.slice(i, i + 32);
    try {
      const vectors = await embed(batch.map((c) => c.body));
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
  return { chunks: storage.listChunks().length, embedded, model: MODEL_EMBED, embedError };
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
  conduct:
    "nội quy, quy định trong phòng, hút thuốc bị phạt, mang thú nuôi, đồ ăn bên ngoài, sầu riêng, khách đến thăm, giờ đóng cửa hồ bơi, tắm biển, tiếng ồn ban đêm",
  booking:
    "loại gói, mã gói phòng, khách lẻ, khách đoàn, rời sớm, voucher, chuyển phòng, hoàn tiền, danh sách khách, đổi tên khách",
  dispute: "khiếu nại, phản hồi, tranh chấp, hotline, thời gian trả lời khiếu nại",
  privacy: "dữ liệu cá nhân, quyền riêng tư, thông tin khách, bảo mật thẻ, dữ liệu trẻ em",
};

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

function bm25(query: string, chunks: DocChunk[]): Scored[] {
  const qTerms = tokenise(query);
  if (!qTerms.length) return [];
  const docs = chunks.map((c) => tokenise(c.body));
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
      let score = 0;
      for (const term of qTerms) {
        const f = d.filter((t) => t === term).length;
        if (!f) continue;
        const n = df.get(term) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avgdl)));
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

async function vectorRank(query: string, chunks: DocChunk[]): Promise<Scored[]> {
  const withVec = chunks.filter((c) => c.embedding);
  if (!withVec.length) return [];
  let qv = queryCache.get(query);
  if (!qv) {
    const [v] = await embed([query]);
    if (!v?.length) return [];
    qv = v;
    if (queryCache.size > 200) queryCache.clear();
    queryCache.set(query, qv);
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
};

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
  opts: { k?: number; kind?: "kb" | "policy" | "all" } = {},
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
  try {
    vec = await vectorRank(query, chunks);
  } catch {
    strategy = "bm25-only (embedding unavailable)";
  }
  if (!vec.length && strategy.startsWith("bm25+")) strategy = "bm25-only (no vectors indexed)";

  // Reciprocal Rank Fusion
  const fused = new Map<number, { chunk: DocChunk; score: number; by: string[] }>();
  lex.slice(0, 20).forEach((s, rank) => {
    const cur = fused.get(s.chunk.id) ?? { chunk: s.chunk, score: 0, by: [] };
    cur.score += 1 / (RRF_K + rank + 1);
    cur.by.push("keyword");
    fused.set(s.chunk.id, cur);
  });
  vec.slice(0, 20).forEach((s, rank) => {
    const cur = fused.get(s.chunk.id) ?? { chunk: s.chunk, score: 0, by: [] };
    cur.score += 1 / (RRF_K + rank + 1);
    cur.by.push("semantic");
    fused.set(s.chunk.id, cur);
  });

  const ranked = [...fused.values()].sort((a, b) => b.score - a.score);

  // Deduplicate: at most two chunks per source document.
  const perDoc = new Map<string, number>();
  const picked: typeof ranked = [];
  for (const r of ranked) {
    const key = `${r.chunk.kind}:${r.chunk.refId}`;
    const n = perDoc.get(key) ?? 0;
    if (n >= 2) continue;
    perDoc.set(key, n + 1);
    picked.push(r);
    if (picked.length >= k) break;
  }

  if (!picked.length)
    return {
      results: [],
      strategy,
      note: "Nothing in the knowledge base or policy register matches. Do not invent an answer — say you will confirm, or escalate.",
    };

  return {
    results: picked.map((r) => ({
      title: r.chunk.title,
      category: r.chunk.category,
      source_url: r.chunk.sourceUrl,
      content: r.chunk.body,
      relevance: Math.round(r.score * 10000) / 10000,
      matched_by: [...new Set(r.by)].join("+"),
    })),
    strategy,
  };
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
