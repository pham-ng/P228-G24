/**
 * Verifies the failover router: order, breaker, what does and does not fail
 * over, cost-saving routing, and the pinned embedding provider.
 *
 * Two mock OpenAI-compatible servers stand in for the hosted API and the local
 * model, so failover is exercised for real rather than asserted.
 */
import { createServer, type Server } from "node:http";

type Hit = { url: string; body: any };
type Mock = { port: number; hits: Hit[]; mode: string; srv: Server };

async function mock(port: number): Promise<Mock> {
  const m = { port, hits: [] as Hit[], mode: "ok" } as Mock;
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      m.hits.push({ url: req.url!, body });
      const fail = (code: number, msg: string) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: msg } }));
      };
      if (m.mode === "down") return fail(503, "service unavailable");
      if (m.mode === "quota") return fail(429, "rate limit exceeded");
      if (m.mode === "badreq") return fail(400, "unknown parameter 'tools'");
      if (m.mode === "dead") return req.socket.destroy();
      if (req.url?.includes("/embeddings")) {
        const n = (body.input as string[]).length;
        const dim = port === 8091 ? 1536 : 384;
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(
          JSON.stringify({
            data: Array.from({ length: n }, (_, i) => ({ index: i, embedding: new Array(dim).fill(0.1) })),
          }),
        );
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: `served by ${port}` }, finish_reason: "stop" }],
        }),
      );
    });
  });
  await new Promise<void>((r) => srv.listen(port, "127.0.0.1", r));
  m.srv = srv;
  return m;
}

const api = await mock(8091); // stands in for api.openai.com
const loc = await mock(8092); // stands in for llama-server / Ollama

process.env.LLM_MODE = "auto";
process.env.CUSTOM_CRED_API_OPENAI_COM_URL = "http://127.0.0.1:8091";
process.env.CUSTOM_CRED_API_OPENAI_COM_TOKEN = "tok";
process.env.LOCAL_LLM_BASE = "http://127.0.0.1:8092";
process.env.LOCAL_EMBED_BASE = "http://127.0.0.1:8092";
process.env.LLM_API_TIMEOUT_MS = "1000";
process.env.LLM_BREAKER_FAILS = "3";
process.env.LLM_BREAKER_COOLDOWN_MS = "1500";

/* Node >=23 runs TypeScript directly but needs the explicit extension, while
   tsx resolves the extensionless form. Taking the specifier from the
   environment lets one test file run under both:
     npx tsx llmtest-router.ts
     LLM_SPEC=./server/llm.ts node llmtest-router.ts
   The `typeof import` cast keeps full type checking despite the dynamic call. */
const llm = (await import(process.env.LLM_SPEC ?? "./server/llm")) as typeof import("./server/llm");

let failed = 0;
const pass = (b: boolean, m: string) => {
  if (!b) failed++;
  console.log((b ? "  PASS  " : "  FAIL  ") + m);
};
const ask = (o: any = {}) => llm.chat({ messages: [{ role: "user", content: "hi" }], ...o });
const reset = () => {
  api.hits.length = 0;
  loc.hits.length = 0;
};

console.log(`mode=${llm.MODE} primary=${llm.PRIMARY} fallback=${llm.FALLBACK} embed=${llm.EMBED_PROVIDER}\n`);
pass(llm.MODE === "auto" && llm.PRIMARY === "openai" && llm.FALLBACK === "local", "auto mode = API primary, local fallback");
pass(llm.EMBED_PROVIDER === "local", "embeddings pin to local when a local embed endpoint exists");

/* 1. healthy API answers, local is never touched */
reset();
let r = await ask();
pass(r.servedBy === "openai" && !r.failedOver && loc.hits.length === 0, "healthy API serves; local model untouched");

/* 2. API down -> failover to local */
reset();
api.mode = "down";
r = await ask();
pass(r.servedBy === "local" && r.failedOver === true, "API 503 fails over to the local model");
pass(api.hits.length === 1 && loc.hits.length === 1, "exactly one attempt per provider, no retry storm");

/* 3. quota exhausted is a failover case -- the business reason for local */
reset();
api.mode = "quota";
r = await ask();
pass(r.servedBy === "local", "API 429 (quota/budget exhausted) falls over to local");

