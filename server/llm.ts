import "dotenv/config";

/**
 * Provider abstraction for chat + embeddings.

 *
 * The point of this module is that the rest of the server never learns whether
 * a reply came from a hosted API or from a model running on the kiosk's own GPU.
 * `openai.ts` keeps its old public surface and delegates here, so agent.ts,
 * routes.ts and retrieval.ts did not have to change.
 *
 * Two providers:
 *   - "openai": the hosted API. Kept for development and for scoring the local
 *     model against a stronger reference. Not required at runtime.
 *   - "local":  any OpenAI-compatible server on this machine — llama.cpp's
 *     `llama-server`, Ollama, or LM Studio. Requests go to /v1/chat/completions
 *     exactly as before, so the wire format is unchanged.
 *
 * Differences between the two that this module has to absorb:
 *   1. `max_completion_tokens` is an OpenAI-only field. llama.cpp and Ollama
 *      read `max_tokens`. Sending the wrong one means the cap is silently
 *      ignored, which on a 4 GB card is the difference between a 2-second reply
 *      and a runaway generation that fills the KV cache.
 *   2. A local server needs no Authorization header, and sending a bogus one
 *      makes some builds reject the request.
 *   3. A local server can stall — a cold model load on a GTX 1650 Ti takes
 *      tens of seconds. Hosted APIs fail fast; llama-server just goes quiet.
 *      So every call gets an explicit timeout and a clear error, otherwise a
 *      guest at the kiosk stares at a spinner forever.
 *   4. `temperature` was accepted by the old chat() signature and then never
 *      put in the request body, so it did nothing. For a grounded concierge the
 *      correct default is 0: identical question, identical answer, and no
 *      sampling creativity invented on top of tool output. It is wired up here
 *      and defaults to 0 for the local provider.
 *
 * Embeddings are configured separately. llama-server serves one model per
 * process, so the embedding model normally listens on its own port. If no
 * embedding endpoint is configured this module throws LlmError, which is what
 * retrieval.ts already expects when it falls back to lexical-only BM25 search.
 */

export type Provider = "openai" | "local";

export class LlmError extends Error {
  /**
   * The status to return to *our* client. `routes.ts` sends this straight to
   * the browser, so it stays 502 for "the model failed" — a malformed request
   * we sent to OpenAI is not the guest's bad request.
   */
  status: number;
  /**
   * The status the provider actually returned, kept separately because the
   * router must distinguish "this provider is unavailable, try the other one"
   * from "we built a bad request, failing over would hide our bug". Collapsing
   * both into `status` made every 400 look like a 502 and silently fail over.
   */
  upstreamStatus?: number;
  constructor(message: string, status = 502, upstreamStatus?: number) {
    super(message);
    this.status = status;
    this.upstreamStatus = upstreamStatus;
  }
}

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
};

export type ToolSpec = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ChatResponse = {
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };

  /**
   * Stage-level timing, when the transport can report it without switching to
   * streaming. Ollama's native /api/chat returns these fields on every call,
   * streamed or not — `prompt_eval_duration` is a true TTFT proxy (the model
   * cannot emit a token before the prompt finishes processing, streaming or
   * not), so a separate streaming code path was not needed to get this number.
   * Measured once real numbers were in hand: on this deployment's 4GB GPU,
   * TTFT was never the problem (0.2-0.7s warm) — `evalMs` (raw generation
   * time) was, and `loadMs` dominates every turn after the model has been
   * idle past Ollama's keep-alive window.
   */
  timing?: {
    loadMs: number;
    promptEvalMs: number;
    promptEvalTokens: number;
    evalMs: number;
    evalTokens: number;
    totalMs: number;
  };

  /**
   * Which provider actually answered. Set by the router, not by the API.
   * `agent.ts` should branch on this: a local turn is a degraded turn and needs
   * the narrower tool set, template-first rendering, and stricter numeric checks.
   */
  servedBy?: Provider;
  /** True when the primary provider failed and the fallback answered instead. */
  failedOver?: boolean;
  /** The model name actually sent, resolved per provider. */
  model?: string;
};

/* ------------------------------------------------------------------ config */

const trimSlash = (s: string) => s.replace(/\/+$/, "");

