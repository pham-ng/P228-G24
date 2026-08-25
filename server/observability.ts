/**
 * Agent observability — structured, persisted execution traces.
 *
 * The coarse `AgentTracer` (tracer.ts) records one line per turn at the route
 * boundary: it can tell you a turn was slow or threw, but not *why*. This module
 * records the turn as a tree of spans — every LLM call, tool call, retrieval and
 * guard check — and attaches typed SIGNALS to each: the machine-readable answer
 * to "when did the agent call a tool wrong, and what was wrong about it".
 *
 * Two design rules make this safe to run on the hot path of a paying product:
 *
 *   1. Tracing NEVER breaks a turn. Every persistence call the agent makes is
 *      wrapped; a failing trace write is logged and swallowed, never thrown.
 *
 *   2. The signal logic is PURE and unit-tested without an LLM. `deriveToolSignals`
 *      and friends take plain data (a tool name, its args, its result) and return
 *      flags. That is what lets a benchmark and the live server agree on what
 *      "tool_needs_input" means, instead of each guessing.
 *
 * A span's `signals` is the observability payload. A turn's status and its
 * rolled-up signals are copied onto the root span so a dashboard listing is a
 * single indexed read (`kind = 'turn'`) rather than a scan of every child.
 */

import { storage, nowIso } from "./storage";
import { exportTrace } from "./langfuse";
import type { InsertTraceSpan } from "@shared/schema";

/* ------------------------------------------------------------------ signals */

/**
 * The taxonomy of things worth noticing on one span. Every code answers a
 * concrete operator question; none is decorative. Grouped by where the fault
 * lies so a dashboard can say "this was a routing problem" vs "the model
 * hallucinated" vs "the provider was down".
 */
export type SignalCode =
  // — the model used a tool wrongly —
  | "tool_error" //        the tool threw or returned { error }
  | "tool_needs_input" //  called before required facts were given (must_ask / ambiguous)
  | "tool_blocked" //      the request is impossible as stated (problems / bookable:false)
  | "tool_repeat" //       same tool + same args called twice in one turn (a loop)
  | "empty_tool_result" // the tool returned nothing usable
  | "unknown_tool" //      the model invoked a tool that does not exist
  | "bad_arguments" //     the model's tool arguments were not valid JSON
  // — the router hid or mis-picked a tool —
  | "router_guessed" //    no keyword matched; a default family set was used
  | "family_dropped" //    a family the message scored for did not fit the token budget
  | "capability_miss" //   find_capability could not place the model's request
  // — retrieval degraded —
  | "retrieval_empty" //   search returned zero passages
  | "retrieval_degraded" //vector leg was unavailable; lexical-only answer
  // — the answer was unsafe or absent —
  | "numeric_fabrication" //the numeric guard found figures with no source this turn
  | "reply_repaired" //    the guard had to strip sentences from the reply
  | "forced_escalation" // the turn was handed to staff by a guard, not the model
  | "empty_reply" //       the model produced no answer at all
  | "max_rounds_hit" //    the tool loop hit its ceiling without a final answer
  | "language_mismatch" // the reply is not in the language the guest wrote in
  // — the provider path was unhealthy —
  | "failover" //          the primary provider failed and the fallback answered
  | "provider_error"; //   an LLM call threw

export type SignalSeverity = "info" | "warn" | "error";

export type Signal = {
  code: SignalCode;
  severity: SignalSeverity;
  /** Short human detail, e.g. "get_folio: No reservation linked." */
  detail?: string;
};

/** The severity each code carries. Kept in one place so rollup is consistent. */
const SEVERITY: Record<SignalCode, SignalSeverity> = {
  tool_error: "error",
  tool_needs_input: "warn",
  tool_blocked: "warn",
  tool_repeat: "warn",
  empty_tool_result: "warn",
  unknown_tool: "error",
  bad_arguments: "error",
  router_guessed: "info",
  family_dropped: "warn",
  capability_miss: "warn",
  retrieval_empty: "warn",
  retrieval_degraded: "info",
  numeric_fabrication: "error",
  reply_repaired: "warn",
  forced_escalation: "warn",
  empty_reply: "error",
  max_rounds_hit: "warn",
  language_mismatch: "warn",
  failover: "warn",
  provider_error: "error",
};

