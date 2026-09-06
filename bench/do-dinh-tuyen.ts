/** In ra bộ định tuyến quyết định gì cho từng câu — trước khi truy xuất chạy. */
import { classifyLocal } from "../server/local-agent";
for (const q of process.argv.slice(2)) {
  const r = classifyLocal(q, false);
  console.log(`  ${JSON.stringify(r).slice(0, 150)}\n    ← ${q}`);
}