/* 4. our own bad request must NOT be hidden by failover */
reset();
llm.resetHealth();
api.mode = "badreq";
try {
  await ask();
  pass(false, "a 400 should surface, not fail over");
} catch (e: any) {
  pass(loc.hits.length === 0 && /400/.test(e.message), `a 400 surfaces as our bug, local not called (${e.message.slice(0, 46)})`);
}

/* 5. breaker: after 3 consecutive failures the API is skipped entirely */
reset();
llm.resetHealth();
api.mode = "down";
for (let i = 0; i < 3; i++) await ask();
const hitsAfterTrip = api.hits.length;
await ask();
await ask();
pass(api.hits.length === hitsAfterTrip, `breaker opens after 3 failures; API not called again (${hitsAfterTrip} calls, then none)`);
pass(llm.providerHealth().openai.available === false, "health snapshot reports the API as unavailable");
pass(loc.hits.length === 5, "every turn still answered, all five by the local model");

/* 6. a tripped breaker costs no wall-clock: no timeout is paid */
api.mode = "dead"; // would hang/reset if actually contacted
const t0 = Date.now();
await ask();
pass(Date.now() - t0 < 400, `a turn during the outage is fast (${Date.now() - t0}ms), no timeout paid`);

/* 7. breaker recovers after the cooldown */
api.mode = "ok";
await new Promise((r) => setTimeout(r, 1600));
reset();
r = await ask();
pass(r.servedBy === "openai" && api.hits.length === 1, "after cooldown the API is probed again and resumes serving");

/* 8. preferLocal routes to local to save API spend, even with a healthy API */
reset();
r = await ask({ preferLocal: true });
pass(r.servedBy === "local" && api.hits.length === 0, "preferLocal keeps a simple turn off the paid API");

/* 9. pinning a provider disables failover (needed by the benchmark) */
reset();
api.mode = "down";
try {
  await ask({ provider: "openai" });
  pass(false, "a pinned provider should not fail over");
} catch {
  pass(loc.hits.length === 0, "a pinned provider never falls back, so the benchmark measures what it names");
}
api.mode = "ok";

/* 10. the per-provider model name follows the provider after failover */
reset();
llm.resetHealth();
process.env.OPENAI_AGENT_MODEL = "gpt-5.4-mini";
process.env.LOCAL_AGENT_MODEL = "qwen3.5-4b";
api.mode = "down";
r = await ask();
pass(
  loc.hits[0].body.model === "qwen3.5-4b" && r.model === "qwen3.5-4b",
  `the local server receives its own model name, not OpenAI's (${loc.hits[0].body.model})`,
);

/* 11. classify picks the per-provider classify model, not the agent model */
reset();
llm.resetHealth();
api.mode = "ok";
process.env.OPENAI_CLASSIFY_MODEL = "gpt-5.4-nano";
await llm.classify("is this urgent?", { urgent: false });
pass(api.hits[0].body.model === "gpt-5.4-nano", `classify uses the small model (${api.hits[0].body.model})`);

/* 12. field names still follow the provider that actually served */
reset();
api.mode = "down";
llm.resetHealth();
await ask({ maxTokens: 50 });
pass(
  api.hits[0].body.max_completion_tokens === 50 && loc.hits[0].body.max_tokens === 50,
  "each provider gets its own token-cap field name across a failover",
);
pass(loc.hits[0].body.temperature === 0, "the local leg still gets temperature 0 after failover");

/* 13. embeddings never fail over -- vector spaces are not interchangeable */
reset();
api.mode = "ok";
loc.mode = "down";
try {
  await llm.embed(["xin chao"]);
  pass(false, "a down embedding server should throw, not fail over");
} catch (e: any) {
  pass(
    api.hits.filter((h) => h.url.includes("embeddings")).length === 0,
    "embeddings do NOT fail over to the API, so retrieval drops to BM25 instead of mixing 384-dim and 1536-dim vectors",
  );
}
loc.mode = "ok";

/* 14. probe targets one named provider and warms it */
reset();
const pl = await llm.probe("local");
pass(pl.provider === "local" && pl.reachable && pl.model === "qwen3.5-4b", "probe('local') checks and warms the offline path");
const all = await llm.probeAll();
pass(all.length === 2, "probeAll covers both paths so a missing local model is visible at boot");

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
api.srv.close();
loc.srv.close();
process.exit(failed === 0 ? 0 : 1);
