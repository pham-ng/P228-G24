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
/**
 * Nạp `.env` GIỐNG server, nếu không mọi phép kiểm cấu hình ở đây đều sai.
 *
 * Bản đầu thiếu dòng này và hậu quả cụ thể: script đọc `process.env.TRUST_PROXY`
 * từ môi trường shell — nơi nó không bao giờ được đặt — rồi cảnh báo "TRUST_PROXY
 * chưa bật" trong khi `.env` đã bật và server đã áp dụng đúng (kiểm bằng 25 yêu
 * cầu từ 25 địa chỉ khác nhau: cả 25 đều qua, tức mỗi địa chỉ một ngân sách).
 *
 * Một cảnh báo sai còn tệ hơn không có cảnh báo: nó dạy người dùng bỏ qua cảnh
 * báo, và lần sau cái thật hiện ra thì cũng bị bỏ qua nốt.
 */
import "dotenv/config";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, renameSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";

const PORT = process.env.PORT || "5000";
const DICH = `http://localhost:${PORT}`;

/** Chỗ để cloudflared nếu phải tự tải. `bin/` nằm trong .gitignore. */
const BIN_DIR = join(process.cwd(), "bin");
const BIN_LOCAL = join(BIN_DIR, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");

const log = (s = "") => console.log(s);

/**
 * Thử một đường dẫn, và chỉ tin khi nó IN RA SỐ PHIÊN BẢN.
 *
 * Windows có "App Execution Alias": những tệp .exe giả trong WindowsApps mở
 * Microsoft Store rồi thoát. `winget.exe` trên máy phát triển này CHÍNH LÀ một
 * cái như vậy — nó nằm trên PATH, `where winget` tìm thấy nó, nhưng chạy thì
 * báo "The system cannot find the path specified". Cùng loại bẫy với "python"
 * giả mà scripts/setup.mjs đã phải né. Nên phép kiểm là hành vi, không phải sự
 * tồn tại của tệp.
 */
function thu(bin) {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
  const ra = (r.stdout || "") + (r.stderr || "");
  if (r.status === 0 && /\d+\.\d+/.test(ra)) return { bin, ver: ra.trim().split("\n")[0] };
  return null;
}

function timCloudflared() {
  /* Bản tự tải trước, rồi mới tới bản cài sẵn: nếu lần trước đã tải một bản
     chạy được thì dùng lại, đừng bắt tải lần nữa. */
  if (existsSync(BIN_LOCAL)) {
    const c = thu(BIN_LOCAL);
    if (c) return c;
  }
  return thu("cloudflared") ?? thu("cloudflared.exe");
}

/** cloudflared là MỘT tệp thực thi, không có bộ cài — tải về là dùng được ngay,
 *  không cần quyền quản trị. macOS phát hành dạng .tgz nên phải giải nén; ở đó
 *  brew gọn hơn, nên bỏ qua và hướng dẫn tay. */
const ASSET = {
  "win32-x64": "cloudflared-windows-amd64.exe",
  "win32-ia32": "cloudflared-windows-386.exe",
  "linux-x64": "cloudflared-linux-amd64",
  "linux-arm64": "cloudflared-linux-arm64",
};

/**
 * Tự tải cloudflared.
 *
 * VÌ SAO TỰ TẢI THAY VÌ BẢO NGƯỜI DÙNG CÀI. Hướng dẫn trước ghi
 * `winget install --id Cloudflare.cloudflared` — và trên chính máy này winget
 * là một alias hỏng, nên lệnh đó thất bại với một thông điệp không nhắc gì tới
 * cloudflared. Một bước cài mà mỗi máy có thể hỏng theo một kiểu riêng thì
 * không nên là bước bắt buộc.
 */
async function taiCloudflared() {
  const asset = ASSET[`${process.platform}-${process.arch}`];
  if (!asset) return null;

  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;
  log(`  ↓ đang tải cloudflared (${asset}) …`);
  try {
    const r = await fetch(url, { redirect: "follow" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    /* Một trang lỗi HTML cũng trả về 200 và vài KB. Tệp thật trên 20 MB, nên
       ngưỡng này phân biệt được "tải xong" với "tải về một lời xin lỗi". */
    if (buf.length < 1_000_000) throw new Error(`chỉ nhận được ${buf.length} byte — không phải tệp thật`);
    mkdirSync(BIN_DIR, { recursive: true });
    /* Ghi tệp tạm rồi đổi tên: một lần Ctrl+C giữa chừng để lại một .exe cụt mà
       lần chạy sau `existsSync` vẫn báo là có. */
    const tam = BIN_LOCAL + ".part";
    writeFileSync(tam, buf);
    renameSync(tam, BIN_LOCAL);
    if (process.platform !== "win32") chmodSync(BIN_LOCAL, 0o755);
    log(`  \x1b[32m✓\x1b[0m đã tải ${(statSync(BIN_LOCAL).size / 1048576).toFixed(1)} MB vào bin/`);
    return thu(BIN_LOCAL);
  } catch (e) {
    log(`  \x1b[31m✗\x1b[0m tải hỏng — ${e.message}`);
    return null;
  }
}

function huongDanCai() {
  log("\x1b[31m✗ Không có cloudflared, và tự tải cũng không xong.\x1b[0m\n");
  log("Tải tay một lần:\n");
  if (process.platform === "win32") {
    log("  1. Mở https://github.com/cloudflare/cloudflared/releases/latest");
    log("  2. Tải \x1b[1mcloudflared-windows-amd64.exe\x1b[0m");
    log(`  3. Đổi tên thành \x1b[1mcloudflared.exe\x1b[0m rồi đặt vào:`);
    log(`     \x1b[1m${BIN_DIR}\x1b[0m`);
    log("\n  Đừng dùng winget trên máy này — nó là một App Execution Alias hỏng.");
  } else if (process.platform === "darwin") {
    log("  \x1b[1mbrew install cloudflared\x1b[0m");
  } else {
    log("  Xem https://github.com/cloudflare/cloudflared/releases/latest");
  }
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

let cf = timCloudflared();
if (!cf) {
  log("\x1b[1mAurea — máy này chưa có cloudflared.\x1b[0m");
  cf = await taiCloudflared();
}
if (!cf) {
  huongDanCai();
  process.exit(1);
}

const h = await serverDangChay();
if (!h.song) {
  log(`\x1b[31m✗ Không có gì trả lời ở ${DICH}\x1b[0m`);
  log("\n  Mở một cửa sổ khác, vào đúng thư mục dự án, và chạy `npm start` trước.");
  log("  Rồi quay lại chạy `npm run tunnel`.");
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
      `    nên giới hạn tần suất sẽ khoá cả nhóm. Bỏ dấu # ở dòng TRUST_PROXY trong .env.\x1b[0m`,
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