/**
 * How runtime traffic is routed.
 *
 *   openai      hosted API only. No fallback. Original behaviour.
 *   local       local model only. Nothing leaves the machine.
 *   auto        hosted API first, local model when the API is unusable.
 *   auto-local  local model first, hosted API only when local fails.
 *
 * `auto` is the kiosk default worth running in production: the API answers
 * while it can, and a network outage or an exhausted quota degrades to the
 * local model instead of taking the concierge down.
 */
export type Mode = "openai" | "local" | "auto" | "auto-local";

function readMode(): Mode {
  const raw = (process.env.LLM_MODE || process.env.LLM_PROVIDER || "").toLowerCase();
  if (raw === "auto" || raw === "auto-local" || raw === "local" || raw === "openai") return raw;
  /* No explicit setting: a configured local endpoint means local-only, which
     keeps the previous LLM_PROVIDER-less behaviour intact. */
  return process.env.LOCAL_LLM_BASE ? "local" : "openai";
}

export const MODE: Mode = readMode();

/** The provider tried first. */
export const PRIMARY: Provider = MODE === "local" || MODE === "auto-local" ? "local" : "openai";

/** The provider tried when the primary is unusable, or null when there is none. */
export const FALLBACK: Provider | null =
  MODE === "auto" ? "local" : MODE === "auto-local" ? "openai" : null;

/**
 * Kept for the modules that imported it before routing existed. It names the
 * primary provider, not the only one — read `MODE` to know whether a fallback
 * exists, and `ChatResponse.servedBy` to know who actually answered a turn.
 */
export const PROVIDER: Provider = PRIMARY;

export const LOCAL_BASE = trimSlash(process.env.LOCAL_LLM_BASE || "http://127.0.0.1:8080");
export const LOCAL_EMBED_BASE = process.env.LOCAL_EMBED_BASE
  ? trimSlash(process.env.LOCAL_EMBED_BASE)
  : "";

const GATEWAY_URL = process.env.CUSTOM_CRED_API_OPENAI_COM_URL;
const GATEWAY_TOKEN = process.env.CUSTOM_CRED_API_OPENAI_COM_TOKEN;
export const OPENAI_BASE = trimSlash(GATEWAY_URL || "https://api.openai.com");

/**
 * Model names per provider. The local names are whatever the local server
 * advertises; llama-server ignores the field entirely, Ollama and LM Studio use
 * it to pick among loaded models, so it must stay configurable.
 */
export function agentModel(provider: Provider): string {
  return provider === "local"
    ? process.env.LOCAL_AGENT_MODEL || "qwen3.5:4b"
    : process.env.OPENAI_AGENT_MODEL || "gpt-5.4-mini";
}

export const MODEL_AGENT = agentModel(PRIMARY);

/**
 * Classification is a separate, smaller job (intent, sentiment, escalation).
 * On a 4 GB card there is no room for a second model resident alongside the
 * agent model, so local deployments point this at the same model by default.
 * Set LOCAL_CLASSIFY_MODEL only if a second server is actually running.
 */
export function classifyModel(provider: Provider): string {
  return provider === "local"
    ? process.env.LOCAL_CLASSIFY_MODEL || process.env.LOCAL_AGENT_MODEL || "qwen3.5:4b"
    : process.env.OPENAI_CLASSIFY_MODEL || "gpt-5.4-nano";
}

export function embedModel(provider: Provider): string {
  return provider === "local"
    ? process.env.LOCAL_EMBED_MODEL || "multilingual-e5-small"
    : process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";
}

export const MODEL_CLASSIFY = classifyModel(PRIMARY);

/**
 * Which provider serves embeddings. Unlike chat, this is pinned and **never
 * fails over**, and that is a correctness requirement rather than caution.
 */
export const EMBED_PROVIDER: Provider = process.env.EMBED_PROVIDER === "openai"
  ? "openai"
  : process.env.EMBED_PROVIDER === "local"
    ? "local"
    : LOCAL_EMBED_BASE
      ? "local"
      : "openai";

export const MODEL_EMBED = embedModel(EMBED_PROVIDER);



/**
 * Milliseconds before a call is abandoned.
 *
 * Local generation on a 4 GB card is slow, so it gets a long budget. The hosted
 * budget is deliberately *shorter* when a fallback exists: in `auto` mode the
 * timeout is how long a guest stares at a spinner before the local model takes
 * over, so waiting 60s to discover the wifi is down is the wrong trade.
 */
