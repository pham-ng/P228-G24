import { ProxyAgent, setGlobalDispatcher } from "undici";

/**
 * The sandbox injects the user's OpenAI credential through an authenticating
 * HTTPS proxy. Node's global fetch (undici) ignores HTTPS_PROXY by default, so
 * we install a ProxyAgent explicitly. When the app runs outside the sandbox it
 * falls back to OPENAI_API_KEY from the environment.
 */
/**
 * Credential resolution, in priority order:
 *  1. CUSTOM_CRED_API_OPENAI_COM_URL/_TOKEN — the platform's credential gateway,
 *     injected into the server process. Requests go to the gateway base URL with
 *     the token in `x-api-key`; the real key never enters this process.
 *  2. OPENAI_API_KEY — a plain key, for running this app anywhere else.
 *  3. HTTPS_PROXY — the sandbox's authenticating proxy (used by CLI tooling).
 */
const GATEWAY_URL = process.env.CUSTOM_CRED_API_OPENAI_COM_URL;
const GATEWAY_TOKEN = process.env.CUSTOM_CRED_API_OPENAI_COM_TOKEN;
export const OPENAI_BASE = (GATEWAY_URL || "https://api.openai.com").replace(/\/$/, "");

const proxyUri = !GATEWAY_URL && (process.env.HTTPS_PROXY || process.env.https_proxy);
if (proxyUri) {
  setGlobalDispatcher(
    new ProxyAgent({
      uri: proxyUri,
      requestTls: { rejectUnauthorized: false },
      proxyTls: { rejectUnauthorized: false },
    }),
  );
}

export const MODEL_AGENT = process.env.OPENAI_AGENT_MODEL || "gpt-5.4-mini";
export const MODEL_CLASSIFY = process.env.OPENAI_CLASSIFY_MODEL || "gpt-5.4-nano";

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

export class LlmError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

export async function chat(opts: {
  model?: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (GATEWAY_TOKEN) headers["x-api-key"] = GATEWAY_TOKEN;
  else if (process.env.OPENAI_API_KEY) headers.authorization = `Bearer ${process.env.OPENAI_API_KEY}`;

  const body: Record<string, unknown> = {
    model: opts.model || MODEL_AGENT,
    messages: opts.messages,
  };
  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = "auto";
  }
  if (opts.maxTokens) body.max_completion_tokens = opts.maxTokens;

  let res: Response;
  try {
    res = await fetch(`${OPENAI_BASE}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (e: any) {
    throw new LlmError(`Could not reach the OpenAI API: ${e?.message ?? e}`);
  }

  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 400);
    try {
      detail = JSON.parse(text)?.error?.message ?? detail;
    } catch {
      /* keep raw */
    }
    throw new LlmError(`OpenAI ${res.status}: ${detail}`, res.status === 401 ? 401 : 502);
  }
  return JSON.parse(text) as {
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
  };
}

/** Small, cheap, strictly-JSON call used for classification work. */
export async function classify(prompt: string, fallback: Record<string, unknown>) {
  try {
    const r = await chat({
      model: MODEL_CLASSIFY,
      messages: [
        {
          role: "system",
          content:
            "You are a precise classifier for a hotel messaging platform. Reply with a single minified JSON object and nothing else.",
        },
        { role: "user", content: prompt },
      ],
      maxTokens: 200,
    });
    const raw = r.choices[0]?.message?.content ?? "";
    const match = raw.match(/\{[\s\S]*\}/);
    return match ? { ...fallback, ...JSON.parse(match[0]) } : fallback;
  } catch {
    return fallback;
  }
}
