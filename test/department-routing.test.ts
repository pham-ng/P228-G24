/**
 * A broken air conditioner is engineering's job, not the front desk's.
 *
 * The offline path escalates through one tool and that tool hardcoded
 * `front_desk`, so every task landed in one department — 46 of 46 measured on
 * the demo dataset. The operations board could not be used to run a hotel and
 * "Workload by department" was a chart of a single bar.
 *
 * These assertions are pure: `departmentFor` is a lexicon over the guest's own
 * words, no model and no index. What is locked here is that the vocabulary
 * covers every production language, that specificity beats generality (a room
 * with a broken air-con is engineering, not housekeeping on the word "room"),
 * and that anything unrecognised still reaches a human.
 */
import "dotenv/config";
import { departmentFor } from "../server/department";

let failures = 0;
function ok(cond: boolean, label: string) {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
}
const routes = (text: string, want: string) =>
  ok(departmentFor(text) === want, `${want.padEnd(12)} <- "${text.slice(0, 52)}"`);

console.log("=== engineering: hỏng hóc thiết bị ===");
routes("205号室のエアコンが効かないので確認をお願いします", "engineering");
routes("Vòi sen phòng 210 bị rò nước, nhờ anh chị cho người lên xem", "engineering");
routes("voi sen phong 210 bi ro nuoc, nho anh chi cho nguoi len xem", "engineering");
routes("The air conditioning in my room is not working", "engineering");
routes("В номере не работает кондиционер", "engineering");
routes("房间电视没有信号", "engineering");
routes("객실 에어컨이 고장났어요", "engineering");

console.log("\n=== housekeeping: dọn dẹp, đồ dùng ===");
routes("Tôi đã gọi ba lần mà vẫn chưa ai lên dọn phòng", "housekeeping");
routes("toi doi 45 phut roi chua thay ai dem khan tam len", "housekeeping");
routes("Уже третий раз прошу убрать номер", "housekeeping");
routes("Could I get extra towels please", "housekeeping");
routes("シーツを交換してください", "housekeeping");

console.log("\n=== fnb: ăn uống ===");
routes("Nhà hàng có món chay không ạ?", "fnb");
routes("Can I book a table for four at seven tonight?", "fnb");
routes("朝食は何時から何時までですか", "fnb");
routes("请问餐厅几点开门", "fnb");

console.log("\n=== spa ===");
routes("아코야 스파 트리트먼트 종류를 알려주세요", "spa");
routes("Tôi muốn đặt liệu trình mát xa chiều nay", "spa");
routes("How much is a 90 minute massage?", "spa");

console.log("\n=== specificity: cụ thể thắng chung chung ===");
/* Every one of these contains a housekeeping or generic word too. If ordering
   ever flips, a broken shower becomes a cleaning request and the engineer is
   never told. */
routes("Phòng tôi máy lạnh không chạy, nhờ kiểm tra", "engineering");
routes("The room is fine but the shower is leaking badly", "engineering");
routes("Phòng bẩn, nhờ dọn giúp tôi", "housekeeping");

console.log("\n=== 'gọi' KHÔNG được kéo mọi thứ về Buồng phòng ===");
/* `gối` (pillow) folds to `goi`, and so does `gọi` — the verb in almost every
   Vietnamese service request. The unaccented entry `goi ` was in the
   housekeeping lexicon and sent a room-service order there, found by ordering
   two bowls of phở through the real endpoint. */
routes("Cho tôi gọi 2 phần phở bò lên phòng nhé", "fnb");
routes("Cho tôi gọi đồ ăn lên phòng", "fnb");
routes("goi do an len phong", "fnb");
routes("Tôi muốn gọi rượu vang đỏ lên phòng", "fnb");
routes("Gọi giúp tôi taxi ra sân bay", "front_desk");
routes("Tôi cần gọi lễ tân", "front_desk");
/* A real pillow request must still reach housekeeping. */
routes("Cho tôi xin thêm một cái gối", "housekeeping");
/* Sending a PERSON up is not an F&B order, so the delivery pattern excludes
   staff nouns rather than matching any "... lên phòng". */
routes("Gọi lễ tân lên phòng giúp tôi", "front_desk");

console.log("\n=== không nhận ra thì vẫn tới người ===");
/* front_desk is the correct default, not a failure: a request nobody can
   categorise is exactly what a front desk exists for. */
routes("Tôi muốn đổi sang biệt thự hướng biển cho hai đêm cuối", "front_desk");
routes("What time is checkout?", "front_desk");
routes("Мне нужен поздний выезд", "front_desk");
ok(departmentFor("") === "front_desk", "front_desk   <- chuỗi rỗng");
ok(departmentFor(null) === "front_desk", "front_desk   <- null");
ok(departmentFor(undefined) === "front_desk", "front_desk   <- undefined");

console.log(failures === 0 ? "\nALL DEPARTMENT ROUTING TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