function chatTimeout(provider: Provider): number {
  if (provider === "local") return Number(process.env.LLM_LOCAL_TIMEOUT_MS || 600_000);
  const withFallback = FALLBACK === "local";
  return Number(
    process.env.LLM_API_TIMEOUT_MS || process.env.LLM_TIMEOUT_MS || (withFallback ? 15_000 : 60_000),
  );
}

const EMBED_TIMEOUT_MS = Number(process.env.LLM_EMBED_TIMEOUT_MS || 60_000);

/**
 * Default sampling temperature. 0 for local: a concierge quoting prices must
 * give the same answer twice. Hosted models keep their server-side default
 * unless a caller asks, which preserves the previous behaviour exactly.
 */
function defaultTemperature(provider: Provider): number | undefined {
  return provider === "local" ? 0 : undefined;
}

/* ---------------------------------------------------------- provider health */

/**
 * A circuit breaker per provider. Without one, every single turn would pay the
 * full hosted timeout while the wifi is down — the guest would wait 15s per
 * message all evening. After a few consecutive failures the provider is
 * skipped outright for a cooldown, so the kiosk answers from the local model
 * at full speed, then probes the API again once the cooldown expires.
 */
const BREAKER_FAILS = Number(process.env.LLM_BREAKER_FAILS || 3);
const BREAKER_COOLDOWN_MS = Number(process.env.LLM_BREAKER_COOLDOWN_MS || 60_000);

export type ProviderHealth = {
  consecutiveFailures: number;
  /** Epoch ms until which this provider is skipped; 0 when healthy. */
  trippedUntil: number;
  lastError: string | null;
  lastOkAt: number | null;
  calls: number;
  failures: number;
};

const health: Record<Provider, ProviderHealth> = {
  openai: { consecutiveFailures: 0, trippedUntil: 0, lastError: null, lastOkAt: null, calls: 0, failures: 0 },
  local: { consecutiveFailures: 0, trippedUntil: 0, lastError: null, lastOkAt: null, calls: 0, failures: 0 },
};

/** Snapshot for /api/health and for logging which path served the evening. */
export function providerHealth() {
  return {
    mode: MODE,
    primary: PRIMARY,
    fallback: FALLBACK,
    openai: { ...health.openai, available: isAvailable("openai") },
    local: { ...health.local, available: isAvailable("local") },
  };
}

function isAvailable(p: Provider) {
  return health[p].trippedUntil <= Date.now();
}

/**
 * Close the breakers and clear the counters. Exposed so an operator can force
 * an immediate retry after fixing the network instead of waiting out the
 * cooldown, and so tests can isolate cases.
 */
export function resetHealth(provider?: Provider) {
  const targets: Provider[] = provider ? [provider] : ["openai", "local"];
  for (const p of targets) {
    health[p] = {
      consecutiveFailures: 0,
      trippedUntil: 0,
      lastError: null,
      lastOkAt: health[p].lastOkAt,
      calls: 0,
      failures: 0,
    };
  }
}

function noteSuccess(p: Provider) {
  const h = health[p];
  h.calls++;
  h.consecutiveFailures = 0;
  h.trippedUntil = 0;
  h.lastOkAt = Date.now();
}

function noteFailure(p: Provider, err: unknown) {
  const h = health[p];
  h.calls++;
  h.failures++;
  h.consecutiveFailures++;
  h.lastError = err instanceof Error ? err.message : String(err);
  if (h.consecutiveFailures >= BREAKER_FAILS) {
    h.trippedUntil = Date.now() + BREAKER_COOLDOWN_MS;
  }
}

/**
 * Should this failure move the turn to the other provider?
 *
 * Yes for anything that means "this provider cannot serve right now": network
 * unreachable, timeout, gateway errors, rate limits, and auth/quota failures
 * (an expired key or an exhausted budget is exactly the business case for
 * falling back to local).
 *
 * No for 400-class request errors. Those mean *we* built a bad request — a
 * malformed tool schema, an unknown model name. Failing over would silently
 * hide our own bug and produce a mystery degradation, so it surfaces instead.
 */
function shouldFailover(err: unknown): boolean {
  if (!(err instanceof LlmError)) return true;
  /* Judge on what the provider said, not on what we will tell our client. */
  const s = err.upstreamStatus ?? err.status;
  if (s === 400 || s === 404 || s === 422) return false;
  return true;
}