export function signal(code: SignalCode, detail?: string): Signal {
  return { code, severity: SEVERITY[code], detail };
}

/** The worst severity in a list, or "ok" when empty. Drives a span's status. */
export function worstStatus(signals: Signal[]): "ok" | "warn" | "error" {
  let s: "ok" | "warn" | "error" = "ok";
  for (const sig of signals) {
    if (sig.severity === "error") return "error";
    if (sig.severity === "warn") s = "warn";
  }
  return s;
}

/* --------------------------------------------------- pure signal derivation */

/** A canonical signature for repeat detection: name plus sorted args. */
export function toolSignature(name: string, args: unknown): string {
  let a = "";
  try {
    a = JSON.stringify(args, Object.keys((args as object) ?? {}).sort());
  } catch {
    a = String(args);
  }
  return `${name}(${a})`;
}

function nonEmptyArray(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0;
}

/**
 * Read a completed tool call and report what, if anything, went wrong with it.
 * Pure: the same inputs always yield the same signals, with no database or model
 * access, which is exactly what the test suite pins.
 *
 * `isRepeat` is supplied by the caller because deciding it needs the turn's
 * history of prior calls, which lives in the trace, not in one result.
 */
export function deriveToolSignals(input: {
  name: string;
  args: unknown;
  result: Record<string, unknown> | string;
  isRepeat?: boolean;
}): Signal[] {
  const out: Signal[] = [];
  const { name, result } = input;

  if (input.isRepeat) out.push(signal("tool_repeat", `${name} called again with identical arguments`));

  // String results (rare) are treated as opaque success unless empty.
  if (typeof result === "string") {
    if (!result.trim()) out.push(signal("empty_tool_result", name));
    return out;
  }
  if (result == null || typeof result !== "object") {
    out.push(signal("empty_tool_result", name));
    return out;
  }

  const r = result as Record<string, unknown>;

  // An explicit error field. runTool returns { error } for unknown tools too.
  if (typeof r.error === "string" && r.error) {
    if (/^unknown tool/i.test(r.error)) out.push(signal("unknown_tool", r.error));
    else out.push(signal("tool_error", `${name}: ${r.error}`));
  }

  // The tool ran but refused to act because the model called it too early.
  if (nonEmptyArray(r.must_ask_the_guest_for) || r.ambiguous === true) {
    out.push(signal("tool_needs_input", `${name} needs more facts before it can act`));
  }

  // The request is impossible as stated (reversed dates, party too large, sold out).
  if (
    nonEmptyArray(r.problems_to_explain) ||
    r.bookable === false ||
    r.created === false ||
    r.changed === false
  ) {
    out.push(signal("tool_blocked", `${name} could not fulfil the request as stated`));
  }

  // Retrieval health, read off search_knowledge's own result shape.
  if (typeof r.strategy === "string") {
    const results = r.results;
    if (Array.isArray(results) && results.length === 0) out.push(signal("retrieval_empty", name));
    // "Degraded" means the vector leg was expected but failed — not that it is
    // deliberately disabled, which is a healthy configured state on this corpus.
    if (/unavailable|no vectors/.test(r.strategy)) {
      out.push(signal("retrieval_degraded", `strategy: ${r.strategy}`));
    }
  }

  return out;
}

/**
 * Signals about the tool *routing* decision for a turn, derived from the
 * selection the router returned. These are coverage risks, not errors: a dropped
 * family means the guest asked about something whose tools did not fit the
 * budget, which is the first thing to look at when an answer is oddly incomplete.
 */
export function deriveRouterSignals(sel: {
  guessed?: boolean;
  dropped?: string[];
}): Signal[] {
  const out: Signal[] = [];
  if (sel.guessed) out.push(signal("router_guessed", "no keyword matched; used default families"));
  if (sel.dropped?.length) out.push(signal("family_dropped", sel.dropped.join(", ")));
  return out;
}

/**
 * Very conservative language check. False positives are worse than misses here —
 * flagging a correct answer as wrong-language trains operators to ignore the
 * signal — so it fires only in the unambiguous case: the guest's profile
 * language is Vietnamese and the reply carries not one Vietnamese-specific
 * letter across a reply long enough that one would certainly appear.
 */
