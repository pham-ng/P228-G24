/**
 * Ngón tay cái của khách có đi được tới nơi không, và ai đọc được nó?
 *
 * Bảng `feedback` từng là bảng CHỈ GHI. `createFeedback` có người gọi,
 * `listFeedback` thì không, không trang nào hiển thị, và cột `message_id`
 * không tồn tại — nên endpoint nhận `messageId` từ client, phân tích nó, rồi
 * vứt đi. Hệ quả: biết khách bực ở hội thoại nào, không biết ở CÂU nào.
 *
 * Không có bài kiểm tra thuần nào bắt được chuyện đó. Nó là mối nối giữa
 * client, một cột cơ sở dữ liệu, một tuyến HTTP và một kiểm tra năng lực —
 * mỗi mảnh đều đúng khi xét riêng.
 *
 * Đi đúng đường khách đi: mã đặt phòng trong thân yêu cầu, không token nhân
 * viên. Dọn sạch mọi thứ nó tạo ra, kể cả việc khẩn và lời xin lỗi mà một
 * lượt chấm thấp sinh ra.
 *
 *   npx tsx bench/feedback-probe.ts
 */
import { storage, db } from "../server/storage";
import { feedbackEntries, tasks, messages } from "@shared/schema";
import { inArray } from "drizzle-orm";