/* --------------------------------------------------------------- proxy setup */

/**
 * Only the hosted path needs the sandbox's authenticating proxy. Installing a
 * global dispatcher would also capture requests to 127.0.0.1, so this is done
 * lazily and never when the provider is local.
 */
let proxyInstalled = false;
async function ensureProxy() {
  if (proxyInstalled) return;
  proxyInstalled = true;
  const proxyUri = !GATEWAY_URL && (process.env.HTTPS_PROXY || process.env.https_proxy);
  if (!proxyUri) return;
  try {
    const { ProxyAgent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(
      new ProxyAgent({
        uri: proxyUri,
        requestTls: { rejectUnauthorized: false },
        proxyTls: { rejectUnauthorized: false },
      }),
    );
  } catch {
    /* undici missing: fall through and let fetch try directly */
  }
}

/* ------------------------------------------------------------------ helpers */

function authHeaders(provider: Provider): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (provider === "local") {
    /* Some local servers accept an arbitrary key; only send one if asked. */
    if (process.env.LOCAL_LLM_API_KEY) {
      headers.authorization = `Bearer ${process.env.LOCAL_LLM_API_KEY}`;
    }
    return headers;
  }
  if (GATEWAY_TOKEN) headers["x-api-key"] = GATEWAY_TOKEN;
  else if (process.env.OPENAI_API_KEY) {
    headers.authorization = `Bearer ${process.env.OPENAI_API_KEY}`;
  }
  return headers;
}

/** fetch with an abort timeout, so a stalled local server cannot hang a turn. */
async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e: any) {
    if (e?.name === "AbortError") {
      throw new LlmError(`The model did not respond within ${Math.round(timeoutMs / 1000)}s.`, 504);
    }
    throw new LlmError(`Could not reach the model at ${url}: ${e?.message ?? e}`);
  } finally {
    clearTimeout(timer);
  }
}

function describeFailure(label: string, status: number, text: string): never {
  let detail = text.slice(0, 400);
  try {
    const parsed = JSON.parse(text);
    detail = parsed?.error?.message ?? parsed?.message ?? detail;
  } catch {
    /* keep raw */
  }
  throw new LlmError(`${label} ${status}: ${detail}`, status === 401 ? 401 : 502, status);
}

/* --------------------------------------------------------------------- chat */

export type ChatOptions = {
  model?: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /**
   * Force the model's next action rather than leave tool selection to its
   * judgment. Used sparingly, only where a benchmark has already shown prompt
   * instructions alone are not reliable — quoting a late-checkout/early-checkin
   * fee or a tax gross-up was described in prose instead of computed, in one
   * case even after the prompt named the exact tool to call. Pass a function
   * name to force that one call; "required" leaves the choice open but forbids
   * answering with plain text this round.
   */
  toolChoice?: { name: string } | "required";
  temperature?: number;
  maxTokens?: number;
  /**
   * Pin this one call to a provider and disable failover. Used by the
   * local-vs-API benchmark, which must know exactly who answered, and by any
   * caller that has a policy reason to stay on one path.
   */
  provider?: Provider;
  /**
   * Route this call to the local model first even in `auto` mode. This is the
   * API-cost lever: a deterministic intent router marks simple, single-tool
   * turns as local-first, so routine traffic never bills the hosted API, while
   * hard turns still go to it. Distinct from failover, which is health-driven.
   */
  preferLocal?: boolean;
  /**
   * This is a classification call, so resolve the smaller per-provider
   * classify model instead of the agent model. Set by `classify()`.
   */
  classify?: boolean;
};

/** One attempt against one provider. No routing, no failover. */
/**
 * Which wire protocol to use for the local server.
 *
 *   "openai" — /v1/chat/completions. Works with llama.cpp's llama-server, LM
 *              Studio and Ollama alike, which is why it was the only option.
 *   "ollama" — Ollama's own /api/chat, which additionally accepts `think`.
 *
 * That one extra field matters more than it sounds. Reasoning models (qwen3.5
 * and its family) emit their chain of thought into a separate `reasoning`
 * field and leave `content` EMPTY until the thought finishes. Measured on this
 * deployment with the agent's own 400-token cap, qwen3.5:4b produced 1,174
 * characters of reasoning, an empty answer, and finish_reason "length" — every
 * single offline turn, in 52 seconds. Ollama's /v1 endpoint silently ignores
 * `think`, `chat_template_kwargs` and a `/no_think` prompt prefix; only the
 * native endpoint honours it. With thinking off the same model answers in 6.3s.
 *
 * Defaults to "openai" so a llama.cpp deployment is unaffected; set
 * LOCAL_API=ollama when the local server is Ollama.
 */
