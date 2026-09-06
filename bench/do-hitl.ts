/** Bộ nhận diện giao dịch offline thấy gì ở mỗi câu. */
import { detectTransactionRequest } from "../server/local-hitl";
for (const q of process.argv.slice(2)) {
  const p = detectTransactionRequest(q);
  console.log(`  ${(p ? p.kind : "KHÔNG KHỚP").padEnd(24)} ← ${q.slice(0, 62)}`);
}
