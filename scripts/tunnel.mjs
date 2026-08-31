#!/usr/bin/env node
/**
 * `npm run tunnel` — mở một đường ra Internet và in ra link gửi được.
 *
 * VÌ SAO CLOUDFLARE TUNNEL. Để người khác vào được máy này, cách thông thường
 * là mở cổng trên router và trỏ tên miền vào IP nhà — nghĩa là cần IP tĩnh, cần
 * quyền vào router, cần tự lo chứng chỉ HTTPS, và phơi thẳng máy cá nhân ra
 * Internet. Tunnel thì ngược lại: chính máy này **gọi ra ngoài**, Cloudflare giữ
 * đầu kia và cấp một URL HTTPS. Không mở cổng nào, không cần IP tĩnh.
 *
 * BA ĐIỀU PHẢI BIẾT, và đều là giới hạn thật:
 *
 *   1. **Link miễn phí đổi mỗi lần chạy lại.** Dạng `xxx.trycloudflare.com` là
 *      link dùng một lần. Muốn link cố định thì cần tài khoản Cloudflare (miễn
 *      phí) và một tên miền — xem docs/DEPLOY.md.
 *   2. **Máy tắt hoặc ngủ là link chết.** Không có gì chạy tiếp ở đâu cả.
 *   3. **Tunnel là một reverse proxy**, nên nếu không đặt `TRUST_PROXY=1` thì
 *      mọi khách trông như cùng một địa chỉ, và giới hạn tần suất sẽ khoá cả
 *      nhóm vì một người bấm nhiều.
 */
import { spawn, spawnSync } from "node:child_process";

const PORT = process.env.PORT || "5000";
const DICH = `http://localhost:${PORT}`;

const log = (s = "") => console.log(s);

function timCloudflared() {
  for (const c of ["cloudflared", "cloudflared.exe"]) {
    const r = spawnSync(c, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return { bin: c, ver: (r.stdout || "").trim().split("\n")[0] };
  }
  return null;
}

function huongDanCai() {
  log("\x1b[31m✗ Không tìm thấy `cloudflared`.\x1b[0m\n");
  log("Cài một lần, rồi chạy lại lệnh này:\n");
  if (process.platform === "win32") {
    log("  \x1b[1mwinget install --id Cloudflare.cloudflared\x1b[0m");
    log("  (hoặc tải .exe tại https://github.com/cloudflare/cloudflared/releases");
    log("   rồi đặt vào một thư mục nằm trong PATH)");
  } else if (process.platform === "darwin") {
    log("  \x1b[1mbrew install cloudflared\x1b[0m");
  } else {
    log("  Xem https://github.com/cloudflare/cloudflared/releases");
  }
  log("\nSau khi cài, mở cửa sổ dòng lệnh MỚI (PATH chỉ được đọc lúc khởi động).");
}

/** Server có đang chạy không — hỏi trước, vì tunnel trỏ vào một cổng chết thì
 *  vẫn tạo ra link, và người nhận link sẽ thấy trang lỗi của Cloudflare. */
async function serverDangChay() {
  try {
    const r = await fetch(`${DICH}/api/health`, { signal: AbortSignal.timeout(4000) });
    const j = await r.json().catch(() => null);
    return { song: true, status: j?.status ?? "?", model: j?.model?.engine ?? "?" };
  } catch {
    return { song: false };
  }
}

const cf = timCloudflared();
if (!cf) {
  huongDanCai();
  process.exit(1);
}

const h = await serverDangChay();
if (!h.song) {
  log(`\x1b[31m✗ Không có gì trả lời ở ${DICH}\x1b[0m`);
  log("\n  Mở một cửa sổ khác và chạy `npm start` (hoặc `npm run dev`) trước,");
  log("  rồi quay lại chạy `npm run tunnel`.");
  log("\n  Tunnel trỏ vào một cổng chết vẫn tạo ra link — và người nhận link");
  log("  sẽ thấy trang lỗi của Cloudflare chứ không phải sản phẩm của anh/chị.");
  process.exit(1);
}

log(`\x1b[1mAurea — mở đường ra Internet\x1b[0m`);
log(`  cloudflared : ${cf.ver}`);
log(`  server      : ${DICH} — ${h.status}, model ${h.model}`);
if (h.status !== "ok")
  log(`  \x1b[33m! Server báo "${h.status}" — kiểm /api/health trước khi gửi link.\x1b[0m`);
if (process.env.TRUST_PROXY !== "1")
  log(
    `  \x1b[33m! TRUST_PROXY chưa bật: qua tunnel mọi khách trông như một địa chỉ,\n` +
      `    nên giới hạn tần suất sẽ khoá cả nhóm. Đặt TRUST_PROXY=1 trong .env.\x1b[0m`,
  );
log("");

/* `--no-autoupdate`: một bản cập nhật tự động giữa buổi demo sẽ khởi động lại
   tiến trình, và link đổi theo. */
const p = spawn(cf.bin, ["tunnel", "--no-autoupdate", "--url", DICH], {
  stdio: ["ignore", "pipe", "pipe"],
});

let daIn = false;
const batLink = (chunk) => {
  const s = String(chunk);
  process.stderr.write(s);
  /* cloudflared in URL ra stderr, giữa một khung kẻ. Bắt bằng biểu thức chứ
     không đọc theo dòng cố định — khung đó đổi theo phiên bản. */
  const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (m && !daIn) {
    daIn = true;
    log(`\n\x1b[32m\x1b[1m╭─ Link gửi cho người khác ────────────────────────╮\x1b[0m`);
    log(`\x1b[32m\x1b[1m│  ${m[0]}\x1b[0m`);
    log(`\x1b[32m\x1b[1m╰──────────────────────────────────────────────────╯\x1b[0m`);
    log(`\n  Đóng cửa sổ này là link chết. Ctrl+C để dừng.`);
    log(`  Link này đổi mỗi lần chạy lại — xem docs/DEPLOY.md để có link cố định.\n`);
  }
};

p.stdout.on("data", batLink);
p.stderr.on("data", batLink);
p.on("close", (code) => {
  log(`\ncloudflared đã dừng (mã ${code}). Link không còn dùng được.`);
  process.exit(code ?? 0);
});
