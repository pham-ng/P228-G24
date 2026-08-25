import "dotenv/config";
import { storage } from "./server/storage";
import { runAgent } from "./server/agent";

async function main() {
  console.log("=== RUNNING WIZARD TEST SUITE ===");

  // 1. Create a test guest & conversation
  const guest = storage.createGuest({
    name: "Wizard Test Guest",
    phone: `+84999${Date.now()}`,
    lang: "vi",
  });

  const hotel = storage.getHotel(1)!;

  // Create a test reservation
  const confirmationCode = `WIZ-${Date.now()}`;
  const res = storage.createReservation({
    hotelId: hotel.id,
    guestId: guest.id,
    confirmationCode,
    checkIn: "2026-09-01",
    checkOut: "2026-09-03",
    checkOutTime: "12:00",
    adults: 2,
    children: 0,
    ratePerNight: 2000000,
    status: "confirmed",
  });

  const conv = storage.createConversation({
    hotelId: hotel.id,
    guestId: guest.id,
    reservationId: res.id,
    channel: "webchat",
    lastMessageAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  });

  // 2. Add history simulating a quoted cancellation
  storage.addMessage({
    conversationId: conv.id,
    role: "guest",
    body: `Tôi muốn hủy đặt phòng ${confirmationCode}`,
    createdAt: new Date().toISOString(),
  });

  storage.addMessage({
    conversationId: conv.id,
    role: "ai",
    body: `Dạ, phí hủy đặt phòng ${confirmationCode} của bạn là 0 ₫ và số tiền hoàn lại là 4.000.000 ₫. Bạn có xác nhận đồng ý hủy không ạ?`,
    toolTrace: JSON.stringify([
      {
        name: "quote_cancellation",
        args: { target: "reservation", confirmation_code: confirmationCode },
        result: { fee: 0, refund: 4000000, allowed: true },
      },
    ]),
    createdAt: new Date().toISOString(),
  });

  // 3. Guest confirms
  storage.addMessage({
    conversationId: conv.id,
    role: "guest",
    body: "Tôi đồng ý hủy",
    createdAt: new Date().toISOString(),
  });

  process.env.LLM_MODE = "local";

  // 4. Run Agent with Form Wizard enabled
  const agentRes = await runAgent(conv.id);

  console.log("Agent Reply:", agentRes.reply);
  console.log("Served By:", agentRes.servedBy);
  console.log("Failed Over:", agentRes.failedOver);
  console.log("Tool Trace:", JSON.stringify(agentRes.trace, null, 2));

  // Check updated reservation status in DB
  const updatedRes = storage.getReservationByCode(confirmationCode)!;
  console.log("Updated Reservation Status:", updatedRes.status);

  if (updatedRes.status === "cancelled") {
    console.log("\n✅ WIZARD TEST PASSED: Form Wizard correctly intercepted and committed cancellation!");
  } else {
    console.error("\n❌ WIZARD TEST FAILED: Reservation status was not updated to cancelled.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Test Error:", e);
  process.exit(1);
});
