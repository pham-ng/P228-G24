import "dotenv/config";
import { hybridSearch } from "../server/retrieval";

const QS = [
  "Tôi trả phòng lúc 3 giờ chiều thì tính phí thế nào?",
  "Đến lúc 10 giờ sáng nhận phòng sớm thì phụ thu bao nhiêu?",
  "Còn 4 ngày nữa mới đến mà tôi muốn huỷ phòng thì mất bao nhiêu?",
  "Tôi bay đến lúc 5 giờ sáng, nhận phòng luôn có mất phí không?",
  "Hoá đơn có bị cộng thêm gì không ạ?",
];
for (const q of QS) {
  const r = await hybridSearch(q, 5);
  console.log(`\n"${q}"`);
  if (!r.length) { console.log("   (không trả về gì)"); continue; }
  for (const p of r) console.log(`   ${p.relevance.toFixed(4)} cov=${(p as any).coverage?.toFixed?.(2) ?? "?"} [${p.matched_by}] ${p.title}`);
}
process.exit(0);