const BASE = process.env.PROBE_BASE || "http://localhost:5000";
let failures = 0;
const ok = (c: boolean, m: string) => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${m}`);
  if (!c) failures++;
};

const beforeF = new Set(storage.listFeedback(500).map((x) => x.id));
const beforeT = new Set(storage.listTasks().map((x) => x.id));
const newF = () => storage.listFeedback(500).filter((x) => !beforeF.has(x.id));
const newT = () => storage.listTasks().filter((x) => !beforeT.has(x.id));

const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${BASE}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }).then(async (r) => ({ s: r.status, j: (await r.json().catch(() => ({}))) as any }));

const get = (p: string, headers: Record<string, string> = {}) =>
  fetch(`${BASE}${p}`, { headers }).then(async (r) => ({ s: r.status, j: (await r.json().catch(() => ({}))) as any }));

const login = async (name: string) => (await post("/api/staff/login", { name, pin: "1234" })).j.staffApiToken as string;

/* Chọn theo tính chất chứ không theo id, để probe còn nghĩa sau khi dựng lại
   dữ liệu mẫu: một đặt phòng mà hội thoại của nó ĐÃ CÓ câu trả lời của trợ lý,
   vì không có câu đó thì chẳng có gì để neo vào. */
const target = storage
  .listReservations()
  .map((r) => {
    const conv = storage.getConversationForReservation(r.id);
    const ai = conv ? [...storage.listMessages(conv.id)].reverse().find((m) => m.role === "ai") : undefined;
    return conv && ai ? { res: r, conv, ai } : null;
  })
  .find((x): x is NonNullable<typeof x> => x !== null)!;

/* Một tin nhắn của hội thoại KHÁC — đạn cho phép thử mạo danh bên dưới. */
const foreign = storage
  .listConversations()
  .filter((c) => c.id !== target.conv.id)
  .flatMap((c) => storage.listMessages(c.id))
  .find((m) => m.role === "ai");

async function main() {
  if (!target) {
    console.log("SKIP  không có hội thoại nào đã có câu trả lời của trợ lý");
    process.exit(0);
  }
  const { res: reservation, conv, ai } = target;
  const CODE = reservation.confirmationCode;
  console.log(`hội thoại #${conv.id} · câu trả lời #${ai.id} · mã ${CODE}\n`);

  /* Trạng thái hội thoại phải được trả lại nguyên vẹn: một lượt chấm thấp
     chuyển hội thoại sang chế độ người và đặt cảm xúc âm. */
  const snapshot = {
    mode: conv.mode,
    sentiment: conv.sentiment,
    sentimentSource: conv.sentimentSource,
    sentimentAt: conv.sentimentAt,
    topic: conv.topic,
    unreadForStaff: conv.unreadForStaff,
  };

  console.log("=== CÓ CHỖ ĐỂ CHỨA CÂU BỊ CHẤM ===");
  const probe = await post(`/api/conversations/${conv.id}/feedback`, { code: CODE, messageId: ai.id, rating: 5 });
  ok(probe.s === 200, `khách chấm được câu trả lời của chính mình (nhận ${probe.s})`);
  const stored = newF().find((f) => f.rating === 5);
  ok(!!stored, "một dòng phản hồi được ghi");
  ok(stored?.messageId === ai.id, `và nó NHỚ đúng câu nào bị chấm (message_id=${stored?.messageId ?? "null"})`);

  console.log("=== KHÔNG GẮN ĐƯỢC LỜI CHÊ LÊN CÂU CỦA NGƯỜI KHÁC ===");
  if (!foreign) console.log("  SKIP  chỉ có một hội thoại trong cơ sở dữ liệu này");
  else {
    /* Yêu cầu này ĐÃ qua cửa xác thực — mã đúng, hội thoại đúng. Thứ duy nhất
       sai là `messageId`. Không kiểm thì một khách có thể đổ lỗi câu trả lời
       của khách khác, và bảng chất lượng sẽ chỉ vào đúng câu vô can. */
    const r = await post(`/api/conversations/${conv.id}/feedback`, {
      code: CODE,
      messageId: foreign.id,
      rating: 1,
      comment: "probe: mạo nhận câu của hội thoại khác",
    });
    ok(r.s === 400, `câu của hội thoại khác bị từ chối (nhận ${r.s})`);
    ok(!newF().some((f) => f.messageId === foreign.id), "và không dòng nào được ghi");
  }

  console.log("=== KHÁCH CŨ KHÔNG BỊ VỠ ===");
  /* Client cũ không gửi `messageId`. Vẫn phải nhận, chỉ là không neo được. */
  const bare = await post(`/api/conversations/${conv.id}/feedback`, { code: CODE, rating: 5 });
  ok(bare.s === 200, `chấm mà không kèm messageId vẫn được nhận (nhận ${bare.s})`);
  ok(
    newF().some((f) => f.messageId === null),
    "dòng đó ghi message_id null chứ không làm hỏng yêu cầu",
  );

  console.log("=== CÓ NGƯỜI ĐỌC ĐƯỢC NÓ ===");
  const manager = storage.listStaff().find((s) => s.role === "manager")!;
  const tok = await login(manager.name);
  const seen = await get("/api/feedback", { "x-staff-token": tok });
  ok(seen.s === 200, `quản lý đọc được /api/feedback (nhận ${seen.s})`);
  const row = seen.j.items?.find((i: any) => i.messageId === ai.id);
  ok(!!row, "lượt chấm vừa gửi có mặt trong danh sách");
  /* Điểm mấu chốt: không phải "có id", mà là dòng đó TỰ KỂ ĐƯỢC câu chuyện.
     "rating 1 ở hội thoại #42" không sửa được gì cho ai. */
  ok(row?.answer === ai.body, "dòng đó mang theo NGUYÊN VĂN câu trả lời bị chấm");
  ok(typeof seen.j.anchored === "number" && seen.j.anchored >= 1, "và đếm được bao nhiêu lượt neo vào một câu cụ thể");

  console.log("=== NHƯNG KHÔNG PHẢI AI CŨNG ĐỌC ĐƯỢC ===");
  const other = storage.listStaff().find((s) => s.role !== "manager");
  if (!other) console.log("  SKIP  cơ sở dữ liệu này chỉ có quản lý");
  else {
    const t2 = await login(other.name);
    const r = await get("/api/feedback", { "x-staff-token": t2 });
    ok(r.s === 403, `${other.dept} không đọc được số liệu chất lượng (nhận ${r.s})`);
  }
  const anon = await get("/api/feedback");
  ok(anon.s === 401, `người lạ không có token thì không vào được (nhận ${anon.s})`);

  console.log("=== TUYẾN CŨ ĐÃ BIẾN MẤT ===");
  /* `/api/bench/report` phục vụ `bench/report.json` — năm ca từ 2026-08-21 và,
     quan trọng hơn, ba mã đặt phòng thật cùng nguyên văn lời khách. Nó nằm sau
     `staffApiGuard` nên không mở ra Internet, nhưng THIẾU kiểm tra năng lực:
     mọi vai đều đọc được. Mã đặt phòng không phải số liệu benchmark. */
  const gone = await get("/api/bench/report", { "x-staff-token": tok });
  ok(gone.s === 404, `tuyến cũ không còn được phục vụ (nhận ${gone.s})`);
  const rag = await get("/api/bench/rag", { "x-staff-token": tok });
  ok(rag.s === 200, "còn bộ 101 ca thì vẫn ở đó");

  /* --- dọn dẹp --- */
  const fIds = newF().map((x) => x.id);
  const tIds = newT().map((x) => x.id);
  /* Lượt chấm thấp sinh ra một lời xin lỗi dưới role `ai`. */
  const mIds = storage
    .listMessages(conv.id)
    .filter((m) => m.body.startsWith("Dạ, em rất xin lỗi vì thông tin chưa chính xác") && m.id > ai.id)
    .map((m) => m.id);
  if (fIds.length) db.delete(feedbackEntries).where(inArray(feedbackEntries.id, fIds)).run();
  if (tIds.length) db.delete(tasks).where(inArray(tasks.id, tIds)).run();
  if (mIds.length) db.delete(messages).where(inArray(messages.id, mIds)).run();
  storage.updateConversation(conv.id, snapshot);
  console.log(`\nđã dọn ${fIds.length} phản hồi, ${tIds.length} việc, ${mIds.length} tin nhắn; hội thoại #${conv.id} về nguyên trạng`);
  ok(newF().length === 0, "probe không để lại dòng nào");

  console.log(failures === 0 ? "\nALL FEEDBACK CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
