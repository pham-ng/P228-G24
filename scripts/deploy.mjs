#!/usr/bin/env node
/**
 * `npm run deploy` — kéo code mới về và dựng lại bản chạy thật.
 *
 * VÌ SAO KHÔNG PHẢI MỘT DÒNG `git pull && npm run build`. Vì thứ tự và các chốt
 * chặn mới là nội dung thật của việc triển khai:
 *
 *   · **Kiểm thử chạy TRƯỚC build.** Build một bản đã hỏng rồi mới phát hiện
 *     nghĩa là bản hỏng đã nằm trong `dist/`, và người tiếp theo chạy
 *     `npm start` sẽ phục vụ nó.
 *   · **Kiểm model TRƯỚC khi khởi động lại.** Trọng số giọng nói không nằm
 *     trong git; một `git clean` hay một ổ đĩa đầy làm chúng biến mất, và
 *     server sẽ **âm thầm** tắt nút mic với nút loa thay vì báo lỗi.
 *   · **Không tự khởi động lại server.** Script này không biết server đang chạy
 *     dưới dạng gì trên máy anh/chị, và một lệnh "kill mọi tiến trình node" là
 *     cách nhanh nhất để giết luôn thứ khác. Nó dừng lại và nói ra việc cuối
 *     cùng cần làm bằng tay.
 *
 * Không tự `git pull` khi cây làm việc còn thay đổi chưa commit — mất việc của
 * người khác là thứ một script triển khai không bao giờ được phép làm.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const BO_QUA_TEST = process.argv.includes("--skip-tests");
const KHONG_KEO = process.argv.includes("--no-pull");

const log = (s = "") => console.log(s);
const buoc = (s) => log(`\n\x1b[1m▸ ${s}\x1b[0m`);
const ok = (s) => log(`  \x1b[32m✓\x1b[0m ${s}`);

function chay(cmd, args, { batLoi = true } = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: false });
  if (r.status !== 0 && batLoi) {
    log(`\n\x1b[31m✗ Dừng lại: \`${cmd} ${args.join(" ")}\` thoát ${r.status}.\x1b[0m`);
    log("  Bản đang chạy KHÔNG bị đụng tới — nó vẫn là bản cũ và vẫn hoạt động.");
    process.exit(r.status ?? 1);
  }
  return r.status === 0;
}

function doc(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return (r.stdout ?? "").trim();
}

log("\x1b[1mAurea — triển khai\x1b[0m");

/* ------------------------------------------------------- 1. kéo code mới */

if (!KHONG_KEO) {
  buoc("Kéo code mới");
  const ban = doc("git", ["status", "--porcelain"]);
  if (ban) {
    log("\x1b[31m✗ Cây làm việc còn thay đổi chưa commit:\x1b[0m");
    log(
      ban
        .split("\n")
        .map((l) => "    " + l)
        .join("\n"),
    );
    log("\n  Commit hoặc `git stash` trước đã. Script này không kéo đè lên việc đang dở.");
    log("  Nếu chắc chắn muốn bỏ qua bước kéo: `npm run deploy -- --no-pull`");
    process.exit(1);
  }
  const truoc = doc("git", ["rev-parse", "--short", "HEAD"]);
  chay("git", ["pull", "--ff-only"]);
  const sau = doc("git", ["rev-parse", "--short", "HEAD"]);
  ok(truoc === sau ? `đã ở bản mới nhất (${sau})` : `${truoc} → ${sau}`);
} else {
  buoc("Bỏ qua bước kéo (--no-pull)");
}

/* ------------------------------------------------------ 2. phụ thuộc */

buoc("Phụ thuộc");
/* `npm ci` chứ không phải `install`: nó dựng lại đúng package-lock.json, nên
   bản trên máy chạy thật giống hệt bản CI vừa kiểm. */
chay("npm", ["ci"]);
ok("node_modules khớp package-lock.json");

/* ------------------------------------- 3. model có còn trên đĩa không */

buoc("Model giọng nói");
const coModel = chay("node", ["scripts/setup.mjs", "--verify"], { batLoi: false });
if (!coModel) {
  log("\n  \x1b[33m! Thiếu model. Chat văn bản vẫn chạy, nút mic và nút loa sẽ không hiện.\x1b[0m");
  log("    Chạy `npm run setup` để tải, rồi deploy lại.");
}

/* ------------------------------------------------------- 4. kiểm tra */

buoc("Kiểm tra kiểu");
chay("npx", ["tsc", "--noEmit"]);
ok("tsc sạch");

if (BO_QUA_TEST) {
  log("\n  \x1b[33m! Bỏ qua kiểm thử theo --skip-tests\x1b[0m");
} else {
  buoc("Kiểm thử");
  chay("npm", ["test"]);
  ok("toàn bộ test xanh");
}

/* --------------------------------------------------------- 5. build */

buoc("Build");
chay("npm", ["run", "build"]);
if (!existsSync("dist/index.cjs")) {
  log("\x1b[31m✗ Build chạy xong nhưng không có dist/index.cjs.\x1b[0m");
  process.exit(1);
}
ok("dist/index.cjs + dist/public");

/* ------------------------------------------------------- 6. việc cuối */

log("\n\x1b[32m\x1b[1m── Xong. Còn một việc phải làm bằng tay ──\x1b[0m");
log("");
log("  Khởi động lại server để nó chạy bản mới:");
log("    \x1b[1mnpm start\x1b[0m                (chỉ máy này vào được)");
log("    \x1b[1mHOST=0.0.0.0 npm start\x1b[0m   (máy khác trong mạng vào được)");
log("");
log("  Đang mở ra Internet? Đọc \x1b[1mdocs/DEPLOY.md\x1b[0m trước, rồi:");
log("    \x1b[1mnpm run tunnel\x1b[0m           (Cloudflare Tunnel, in ra link công khai)");
log("");
log("  Kiểm tra sau khi khởi động lại:");
log("    curl http://localhost:5000/api/health");
