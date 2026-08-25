/**
 * Langfuse exporter.
 *
 * The trace spine (observability.ts) already builds a full span tree per turn and
 * stores it locally. This module mirrors that tree into Langfuse — the recognised
 * open-source LLM-observability product — so a prospective customer sees the
 * agent's every step in a dashboard they already trust, instead of taking our
 * word for it. That recognition is the whole reason it exists; the local trace
 * remains the source of truth and works with Langfuse switched off.
 *
 * It talks to Langfuse's public ingestion endpoint directly (Basic auth, a
 * batch of typed events) rather than pulling in the SDK: no dependency to keep
 * in step, and the same hand-rolled-fetch shape as the rest of this server. It
 * is entirely env-gated and fire-and-forget — a Langfuse outage, a wrong key or
 * a slow network must never touch a guest's answer.
 *
 *   LANGFUSE_PUBLIC_KEY   pk-lf-...
 *   LANGFUSE_SECRET_KEY   sk-lf-...
 *   LANGFUSE_BASEURL      https://cloud.langfuse.com (default) or self-hosted URL
 */

import { storage } from "./storage";
import type { Signal, SpanKind } from "./observability";

/** The fields the exporter reads off a span. The Span class satisfies this, and
 *  so can a plain object in a test — the batch builder never touches a class. */
export interface ExportableSpan {
  id: string;
  traceId: string;
  conversationId: number;
  parentId: string | null;
  name: string;
  kind: SpanKind;
  status: "ok" | "warn" | "error";
  provider?: string | null;
  model?: string | null;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  attributes: Record<string, unknown>;
  signals: Signal[];
  error?: string;
}

const DEFAULT_BASE_URL = "https://cloud.langfuse.com";
const SEND_TIMEOUT_MS = Number(process.env.LANGFUSE_TIMEOUT_MS || 4000);

const SETTING_KEYS = {
  public: "langfuse.publicKey",
  secret: "langfuse.secretKey",
  base: "langfuse.baseUrl",
} as const;

/**
 * Resolve the live Langfuse configuration. An environment variable always wins
 * over a value saved from the UI, so an operator can hard-lock the credentials
 * in production while a demo box stays editable from Settings. Read fresh every
 * time (settings live in SQLite) so pasting a key takes effect on the very next
 * turn without a restart.
 */
