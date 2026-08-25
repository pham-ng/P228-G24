/**
 * Verifies the local-provider behaviour of llm.ts against a mock
 * OpenAI-compatible server: field names, temperature, timeout, JSON salvage.
 */
import { createServer } from "node:http";

const seen: any[] = [];
let mode = "ok";

const srv = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    const body = raw ? JSON.parse(raw) : {};
    seen.push({ url: req.url, body, auth: req.headers.authorization ?? null });

    if (mode === "hang") return; // never respond → exercise the timeout
    if (mode === "500") {
      res.writeHead(500, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "model not loaded" } }));
    }
    if (req.url?.includes("/embeddings")) {
      const n = (body.input as string[]).length;
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({ data: Array.from({ length: n }, (_, i) => ({ index: i, embedding: [i, 0.5] })) }),
      );
    }
    const content =
      mode === "messyjson"
        ? '<think>The guest seems annoyed, let me think...</think>\nSure!\n```json\n{"sentiment":"negative","escalate":true}\n```\nHope that helps.'
        : "pong";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content, tool_calls: undefined }, finish_reason: "stop" }] }));
  });
});

await new Promise<void>((r) => srv.listen(8099, "127.0.0.1", r));

process.env.LLM_MODE = "local";
process.env.LOCAL_LLM_BASE = "http://127.0.0.1:8099";
process.env.LOCAL_EMBED_BASE = "http://127.0.0.1:8099";
process.env.LLM_TIMEOUT_MS = "1200";


/* Node >=23 runs TypeScript directly but needs the explicit extension, while
   tsx resolves the extensionless form. Taking the specifier from the
   environment lets one test file run under both:
     npx tsx llmtest-router.ts
     LLM_SPEC=./server/llm.ts node llmtest-router.ts
   The `typeof import` cast keeps full type checking despite the dynamic call. */
const llm = (await import(process.env.LLM_SPEC ?? "./server/llm")) as typeof import("./server/llm");

const pass = (b: boolean, m: string) => console.log((b ? "  PASS  " : "  FAIL  ") + m);

console.log("provider =", llm.PROVIDER, "| base =", llm.LOCAL_BASE, "| model =", llm.MODEL_AGENT);
pass(llm.PROVIDER === "local", "LOCAL_LLM_BASE alone selects the local provider");

/* 1. field names + temperature */
await llm.chat({ messages: [{ role: "user", content: "hi" }], maxTokens: 64 });
const b1 = seen.at(-1)!.body;
pass(b1.max_tokens === 64, `local uses max_tokens (got ${JSON.stringify(b1.max_tokens)})`);
pass(b1.max_completion_tokens === undefined, "local does NOT send max_completion_tokens");
pass(b1.temperature === 0, `temperature defaults to 0 locally (got ${b1.temperature})`);
pass(seen.at(-1)!.auth === null, "no Authorization header sent to a local server");

/* 2. caller can override temperature */
await llm.chat({ messages: [{ role: "user", content: "hi" }], temperature: 0.7 });
pass(seen.at(-1)!.body.temperature === 0.7, "an explicit temperature is honoured");

/* 3. tools passthrough */
await llm.chat({
  messages: [{ role: "user", content: "hi" }],
  tools: [{ type: "function", function: { name: "t", description: "d", parameters: {} } }],
});
pass(seen.at(-1)!.body.tool_choice === "auto", "tools trigger tool_choice=auto");

/* 4. embeddings order */
const vecs = await llm.embed(["a", "b", "c"]);
pass(vecs.length === 3 && vecs[2][0] === 2, "embeddings return one vector per input, in order");

/* 5. messy JSON salvage */
mode = "messyjson";
const cls = await llm.classify("x", { sentiment: "neutral", escalate: false });
pass(
  cls.sentiment === "negative" && cls.escalate === true,
  `classify survives <think> + code fences (got ${JSON.stringify(cls)})`,
);

/* 6. server error surfaces the provider's message */
mode = "500";
try {
  await llm.chat({ messages: [{ role: "user", content: "hi" }] });
  pass(false, "a 500 should throw");
} catch (e: any) {
  pass(
    e instanceof llm.LlmError && /Local model 500/.test(e.message) && /model not loaded/.test(e.message),
    `a 500 becomes LlmError with the provider detail (${e.message})`,
  );
}

/* 7. classify never throws, even on a 500 */
const fb = await llm.classify("x", { sentiment: "neutral" });
pass(fb.sentiment === "neutral", "classify falls back instead of throwing");

/* 8. a stalled server hits the timeout instead of hanging forever */
mode = "hang";
const t0 = Date.now();
try {
  await llm.chat({ messages: [{ role: "user", content: "hi" }] });
  pass(false, "a hanging server should time out");
} catch (e: any) {
  const dt = Date.now() - t0;
  pass(
    e.status === 504 && dt < 3000,
    `a hanging server times out in ${dt}ms with status ${e.status}`,
  );
}

/* 9. probe reports unreachable rather than throwing */
mode = "500";
const p = await llm.probe();
pass(p.reachable === false && !!p.error, `probe reports unreachable cleanly (${p.error?.slice(0, 45)})`);

/* 10. extractJsonObject edge cases */
pass(Object.keys(llm.extractJsonObject("no json here")).length === 0, "extractJsonObject returns {} on prose");
pass(
  (llm.extractJsonObject('prefix {"a":{"b":2},"s":"}"} suffix') as any).s === "}",
  "extractJsonObject handles nested braces and braces inside strings",
);

srv.close();
process.exit(0);
