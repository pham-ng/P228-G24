/**
 * Migration 012: ingest the full house rules ("Quy Định Chung", 24 điều).
 *
 * The corpus had only a reduced English summary of the house rules, spread
 * across the CONDUCT policy fields — enough to answer smoking, pets and durian,
 * but missing whole rules (dress code, noise/TV volume, valuables, damage
 * compensation, the full cooking ban). A live tester hit exactly that gap
 * ("may I cook with my own stove?" → half-answer). This adds the property's
 * authoritative Vietnamese house rules verbatim as one retrievable KB article,
 * so every rule is answerable and the guest handbook has a source of truth.
 *
 * NO CONFLICT with the structured policies: the figures that overlap match what
 * is already stored (smoking 3.000.000, outside food 1.175.000, visitor curfew
 * 20:00, pool closes by 22:00). The structured policies stay for quick numeric
 * lookups; this article carries the full prose. Idempotent by title.
 *
 *   DB_FILE=data.db npx tsx server/migrations/012-general-regulations.ts
 */

import "dotenv/config";
import { storage } from "../storage";
import { reindex } from "../retrieval";

const TITLE = "Quy Định Chung — nội quy khách sạn Vinpearl";
const TAGS = [
  "nội quy", "quy định chung", "house rules", "quy tắc",
  "trang phục", "két an toàn", "đồ có giá trị", "tiếng ồn", "tivi",
  "bồi thường", "hư hỏng", "nấu nướng", "bếp", "thú nuôi", "hút thuốc",
  "vũ khí", "khách đến thăm", "hồ bơi", "tắm biển", "đồ ăn bên ngoài",
];