function resolveConfig(): { publicKey: string; secretKey: string; baseUrl: string; source: "env" | "stored" | "none" } {
  const envPublic = process.env.LANGFUSE_PUBLIC_KEY || "";
  const envSecret = process.env.LANGFUSE_SECRET_KEY || "";
  const envBase = process.env.LANGFUSE_BASEURL || "";

  let storedPublic = "";
  let storedSecret = "";
  let storedBase = "";
  try {
    storedPublic = storage.getSetting(SETTING_KEYS.public) ?? "";
    storedSecret = storage.getSetting(SETTING_KEYS.secret) ?? "";
    storedBase = storage.getSetting(SETTING_KEYS.base) ?? "";
  } catch {
    /* settings table not ready (e.g. during a test import) — env-only is fine */
  }

  const publicKey = envPublic || storedPublic;
  const secretKey = envSecret || storedSecret;
  const baseUrl = (envBase || storedBase || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const source = envPublic || envSecret ? "env" : publicKey && secretKey ? "stored" : "none";
  return { publicKey, secretKey, baseUrl, source };
}

export function langfuseEnabled(): boolean {
  const c = resolveConfig();
  return Boolean(c.publicKey && c.secretKey);
}

/** Non-secret status for the UI: enough to show a badge and mask the key, never
 *  the secret itself. */
export function langfuseConfig() {
  const c = resolveConfig();
  const enabled = Boolean(c.publicKey && c.secretKey);
  const mask = (k: string) => (k.length > 8 ? `${k.slice(0, 6)}…${k.slice(-4)}` : k ? "set" : "");
  return {
    enabled,
    baseUrl: enabled ? c.baseUrl : c.baseUrl, // baseUrl is not secret; always show it
    source: c.source, // "env" (locked), "stored" (from UI), or "none"
    publicKeyMasked: mask(c.publicKey),
    hasSecret: Boolean(c.secretKey),
    envLocked: c.source === "env",
  };
}

/** Persist Langfuse credentials entered from the UI. Empty string clears a field. */
export function saveLangfuseSettings(input: { publicKey?: string; secretKey?: string; baseUrl?: string }): void {
  const put = (key: string, v: string | undefined) => {
    if (v === undefined) return;
    if (v.trim() === "") storage.deleteSetting(key);
    else storage.setSetting(key, v.trim());
  };
  put(SETTING_KEYS.public, input.publicKey);
  put(SETTING_KEYS.secret, input.secretKey);
  put(SETTING_KEYS.base, input.baseUrl);
}

/** Remove all stored Langfuse credentials (the "Disconnect" button). */
export function clearLangfuseSettings(): void {
  storage.deleteSetting(SETTING_KEYS.public);
  storage.deleteSetting(SETTING_KEYS.secret);
  storage.deleteSetting(SETTING_KEYS.base);
}

/** Langfuse severity levels. Our three-way status maps straight onto three of them. */
function levelOf(status: "ok" | "warn" | "error"): "DEFAULT" | "WARNING" | "ERROR" {
  return status === "error" ? "ERROR" : status === "warn" ? "WARNING" : "DEFAULT";
}

function uuid(): string {
  // Node 18+ has crypto.randomUUID globally; fall back just in case.
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  return g.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** A short status message for the observation, drawn from the worst thing on it. */
function statusMessage(span: ExportableSpan): string | undefined {
  if (span.error) return span.error;
  const worst = span.signals.find((s) => s.severity === "error") ?? span.signals.find((s) => s.severity === "warn");
  return worst ? `${worst.code}${worst.detail ? `: ${worst.detail}` : ""}` : undefined;
}

/**
 * Turn one turn's spans into a Langfuse ingestion batch. Pure and total: the
 * root "turn" span becomes a Langfuse trace, LLM spans become generations (so
 * Langfuse renders them as model calls), everything else becomes a span. Nesting
 * is preserved through `parentObservationId`.
 *
 * Returns an empty array when there is no root, so a malformed trace is dropped
 * rather than sent half-formed.
 */
export function buildIngestionBatch(spans: ExportableSpan[]): Array<Record<string, unknown>> {
  const root = spans.find((s) => s.kind === "turn");
  if (!root) return [];

  const batch: Array<Record<string, unknown>> = [];

  batch.push({
    id: uuid(),
    type: "trace-create",
    timestamp: root.startedAt,
    body: {
      id: root.traceId,
      name: root.name,
      userId: `conversation:${root.conversationId}`,
      sessionId: `conversation:${root.conversationId}`,
      timestamp: root.startedAt,
      metadata: { ...root.attributes, signals: root.signals, status: root.status },
      tags: root.signals.map((s) => s.code),
      output: { status: root.status, latency_ms: root.durationMs },
    },
  });

  for (const span of spans) {
    if (span.kind === "turn") continue;
    const isGeneration = span.kind === "llm";
    const body: Record<string, unknown> = {
      id: span.id,
      traceId: root.traceId,
      // The root turn is the trace itself, so a span whose parent is the root
      // hangs directly off the trace (no parentObservationId).
      parentObservationId: span.parentId && span.parentId !== root.id ? span.parentId : undefined,
      name: span.name,
      startTime: span.startedAt,
      endTime: span.endedAt ?? span.startedAt,
      level: levelOf(span.status),
      statusMessage: statusMessage(span),
      metadata: { ...span.attributes, signals: span.signals, kind: span.kind },
    };
    if (isGeneration && span.model) body.model = span.model;
    batch.push({
      id: uuid(),
      type: isGeneration ? "generation-create" : "span-create",
      timestamp: span.startedAt,
      body,
    });
  }

  return batch;
}

/**
 * Ship one turn's spans to Langfuse. Fire-and-forget: never awaited on the hot
 * path, never throws, and aborts on a timeout so a slow ingest endpoint cannot
 * pile up. Call it from `Trace.flush()` after the local write.
 */
export function exportTrace(spans: ExportableSpan[]): void {
  if (!langfuseEnabled() || !spans.length) return;
  const batch = buildIngestionBatch(spans);
  if (!batch.length) return;

  void sendBatch(batch).catch((e) => {
    console.error("[langfuse] export failed:", e?.message ?? e);
  });
}

async function sendBatch(batch: Array<Record<string, unknown>>): Promise<void> {
  const { publicKey, secretKey, baseUrl } = resolveConfig();
  if (!publicKey || !secretKey) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const auth = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
    const res = await fetch(`${baseUrl}/api/public/ingestion`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Basic ${auth}` },
      body: JSON.stringify({ batch }),
      signal: controller.signal,
    });
    if (!res.ok && res.status !== 207) {
      // 207 is Langfuse's partial-success code; anything else worth a line.
      console.error(`[langfuse] ingestion returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
