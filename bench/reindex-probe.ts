/**
 * Dựng lại chỉ mục có thật sự tăng dần không, và có bao giờ để lại khoảng trống?
 *
 * Ba điều bản trước làm sai, mỗi điều đo được:
 *   1. `clearChunks()` xoá sạch trước khi dựng → 136 chunk, 0 vector suốt ~15
 *      giây, và tìm kiếm ngữ nghĩa tắt gần một phút sau MỖI lần sửa một bài.
 *   2. Sửa một bài trong 52 bài vẫn nhúng lại cả 136 chunk.
 *   3. Lỗi bị `void ... .catch(() => {})` nuốt im lặng.
 *
 * Probe này canh cả ba, và canh cả cái bẫy ngược lại: "tăng dần" mà bỏ sót nội
 * dung đã đổi thì còn tệ hơn dựng lại toàn bộ — chỉ mục sẽ trả lời bằng văn bản
 * đã bị thay thế, không lỗi, không cảnh báo.
 *
 * Trả lại nguyên trạng bài viết nó sửa.
 *
 *   npx tsx bench/reindex-probe.ts
 */
import { storage } from "../server/storage";
import { reindex } from "../server/retrieval";

let failures = 0;
const ok = (c: boolean, m: string) => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${m}`);
  if (!c) failures++;
};
const soVector = () =>
  storage.listChunks().filter((c) => c.embedding != null).length;

async function main() {
  console.log("=== KHỞI ĐIỂM: CHỈ MỤC ĐANG ĐẦY ĐỦ ===");
  const t0 = Date.now();
  const base = await reindex();
  const msBase = Date.now() - t0;
  ok(base.chunks > 0, `chỉ mục có ${base.chunks} chunk`);
  ok(base.vectorCount === base.chunks, `mọi chunk đều có vector (${base.vectorCount}/${base.chunks})`);
  ok(!base.embedError, "không lỗi nhúng");
  console.log(`  (lượt này ${msBase}ms — nhúng lại ${base.embedded}, giữ nguyên ${base.kept})`);

  console.log("=== KHÔNG ĐỔI GÌ THÌ KHÔNG NHÚNG LẠI GÌ ===");
  const t1 = Date.now();
  const r2 = await reindex();
  const ms2 = Date.now() - t1;
  ok(r2.embedded === 0, `không nhúng lại chunk nào (nhúng ${r2.embedded})`);
  ok(r2.kept === r2.chunks, `giữ nguyên toàn bộ ${r2.kept}/${r2.chunks} chunk`);
  ok(r2.added === 0 && r2.changed === 0 && r2.removed === 0, "không thêm, không sửa, không xoá");
  /* Con số quyết định: bản cũ mất 65 giây cho đúng việc này. */
  ok(ms2 < 5000, `và mất ${ms2}ms — bản cũ mất ~65.000ms cho cùng việc`);
  ok(r2.vectorCount === r2.chunks, "chỉ mục vẫn đầy đủ vector");

  console.log("=== SỬA MỘT BÀI: CHỈ CHUNK CỦA BÀI ĐÓ BỊ ĐỘNG ===");
  const bai = storage.listKb().find((a) => a.retrievable !== 0 && (a.body ?? "").length > 40);
  if (!bai) {
    console.log("  SKIP  không có bài viết nào để sửa");
  } else {
    const goc = bai.body;
    const dauHieu = "ZZTHUNGHIEMREINDEXZZ";
    storage.updateKb(bai.id, { body: `${goc}\n${dauHieu}` });
    try {
      const t2 = Date.now();
      const r3 = await reindex();
      const ms3 = Date.now() - t2;
      ok(r3.changed > 0, `có ${r3.changed} chunk bị sửa`);
      ok(r3.changed <= 5, `và CHỈ vài chunk, không phải cả kho (${r3.changed}/${r3.chunks})`);
      ok(r3.embedded === r3.changed + r3.added, `chỉ nhúng lại đúng phần đã đổi (${r3.embedded})`);
      ok(r3.kept === r3.chunks - r3.changed - r3.added, `phần còn lại dùng lại vector cũ (${r3.kept})`);
      ok(ms3 < 20000, `mất ${ms3}ms`);
      ok(r3.vectorCount === r3.chunks, "và chỉ mục vẫn đầy đủ vector sau khi sửa");

      /* Cái bẫy ngược: "tăng dần" mà bỏ sót thì tệ hơn dựng lại toàn bộ. */
      const coDauHieu = storage.listChunks().some((c) => c.body.includes(dauHieu));
      ok(coDauHieu, "NỘI DUNG MỚI THẬT SỰ VÀO ĐƯỢC chỉ mục — không phải bỏ qua vì 'không đổi'");
    } finally {
      storage.updateKb(bai.id, { body: goc });
    }

    console.log("=== HOÀN NGUYÊN: DẤU HIỆU THỬ NGHIỆM BIẾN MẤT ===");
    const r4 = await reindex();
    ok(
      !storage.listChunks().some((c) => c.body.includes(dauHieu)),
      "văn bản cũ bị xoá khỏi chỉ mục, không nằm lại song song với bản mới",
    );
    ok(r4.vectorCount === r4.chunks, "chỉ mục đầy đủ trở lại");
  }

  console.log("=== ĐỔI MODEL NHÚNG THÌ PHẢI NHÚNG LẠI TẤT ===");
  {
    /* Vector của hai model khác nhau không so sánh được. Trộn chúng thì xếp
       hạng sai mà không báo lỗi gì — nên đổi model phải kéo theo nhúng lại
       toàn bộ, không được "giữ nguyên vì nội dung không đổi". */
    const mau = storage.listChunks()[0];
    if (!mau) console.log("  SKIP  chỉ mục rỗng");
    else {
      storage.setChunkEmbedding(mau.id, mau.embedding!, "model-khac-hoan-toan");
      const r5 = await reindex();
      ok(r5.changed >= 1, "chunk mang vector của model khác bị dựng lại");
      ok(r5.vectorCount === r5.chunks, "và chỉ mục đầy đủ trở lại");
    }
  }

  console.log("=== KHÔNG BAO GIỜ CÓ CHUNK MÀ KHÔNG CÓ VECTOR ===");
  ok(soVector() === storage.listChunks().length, "kết thúc với 100% chunk có vector");

  console.log(failures === 0 ? "\nALL REINDEX CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
