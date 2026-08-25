/**
 * Unit tests for the rate-package parser and the upsell engine.
 * Pure: no database, no model, no filesystem beyond a literal fixture.
 *
 *   npx tsx test/packages-upsell.test.ts
 */

import { parsePackageFile, cleanPackageName, deriveFacets } from "../server/packages";
import { recommend, upgradeDelta, matchRooms, summarise, compareRooms, type RoomContext } from "../server/upsell";
import type { RoomPackageRow } from "@shared/schema";

let failures = 0;
function ok(cond: boolean, msg: string) {
  if (cond) console.log(`  PASS  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}

/* A fixture in the exact shape the scrape produces: every line duplicated, the
   marketing summary repeated inside the detail block, shared T&C at the end. */
const FIXTURE = `
Hè Sánh Vibes
Bữa sáng buffet
Bữa sáng buffet
Tặng hotel credit 300.000đ/phòng/đêm
Tặng hotel credit 300.000đ/phòng/đêm
Miễn phí trải nghiệm thư giãn tại Aquafiled - Tổ hợp spa & xông hơi cao cấp Top 1 Hàn Quốc đầu tiên tại Việt Nam (01 lần cho tất cả các khách trong phòng trong thời gian lưu trú, Áp dụng lưu trú đến 30/11/2026. Không áp dụng giai đoạn hè từ 25/5-15/8 và các ngày lễ tết)
Giảm 30% Spa, 20% dịch vụ ẩm thực (không gồm đồ uống có cồn), 20% Golf
Miễn phí thay đổi/ hủy phòng trước ngày 04/10/26. Từ ngày 04/10/26 tính phí 100% . Không đến nhận phòng tính phí 100%.
Giá công bố4.620.000 đ
unionGiá thành viên4.389.000 đ
/đêm
Điều kiện gói
Chi tiết gói giá
Bữa sáng buffet
Tặng hotel credit 300.000đ/phòng/đêm
Miễn phí trải nghiệm thư giãn tại Aquafiled - Tổ hợp spa & xông hơi cao cấp Top 1 Hàn Quốc đầu tiên tại Việt Nam (01 lần cho tất cả các khách trong phòng trong thời gian lưu trú, Áp dụng lưu trú đến 30/11/2026. Không áp dụng giai đoạn hè từ 25/5-15/8 và các ngày lễ tết)
Giảm 30% Spa, 20% dịch vụ ẩm thực (không gồm đồ uống có cồn), 20% Golf
Điều kiện, điều khoản
Phòng khách sạn: Tối đa 4 người trong một phòng (3 người lớn 1 trẻ em hoặc 2 người lớn và 2 trẻ em)
Trẻ em dưới 4 tuổi: Miễn phí
Chính sách hoàn huỷ
Miễn phí thay đổi/ hủy phòng trước ngày 04/10/26. Từ ngày 04/10/26 tính phí 100% . Không đến nhận phòng tính phí 100%.
`;

console.log("=== PARSER ===");
const p = parsePackageFile(FIXTURE, "Grand Deluxe Hướng Biển 2 Giường Đơn", "gói 1")!;
ok(!!p, "parses a package file");
ok(p.publicPrice === 4620000, `public price 4.620.000 (got ${p.publicPrice})`);
ok(p.memberPrice === 4389000, `member price 4.389.000 (got ${p.memberPrice})`);
ok(p.name === "Hè Sánh Vibes", `package name (got "${p.name}")`);
// The regression that mattered: whole-file dedup used to empty the detail block.
ok(p.inclusions.length === 4, `4 inclusions kept, duplicates collapsed (got ${p.inclusions.length})`);
ok(p.facets.mealPlan === "breakfast", "meal plan detected from the detail block");
ok(p.facets.hotelCredit === 300000, `hotel credit 300.000 (got ${p.facets.hotelCredit})`);
ok(p.facets.aquafield, "Aquafield detected despite the source's 'Aquafiled' misspelling");
ok(p.facets.spaDiscountPct === 30 && p.facets.fnbDiscountPct === 20 && p.facets.golfDiscountPct === 20, "discount percentages");
// Aquafield carries a blackout caveat but is a benefit, not a rule.
ok(
  p.inclusions.some((l) => /Aquafiled/i.test(l)),
  "the Aquafield benefit stays an inclusion, not a condition",
);
ok(p.hasBlackout, "blackout flagged");
ok(p.conditions.length === 1 && /04\/10\/26/.test(p.conditions[0]), `one cancellation condition (got ${p.conditions.length})`);
ok(
  !p.inclusions.some((l) => /Tối đa 4 người|Trẻ em dưới 4 tuổi/.test(l)),
  "shared property-wide T&C dropped, not duplicated into every package",
);
ok(
  !p.conditions.some((l) => /^Chính sách hoàn huỷ$/i.test(l)),
  "section headers are not captured as conditions",
);

console.log("=== NAME CLEANUP (scrape damage) ===");
ok(cleanPackageName("iá Công Bố Tốt Nhất") === "Giá Công Bố Tốt Nhất", "restores a truncated first letter");
ok(cleanPackageName("Gía Công Bố Tốt Nhất") === "Giá Công Bố Tốt Nhất", "normalises the site's Gía typo");
ok(cleanPackageName("è Sánh Vibes") === "Hè Sánh Vibes", "restores 'Hè Sánh Vibes'");
ok(cleanPackageName("Hè sánh vibes") === "Hè Sánh Vibes", "case-insensitive");
ok(cleanPackageName("Stay & Play") === "Stay & Play", "leaves a clean name alone");

console.log("=== FACETS ===");
const full = deriveFacets(["Bữa buffet sáng, bữa trưa, bữa tối", "Vé vui chơi không giới hạn Vinwonders cho tất cả khách"]);
ok(full.mealPlan === "full_board", "full board detected");
ok(full.vinwonders, "unlimited VinWonders detected");
const golf = deriveFacets(["02 vòng chơi golf 18 hố/phòng/đêm, bao gồm phí sân"]);
ok(golf.golfRounds === 2, `2 golf rounds (got ${golf.golfRounds})`);
ok(!deriveFacets(["Vé VinWonders cho 1 lượt"]).vinwonders, "a limited VinWonders ticket is not 'unlimited'");

/* ------------------------------------------------------------ upsell engine */

const ROOMS: RoomContext[] = [
  { code: "DLX", nameVi: "Deluxe 2 Giường Đơn", maxGuests: 4, privatePool: false, oceanView: false, areaSqm: 42 },
  { code: "VILLA", nameVi: "Biệt Thự 3 Phòng Ngủ Hướng Biển", maxGuests: 8, privatePool: true, oceanView: true, areaSqm: 370 },
];

const mk = (o: Partial<RoomPackageRow> & { id: number; roomCode: string; publicPrice: number }): RoomPackageRow =>
  ({
    hotelId: 1,
    roomNameVi: o.roomCode === "VILLA" ? "Biệt Thự 3 Phòng Ngủ Hướng Biển" : "Deluxe 2 Giường Đơn",
    name: "Giá Công Bố Tốt Nhất",
    memberPrice: null,
    mealPlan: "breakfast",
    vinwonders: 0,
    golfRounds: 0,
    hotelCredit: 0,
    aquafield: 0,
    saunaJacuzzi: 0,
    cableCar: 0,
    spaDiscountPct: 0,
    fnbDiscountPct: 0,
    golfDiscountPct: 0,
    inclusions: "[]",
    conditions: "[]",
    hasBlackout: 0,
    sourceFile: null,
    updatedAt: "",
    ...o,
  }) as RoomPackageRow;

const PKGS: RoomPackageRow[] = [
  mk({ id: 1, roomCode: "DLX", publicPrice: 3580000 }),
  mk({ id: 2, roomCode: "DLX", publicPrice: 4960000, vinwonders: 1, name: "Hè Sánh Vibes" }),
  mk({ id: 3, roomCode: "DLX", publicPrice: 6260000, mealPlan: "full_board" }),
  mk({ id: 4, roomCode: "DLX", publicPrice: 7390900, golfRounds: 2, name: "Stay & Play" }),
  mk({ id: 5, roomCode: "VILLA", publicPrice: 13850000 }),
];

console.log("=== UPSELL: specific room ===");
const r1 = recommend(PKGS, ROOMS, { roomQuery: "deluxe" });
ok(r1.mode === "quote", "a named category yields a quote");
ok(r1.base?.public_price === 3580000, "quotes the CHEAPEST package first");
ok(r1.upsells.length > 0 && r1.upsells.every((u) => u.extra_cost! > 0), "upsells all cost more than the base");
ok(r1.upsells.every((u) => (u.adds ?? []).length > 0), "every upsell says what the extra money adds");
ok(r1.upsells[0].adds!.some((a) => /VinWonders/i.test(a)), "the first rung names its added benefit");
ok(!r1.upsells.some((u) => u.room_code === "VILLA"), "a Deluxe request is not upsold into a villa");

console.log("=== UPSELL: budget ===");
const r2 = recommend(PKGS, ROOMS, { maxPrice: 5000000 });
ok(r2.mode === "quote", "a budget alone is enough to answer");
ok(!!r2.base && r2.base.public_price <= 5000000, "base respects the ceiling");
ok(r2.upsells.every((u) => u.public_price <= 5000000), "no upsell breaks the stated budget");

console.log("=== UPSELL: vague ===");
const r3 = recommend(PKGS, ROOMS, {});
ok(r3.mode === "clarify", "says nothing concrete when the guest said nothing concrete");
ok(!r3.base, "no price is quoted on the vague path");
ok(r3.clarify.length >= 5, "offers preference chips to tap");

console.log("=== UPSELL: facets & conflicts ===");
const r4 = recommend(PKGS, ROOMS, { mustHave: ["pool"] });
ok(r4.base?.room_code === "VILLA", "a private-pool request selects the villa");
const r5 = recommend(PKGS, ROOMS, { mustHave: ["full_board", "golf"] });
ok(r5.mode === "empty", "an unsatisfiable combination returns empty, not a wrong answer");
ok(/không có gói nào đáp ứng đồng thời/i.test(r5.note), "the note names the conflicting criteria");
ok(/KHÔNG được tự bỏ tiêu chí/i.test(r5.note), "the agent is told not to silently drop a criterion");
const r6 = recommend(PKGS, ROOMS, { guests: 8 });
ok(r6.base?.room_code === "VILLA", "party size filters out rooms that cannot fit it");
const r7 = recommend(PKGS, ROOMS, { roomQuery: "deluxe", maxPrice: 1000000 });
ok(r7.mode === "empty" && /vượt ngân sách/i.test(r7.note), "an impossible budget reports the cheapest option above it");

console.log("=== TRAVELLER PERSONALISATION ===");
const golfer = recommend(PKGS, ROOMS, { roomQuery: "deluxe", traveller: "golf", limit: 2 });
ok(golfer.upsells[0].adds!.some((a) => /golf/i.test(a)), "a golfer is shown the golf package first");
ok(golfer.upsells[0].suits_traveller === true, "the matching rung is flagged suits_traveller");
const family = recommend(PKGS, ROOMS, { roomQuery: "deluxe", traveller: "family", limit: 2 });
ok(
  family.upsells[0].adds!.some((a) => /trưa|tối|VinWonders/i.test(a)),
  "a family is shown meals / VinWonders first",
);
ok(
  golfer.base?.public_price === family.base?.public_price,
  "the traveller hint never changes the honest cheapest quote",
);
/* A guess about who someone is must not remove an option they could book. */
const noHint = recommend(PKGS, ROOMS, { roomQuery: "deluxe", limit: 99 });
const withHint = recommend(PKGS, ROOMS, { roomQuery: "deluxe", traveller: "couple", limit: 99 });
ok(withHint.upsells.length === noHint.upsells.length, "a traveller hint ranks but never filters options away");

console.log("=== LADDER DEDUP ===");
/* Two categories priced identically must not offer the guest the same upgrade twice. */
const twinned: RoomPackageRow[] = [
  mk({ id: 10, roomCode: "DLX", publicPrice: 3580000 }),
  mk({ id: 11, roomCode: "DLX", publicPrice: 4960000, vinwonders: 1 }),
  mk({ id: 12, roomCode: "DLX2" as string, publicPrice: 4960000, vinwonders: 1 }),
];
const twinRooms: RoomContext[] = [
  ...ROOMS,
  { code: "DLX2", nameVi: "Deluxe Giường Đôi", maxGuests: 4, privatePool: false, oceanView: false, areaSqm: 42 },
];
const dedup = recommend(twinned, twinRooms, { roomQuery: "deluxe", limit: 5 });
ok(dedup.upsells.length === 1, `identical upgrades collapse to one rung (got ${dedup.upsells.length})`);

console.log("=== CELEBRATIONS ===");
const honey = recommend(PKGS, ROOMS, { roomQuery: "deluxe", traveller: "honeymoon" });
ok(!!honey.celebration, "a honeymoon is surfaced as a celebration");
ok(/CHÚC MỪNG/i.test(honey.note), "the agent is told to congratulate before selling");
ok(
  honey.base?.public_price === recommend(PKGS, ROOMS, { roomQuery: "deluxe" }).base?.public_price,
  "a celebration never inflates the quoted price",
);

console.log("=== PRICE OBJECTION ===");
const objection = recommend(PKGS, ROOMS, { roomQuery: "villa", tooExpensive: true });
ok(objection.cheaper.length > 0, "'too expensive' returns cheaper alternatives");
ok(
  objection.cheaper.every((c) => c.public_price < objection.base!.public_price),
  "every alternative really is cheaper",
);
ok(objection.cheaper.every((c) => (c.extra_cost ?? 0) < 0), "the saving is expressed as a negative delta");
ok(objection.cheaper.every((c) => (c.adds ?? []).length > 0), "each alternative states what it gives up");
ok(
  objection.cheaper.some((c) => c.room_code !== "VILLA"),
  "the search leaves the guest's original category — otherwise a villa has nothing cheaper",
);
ok(recommend(PKGS, ROOMS, { roomQuery: "villa" }).cheaper.length === 0, "no alternatives offered unless price was queried");

/* An unmapped room category has unknown features; claiming it lacks them is a lie. */
const orphanPkgs: RoomPackageRow[] = [
  mk({ id: 20, roomCode: "VILLA", publicPrice: 13850000 }),
  mk({ id: 21, roomCode: "UNMAPPED" as string, publicPrice: 9000000 }),
];
const orphan = recommend(orphanPkgs, ROOMS, { roomQuery: "villa", tooExpensive: true });
ok(
  !orphan.cheaper.some((c) => (c.adds ?? []).some((a) => /bể bơi riêng|hướng biển/.test(a))),
  "a room with no catalogue row is never claimed to lack a feature",
);

console.log("=== COMPARISON ===");
const cmp = compareRooms(PKGS, ROOMS, "deluxe và villa");
ok(cmp.rooms.length === 2, `compares exactly the two categories named (got ${cmp.rooms.length})`);
ok(cmp.rooms[0].from_price! <= cmp.rooms[1].from_price!, "cheapest category listed first");
ok(
  cmp.rooms.find((r) => r.room_code === "VILLA")!.unique.some((u) => /bể bơi riêng/.test(u)),
  "the villa's private pool is named as a real difference",
);
ok(
  cmp.rooms.find((r) => r.room_code === "DLX")!.from_price === 3580000,
  "from_price is the category's CHEAPEST package, not an arbitrary one",
);
const cmpAll = compareRooms(PKGS, ROOMS, "");
ok(cmpAll.rooms.length === ROOMS.length, "an empty query compares everything");
/* When every option shares a feature, saying so distinguishes nothing. */
const sameRooms: RoomContext[] = [
  { code: "A", nameVi: "Alpha", maxGuests: 4, privatePool: false, oceanView: true, areaSqm: 40 },
  { code: "B", nameVi: "Beta", maxGuests: 4, privatePool: false, oceanView: true, areaSqm: 40 },
];
const cmpSame = compareRooms([mk({ id: 30, roomCode: "A", publicPrice: 1000000 }), mk({ id: 31, roomCode: "B", publicPrice: 1000000 })], sameRooms, "");
ok(cmpSame.rooms.every((r) => r.unique.length === 0), "a shared feature is not listed as a difference");

console.log("=== HELPERS ===");
ok(matchRooms("villa", ROOMS).length === 1, "matchRooms narrows on a term");
ok(matchRooms("", ROOMS).length === 2, "an empty query matches everything (so the vague path triggers)");
ok(matchRooms("penthouse", ROOMS).length === 0, "an unknown category matches nothing");
ok(upgradeDelta(PKGS[0], PKGS[2]).some((a) => /trưa|tối/.test(a)), "upgradeDelta reports the added meals");
ok(upgradeDelta(PKGS[2], PKGS[0]).length === 0, "a downgrade adds nothing");
ok(summarise(PKGS[1]).some((s) => /VinWonders/i.test(s)), "summarise lists the headline benefit");

console.log(failures === 0 ? "\nALL PACKAGE/UPSELL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