const LOCAL_API = (process.env.LOCAL_API ?? "openai").toLowerCase() === "ollama" ? "ollama" : "openai";

/** Ollama's native /api/chat, used so thinking can actually be switched off. */
async function chatOllamaNative(opts: ChatOptions, model: string): Promise<ChatResponse> {
  const body: Record<string, unknown> = {
    model,
    messages: opts.messages,
    stream: false,
    /* The whole reason this transport exists. */
    think: false,
    options: {
      temperature: opts.temperature ?? 0,
      ...(opts.maxTokens ? { num_predict: opts.maxTokens } : {}),
    },
  };
  if (opts.tools?.length) body.tools = opts.tools;

  const res = await postJson(`${LOCAL_BASE}/api/chat`, authHeaders("local"), body, chatTimeout("local"));
  const text = await res.text();
  if (!res.ok) describeFailure("Local model", res.status, text);

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LlmError(`The local model returned a non-JSON response: ${text.slice(0, 200)}`);
  }
  const msg = parsed?.message ?? {};
  /* Mapped back into the OpenAI shape the rest of the server speaks, so this
     transport is invisible above this function. */
  return {
    choices: [
      {
        message: {
          content: msg.content ?? "",
          tool_calls: Array.isArray(msg.tool_calls)
            ? msg.tool_calls.map((t: any, i: number) => ({
                id: t.id ?? `call_${i}`,
                type: "function" as const,
                function: {
                  name: t.function?.name ?? "",
                  arguments:
                    typeof t.function?.arguments === "string"
                      ? t.function.arguments
                      : JSON.stringify(t.function?.arguments ?? {}),
                },
              }))
            : undefined,
        },
        finish_reason: parsed?.done_reason ?? "stop",
      },
    ],
    servedBy: "local",
    model,
    timing:
      typeof parsed?.total_duration === "number"
        ? {
            loadMs: Math.round((parsed.load_duration ?? 0) / 1e6),
            promptEvalMs: Math.round((parsed.prompt_eval_duration ?? 0) / 1e6),
            promptEvalTokens: parsed.prompt_eval_count ?? 0,
            evalMs: Math.round((parsed.eval_duration ?? 0) / 1e6),
            evalTokens: parsed.eval_count ?? 0,
            totalMs: Math.round(parsed.total_duration / 1e6),
          }
        : undefined,
  };
}

async function chatOnce(provider: Provider, opts: ChatOptions): Promise<ChatResponse> {
  const base = provider === "local" ? LOCAL_BASE : OPENAI_BASE;
  if (provider === "openai") await ensureProxy();

  const model =
    opts.model ?? (opts.classify ? classifyModel(provider) : agentModel(provider));

  if (provider === "local" && LOCAL_API === "ollama") return await chatOllamaNative(opts, model);

  const body: Record<string, unknown> = { model, messages: opts.messages };

  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice =
      typeof opts.toolChoice === "object"
        ? { type: "function", function: { name: opts.toolChoice.name } }
        : opts.toolChoice === "required"
          ? "required"
          : "auto";
  }

  /* The token-cap field name differs between the two APIs. */
  if (opts.maxTokens) {
    if (provider === "local") body.max_tokens = opts.maxTokens;
    else body.max_completion_tokens = opts.maxTokens;
  }

  const temperature = opts.temperature ?? defaultTemperature(provider);
  if (temperature !== undefined) body.temperature = temperature;

  const res = await postJson(
    `${base}/v1/chat/completions`,
    authHeaders(provider),
    body,
    chatTimeout(provider),
  );
  const text = await res.text();
  if (!res.ok) describeFailure(provider === "local" ? "Local model" : "OpenAI", res.status, text);

  let parsed: ChatResponse;
  try {
    parsed = JSON.parse(text) as ChatResponse;
  } catch {
    throw new LlmError(`The model returned a non-JSON response: ${text.slice(0, 200)}`);
  }
  if (!parsed?.choices?.length) {
    throw new LlmError(`The model returned no choices: ${text.slice(0, 200)}`);
  }
  parsed.servedBy = provider;
  parsed.model = model;
  return parsed;
}

