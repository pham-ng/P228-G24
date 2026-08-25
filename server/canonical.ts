/**
 * Canonical knowledge model (Phase A, §7).
 *
 * A canonical fact is the single source of truth for one entity (wifi, breakfast,
 * late_checkout…). Each language is a *rendering* of that one fact, never a place
 * to store a different value — so VI/EN/ZH/JA/KO can never contradict each other.
 *
 * Right now this file carries only the HIGH-PRIORITY GAP placeholders: entities a
 * real guest asks about that the corpus could not answer. Rather than invent an
 * answer, each placeholder states plainly that no verified information exists yet
 * and defers to staff — which is exactly the grounding rule the concierge must
 * follow. A human promotes a placeholder to a real fact by filling `attributes`,
 * adding a `source`, and setting `verified: "verified"`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { storage, nowIso } from "./storage";
import type { KbArticle } from "@shared/schema";

export type LangText = { title: string; body: string } | null;

export type VerificationStatus =
  | "VERIFIED"
  | "UNVERIFIED"
  | "REQUIRES_HUMAN_CONFIRMATION"
  | "OUTDATED"
  | "CONFLICTING";

export type CanonicalFact = {
  fact_id: string;
  entity: string;
  property: string;
  domain: string;
  type: string;
  static_or_dynamic: "static" | "dynamic" | "mixed";
  verification_status: VerificationStatus;
  source: string | null;
  source_type: string | null;
  confidence: number;
  last_verified: string | null;
  effective_date: string | null;
  attributes: Record<string, unknown>;
  aliases: Partial<Record<"vi" | "en" | "zh" | "ja" | "ko", string>>;
  languages: Record<"vi" | "en" | "zh" | "ja" | "ko", LangText>;
};

let cache: CanonicalFact[] | null = null;

export function loadCanonicalFacts(): CanonicalFact[] {
  if (cache) return cache;
  const path = join(process.cwd(), "server/data/canonical-facts.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as { facts: CanonicalFact[] };
  cache = raw.facts;
  return cache;
}

/**
 * The indexed body for a placeholder article. Both the Vietnamese and English
 * renderings plus every alias ride along, so the keyword retriever reaches the
 * entry whatever language the guest used — and the body itself makes clear the
 * fact is unverified, so a retrieval hit produces an honest deferral, not a guess.
 */
function renderKbBody(fact: CanonicalFact): string {
  const parts: string[] = [];
  for (const lang of ["vi", "en"] as const) {
    const t = fact.languages[lang];
    if (t) parts.push(`${t.title}\n${t.body}`);
  }
  const aliasLine = [fact.aliases.vi, fact.aliases.en].filter(Boolean).join(", ");
  if (aliasLine) parts.push(`Cũng được hỏi là: ${aliasLine}`);
  if (fact.verification_status !== "VERIFIED") parts.push(`[status: ${fact.verification_status}]`);
  return parts.join("\n\n");
}

/** A verified fact becomes trustworthy production knowledge; anything else stays
 *  a placeholder that the generator must treat as "not confirmed — defer to staff". */
function qualityOf(fact: CanonicalFact): { quality: string; verified: string } {
  return fact.verification_status === "VERIFIED"
    ? { quality: "curated", verified: "verified" }
    : { quality: "placeholder", verified: "unverified" };
}

/**
 * Upsert the canonical placeholders into kb_articles so the agent can retrieve
 * them. Idempotent and keyed by `entity`: a second run updates in place rather
 * than duplicating. Marked quality=placeholder so retrieval and the generator
 * treat the hit as "no verified fact — defer to staff".
 */
export function ingestCanonicalFacts(): { inserted: number; updated: number; verified: number; placeholder: number } {
  const hotel = storage.getHotel();
  const facts = loadCanonicalFacts();
  // Canonical-sourced articles are tagged "canonical"; key by entity to upsert.
  const existing = storage.listKb().filter((a) => {
    try {
      return (JSON.parse(a.tags || "[]") as string[]).includes("canonical");
    } catch {
      return false;
    }
  });
  const byEntity = new Map(existing.map((a) => [a.entity, a]));

  let inserted = 0;
  let updated = 0;
  let verified = 0;
  let placeholder = 0;
  for (const fact of facts) {
    const body = renderKbBody(fact);
    const title = fact.languages.vi?.title ?? fact.languages.en?.title ?? fact.entity;
    const q = qualityOf(fact);
    if (q.quality === "curated") verified++;
    else placeholder++;
    const patch: Partial<KbArticle> = {
      hotelId: hotel.id,
      category: fact.domain,
      title,
      body,
      tags: JSON.stringify(["canonical", q.quality, fact.entity]),
      quality: q.quality,
      verified: q.verified,
      contentClass: fact.static_or_dynamic,
      entity: fact.entity,
      domain: fact.domain,
      sourceUrl: fact.source,
      effectiveDate: fact.effective_date,
      lastVerified: fact.last_verified,
      retrievable: 1,
      updatedAt: nowIso(),
    };
    const prev = byEntity.get(fact.entity);
    if (prev) {
      storage.updateKb(prev.id, patch);
      updated++;
    } else {
      storage.createKb(patch as Omit<KbArticle, "id">);
      inserted++;
    }
  }
  return { inserted, updated, verified, placeholder };
}
