/**
 * Log có mang mã trace không, và JSON có đúng một dòng một object không?
 *
 * Đây là mắt nối giữa hai nguồn thông tin về cùng một lượt. Cơ sở dữ liệu có
 * trace đầy đủ với `traceId`; nếu log không mang mã đó thì khi có sự cố, người
 * trực ca có hai nửa của một bức tranh và không cách nào ghép lại — đúng tình
 * trạng trước bản vá này.
 *
 * Kiểm bằng cách chặn `console.*` thay vì đọc tệp log: không phụ thuộc đường
 * dẫn, chạy được trên mọi máy, và bắt được cả trường hợp một dòng JSON hỏng cú
 * pháp — thứ mà mắt người đọc lướt qua sẽ bỏ sót.
 */
import { setLogTrace, withLogTrace, getLogTrace } from "../server/log";

let failures = 0;
const t = (c: boolean, m: string) => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${m}`);
  if (!c) failures++;
};

/** Chạy một hàm và trả về mọi dòng nó in ra. */
function bat(fn: () => void): string[] {
  const ra: string[] = [];
  const goc = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a: any[]) => ra.push(a.join(" "));
  console.warn = (...a: any[]) => ra.push(a.join(" "));
  console.error = (...a: any[]) => ra.push(a.join(" "));
  try {
    fn();
  } finally {
    Object.assign(console, goc);
  }
  return ra;
}

/* `LOG_FORMAT` được đọc lúc nạp module, nên phải nạp lại để đổi chế độ. */
async function loadLogger(mode: "json" | "human") {
  if (mode === "json") process.env.LOG_FORMAT = "json";
  else delete process.env.LOG_FORMAT;
  const m = await import(`../server/log?bust=${mode}-${Math.random()}`);
  return m as typeof import("../server/log");
}

async function main() {
  console.log("=== CHẾ ĐỘ NGƯỜI ĐỌC ===");
  {
    const L = await loadLogger("human");
    const ra = bat(() => {
      L.setLogTrace(null);
      L.log("khong co trace");
      L.setLogTrace("tr_abcdef_123456");
      L.log("co trace");
      L.setLogTrace(null);
    });
    t(ra.length === 2, `in ra 2 dòng (được ${ra.length})`);
    t(!/</.test(ra[0]), "dòng không có trace thì không kèm mã");
    t(/<[a-z0-9_]{8}>/.test(ra[1]), `dòng có trace kèm mã rút gọn (${ra[1].slice(0, 40)})`);
    /* Rút gọn chứ không in đủ: mã đầy đủ làm dòng log không đọc nổi, mà 8 ký tự
       cuối vẫn đủ để đối chiếu với trang Traces. */
    t(!ra[1].includes("tr_abcdef_123456"), "và KHÔNG in nguyên mã dài");
  }

  console.log("=== CHẾ ĐỘ JSON ===");
  {
    const L = await loadLogger("json");
    const ra = bat(() => {
      L.setLogTrace("tr_xyz_999");
      L.logger.info("da nhan phong", { room: "108" }, "checkin");
      L.logger.error("model chet", { provider: "local" });
      L.setLogTrace(null);
      L.logger.warn("khong co trace o day");
    });
    t(ra.length === 3, `in ra 3 dòng (được ${ra.length})`);

    const objs = ra.map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    });
    t(
      objs.every((o) => o !== null),
      "MỌI dòng đều là JSON hợp lệ — một dòng hỏng là bộ gom log bỏ cả dòng",
    );
    t(objs[0]?.traceId === "tr_xyz_999", "mang traceId ĐẦY ĐỦ, không rút gọn (máy đọc thì cần cả mã)");
    t(objs[0]?.room === "108" && objs[0]?.source === "checkin", "giữ trường phụ và nguồn");
    t(objs[0]?.level === "info" && objs[1]?.level === "error", "mức log đúng");
    t(!("traceId" in (objs[2] ?? {})), "dòng ngoài lượt KHÔNG bịa ra traceId");
    t(typeof objs[0]?.ts === "string" && !Number.isNaN(Date.parse(objs[0].ts)), "dấu thời gian ISO phân tích được");
  }

  console.log("=== MÃ TRACE ĐƯỢC THÁO RA SAU KHI XONG ===");
  {
    const L = await loadLogger("human");
    L.setLogTrace(null);
    const trong = L.withLogTrace("tr_trong_luot", () => L.getLogTrace());
    t(trong === "tr_trong_luot", "trong lượt thì có mã");
    t(L.getLogTrace() === null, "ra khỏi lượt thì mã được tháo — tác vụ nền sau đó không mang mã của lượt đã xong");
  }

  console.log(failures === 0 ? "\nALL LOG TESTS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
