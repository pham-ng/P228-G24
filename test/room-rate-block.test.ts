/**
 * A room price must come from `room_packages`, cheapest package first.
 *
 * Each room category is published as a LADDER — seven packages for a Deluxe,
 * six for a villa — identical rooms at rising prices, each adding inclusions.
 * That is a deliberate upsell design, so a general "how much is this room?"
 * has one right answer: the cheapest rung, with the dearer ones available as
 * what more money buys.
 *
 * The offline path had no access to that table. `recommend_room_packages` is
 * withheld from the local model on purpose (a 4B model upsells badly), but
 * withholding the tool also withheld the FACTS, so prices were read out of
 * whichever prose chunk survived retrieval and compression. Three live
 * failures came from that, and each has an assertion here:
 *
 *   - "Giá phòng Deluxe giường đôi được công bố là 100%" — no price reached
 *     the model at all, so it quoted a percentage from a late-checkout clause.
 *   - The villa was quoted at 21.890.000đ as its "giá niêm yết tốt nhất" when
 *     the cheapest package is 13.850.000đ.
 *   - The same question phrased three ways led with three different figures.
 *
 * These tests are deterministic — the block is built in TypeScript from the
 * table, with no model involved — which is the point: the figure a guest is
 * quoted should not depend on inference.
 */
import "dotenv/config";
import { buildRoomRateBlock } from "../server/local-agent";
import { storage } from "../server/storage";

let failures = 0;
function ok(cond: boolean, label: string) {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
}

const vnd = (n: number) => Math.round(n).toLocaleString("vi-VN");

console.log("=== the quoted figure is the cheapest package, from the table ===");
for (const roomName of ["Deluxe Giường Đôi", "Grand Deluxe Giường Đôi", "Biệt Thự 3 Phòng Ngủ Hướng Biển"]) {
  const room = storage.listRoomTypes().find((r) => r.nameVi === roomName);
  if (!room) {
    ok(false, `${roomName} exists in room_types`);
    continue;
  }
  const pkgs = storage.packagesForRoom(room.code);
  if (!pkgs.length) {
    ok(false, `${roomName} has packages`);
    continue;
  }
  const cheapest = Math.min(...pkgs.map((p) => p.publicPrice));
  const dearest = Math.max(...pkgs.map((p) => p.publicPrice));

  const block = buildRoomRateBlock(`${roomName} giá bao nhiêu?`, "vi");
  ok(!!block, `${roomName}: a rate block is produced`);
  if (!block) continue;
  ok(block.includes(vnd(cheapest)), `${roomName}: quotes the cheapest package (${vnd(cheapest)}đ)`);
  /* The reported villa failure: the dearest rung reported as the headline
     rate. It may appear as the ladder ceiling, but never as the quote. */
  const beforeCeiling = block.split("Gói cao nhất")[0];
  ok(!beforeCeiling.includes(vnd(dearest)), `${roomName}: does NOT quote the dearest package (${vnd(dearest)}đ) as the price`);
}

console.log("\n=== the package NAME must not decide anything ===");
{
  /* "Giá Công Bố Tốt Nhất" is a marketing label that repeats across four
     different prices in the same Deluxe ladder — trusting it is exactly how
     the villa got quoted at its top rung. Ordering is by public_price only. */
  const room = storage.listRoomTypes().find((r) => r.nameVi === "Deluxe Giường Đôi")!;
  const pkgs = storage.packagesForRoom(room.code);
  const labelled = pkgs.filter((p) => /tốt nhất/i.test(p.name));
  ok(labelled.length > 1, `the label repeats across ${labelled.length} different prices (data is designed that way)`);
  const block = buildRoomRateBlock("Deluxe Giường Đôi giá bao nhiêu?", "vi")!;
  ok(block.includes(vnd(Math.min(...pkgs.map((p) => p.publicPrice)))), "the quote still follows price, not the label");
}

console.log("\n=== a tied cheapest price prefers the one with a member rate ===");
{
  /* Deluxe Giường Đôi has TWO packages at 3.580.000đ and only one carries a
     Pearl Club rate. At an equal price the member rate is strictly better for
     the guest; packagesForRoom orders by price alone and would otherwise
     return whichever row was inserted first. */
  const room = storage.listRoomTypes().find((r) => r.nameVi === "Deluxe Giường Đôi")!;
  const pkgs = storage.packagesForRoom(room.code);
  const floor = Math.min(...pkgs.map((p) => p.publicPrice));
  const tied = pkgs.filter((p) => p.publicPrice === floor);
  const withMember = tied.find((p) => p.memberPrice);
  ok(tied.length > 1, `two packages tie at the cheapest price (${tied.length})`);
  if (withMember) {
    const block = buildRoomRateBlock("Deluxe Giường Đôi giá bao nhiêu?", "vi")!;
    ok(block.includes(vnd(withMember.memberPrice!)), `the Pearl Club rate ${vnd(withMember.memberPrice!)}đ is surfaced`);
  }
}

console.log("\n=== the block appears only when it should ===");
{
  ok(!buildRoomRateBlock("Villa 3 phòng ngủ hướng biển có gì?", "vi"), "a room question that is not about price gets no rate block");
  ok(!buildRoomRateBlock("Mấy giờ ăn sáng?", "vi"), "a question naming no room gets none");
  ok(!buildRoomRateBlock("Wifi có miễn phí không?", "vi"), "an amenity question gets none");
  ok(!!buildRoomRateBlock("Deluxe Giường Đôi giá bao nhiêu?", "vi"), "a room price question does get one");
  /* Most-specific-wins, same rule the cards use: asking about the Grand
     Deluxe must not also quote the plain Deluxe nested inside its name. */
  const grand = buildRoomRateBlock("Grand Deluxe Giường Đôi giá bao nhiêu?", "vi")!;
  ok(!/\bDeluxe Giường Đôi:/.test(grand.replace(/Grand Deluxe Giường Đôi:/g, "")), "asking about Grand Deluxe does not also price the plain Deluxe");
}

console.log("\n=== English guests get the same figures ===");
{
  const room = storage.listRoomTypes().find((r) => r.nameVi === "Deluxe Giường Đôi")!;
  const cheapest = Math.min(...storage.packagesForRoom(room.code).map((p) => p.publicPrice));
  const en = buildRoomRateBlock("How much is the Deluxe Queen Bed room?", "en");
  ok(!!en, "an English question naming the room code produces a block");
  if (en) ok(en.includes(vnd(cheapest)), "with the same cheapest figure");
}

console.log(failures === 0 ? "\nALL ROOM RATE TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