/**
 * Decide the order of providers to try for one call.
 *
 * A provider whose breaker is open is moved to the back rather than removed:
 * if every provider is tripped the turn should still be attempted, because
 * answering slowly beats refusing when both look dead but one has recovered.
 */
function routeOrder(opts: ChatOptions): Provider[] {
  if (opts.provider) return [opts.provider];

  let order: Provider[];
  if (FALLBACK === null) order = [PRIMARY];
  else if (opts.preferLocal) order = (["local", "openai"] as Provider[]);
  else order = [PRIMARY, FALLBACK];

  const ready = order.filter(isAvailable);
  const tripped = order.filter((p) => !isAvailable(p));
  return [...ready, ...tripped];
}

/**
 * Routed chat. Tries providers in order and returns the first success, with
 * `servedBy` naming who answered so the caller can log or display it.
 *
 * Failover is deliberately *not* silent to the rest of the server: a turn
 * answered by the local model is a degraded turn, and `agent.ts` should treat
 * it as such — narrower tool set, template-first rendering, stricter numeric
 * checks. Hiding which provider ran would make that impossible.
 */
export async function chat(opts: ChatOptions): Promise<ChatResponse> {
  const order = routeOrder(opts);
  let lastError: unknown;

  for (let i = 0; i < order.length; i++) {
    const provider = order[i];
    try {
      const out = await chatOnce(provider, opts);
      noteSuccess(provider);
      if (i > 0) out.failedOver = true;
      return out;
    } catch (e) {
      noteFailure(provider, e);
      lastError = e;
      const isLast = i === order.length - 1;
      /* A request we built wrong is our bug: surface it instead of masking it
         behind a fallback that would appear to work. */
      if (!shouldFailover(e) || isLast) throw e;
    }
  }

  throw lastError instanceof Error ? lastError : new LlmError("No provider was reachable.");
}

/* --------------------------------------------------------------- embeddings */

/**
 * Which provider serves embeddings. Unlike chat, this is pinned and **never
 * fails over**, and that is a correctness requirement rather than caution.
 *
 * A query vector is only comparable to the corpus vectors stored in
 * `chunk.embedding` if both came from the same model: `text-embedding-3-small`
 * produces 1536 dimensions, `multilingual-e5-small` produces 384. Falling back
 * mid-outage would compare vectors from two different spaces — either a crash
 * or, worse, silently meaningless similarity scores that still rank documents
 * and still look like working retrieval.
 *
 * So embeddings pick one provider and stay there. When it is down, `embed`
 * throws, `retrieval.ts` drops to its lexical BM25 leg, and search degrades
 * honestly instead of returning confident nonsense. Whichever provider indexed
 * the corpus must also serve queries — switching means running `reindex()`.
 *
 * Defaults to local whenever a local embedding endpoint is configured, since
 * that is the leg that keeps working offline and costs nothing per query.
 */


/**
 * Batch embedding call. Returns one vector per input, in order.
 * Throws LlmError so retrieval.ts can fall back to lexical-only search — which
 * is the expected state on a kiosk with no embedding server configured.
 */
export async function embed(
  inputs: string[],
  model = embedModel(EMBED_PROVIDER),
): Promise<number[][]> {
  if (!inputs.length) return [];

  const provider: Provider = EMBED_PROVIDER;
  let base: string;
  if (provider === "local") {
    const currentBase = process.env.LOCAL_EMBED_BASE ? trimSlash(process.env.LOCAL_EMBED_BASE) : LOCAL_EMBED_BASE;
    if (!currentBase) {
      throw new LlmError(
        "No local embedding endpoint is configured (set LOCAL_EMBED_BASE). Retrieval will use lexical search only.",
      );
    }
    base = currentBase;
  } else {
    await ensureProxy();
    base = OPENAI_BASE;
  }

  const res = await postJson(
    `${base}/v1/embeddings`,
    authHeaders(provider),
    { model, input: inputs },
    EMBED_TIMEOUT_MS,
  );
  const text = await res.text();
  if (!res.ok) describeFailure("Embeddings", res.status, text);

  const parsed = JSON.parse(text) as { data?: Array<{ index: number; embedding: number[] }> };
  if (!parsed?.data?.length) throw new LlmError("The embedding endpoint returned no vectors.");

  const out: number[][] = new Array(inputs.length);
  for (const row of parsed.data) out[row.index] = row.embedding;
  /* A short batch would silently corrupt the index, so fail loudly instead. */
  for (let i = 0; i < inputs.length; i++) {
    if (!out[i]) throw new LlmError(`The embedding endpoint skipped input ${i}.`);
  }
  return out;
}