export function detectLanguageMismatch(guestLang: string, reply: string): Signal | null {
  const text = reply.trim();
  if (guestLang !== "vi" || text.length < 40) return null;
  // Vietnamese-specific letters that do not occur in English or other Latin langs.
  const viMark = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
  if (viMark.test(text)) return null;
  // No Vietnamese diacritic in a long reply to a Vietnamese guest → mismatch.
  return signal("language_mismatch", "guest wrote Vietnamese; reply has no Vietnamese diacritics");
}

/* ----------------------------------------------------------------- spans */

export type SpanKind = "turn" | "llm" | "tool" | "retrieval" | "guard" | "wizard" | "router";

function spanId(): string {
  return `sp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function traceId(): string {
  return `tr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export class Span {
  readonly id = spanId();
  readonly startedAt = nowIso();
  private start = Date.now();
  endedAt?: string;
  durationMs?: number;
  signals: Signal[] = [];
  attributes: Record<string, unknown> = {};
  error?: string;
  status: "ok" | "warn" | "error" = "ok";
  ended = false;

  constructor(
    readonly trace: Trace,
    readonly name: string,
    readonly kind: SpanKind,
    readonly parentId: string | null,
    attrs?: Record<string, unknown>,
  ) {
    if (attrs) this.attributes = attrs;
  }

  /* These read through to the owning trace so a span satisfies ExportableSpan
     (langfuse.ts) and toRow() without duplicating the values on every node. */
  get traceId(): string {
    return this.trace.id;
  }
  get conversationId(): number {
    return this.trace.conversationId;
  }
  get provider(): string | null {
    return (this.attributes.provider as string) ?? this.trace.provider ?? null;
  }
  get model(): string | null {
    return (this.attributes.model as string) ?? this.trace.model ?? null;
  }

  setAttributes(attrs: Record<string, unknown>): this {
    Object.assign(this.attributes, attrs);
    return this;
  }

  addSignals(signals: Signal[]): this {
    for (const s of signals) this.signals.push(s);
    return this;
  }

  addSignal(code: SignalCode, detail?: string): this {
    this.signals.push(signal(code, detail));
    return this;
  }

  /** Close the span. Status is the worst of its own signals unless forced. */
  end(opts?: { error?: string; status?: "ok" | "warn" | "error" }): this {
    if (this.ended) return this;
    this.ended = true;
    this.endedAt = nowIso();
    this.durationMs = Date.now() - this.start;
    if (opts?.error) this.error = opts.error;
    this.status = opts?.status ?? worstStatus(this.signals);
    if (this.error && this.status === "ok") this.status = "error";
    return this;
  }

  toRow(): InsertTraceSpan {
    return {
      id: this.id,
      traceId: this.trace.id,
      conversationId: this.trace.conversationId,
      parentId: this.parentId,
      name: this.name,
      kind: this.kind,
      status: this.status,
      provider: (this.attributes.provider as string) ?? this.trace.provider ?? null,
      model: (this.attributes.model as string) ?? this.trace.model ?? null,
      startedAt: this.startedAt,
      endedAt: this.endedAt ?? this.startedAt,
      durationMs: this.durationMs ?? 0,
      attributes: safeJson(this.attributes),
      signals: JSON.stringify(this.signals),
      error: this.error ?? null,
      createdAt: this.startedAt,
    };
  }
}

/**
 * One agent turn. Owns a root "turn" span and every child span, times the whole
 * turn, and flushes the tree to storage in one transaction. Construct it at the
 * top of `runAgent`, open child spans as work happens, then `flush()` once —
 * from a try/catch, because a paying guest's answer must not depend on a trace
 * write succeeding.
 */
export class Trace {
  readonly id = traceId();
  readonly root: Span;
  private spans: Span[] = [];
  provider?: string;
  model?: string;

  constructor(
    readonly conversationId: number,
    meta?: { provider?: string; model?: string },
  ) {
    this.provider = meta?.provider;
    this.model = meta?.model;
    this.root = new Span(this, "agent.turn", "turn", null);
    this.spans.push(this.root);
  }

  /** Open a child span under the root (or under `parent`). */
  startSpan(
    name: string,
    kind: SpanKind,
    attrs?: Record<string, unknown>,
    parent: Span = this.root,
  ): Span {
    const s = new Span(this, name, kind, parent.id, attrs);
    this.spans.push(s);
    return s;
  }

  /** Signals attached directly to the turn (not to a specific child span). */
  addTurnSignals(signals: Signal[]) {
    this.root.addSignals(signals);
  }

  /** Record which provider/model actually served the turn, for the root row. */
  setServedBy(provider?: string, model?: string) {
    if (provider) this.provider = provider;
    if (model) this.model = model;
  }

  /**
   * Close the turn and persist every span. Rolls each child's signals up onto
   * the root so a turn listing shows the whole story without reading children,
   * and de-duplicates by code keeping the worst severity.
   */
  flush(turnAttrs?: Record<string, unknown>): string {
    for (const s of this.spans) if (!s.ended && s !== this.root) s.end();

    const rolled = new Map<SignalCode, Signal>();
    for (const s of this.spans) {
      if (s === this.root) continue;
      for (const sig of s.signals) {
        const prev = rolled.get(sig.code);
        if (!prev || rank(sig.severity) > rank(prev.severity)) rolled.set(sig.code, sig);
      }
    }
    for (const sig of this.root.signals) {
      const prev = rolled.get(sig.code);
      if (!prev || rank(sig.severity) > rank(prev.severity)) rolled.set(sig.code, sig);
    }
    this.root.signals = [...rolled.values()];
    if (turnAttrs) this.root.setAttributes(turnAttrs);
    this.root.setAttributes({
      span_count: this.spans.length,
      tool_calls: this.spans.filter((s) => s.kind === "tool").length,
    });
    this.root.end();

    try {
      storage.insertSpans(this.spans.map((s) => s.toRow()));
    } catch (e: any) {
      console.error("[observability] failed to persist trace", this.id, e?.message ?? e);
    }
    /* Mirror to Langfuse when configured. Fire-and-forget inside its own guard:
       the local trace above is the source of truth, and a Langfuse hiccup must
       never surface here. */
    try {
      exportTrace(this.spans);
    } catch (e: any) {
      console.error("[observability] langfuse export threw", this.id, e?.message ?? e);
    }
    return this.id;
  }
}

function rank(s: SignalSeverity): number {
  return s === "error" ? 2 : s === "warn" ? 1 : 0;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, val) =>
      typeof val === "string" && val.length > 600 ? `${val.slice(0, 600)}…` : val,
    );
  } catch {
    return "{}";
  }
}

