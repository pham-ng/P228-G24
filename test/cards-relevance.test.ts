/**
 * Cards are offers. An offer nobody asked for is noise.
 *
 * Measured against the running kiosk on 2026-08-27, EVERY turn shipped 20-25
 * cards: the whole 10-type room catalogue under "Wifi có miễn phí không?",
 * cable-car and airport-transfer offers under "Mấy giờ ăn sáng?", and room
 * photos under a broken-air-con complaint. 158 cards across 8 questions.
 *
 * Three independent causes, one per assertion group below:
 *   1. rooms.ts fuzzy-matched generic Vietnamese tokens ("phong", "bien",
 *      "giuong") with Damerau-Levenshtein ≤1 — "khong" is one edit from
 *      "phong", so nearly any passage matched the villas.
 *   2. services.ts matched a whole CATEGORY: one "spa" passage surfaced all
 *      seven Akoya treatments; one "dining" passage surfaced every restaurant.
 *   3. All three detectors keyed off retrieved passages, and retrieval returns
 *      five passages whether or not they are relevant.
 *
 * The fix keys them off what the turn actually NAMED — the guest's question
 * plus the reply. These tests are pure: they call the detectors with fixed
 * passages and fixed focus text, so no model and no retrieval is involved.
 */
import "dotenv/config";
import { detectReferencedRoomTypes } from "../server/rooms";
import { detectReferencedServices } from "../server/services";
import { detectReferencedVenues } from "../server/dining";
import { storage } from "../server/storage";

let failures = 0;
function ok(cond: boolean, label: string) {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
}

/* The passages a real turn retrieved for "Điều hoà phòng tôi bị hỏng" and for
   "Mấy giờ ăn sáng?" — copied from the live run, noise and all. */
const FAULT_PASSAGES = [
  { title: "Giờ mở cửa tiện ích (FACILITY_HOURS)", category: "policy" },
  { title: "Deluxe 2 Giường Đơn — phòng", category: "room_type" },
  { title: "Deluxe Hướng Biển Giường Đôi — phòng", category: "room_type" },
  { title: "Phòng Gym / Fitness", category: "facility" },
  { title: "Deluxe Giường Đôi — phòng", category: "room_type" },
];
const BREAKFAST_PASSAGES = [
  { title: "Phòng Gym / Fitness", category: "facility" },
  { title: "Breakfast and buffet pricing", category: "dining" },
  { title: "Lotus Restaurant — ẩm thực", category: "dining_venue" },
  { title: "Hồ bơi nước ngọt", category: "facility" },
];

console.log("=== a fault report is not a shopping moment ===");
{
  const focus = "Điều hoà phòng tôi bị hỏng, xử lý thế nào?\nVui lòng liên hệ lễ tân để được hỗ trợ xử lý sự cố điều hòa.";
  const rooms = detectReferencedRoomTypes(FAULT_PASSAGES, focus);
  const svc = detectReferencedServices(FAULT_PASSAGES, focus);
  const venues = detectReferencedVenues(FAULT_PASSAGES, focus);
  ok(rooms.length === 0, `no room cards under a broken-air-con complaint (got ${rooms.length}, was 10)`);
  ok(svc.length === 0, `no service cards either (got ${svc.length}, was 11)`);
  ok(venues.length === 0, `no dining cards either (got ${venues.length})`);
}

console.log("\n=== an amenity question does not sell the room catalogue ===");
{
  const focus = "Wifi có miễn phí không?\nCó, Wi-Fi tốc độ cao được cung cấp miễn phí trong toàn bộ phòng, biệt thự và khu vực công cộng của resort.";
  const rooms = detectReferencedRoomTypes(FAULT_PASSAGES, focus);
  /* The reply contains "phòng" and "biệt thự" — the exact generic words the
     old ≤1-edit token matcher fired on. It must not resolve a room type. */
  ok(rooms.length === 0, `"phòng"/"biệt thự" as ordinary words resolve no room type (got ${rooms.length}, was 10)`);
  ok(detectReferencedServices(FAULT_PASSAGES, focus).length === 0, "and no service cards");
}

console.log("\n=== retrieval noise does not become an offer ===");
{
  const focus = "Mấy giờ ăn sáng?\nĂn sáng được phục vụ tại Lotus Restaurant từ 06:00 đến 10:30.";
  const venues = detectReferencedVenues(BREAKFAST_PASSAGES, focus);
  ok(venues.length === 1 && venues[0].name.includes("Lotus"), `only the venue the answer named (got ${venues.map((v) => v.name).join(", ") || "none"})`);
  ok(detectReferencedRoomTypes(BREAKFAST_PASSAGES, focus).length === 0, "the Gym/pool passages sell no rooms");
  ok(detectReferencedServices(BREAKFAST_PASSAGES, focus).length === 0, `no cable car / VinWonders / airport transfer (was 16 services)`);
}