const BODY = `Quy Định Chung của khách sạn Vinpearl / VinOasis (nội quy khách sạn). Khách vui lòng hiểu rõ và tuân theo:

1. Tuân thủ quy định của Nhà nước và Khách sạn về an toàn phòng, chống dịch bệnh.
2. Tất cả khách lưu trú phải mang theo giấy tờ tùy thân hợp lệ theo Luật lưu trú.
3. Thú nuôi KHÔNG được phép mang vào khu vực Khách sạn.
4. Hút thuốc (bao gồm cả thuốc lá điện tử) chỉ được phép tại nơi có biển cho phép và/hoặc ngoài ban công phòng. Vi phạm: phí phục hồi/làm sạch/khử mùi là 3.000.000 VNĐ cho một lần ở có phát hiện.
5. Tuân thủ quy định an toàn khi di chuyển bằng xe trong khu vực Khách sạn.
6. Cư xử đúng mực nơi công cộng: đến trước phục vụ trước; ưu tiên phụ nữ mang thai, người khuyết tật, người già yếu; không gây ồn ào, la hét; không gác chân lên ghế; quản lý trẻ em ở khu vực công cộng.
7. Cất giữ vật dụng có giá trị trong két an toàn tại phòng hoặc gửi quầy Lễ tân. Khách sạn không chịu trách nhiệm pháp lý với mất mát/hư hại tài sản cá nhân nếu Khách không thực hiện theo quy định.
8. Khi ra khỏi phòng: trả các thiết bị điện về nguyên trạng; khóa cửa an toàn; không đưa chìa khóa phòng cho người khác.
9. Tuyệt đối tuân thủ quy định về nấu nướng trong phòng và sử dụng thiết bị điện đúng mục đích.
10. Tại biệt thự/căn hộ: Bếp CHỈ dùng để hâm nóng đồ ăn. NGHIÊM CẤM mọi hình thức nấu nướng, chế biến thực phẩm gây mùi, gây khói hoặc không đảm bảo an toàn cháy nổ — kể cả mang bếp riêng vào nấu. Nướng BBQ tại sân vườn/khuôn viên phải đăng ký với Trung tâm Dịch vụ Khách hàng (có phí). Khách sạn không chịu trách nhiệm về vệ sinh an toàn thực phẩm khi Khách tự chế biến.
11. KHÔNG mang thức ăn/đồ uống mua bên ngoài vào Khách sạn. Nếu mang vào phải thông báo Ban quản lý và trả phí dịch vụ bổ sung 1.175.000 đồng/lần, ký "Giấy miễn trừ trách nhiệm"; Khách sạn không chịu trách nhiệm vệ sinh an toàn thực phẩm với đồ ăn không do Khách sạn cung cấp.
12. KHÔNG mang trái cây, thực phẩm nặng mùi (sầu riêng, mít, các loại mắm…) vào phòng.
13. KHÔNG mang vũ khí, hóa chất hay chất nổ vào khu vực Khách sạn vào bất kỳ thời gian nào.
14. Khách phải bồi thường thiệt hại khi làm hư hỏng vật dụng, trang thiết bị trong phòng. Mức bồi thường từng vật dụng theo danh mục vật dụng tính phí/bán trong phòng.
15. Tuyệt đối nghiêm cấm mọi hành vi vi phạm pháp luật trong Khách sạn: đánh bạc, mại dâm, sử dụng chất kích thích/sản phẩm bị cấm (gồm thuốc lá điện tử, thuốc lá nung nóng), gây gổ đánh nhau… Khách chịu trách nhiệm trước pháp luật Việt Nam và Khách sạn nếu vi phạm.
16. Khách mời đến thăm: thông báo Lễ tân và gửi giấy tờ tùy thân của khách mời tại Lễ tân; gặp tại phòng phải được khách lưu trú đồng ý và trực tiếp đón. Vì lý do an ninh, khách mời KHÔNG được vào phòng nghỉ sau 20:00. Muốn khách mời ở lại qua đêm phải đăng ký với Lễ tân và trả phí lưu trú theo quy định.
17. Tuân thủ giờ hoạt động hồ bơi (có thể đổi theo thời tiết/mùa). Bơi ngoài giờ hoạt động: Khách tự chịu trách nhiệm an toàn, không khiếu nại. Khách sạn đóng cửa hồ bơi muộn nhất lúc 22:00; vui lòng không dùng hồ bơi sau 22:00.
18. Bãi biển: KHÔNG tắm biển sau 19:00 (không có cứu hộ sau 19:00). Cố ý tắm sau giờ này Khách tự chịu trách nhiệm, không khiếu nại.
19. Mặc trang phục thích hợp ở khu vực chung (tiền sảnh, nhà hàng…). Tôn trọng văn hóa: tuyệt đối KHÔNG khỏa thân, kể cả trẻ em.
20. Gói phòng có vé VinWonders: sử dụng trò chơi/dịch vụ phải tuân thủ quy định độ tuổi, chiều cao, cân nặng và điều kiện an toàn từng trò; xem thêm tại website VinWonders.
21. Thực hiện các thủ tục khác theo quy định của Vinpearl và cơ quan quản lý lưu trú địa phương (nếu có).
22. Ban quản lý có thể yêu cầu Khách rời Khách sạn mà KHÔNG hoàn trả chi phí nếu Khách cố tình vi phạm quy định, nội quy.
23. Quy định tiếng ồn: sau 22:00, âm lượng tivi không mở quá mức 10; không mở loa quá lớn hoặc nói chuyện quá to. Tiếng ồn bị coi là quá mức khi làm khách khác phiền/khó chịu.
24. Quy Định Chung có thể được Vinpearl sửa đổi, bổ sung tại từng thời điểm; bản chính thức tại website Vinpearl.`;

function main() {
  const existing = storage.listKb().find((a: any) => a.title === TITLE);
  const now = new Date().toISOString();
  if (existing) {
    if ((existing as any).body === BODY) {
      console.log("Đã có và trùng nội dung — không đổi.");
      return;
    }
    storage.updateKb((existing as any).id, { body: BODY, tags: JSON.stringify(TAGS), updatedAt: now } as any);
    console.log(`[kb] cập nhật "${TITLE}"`);
  } else {
    storage.createKb({
      hotelId: 1,
      category: "policy",
      title: TITLE,
      body: BODY,
      tags: JSON.stringify(TAGS),
      updatedAt: now,
    } as any);
    console.log(`[kb] thêm mới "${TITLE}"`);
  }
  console.log("Reindexing...");
  reindex().then((r) => console.log(`  ${r.embedded}/${r.chunks} chunks embedded (${r.model})`));
}

main();
