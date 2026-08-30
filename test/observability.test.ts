/**
 * Observability unit + integration tests.
 *
 * Runs WITHOUT an LLM or the hosted API: the signal logic is pure, and the trace
 * persistence is exercised against a throwaway SQLite file. That is the whole
 * point of keeping derivation pure — the meaning of "tool_needs_input" is pinned
 * here, so the live server and the benchmark cannot drift on what a fault is.
 *
 *   npx tsx test/observability.test.ts
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The storage module opens its database at import time from DB_FILE, so a fresh
// throwaway path must be set before anything pulls storage in (transitively via
// observability). ESM evaluates imports first, hence the dynamic imports below.
process.env.DB_FILE = join(mkdtempSync(join(tmpdir(), "aurea-obs-")), "obs.db");

let failures = 0;
function ok(cond: boolean, msg: string) {
  if (cond) console.log(`  PASS  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}
function has(sigs: Array<{ code: string }>, code: string): boolean {
  return sigs.some((s) => s.code === code);
}

async function main() {
  const obs = await import("../server/observability");
  const { migrate, storage } = await import("../server/storage");
  migrate();

  console.log("=== OBSERVABILITY: pure signal derivation ===");

  // A tool that returned an error.
  ok(
    has(obs.deriveToolSignals({ name: "get_folio", args: {}, result: { error: "No reservation linked." } }), "tool_error"),
    "error result -> tool_error",
  );

  // The unknown-tool error is distinguished from an ordinary tool error.
  const unknown = obs.deriveToolSignals({ name: "teleport", args: {}, result: { error: "Unknown tool teleport" } });
  ok(has(unknown, "unknown_tool") && !has(unknown, "tool_error"), "unknown tool -> unknown_tool (not tool_error)");

  // Called before the required facts were supplied.
  ok(
    has(obs.deriveToolSignals({ name: "create_reservation", args: {}, result: { created: false, must_ask_the_guest_for: ["full name"] } }), "tool_needs_input"),
    "must_ask_the_guest_for -> tool_needs_input",
  );

  // Impossible request as stated.
  ok(
    has(obs.deriveToolSignals({ name: "check_availability", args: {}, result: { bookable: false, problems_to_explain: ["reversed dates"] } }), "tool_blocked"),
    "problems_to_explain -> tool_blocked",
  );

  // Retrieval health read off search_knowledge's own shape.
  ok(
    has(obs.deriveToolSignals({ name: "search_knowledge", args: {}, result: { strategy: "bm25-only (embedding unavailable)", results: [{}] } }), "retrieval_degraded"),
    "bm25-only strategy -> retrieval_degraded",
  );
  ok(
    has(obs.deriveToolSignals({ name: "search_knowledge", args: {}, result: { strategy: "bm25+embedding-rrf", results: [] } }), "retrieval_empty"),
    "zero results -> retrieval_empty",
  );
  ok(
    !has(obs.deriveToolSignals({ name: "search_knowledge", args: {}, result: { strategy: "bm25+embedding-rrf", results: [{}] } }), "retrieval_degraded"),
    "healthy hybrid search -> no retrieval signal",
  );
  ok(
    !has(obs.deriveToolSignals({ name: "search_knowledge", args: {}, result: { strategy: "bm25-only (vector leg disabled)", results: [{}] } }), "retrieval_degraded"),
    "deliberately-disabled vector leg -> NOT flagged as degraded",
  );

  // Loop detection.
  ok(
    has(obs.deriveToolSignals({ name: "get_folio", args: {}, result: { balance_due: 1 }, isRepeat: true }), "tool_repeat"),
    "isRepeat -> tool_repeat",
  );

  // Empty results.
  ok(has(obs.deriveToolSignals({ name: "x", args: {}, result: "" }), "empty_tool_result"), "empty string -> empty_tool_result");

  // A clean success produces nothing.
  ok(obs.deriveToolSignals({ name: "get_stay_details", args: {}, result: { room: "V03" } }).length === 0, "clean result -> no signals");

  console.log("=== OBSERVABILITY: router signals ===");
  ok(has(obs.deriveRouterSignals({ guessed: true }), "router_guessed"), "guessed -> router_guessed");
  ok(has(obs.deriveRouterSignals({ dropped: ["stay_changes"] }), "family_dropped"), "dropped family -> family_dropped");
  ok(obs.deriveRouterSignals({}).length === 0, "clean selection -> no router signal");

  console.log("=== OBSERVABILITY: language mismatch (conservative) ===");
  ok(
    obs.detectLanguageMismatch("vi", "The Deluxe rooms range from 2,200,000 to 2,870,000 per night depending on the view.") != null,
    "vi guest + long English reply -> language_mismatch",
  );
  ok(
    obs.detectLanguageMismatch("vi", "Dạ, các loại phòng Deluxe dao động từ 2.200.000 đến 2.870.000 mỗi đêm tùy hướng ạ.") == null,
    "vi guest + Vietnamese reply -> no signal",
  );
  ok(obs.detectLanguageMismatch("vi", "OK") == null, "short reply -> no signal (avoids false positive)");
  ok(obs.detectLanguageMismatch("en", "The rooms are lovely and spacious with an ocean view.") == null, "en guest -> no signal");

  console.log("=== OBSERVABILITY: signature + status helpers ===");
  ok(
    obs.toolSignature("t", { a: 1, b: 2 }) === obs.toolSignature("t", { b: 2, a: 1 }),
    "toolSignature is stable across key order",
  );
  ok(obs.worstStatus([obs.signal("router_guessed"), obs.signal("tool_error")]) === "error", "worstStatus picks error");
  ok(obs.worstStatus([obs.signal("family_dropped")]) === "warn", "worstStatus picks warn");
  ok(obs.worstStatus([obs.signal("router_guessed")]) === "ok", "worstStatus: info does not elevate status");
  ok(obs.worstStatus([]) === "ok", "worstStatus baseline ok");

  console.log("=== OBSERVABILITY: Trace persistence round-trip ===");
  const tr = new obs.Trace(4242, { provider: "openai", model: "gpt-test" });
  const llm = tr.startSpan("llm.chat.round0", "llm", { round: 0 });
  llm.setAttributes({ tool_calls_requested: 1 }).end();
  const toolSpan = tr.startSpan("tool.get_folio", "tool", { args: {} });
  toolSpan.addSignals(obs.deriveToolSignals({ name: "get_folio", args: {}, result: { error: "No reservation linked." } }));
  toolSpan.end();
  const traceId = tr.flush({ path: "agent", latency_ms: 1234 });

  const spans = storage.getTraceSpans(traceId);
  ok(spans.length === 3, `all 3 spans persisted (got ${spans.length})`);
  const root = spans.find((s) => s.kind === "turn")!;
  ok(!!root && root.status === "error", "root turn status rolled up to error");
  ok(has(JSON.parse(root.signals), "tool_error"), "root turn carries rolled-up tool_error");
  ok(storage.listRecentTurns(10).some((t) => t.traceId === traceId), "turn appears in listRecentTurns");
  ok(storage.listTurnsForConversation(4242).length === 1, "turn is queryable by conversation");

  console.log("=== OBSERVABILITY: aggregation ===");
  const since = new Date(Date.now() - 3600_000).toISOString();
  const all = storage.spansSince(since);
  const agg = obs.aggregateSignals(
    all.filter((s) => s.kind === "turn"),
    all.filter((s) => s.kind === "tool").map((s) => ({ name: s.name, status: s.status, signals: s.signals })),
  );
  ok(agg.turns >= 1, "aggregate counts at least one turn");
  ok((agg.signalCounts.tool_error ?? 0) >= 1, "aggregate counts the tool_error");
  ok(agg.toolTrouble["get_folio"]?.faults === 1, "aggregate attributes the fault to get_folio");
  ok(typeof agg.latencyMs.p95 === "number", "aggregate reports a p95 latency");

  console.log("=== MESSAGE LANGUAGE DETECTION ===");
  /* A guest's stored profile is not their current language. This detector exists
     because a Vietnamese message from a guest whose profile said Chinese was
     being answered in Chinese — the profile out-argued the message. */
  const { detectMessageLang } = await import("../server/agent");
  ok(detectMessageLang("Vợ chồng tôi đi tuần trăng mật") === "vi", "Vietnamese diacritics -> vi");
  ok(detectMessageLang("我想延迟退房") === "zh", "Han script -> zh");
  ok(detectMessageLang("레이트 체크아웃 가능한가요?") === "ko", "Hangul -> ko");
  ok(detectMessageLang("チェックアウトは何時ですか") === "ja", "Kana -> ja");
  /* Regression: this used to return null for plain ASCII, and the caller's
     fallback for null lost to the guest's stored profile line in the prompt —
     measured on a 105-case hosted benchmark, 9/13 English cases came back in
     Vietnamese. Plain ASCII Latin text is now treated as English. */
  ok(detectMessageLang("Can I get a late checkout?") === "en", "plain ASCII Latin -> en");
  ok(detectMessageLang("I land at 8am. How much to check in early?") === "en", "ASCII with digits/punctuation -> en");
  ok(detectMessageLang("What time does the pool close?") === "en", "ASCII question -> en");
  /* Accented Latin script still falls through to null when its accented
     characters are not shared with Vietnamese — German ö/ü/ä are not, so this
     is unaffected by either the vi check or the new en check. */
  ok(detectMessageLang("Können wir früher einchecken?") === null, "accented Latin (German) -> null, unchanged");
  /* NOT fixed here, and pre-existing: French/Spanish/Portuguese use the same
     acute/grave/tilde vowels as Vietnamese (é, à, ù…), so the vi check — which
     runs before the new en check and is unchanged by this fix — claims them.
     "Où est la piscine?" reads as Vietnamese today. Out of scope for this pass;
     worth its own fix if French/Spanish guests show up in real traffic. */
  ok(detectMessageLang("Où est la piscine?") === "vi", "French collides with the vi check (pre-existing, undocumented until now)");
  ok(detectMessageLang("") === null, "empty message -> null");
  ok(detectMessageLang("123") === null, "digits with no letters -> null, not enough signal");
  /* Korean and Japanese both contain Han characters; script order must not
     misclassify them as Chinese. */
  ok(detectMessageLang("체크아웃 時間") === "ko", "Hangul wins over stray Han");

  console.log("=== LANGFUSE: batch builder (pure, no network) ===");
  /**
   * Điều khiển môi trường, đừng ĐỌC nó.
   *
   * Hai phép kiểm này từng khẳng định "Langfuse tắt theo mặc định" và đọc thẳng
   * `process.env`. Chúng xanh suốt — cho tới khi có người thật sự cấu hình
   * Langfuse, và rồi cả bộ kiểm thử đỏ vì SẢN PHẨM ĐÃ ĐƯỢC BẬT ĐÚNG CÁCH. Một
   * bài kiểm thử mà kết quả phụ thuộc vào việc người vận hành đã cấu hình gì
   * thì không kiểm được gì cả.
   *
   * Giờ nó xoá khoá đi rồi mới hỏi, và trả lại nguyên trạng sau đó.
   */
  const khoaCu = { pk: process.env.LANGFUSE_PUBLIC_KEY, sk: process.env.LANGFUSE_SECRET_KEY };
  delete process.env.LANGFUSE_PUBLIC_KEY;
  delete process.env.LANGFUSE_SECRET_KEY;
  const lf = await import("../server/langfuse");
  ok(lf.langfuseEnabled() === false, "không có khoá thì Langfuse tắt — mặc định an toàn");

  const now = new Date().toISOString();
  const exportSpans: any[] = [
    { id: "root", traceId: "tr_x", conversationId: 7, parentId: null, name: "agent.turn", kind: "turn", status: "error", startedAt: now, endedAt: now, durationMs: 100, attributes: { path: "agent" }, signals: [{ code: "tool_error", severity: "error" }] },
    { id: "s_llm", traceId: "tr_x", conversationId: 7, parentId: "root", name: "llm.chat.round0", kind: "llm", status: "ok", model: "gpt-test", startedAt: now, endedAt: now, durationMs: 40, attributes: {}, signals: [] },
    { id: "s_tool", traceId: "tr_x", conversationId: 7, parentId: "root", name: "tool.get_folio", kind: "tool", status: "error", startedAt: now, endedAt: now, durationMs: 5, attributes: {}, signals: [{ code: "tool_error", severity: "error", detail: "No reservation" }] },
  ];
  const batch = lf.buildIngestionBatch(exportSpans);
  const trace = batch.find((e: any) => e.type === "trace-create") as any;
  const gen = batch.find((e: any) => e.type === "generation-create") as any;
  const span = batch.find((e: any) => e.type === "span-create") as any;

  ok(!!trace && trace.body.id === "tr_x", "root turn -> trace-create with trace id");
  ok(Array.isArray(trace.body.tags) && trace.body.tags.includes("tool_error"), "trace tags carry signal codes");
  ok(!!gen && gen.body.model === "gpt-test", "llm span -> generation-create with model");
  ok(gen.body.parentObservationId === undefined, "direct child of root has no parentObservationId (hangs off trace)");
  ok(!!span && span.body.level === "ERROR", "error tool span -> span-create at level ERROR");
  ok(span.body.statusMessage?.includes("tool_error"), "span statusMessage derived from worst signal");
  ok(lf.buildIngestionBatch([]).length === 0, "no root -> empty batch (nothing sent half-formed)");
  ok(lf.langfuseConfig().enabled === false, "langfuseConfig báo là đang tắt");

  /* Và bật lên được khi CÓ khoá — nửa còn lại của phép kiểm, trước đây thiếu. */
  const khoaGia = "pk-lf-0123456789abcdef";
  process.env.LANGFUSE_PUBLIC_KEY = khoaGia;
  process.env.LANGFUSE_SECRET_KEY = "sk-lf-0123456789abcdef";
  ok(lf.langfuseEnabled() === true, "có khoá thì bật — cấu hình được đọc lại mỗi lần, không cache lúc nạp module");

  /* Che nghĩa là GIẤU KHÚC GIỮA, không phải giấu sạch: bốn ký tự cuối để người
     vận hành đối chiếu được với khoá trong bảng điều khiển Langfuse. Phép kiểm
     đầu tôi viết đòi chuỗi che không chứa "test", mà khoá giả lại kết thúc bằng
     "test" — kiểm sai, code đúng. */
  const che = lf.langfuseConfig().publicKeyMasked;
  ok(che !== khoaGia, "chuỗi hiển thị KHÁC khoá thật");
  ok(!che.includes("0123456789"), "khúc giữa bị giấu");
  ok(che.endsWith("cdef"), "vẫn để lộ 4 ký tự cuối để đối chiếu");
  ok(lf.langfuseConfig().hasSecret === true && !JSON.stringify(lf.langfuseConfig()).includes("sk-lf-"), "khoá BÍ MẬT không bao giờ lọt ra, kể cả dạng che");

  /* Trả môi trường về đúng như lúc nhận. */
  if (khoaCu.pk) process.env.LANGFUSE_PUBLIC_KEY = khoaCu.pk;
  else delete process.env.LANGFUSE_PUBLIC_KEY;
  if (khoaCu.sk) process.env.LANGFUSE_SECRET_KEY = khoaCu.sk;
  else delete process.env.LANGFUSE_SECRET_KEY;

  console.log(failures === 0 ? "\nALL OBSERVABILITY TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