console.log("\n=== but a guest who DOES ask still gets the card ===");
{
  /* Named in Vietnamese while the venue is stored in English — word order and
     the language of the generic half both vary, the distinctive half does not.
     A contiguous-substring test failed this and showed no Lotus card at all. */
  const focus = "Nhà hàng Lotus phục vụ món gì?\nNhà hàng Lotus phục vụ ẩm thực Việt Nam.";
  const venues = detectReferencedVenues(BREAKFAST_PASSAGES, focus);
  ok(venues.some((v) => v.name.includes("Lotus")), "\"Nhà hàng Lotus\" resolves the venue stored as \"Lotus Restaurant\"");
}
{
  /* The model answers "Spa Akoya"; the group is stored "Akoya Spa". Reversed. */
  const focus = "Spa có những liệu trình gì?\nSpa Akoya cung cấp các liệu trình sau: Foot Therapy 50', Balinese Massage 90'.";
  const svc = detectReferencedServices([], focus);
  ok(svc.some((s) => s.name.includes("Akoya")), "\"Spa Akoya\" resolves the group stored as \"Akoya Spa\" (reversed word order)");
  ok(svc.length === 1, `and only that one group (got ${svc.length}, was 16)`);
}
{
  const focus =
    "Phòng Deluxe giá bao nhiêu một đêm?\nPhòng Deluxe Giường Đôi có giá công bố tốt nhất là 4.600.000VNĐ/đêm.";
  const rooms = detectReferencedRoomTypes(FAULT_PASSAGES, focus);
  ok(rooms.some((r) => r.name === "Deluxe Giường Đôi"), "a room the answer named gets its card");
  /* Whole-name matching, so naming one variant never drags in the others:
     "Deluxe Giường Đôi" is not a substring of "Deluxe Hướng Biển Giường Đôi"
     and the ocean-view variant was never mentioned here. */
  ok(!rooms.some((r) => r.name.includes("Hướng Biển")), "and an unmentioned ocean-view variant does not ride along");
  ok(!rooms.some((r) => r.name.includes("Grand")), "nor does Grand Deluxe");
}

console.log("\n=== the same room named across the two stored languages ===");
{
  /* Every room is stored under two names that mean the same thing —
     code "Villa 3-Bedroom Ocean View" and name_vi "Biệt Thự 3 Phòng Ngủ
     Hướng Biển" — and a guest freely mixes them. "Villa 3 phòng ngủ hướng
     biển" is a substring of NEITHER, so before name-alias.ts normalised both
     sides into one vocabulary, asking about that villa by name produced no
     villa card at all. */
  const focus = "Villa 3 phòng ngủ hướng biển có gì?\nVilla 3 phòng ngủ hướng biển có diện tích 370 m², bể bơi riêng.";
  const rooms = detectReferencedRoomTypes([], focus);
  ok(rooms.some((r) => r.name === "Biệt Thự 3 Phòng Ngủ Hướng Biển"), "\"Villa 3 phòng ngủ hướng biển\" resolves the villa stored as \"Biệt Thự...\"");
  ok(!rooms.some((r) => /Tropicana/i.test(r.name)), "and not the Tropicana villa, which was never named");
  ok(!rooms.some((r) => /Deluxe/i.test(r.name)), "and no Deluxe rides along");
}
{
  /* The service group is stored "Vinpearl cable car" and the entire
     conversation says "cáp treo" — same gap, same fix. */
  const focus = "Cáp treo Vinpearl chạy mấy giờ?\nCáp treo Vinpearl chạy từ 08:30 đến 23:00.";
  const svc = detectReferencedServices([], focus);
  ok(svc.some((s) => /cable car/i.test(s.name)), "\"cáp treo\" resolves the group stored as \"Vinpearl cable car\"");
  ok(svc.length === 1, `and nothing else (got ${svc.length})`);
}
{
  /* The normalisation must not blur the variants back together: "hướng biển"
     is a DISCRIMINATOR, so it stays one token rather than two loose words
     either name could pick up. */
  const focus = "Deluxe Hướng Biển Giường Đôi giá bao nhiêu?\nDeluxe Hướng Biển Giường Đôi có giá 4.270.000đ/đêm.";
  const rooms = detectReferencedRoomTypes([], focus);
  ok(rooms.some((r) => r.name === "Deluxe Hướng Biển Giường Đôi"), "the ocean-view variant resolves when named");
  ok(!rooms.some((r) => r.name === "Deluxe Giường Đôi"), "and the plain variant does not ride along with it");
}

console.log("\n=== every emitted service key must resolve in /api/service-groups ===");
{
  /* The old detector emitted `serviceGroup || name`, but the detail endpoint
     only serves entries that HAVE a serviceGroup — so group-less services
     rendered as cards with no items, no price, and a modal reading "chưa có
     thông tin chi tiết". A dead end is not an offer. */
  const resolvable = new Set(storage.listServices().map((s) => s.serviceGroup).filter(Boolean) as string[]);
  const focus =
    "Spa Akoya, Vinpearl cable car, VinWonders Nha Trang, In-room dining — Phở bò, Cam Ranh Airport transfer";
  const svc = detectReferencedServices([], focus);
  ok(svc.length > 0, "the probe text does resolve some groups");
  ok(svc.every((s) => resolvable.has(s.key)), `no dead-end cards emitted (${svc.map((s) => s.key).join(", ")})`);
  ok(!svc.some((s) => s.key.includes("In-room dining —")), "a group-less service is not emitted as its own card");
}

console.log(failures === 0 ? "\nALL CARD RELEVANCE TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
