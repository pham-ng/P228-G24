import readline from "node:readline";
import { storage, nowIso } from "./server/storage";
import { runAgent } from "./server/agent";

async function main() {
  console.log("\n=======================================================");
  console.log("  🤖 AUREA AI CONCIERGE - TERMINAL CHAT TESTER  ");
  console.log(`  Mode: ${process.env.LLM_MODE || "local"} | Model: ${process.env.LOCAL_AGENT_MODEL || "qwen3.5:4b"}`);
  console.log("=======================================================\n");

  // Create a clean demo conversation for terminal testing
  const resList = storage.listReservations();
  const r = resList[0] || { id: 1, hotelId: 1, guestId: 1 };
  
  let conv = storage.createConversation({
    hotelId: r.hotelId,
    guestId: r.guestId,
    reservationId: r.id,
    channel: "webchat",
    mode: "ai",
    assignedStaffId: null,
    sentiment: "neutral",
    topic: null,
    unreadForStaff: 0,
    lastMessageAt: nowIso(),
    createdAt: nowIso(),
    firstResponseSeconds: null,
  });

  const guest = storage.getGuest(conv.guestId);
  console.log(`👤 Guest: ${guest?.name || "Nguyễn Thanh Hà"} (Platinum VIP)`);
  console.log(`💡 Gõ câu hỏi của bạn (hoặc gõ 'exit' để thoát, 'clear' để xóa lịch sử chat):\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const promptUser = () => {
    rl.question("\n💬 Bạn: ", async (input) => {
      const text = input.trim();
      if (!text) return promptUser();
      
      if (text.toLowerCase() === "exit") {
        console.log("👋 Đã thoát Terminal Chat.");
        process.exit(0);
      }

      if (text.toLowerCase() === "clear") {
        conv = storage.createConversation({
          hotelId: r.hotelId,
          guestId: r.guestId,
          reservationId: r.id,
          channel: "webchat",
          mode: "ai",
          assignedStaffId: null,
          sentiment: "neutral",
          topic: null,
          unreadForStaff: 0,
          lastMessageAt: nowIso(),
          createdAt: nowIso(),
          firstResponseSeconds: null,
        });
        console.log("🧹 Đã làm mới cuộc hội thoại!");
        return promptUser();
      }

      // Add guest message
      storage.addMessage({
        conversationId: conv.id,
        role: "guest",
        authorName: null,
        body: text,
        toolTrace: null,
        latencyMs: null,
        createdAt: nowIso(),
      });

      console.log("⏳ Aurea Agent đang suy luận và gọi Tool (xin chờ)...");
      const startTime = Date.now();

      try {
        const result = await runAgent(conv.id);
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

        storage.addMessage({
          conversationId: conv.id,
          role: "ai",
          authorName: "Aurea Agent",
          body: result.reply,
          toolTrace: result.trace.length ? JSON.stringify(result.trace) : null,
          latencyMs: result.latencyMs,
          createdAt: nowIso(),
        });

        console.log(`\n🤖 Aurea Concierge (${duration}s):`);
        console.log("-------------------------------------------------------");
        console.log(result.reply);
        console.log("-------------------------------------------------------");

        if (result.trace.length > 0) {
          console.log(`🛠️ Tools đã dùng (${result.trace.length}):`, result.trace.map((t: any) => t.name).join(", "));
        } else {
          console.log("ℹ️ Trả lời trực tiếp từ RAG Knowledge (0 tool calls).");
        }
      } catch (err: any) {
        console.error(`❌ Lỗi suy luận: ${err?.message || err}`);
      }

      promptUser();
    });
  };

  promptUser();
}

main().catch(console.error);
