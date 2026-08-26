import "dotenv/config";
import { writeFileSync } from "node:fs";
import { chat, type ChatMessage, type ToolSpec } from "../server/llm";
import { migrate, storage } from "../server/storage";
import { runLocalTurn } from "../server/local-agent";

/**
 * Phase 10A spike: can qwen2.5:3b reliably call ONE small read-only tool?
 * Exposes only list_services (1 required arg, 1 optional) — not the 30+ tool
 * catalog — to isolate the question "can a 3B model call a small tool set"
 * from "can it survive a 30-schema prompt" (already answered: no, per the
 * cited research in local-agent.ts's header comment).
 */

const LIST_SERVICES_TOOL: ToolSpec = {
  type: "function",
  function: {
    name: "list_services",
    description:
      "List bookable services with live prices and available time slots. Categories: dining, spa, experience, transport, roomservice. DO NOT use for hotel room prices or room types.",
    parameters: {
      type: "object",
      properties: {
        category: { type: "string", enum: ["dining", "spa", "experience", "transport", "roomservice", "all"] },
        date: { type: "string", description: "YYYY-MM-DD to check remaining capacity for. Defaults to today." },
      },
      required: ["category"],
    },
  },
};

const SYSTEM = `Bạn là lễ tân khách sạn. Khi khách hỏi về giá/dịch vụ đặt được (ăn uống, spa, trải nghiệm, vận chuyển, phục vụ phòng), hãy gọi tool list_services với category đúng. Nếu không rõ khách muốn loại dịch vụ nào, hỏi lại thay vì đoán category. Đừng gọi tool này cho câu hỏi về LOẠI PHÒNG hay GIÁ PHÒNG khách sạn — đó không phải dịch vụ.`;

type Case = {
  id: string;
  lang: string;
  q: string;
  kind: "straightforward" | "paraphrase" | "missing_arg" | "ambiguous" | "wrong_tool_trap" | "mapping";
  expectToolCall: boolean;
  expectCategory?: string;
  note: string;
};

const CASES: Case[] = [
  { id: "t1-airport-vi", lang: "vi", q: "Giá đưa đón sân bay bao nhiêu?", kind: "straightforward", expectToolCall: true, expectCategory: "transport", note: "known-failing case from ANSWERABLE_FROM_TOOL" },
  { id: "t2-airport-paraphrase-vi", lang: "vi", q: "Xe đưa đón từ sân bay Cam Ranh về khách sạn giá thế nào?", kind: "paraphrase", expectToolCall: true, expectCategory: "transport", note: "paraphrase of t1" },
  { id: "t3-airport-en", lang: "en", q: "How much does the airport pickup cost?", kind: "straightforward", expectToolCall: true, expectCategory: "transport", note: "known-failing case, English" },
  { id: "t4-cablecar-mapping-vi", lang: "vi", q: "Giá cáp treo qua đảo là bao nhiêu?", kind: "mapping", expectToolCall: true, expectCategory: "transport", note: "tests whether 'cáp treo' maps to category=transport, not a made-up category" },
  { id: "t5-buggy-mapping-vi", lang: "vi", q: "Xe điện trong khu nghỉ dưỡng có tính phí không?", kind: "mapping", expectToolCall: true, expectCategory: "transport", note: "electric buggy is complimentary — tests it doesn't fabricate a price" },
  { id: "t6-spa-vi", lang: "vi", q: "Cho tôi biết giá các liệu trình spa", kind: "straightforward", expectToolCall: true, expectCategory: "spa", note: "different category, same tool" },
  { id: "t7-spa-en", lang: "en", q: "What spa treatments are available and how much do they cost?", kind: "straightforward", expectToolCall: true, expectCategory: "spa", note: "English, spa" },
  { id: "t8-ambiguous-vi", lang: "vi", q: "Dịch vụ ở đây giá bao nhiêu?", kind: "ambiguous", expectToolCall: false, note: "no category signal at all — should clarify, not guess/default to 'all' silently claiming completeness" },
  { id: "t9-room-trap-vi", lang: "vi", q: "Phòng Deluxe giá bao nhiêu một đêm?", kind: "wrong_tool_trap", expectToolCall: false, note: "room price — tool description explicitly says do not use for rooms; correct behavior is NOT calling this tool" },
  { id: "t10-dining-zh", lang: "zh", q: "晚餐自助餐多少钱？", kind: "straightforward", expectToolCall: true, expectCategory: "dining", note: "Chinese, dining" },
  { id: "t11-experience-ko", lang: "ko", q: "베이비시터 서비스 요금이 얼마인가요?", kind: "straightforward", expectToolCall: true, expectCategory: "experience", note: "Korean — actually babysitting isn't in list_services categories as a distinct item; tests graceful category mapping" },
  { id: "t12-transfer-ja", lang: "ja", q: "空港送迎はいくらですか？", kind: "straightforward", expectToolCall: true, expectCategory: "transport", note: "Japanese, airport transfer" },
];

function svc(hotel: any, guest: any, res: any, room: any) {
  return { conv: null as any, hotel, guest, res, room };
}

