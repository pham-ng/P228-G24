/**
 * Does the upsell gate actually fire in the real tool?
 *
 * The unit tests prove `upsellAllowed` is right. They cannot prove it is
 * WIRED right — that the tool reads the conversation's real mode and sentiment,
 * that the guard flags reach it through `Ctx`, that a suppressed turn records
 * no impression, and that the cooldown reads back what the previous call wrote.
 * Every one of those is a join between modules that a pure test cannot see.
 *
 * Calls `runTool` directly against the live database: no model, no OpenAI
 * credit, no HTTP. Cleans up every row it creates.
 *
 *   npx tsx bench/upsell-gate-probe.ts
 */
import { storage, db } from "../server/storage";
import { runTool } from "../server/agent";
import { upsellImpressions } from "@shared/schema";
import { inArray } from "drizzle-orm";

let failures = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures++;
};

const before = new Set(storage.listUpsellImpressions().map((i) => i.id));
const newRows = () => storage.listUpsellImpressions().filter((i) => !before.has(i.id));

const conv = (id: number) => storage.getConversation(id)!;
const run = (id: number, extra: Record<string, unknown> = {}) =>
  runTool("suggest_experiences", {}, { conversation: conv(id), ...extra }) as Promise<any>;

/* Pick the conversations by the property under test rather than by id, so the
   probe still means something after the demo data is rebuilt. */
const all = storage.listConversations().filter((c) => c.reservationId);
const pick = (f: (c: any) => boolean) => all.find(f);

/* Must also be outside the cooldown, or the "is allowed" case tests nothing.
   The first draft of this probe picked conv#2, which had been shown an offer
   eight seconds after the guest last spoke — so it was correctly suppressed for
   `cooldown` and the probe read that as the gate being broken. */
const calm = pick((c) => c.mode === "ai" && c.sentiment !== "negative" && storage.lastUpsellAt(c.id) === null);
const unhappy = pick((c) => c.mode === "ai" && c.sentiment === "negative");
const takenOver = pick((c) => c.mode === "human");

/**
 * Cổng upsell im lặng vào ban đêm, theo đúng thiết kế — nên ca "được phép"
 * KHÔNG THỂ đạt sau 22:00, và probe chạy lúc đó sẽ báo đỏ cho một hệ thống
 * đang hành xử đúng.
 *
 * Đã xảy ra thật lúc 22:55: bốn kiểm tra đỏ với lý do "night". Cùng loại lỗi
 * với fixture `in_house` trước đây — probe giả định một điều kiện môi trường
 * mà nó không kiểm. Nói thẳng ra và bỏ qua, thay vì để người đọc tưởng sản
 * phẩm hỏng.
 */
const HH = new Date().getHours();
const NIGHT = HH >= 22 || HH < 6;

async function main() {
  if (NIGHT) {
    console.log(`Bây giờ là ${String(HH).padStart(2, "0")}:xx — cổng upsell im lặng ban đêm THEO THIẾT KẾ.`);
    console.log("Các ca 'được phép chào bán' không thể kiểm lúc này; chạy lại trong khoảng 06:00–22:00.\n");
  }
  console.log("=== A CALM CONVERSATION IS ALLOWED, AND IS RECORDED ===");
  if (!calm || NIGHT) {
    console.log(NIGHT ? "  SKIP  ban đêm — cổng im lặng theo thiết kế" : "  SKIP  no calm ai-mode conversation in this database");
  } else {
    const r = await run(calm.id);
    ok(!r.suppressed, `conv#${calm.id} is not suppressed`);
    ok(Array.isArray(r.suggestions) && r.suggestions.length > 0, "it returns suggestions");
    /* Strictly greater than zero: `0 === 0` passed vacuously while the turn was
       actually being suppressed, which is how the picker bug above hid. */
    ok(newRows().length > 0 && newRows().length === r.suggestions.length, "one impression row per suggestion shown");
    ok(
      newRows().every((i) => i.conversationId === calm.id),
      "the rows are attributed to this conversation",
    );

    console.log("=== AND THE COOLDOWN READS BACK WHAT WAS JUST WRITTEN ===");
    const again = await run(calm.id);
    ok(again.suppressed === true, "a second offer on the same turn is suppressed");
    ok(again.reason === "cooldown", `and the reason is the cooldown (got "${again.reason}")`);
    const n = newRows().length;
    ok(n === r.suggestions.length, "a suppressed turn writes no new impression");
  }

  console.log("=== A GUARD FLAG SILENCES IT ===");
  if (!calm || NIGHT) console.log(NIGHT ? "  SKIP  ban đêm" : "  SKIP  needs a calm conversation to isolate the flag");
  else {
    const countBefore = newRows().length;
    const r = await run(calm.id, { guardFlags: ["medical_emergency"] });
    ok(r.suppressed === true, "a flagged message gets no offer");
    ok(r.reason === "guard_flag", `and the reason names the flag (got "${r.reason}")`);
    ok(newRows().length === countBefore, "nothing is recorded as shown");
    ok(
      typeof r.instruction === "string" && /KHÔNG gợi ý/.test(r.instruction),
      "the model is told plainly not to improvise a suggestion",
    );
  }

  console.log("=== AN UNHAPPY GUEST IS NOT SOLD TO ===");
  if (!unhappy) console.log("  SKIP  no negative ai-mode conversation in this database");
  else {
    const r = await run(unhappy.id);
    ok(r.suppressed === true, `conv#${unhappy.id} (sentiment=negative) is suppressed`);
    ok(r.reason === "guest_unhappy", `and the reason is the guest, not the clock (got "${r.reason}")`);
  }

  console.log("=== A CONVERSATION A PERSON HAS TAKEN OVER IS NOT SOLD TO ===");
  if (!takenOver) console.log("  SKIP  no human-mode conversation in this database");
  else {
    const r = await run(takenOver.id);
    ok(r.suppressed === true, `conv#${takenOver.id} (mode=human) is suppressed`);
    ok(r.reason === "escalated", `and it reads as a handoff (got "${r.reason}")`);
  }

  /* Leave the database exactly as it was found. */
  const created = newRows().map((i) => i.id);
  if (created.length) {
    db.delete(upsellImpressions).where(inArray(upsellImpressions.id, created)).run();
    console.log(`\ncleaned up ${created.length} impression row(s) created by this probe`);
  }
  const leaked = storage.listUpsellImpressions().filter((i) => !before.has(i.id));
  ok(leaked.length === 0, "the probe left no rows behind");

  console.log(failures === 0 ? "\nALL GATE PROBE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