/* ----------------------------------------------------------- classification */

/**
 * Small, strictly-JSON call used for classification work. Never throws: on any
 * failure the caller's fallback is returned, because a classifier outage must
 * not take the conversation down with it.
 *
 * Local models are far worse at "reply with JSON and nothing else" than hosted
 * ones — they add prose, code fences, or a <think> block. The extraction below
 * strips reasoning blocks and fences before looking for the object.
 */
export async function classify(prompt: string, fallback: Record<string, unknown>) {
  try {
    const r = await chat({
      /* Left unset so the router can pick the classify model of whichever
         provider actually serves the call; pinning a name here would send an
         OpenAI model name to the local server after a failover. */
      messages: [
        {
          role: "system",
          content:
            "You are a precise classifier for a hotel messaging platform. Reply with a single minified JSON object and nothing else.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0,
      maxTokens: 200,
      classify: true,
    });
    const raw = r.choices[0]?.message?.content ?? "";
    return { ...fallback, ...extractJsonObject(raw) };
  } catch {
    return fallback;
  }
}

/**
 * Pull the first JSON object out of a model reply. Tolerates ```json fences and
 * a leading <think>…</think> block, both of which small local models emit even
 * when told not to. Returns {} when nothing parseable is present.
 */
export function extractJsonObject(raw: string): Record<string, unknown> {
  let s = String(raw || "");
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, "");
  s = s.replace(/```(?:json)?/gi, "");
  const start = s.indexOf("{");
  if (start === -1) return {};
  /* Scan for the matching brace so trailing prose does not break the parse. */
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          const obj = JSON.parse(s.slice(start, i + 1));
          return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
        } catch {
          return {};
        }
      }
    }
  }
  return {};
}

/* --------------------------------------------------------------- diagnostics */

export type ProbeResult = {
  provider: Provider;
  base: string;
  model: string;
  reachable: boolean;
  latencyMs: number | null;
  error: string | null;
};

/**
 * Probe one provider directly, bypassing the router so the result is about that
 * provider and not about whoever the router happened to reach.
 *
 * Worth calling for both providers at boot in `auto` mode: it warms the local
 * model into VRAM (the first real request otherwise pays the model load, which
 * on a 4 GB card is the difference between a 5s failover and a 40s one) and it
 * tells you at startup whether the offline path is actually there — rather than
 * finding out during the outage it exists for.
 */
export async function probe(provider: Provider = PRIMARY): Promise<ProbeResult> {
  const base = provider === "local" ? LOCAL_BASE : OPENAI_BASE;
  const started = Date.now();
  try {
    await chatOnce(provider, {
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 1,
      temperature: 0,
    });
    noteSuccess(provider);
    return {
      provider,
      base,
      model: agentModel(provider),
      reachable: true,
      latencyMs: Date.now() - started,
      error: null,
    };
  } catch (e: any) {
    noteFailure(provider, e);
    return {
      provider,
      base,
      model: agentModel(provider),
      reachable: false,
      latencyMs: null,
      error: e?.message ?? String(e),
    };
  }
}

/**
 * Probe every provider this deployment can use. Run at boot so the startup
 * banner states plainly which paths are live — a kiosk in `auto` mode whose
 * local model was never loaded looks perfectly healthy right up to the outage.
 *
 * Failed probes count toward the breaker, which is intended: a local server
 * that is not running should already be tripped when the first guest arrives
 * rather than costing that guest a timeout.
 */
export async function probeAll(): Promise<ProbeResult[]> {
  const targets: Provider[] = FALLBACK ? [PRIMARY, FALLBACK] : [PRIMARY];
  return Promise.all(targets.map((p) => probe(p)));
}
