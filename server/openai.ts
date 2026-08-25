/**
 * Backwards-compatible surface for the LLM layer.
 *
 * This file used to talk to api.openai.com directly. The kiosk has to keep
 * working when that API is unreachable or the budget is spent, so the transport
 * and the routing moved to `llm.ts`: it can serve a turn from the hosted API,
 * from an OpenAI-compatible server on this machine, or from the API first and
 * the local model on failure.
 *
 * Everything the rest of the server imported from here is re-exported
 * unchanged, so agent.ts, routes.ts, ops.ts and retrieval.ts keep working with
 * no edits. Prefer importing from `./llm` in new code — the routing controls
 * (MODE, providerHealth, probeAll, servedBy) only exist there.
 */

export {
  chat,
  embed,
  classify,
  extractJsonObject,
  probe,
  probeAll,
  providerHealth,
  resetHealth,
  agentModel,
  classifyModel,
  embedModel,
  LlmError,
  MODE,
  PRIMARY,
  FALLBACK,
  PROVIDER,
  EMBED_PROVIDER,
  LOCAL_BASE,
  LOCAL_EMBED_BASE,
  OPENAI_BASE,
  MODEL_AGENT,
  MODEL_CLASSIFY,
  MODEL_EMBED,
} from "./llm";

export type {
  ChatMessage,
  ToolSpec,
  ChatResponse,
  ChatOptions,
  Provider,
  Mode,
  ProbeResult,
  ProviderHealth,
} from "./llm";
