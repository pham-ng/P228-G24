/**
 * Context-compression experiment, §3-4: passage text is capped for the local
 * model's prompt. The old cut was a bare `.slice(0, cap)`, which can land
 * mid-price or mid-hour ("Giá 2.870.0" instead of the full figure or none at
 * all). truncateAtBoundary() must always cut at a sentence boundary, and only
 * fall back to a word boundary when no sentence end exists in a reasonable
 * range — never mid-word, never mid-number.
 *
 *   npx tsx test/truncate-boundary.test.ts
 */
import { truncateAtBoundary, selectRelevantWindow } from "../server/local-agent";

let failures = 0;
function ok(cond: boolean, msg: string) {
  if (cond) console.log(`  PASS  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}

const SAMPLE =
  "Phòng gồm 2 giường đơn hoặc 1 giường đôi, diện tích 42m2. Giá phòng là 2.870.000 đồng mỗi đêm, đã bao gồm ăn sáng cho 2 người. Trẻ em dưới 6 tuổi ở miễn phí khi dùng chung giường với bố mẹ. Phòng có hướng biển và ban công riêng, view trực tiếp ra Vịnh Nha Trang.";

console.log("=== truncateAtBoundary ===");

ok(truncateAtBoundary("short.", 700) === "short.", "text shorter than cap is returned unchanged");

const cut300 = truncateAtBoundary(SAMPLE, 300);
ok(cut300.length <= 300, "respects the cap");
ok(cut300.endsWith("."), "cuts at a sentence end, not mid-word");
ok(!/\d\.\d{3}\.0$/.test(cut300) && !cut300.includes("2.870.0 "), "never splits a price mid-number");

const cut60 = truncateAtBoundary(SAMPLE, 60);
ok(cut60.endsWith("."), "a very tight cap still ends on a full sentence, not a partial one");
ok(cut60.length < 60, "prefers a shorter, complete sentence over a longer, cut one");

const noBoundary = "a".repeat(500); // no punctuation anywhere — must not crash or mid-word cut past cap
const cutNoBoundary = truncateAtBoundary(noBoundary, 100);
ok(cutNoBoundary.length <= 101, "falls back gracefully when there is no sentence boundary at all");

console.log("\n=== selectRelevantWindow ===");

/* Real "Rooms and room types" KB chunk (773 chars) — the villa sentence
   sits at char 492, past the frozen 400-char cap. Reproduces the live bug:
   truncateAtBoundary(text, 400) drops the villa fact entirely. */
const ROOMS_CHUNK =
  "The resort has 476 rooms on floors 1-5, all with telephone, high-speed internet, TV, air conditioning, hairdryer and minibar; Grand Deluxe categories have a balcony. Deluxe Queen and Deluxe Twin are 32 m2 with garden view, maximum 4 guests, from 2,200,000 VND per night. Grand Deluxe Queen and Twin are 42 m2 garden view, from 2,410,000. Deluxe Ocean View is 32 m2 from 2,640,000, and Grand Deluxe Ocean View 42 m2 from 2,870,000. Deluxe Suite King Ocean View is 52 m2, around 4,097,000. The 3-Bedroom Ocean View Villa is 370 m2 with a private pool for up to 12 guests, from 8,610,000, and the Tropicana Beachfront Villa 3-Bedroom is 370 m2 with a private pool and tropical garden, from 10,130,000. Source: https://vinpearl.com/vi/moi-nhat-bang-gia-phong-vinpearl-nha-trang";

ok(!truncateAtBoundary(ROOMS_CHUNK, 400).includes("8,610,000"), "sanity check: head-truncation alone really does drop the villa fact (reproduces the live bug)");

const villaWindow = selectRelevantWindow(ROOMS_CHUNK, 400, "3-Bedroom Ocean View Villa price per night");
ok(villaWindow.length <= 400, "respects the cap");
ok(villaWindow.includes("8,610,000"), "keeps the villa price even though it sits past the head-truncation cut point");

const deluxeWindow = selectRelevantWindow(ROOMS_CHUNK, 400, "Deluxe Queen room price");
ok(deluxeWindow.includes("2,200,000"), "a different question pulls a different, still-relevant window from the same chunk");

ok(selectRelevantWindow("short.", 700, "anything") === "short.", "text shorter than cap is returned unchanged");

/* Real "Ozone" venue chunk (741 chars). Regression for a bug in an earlier
   version of selectRelevantWindow: raw occurrence-count scoring let the
   venue's own title/description sentence (which repeats "Ozone" and "hải
   sản" several times — Vietnamese name + English name + description all
   restate them) dominate over the short "Giờ mở cửa" and "Sức chứa"
   sentences, which score lower purely because they don't repeat words. The
   window then spent its whole budget on menu items near the title and
   never reached the hours/capacity facts — the model filled the gap by
   copying a DIFFERENT venue's capacity from another passage. A second bug
   in the same function made this worse: once the single best-scoring
   sentence didn't fit the remaining budget, the whole selection loop
   stopped instead of skipping it and trying the next-best (smaller)
   sentence — so a short, perfectly-fitting answer sentence was discarded
   just because a longer one was preferred and didn't fit first. */
const OZONE_CHUNK =
  "Nhà hàng hải sản Ozone Ozone Seafood Restaurant Nhà hàng hải sản Ozone (Ozone Seafood Restaurant) — nhà hàng. Giờ mở cửa: 10:30-14:00, 17:00-22:00. Vị trí: Vinpearl Resort Nha Trang, Đảo Hòn Tre, Phường Vĩnh Nguyên, Nha Trang, Khánh Hòa - Tầng 1, Trung tâm ẩm thực và giải trí cao cấp Imperial Club. Điện thoại: 0902 278 058. Sức chứa 360 khách. Ẩm thực: Hải sản, A la Carte, Soups, Starters, Main dishes. Món tiêu biểu công bố: Món súp (Soups): Súp hải sản chua cay 135.000đ, Súp cua măng tây 135.000đ, Súp nấm bào ngư 250.000đ, Súp đặc biệt theo ngày 250.000đ Món khai vị (Starters): Gỏi hải sản chua cay 250.000đ, Gỏi ốc Nha Trang 250.000đ, Gỏi xoài sứa sốt hải sản 200.000đ, Gỏi cuốn hải sản Ozone 160.000đ, Chả giò hải sản Ozone 160.000đ";
const ozoneWindow = selectRelevantWindow(OZONE_CHUNK, 400, "Nhà hàng hải sản Ozone mở cửa mấy giờ và sức chứa bao nhiêu khách?");
ok(ozoneWindow.length <= 400, "respects the cap");
ok(ozoneWindow.includes("360 khách"), "keeps the capacity fact instead of dropping it for a repetitive title sentence");
ok(ozoneWindow.includes("10:30") && ozoneWindow.includes("17:00"), "keeps the opening-hours fact in the same window");

const noMatch = selectRelevantWindow(SAMPLE, 60, "hoàn toàn không liên quan xyz123");
ok(noMatch === truncateAtBoundary(SAMPLE, 60), "falls back to head-truncation when nothing in the passage matches the question");

/* A PRICE is the sentence a price question needs and the sentence this
 * function was most likely to throw away.
 *
 * Reported live by the operator: "Giá phòng Deluxe giường đôi được công bố là
 * 100%." Retrieval was correct — three of five passages were the right rate
 * chunks — and then every one of the thirteen passages reached the model with
 * its price deleted here, so the model answered a price question with the
 * nearest percentage it could see.
 *
 * The cause is that selection scored sentences by MARGINAL new coverage of
 * the question's tokens and stopped as soon as nothing added a new one. A
 * price sentence adds no new token — a figure is not a word the guest typed —
 * so it scored 0 and was dropped, with more than half the character budget
 * still unspent. Redundant in vocabulary is not the same as worthless. */
const ROOM_CHUNK =
  "Hạng phòng Deluxe Giường Đôi (Deluxe Queen Bed): Diện tích 32m², tối đa 4 khách. " +
  "Mô tả & bảng giá niêm yết: Với diện tích 32 m², Deluxe Giường Đôi là phòng khách sạn thiết kế hiện đại " +
  "với giường đôi sang trọng, tích hợp đầy đủ tiện nghi cho kỳ lưu trú của bạn. " +
  "Tầm nhìn thoáng đãng, vị trí đắc địa ngay cạnh bãi biển, đây sẽ là lựa chọn lý tưởng dành cho các cặp đôi, " +
  "gia đình nhỏ hay du khách đi công tác. " +
  "Tối đa 4 người trong một phòng (3 người lớn 1 trẻ em hoặc 2 người lớn 2 trẻ em). " +
  "Giá công bố~ 4.600.000VNĐ/đêm Giá chỉ từ~ 4.370.000VNĐ /đêm";

const priceWindow = selectRelevantWindow(ROOM_CHUNK, 400, "Giá phòng Deluxe giường đôi bao nhiêu?");
ok(priceWindow.length <= 400, "respects the cap");
ok(priceWindow.includes("4.600.000"), "keeps the published rate a price question is asking for");
/* The budget must actually be spent. The reported failure used 179 of 400
   characters and dropped the price for want of room it already had. */
ok(priceWindow.length > 250, `uses the budget rather than stopping early (${priceWindow.length}/400 chars)`);

/* And the KIND of figure matters: ranking by "contains a digit" alone let the
   occupancy line win on document order, which pushed the price past the cap
   by a single character. */
ok(
  priceWindow.indexOf("4.600.000") < priceWindow.length,
  "the price survives even though an occupancy figure competes for the same budget",
);

/* A question that is NOT about money must not be reshaped by this: the
   capacity/hours case above still passes, and a non-money question keeps
   taking its answer from coverage. */
const areaWindow = selectRelevantWindow(ROOM_CHUNK, 400, "Phòng Deluxe giường đôi rộng bao nhiêu m2?");
ok(areaWindow.includes("32"), "a size question still gets the size");

console.log(failures === 0 ? "\nALL TRUNCATION TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