async function callListServicesReal(category: string, date: string, hotel: any, guest: any) {
  const list = storage.listServices().filter((s) => category === "all" || s.category === category);
  return {
    date,
    currency: hotel.currency,
    services: list.map((s) => ({ service_id: s.id, name: s.name, category: s.category, price: s.price, unit: s.unit })),
  };
}

function templateAnswer(toolResult: any, lang: string): string {
  const lines = toolResult.services
    .slice(0, 5)
    .map((s: any) => `${s.name}: ${s.price > 0 ? s.price.toLocaleString("vi-VN") + " " + toolResult.currency : "miễn phí"}`);
  return lines.join("; ");
}

async function main() {
  migrate();
  const hotel = storage.getHotel();
  const res = storage.listReservations().find((r) => r.confirmationCode === "VPNT-2M77VD")!;
  const guest = storage.getGuest(res.guestId)!;
  const today = new Date().toISOString().slice(0, 10);

  const results: any[] = [];

  // --- control: zero-tool baseline latency (existing RAG path, no tools at all)
  const t0 = Date.now();
  await runLocalTurn({ question: "Spa mở cửa mấy giờ?", isEmergency: false, lang: "vi" });
  const controlMs = Date.now() - t0;
  console.log("CONTROL (no-tool RAG baseline):", controlMs, "ms\n");

  for (const c of CASES) {
    console.log(`--- ${c.id} [${c.lang}] "${c.q}"`);
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM },
      { role: "user", content: c.q },
    ];
    const tCall1 = Date.now();
    let r1: any;
    try {
      r1 = await chat({ messages, tools: [LIST_SERVICES_TOOL], maxTokens: 200 });
    } catch (e: any) {
      console.log(`  (transient error, retrying once: ${e.message})`);
      await new Promise((res) => setTimeout(res, 500));
      r1 = await chat({ messages, tools: [LIST_SERVICES_TOOL], maxTokens: 200 });
    }
    const call1Ms = Date.now() - tCall1;
    const msg1 = r1.choices[0].message;
    const toolCalls = msg1.tool_calls ?? [];
    const calledTool = toolCalls[0]?.function?.name ?? null;
    let calledArgs: any = null;
    let argsParseError = false;
    if (toolCalls[0]) {
      try {
        calledArgs = JSON.parse(toolCalls[0].function.arguments);
      } catch {
        argsParseError = true;
      }
    }

    const row: any = {
      id: c.id,
      lang: c.lang,
      q: c.q,
      kind: c.kind,
      note: c.note,
      expectToolCall: c.expectToolCall,
      expectCategory: c.expectCategory ?? null,
      calledTool,
      calledArgs,
      argsParseError,
      directTextReply: msg1.content ?? null,
      call1Ms,
      call1PromptEvalMs: r1.timing?.promptEvalMs,
      call1PromptEvalTokens: r1.timing?.promptEvalTokens,
      call1EvalMs: r1.timing?.evalMs,
    };

    if (calledTool === "list_services" && calledArgs?.category) {
      const toolResult = await callListServicesReal(calledArgs.category, calledArgs.date ?? today, hotel, guest);
      row.toolResultServiceCount = toolResult.services.length;

      // ARCH-A: second LLM call to verbalize
      /* Ollama 0.32.15's native /api/chat cannot parse `tool_calls` echoed
       * back on an assistant message — every attempt fails with a cryptic
       * "Value looks like object, but can't find closing '}' symbol", even
       * for a minimal {function:{name,arguments}} with no other fields.
       * Confirmed via direct curl, isolated from this script entirely — a
       * real Ollama-version limitation, not an app bug. Workaround: skip the
       * assistant echo and append the tool result directly after the user
       * turn; verified this shape works and the model uses the injected
       * price correctly. */
      const messagesA: ChatMessage[] = [
        ...messages,
        { role: "tool", content: JSON.stringify(toolResult) },
      ];
      const tCall2 = Date.now();
      let r2: any;
      try {
        r2 = await chat({ messages: messagesA, maxTokens: 150 });
      } catch (e: any) {
        console.log(`  (transient error on call2, retrying once: ${e.message})`);
        await new Promise((res) => setTimeout(res, 500));
        r2 = await chat({ messages: messagesA, maxTokens: 150 });
      }
      const call2Ms = Date.now() - tCall2;
      row.archA_finalAnswer = r2.choices[0].message.content;
      row.archA_call2Ms = call2Ms;
      row.archA_call2PromptEvalMs = r2.timing?.promptEvalMs;
      row.archA_totalMs = call1Ms + call2Ms;

      // ARCH-B: deterministic template, zero extra LLM call
      row.archB_finalAnswer = templateAnswer(toolResult, c.lang);
      row.archB_totalMs = call1Ms;
    }

    console.log(JSON.stringify(row, null, 1).slice(0, 900));
    results.push(row);
  }

  writeFileSync(
    "bench/baselines/kiosk-validation/11-tool-spike-raw.json",
    JSON.stringify({ ranAt: new Date().toISOString(), controlMs, results }, null, 2),
  );
  console.log("\nwritten to bench/baselines/kiosk-validation/11-tool-spike-raw.json");
}
main();
