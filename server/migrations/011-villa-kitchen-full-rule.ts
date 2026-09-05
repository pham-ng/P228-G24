/**
 * Migration 011: give the villa-kitchen rule its full, explicit prohibition.
 *
 * A live tester asked "tôi có được nấu trong khách sạn bằng bếp của mình không?"
 * (may I cook with my own stove?) and got a half-answer: "the kitchen is for
 * reheating only; a BBQ must be registered." True, but it never draws the
 * conclusion the guest asked for — that cooking, including bringing your own
 * stove, is NOT allowed — the way the durian and pet rules plainly say "no".
 *
 * Root cause was DATA, not the model: the CONDUCT policy carried only the terse
 * English summary `villa_kitchen: "for reheating only; a barbecue must be
 * registered…"`. The property's actual policy — cooking that makes smell, smoke
 * or a fire hazard is strictly prohibited, own stove included — was never in the
 * corpus (grep for "nấu nướng" returned nothing). With only "reheating only" to
 * go on, a 4B model states the rule instead of concluding the ban.
 *
 * This writes the full rule (guest-supplied, their real policy text), so the
 * answer becomes an unambiguous "không được nấu nướng". Idempotent.
 *
 *   DB_FILE=data.db npx tsx server/migrations/011-villa-kitchen-full-rule.ts
 */

import "dotenv/config";
import { storage } from "../storage";
import { reindex } from "../retrieval";

const FULL =
  "Tại biệt thự/căn hộ, bếp CHỈ được dùng để hâm nóng thức ăn. NGHIÊM CẤM mọi hình thức nấu nướng, chế biến thực phẩm gây mùi, gây khói hoặc không đảm bảo an toàn cháy nổ — kể cả mang bếp riêng vào nấu. Nướng BBQ tại sân vườn/khuôn viên phải đăng ký với Trung tâm Dịch vụ Khách hàng (có phí). Khách sạn không chịu trách nhiệm về vệ sinh an toàn thực phẩm khi khách tự chế biến.";

function main() {
  const p = storage.getPolicy("CONDUCT");
  if (!p) {
    console.log("[skip] CONDUCT không tồn tại");
    return;
  }
  const rules = JSON.parse(p.rules || "{}");
  if (rules.villa_kitchen === FULL) {
    console.log("Đã đầy đủ từ trước — không đổi.");
    return;
  }
  rules.villa_kitchen = FULL;
  storage.updatePolicyRules("CONDUCT", JSON.stringify(rules));
  console.log("[CONDUCT] villa_kitchen -> quy định đầy đủ (cấm nấu nướng)");
  console.log("Reindexing...");
  reindex().then((r) => console.log(`  ${r.embedded}/${r.chunks} chunks embedded (${r.model})`));
}

main();
