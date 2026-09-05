/**
 * Migration 014: tắt truy xuất cho tài liệu VinWonders "placeholder" cũ, vì
 * nó tự mâu thuẫn với tài liệu "curated" đã có số liệu thật.
 *
 * Bắt được qua audit PRICING trên bộ 461 (2026-09-03): hai tài liệu cùng nói
 * về giá vé VinWonders nhưng NGƯỢC NHAU hoàn toàn —
 *
 *   article #4  "VinWonders Nha Trang tickets and shows" (quality: curated)
 *     có số liệu chi tiết theo chiều cao/tuổi, có nguồn: "Official VinWonders
 *     source, checked 2026-08-23". Vé trẻ em 1–1,4m: 800.000đ. Vé 2 ngày:
 *     1.280.000đ.
 *
 *   article #34 "Giá vé & giờ mở cửa VinWonders (thay đổi theo ngày)"
 *     (quality: placeholder, verified: unverified) nói thẳng "hệ thống
 *     KHÔNG chốt một con số cố định" — phủ nhận chính những con số ở #4.
 *
 * Tuỳ retrieval kéo về đoạn nào mà model hoặc trả lời đúng số (vì #4), hoặc
 * từ chối trả lời (vì #34) — cho CÙNG một câu hỏi. Hai ca benchmark
 * (BM-REAL-037 vé trẻ em, BM-REAL-040 vé 2 ngày) đo được đúng hiện tượng
 * này: model trả lời ĐÚNG theo #4 nhưng ground_truth (viết theo #34) chấm là
 * sai.
 *
 * SỬA: đặt `retrievable = 0` cho #34, KHÔNG xoá nội dung. #34 rõ ràng là bản
 * nháp có trước khi #4 được soạn kỹ với nguồn thật — giữ lại để tham khảo,
 * chỉ ngừng để nó cạnh tranh trong truy xuất. #4 vẫn giữ nguyên câu "giá vé
 * và giờ mở cửa THAY ĐỔI theo ngày" của riêng nó — tính thận trọng không mất
 * đi, chỉ không còn ở dạng phủ định tuyệt đối mâu thuẫn với chính số liệu kế
 * bên.
 *
 *   DB_FILE=data.db npx tsx server/migrations/014-vinwonders-placeholder-retire.ts
 */
import "dotenv/config";
import { storage } from "../storage";
import { reindex } from "../retrieval";

const TITLE_PLACEHOLDER = "Giá vé & giờ mở cửa VinWonders (thay đổi theo ngày)";
const TITLE_CURATED = "VinWonders Nha Trang tickets and shows";

function main() {
  const placeholder = storage.listKb().find((x: any) => x.title === TITLE_PLACEHOLDER);
  const curated = storage.listKb().find((x: any) => x.title === TITLE_CURATED);
  if (!placeholder) {
    console.log(`[skip] Không thấy article "${TITLE_PLACEHOLDER}"`);
    return;
  }
  if (!curated) {
    console.log(`[dừng] Không thấy article "${TITLE_CURATED}" — không tắt placeholder khi chưa chắc có bản thay thế.`);
    return;
  }
  if ((placeholder as any).retrievable === 0) {
    console.log("Đã tắt truy xuất cho placeholder từ trước — không đổi.");
    return;
  }
  storage.updateKb((placeholder as any).id, { retrievable: 0 } as any);
  console.log(`[kb] tắt truy xuất cho "${TITLE_PLACEHOLDER}" (id ${(placeholder as any).id})`);
  console.log("Reindexing...");
  reindex().then((r) => console.log(`  ${r.embedded}/${r.chunks} chunks embedded (${r.model})`));
}

main();