/* ------------------------------------------------------- aggregation helper */

/**
 * Roll a window of persisted spans into per-signal counts and the tools that
 * fault most. This is what `/api/observability/signals` serves — the numbers an
 * operator scans to decide what to fix next, not a per-turn drill-down.
 */
export function aggregateSignals(
  turns: Array<{ signals: string | null; status: string; durationMs: number | null }>,
  toolSpans: Array<{ name: string; status: string; signals: string | null }>,
) {
  const signalCounts: Record<string, number> = {};
  let warnTurns = 0;
  let errorTurns = 0;
  const durations: number[] = [];

  for (const t of turns) {
    if (t.status === "warn") warnTurns++;
    if (t.status === "error") errorTurns++;
    if (typeof t.durationMs === "number") durations.push(t.durationMs);
    for (const s of parseSignals(t.signals)) signalCounts[s.code] = (signalCounts[s.code] ?? 0) + 1;
  }

  // Which tools raise the most trouble, so "get_folio errors a lot" is one glance.
  const toolTrouble: Record<string, { calls: number; faults: number }> = {};
  for (const sp of toolSpans) {
    const key = sp.name.replace(/^tool\./, "");
    const t = (toolTrouble[key] ??= { calls: 0, faults: 0 });
    t.calls++;
    if (sp.status !== "ok") t.faults++;
  }

  durations.sort((a, b) => a - b);
  const pct = (p: number) => (durations.length ? durations[Math.min(durations.length - 1, Math.floor((p / 100) * durations.length))] : 0);

  return {
    turns: turns.length,
    warnTurns,
    errorTurns,
    cleanRate: turns.length ? +(1 - (warnTurns + errorTurns) / turns.length).toFixed(3) : 1,
    latencyMs: { p50: pct(50), p95: pct(95), p99: pct(99) },
    signalCounts,
    toolTrouble,
  };
}

function parseSignals(json: string | null): Signal[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
