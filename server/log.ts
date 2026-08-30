/**
 * Ghi log — có cấu trúc khi cần máy đọc, dễ nhìn khi người đọc.
 *
 * Module này KHÔNG import gì. Nó từng nằm trong `index.ts`, tức điểm vào của
 * server, nên `backup.ts` lấy một hàm định dạng tám dòng từ đó là tạo ra vòng
 * `routes -> backup -> index -> routes`. Vòng đó ẩn được chỉ vì `routes.ts`
 * nạp `backup` qua `require()` lười — mà `require` không tồn tại trong gói
 * `"type": "module"`, nên `/metrics` và hai tuyến quản trị backup trả 500 ngay
 * lần đầu có ai gọi. Đích Prometheus chưa từng trả về một chỉ số nào.
 *
 * TẠI SAO CÓ JSON
 *
 * Bản trước chỉ in chuỗi ra stdout. Không có gì gom được, và quan trọng hơn:
 * **không nối được vào trace**. Cơ sở dữ liệu có 181 trace với `traceId` đầy
 * đủ, còn log thì không mang mã nào — nên khi có sự cố, người trực ca có hai
 * nguồn thông tin về cùng một lượt và không cách nào ghép chúng lại.
 *
 * Giờ mỗi dòng mang `traceId` khi lượt đó có trace. Đặt `LOG_FORMAT=json` thì
 * in JSON một dòng cho bộ gom log; để trống thì in như cũ, vì đọc JSON bằng
 * mắt trong lúc phát triển là cực hình.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const JSON_MODE = process.env.LOG_FORMAT === "json";

/**
 * Mã trace của lượt đang xử lý.
 *
 * Dùng biến module thay vì `AsyncLocalStorage` là một đánh đổi có chủ đích, và
 * nó CÓ giới hạn: Node xử lý một lượt tại một thời điểm trên vòng lặp sự kiện,
 * nhưng hai lượt chạy xen kẽ nhau qua các điểm `await` thì dòng log của lượt
 * này có thể mang mã của lượt kia.
 *
 * Chấp nhận được ở đây vì sản phẩm chạy trên một GPU 4GB phục vụ tuần tự — hai
 * lượt sinh chữ không bao giờ chồng nhau thật. Khi nào chạy nhiều máy hoặc mở
 * đồng thời thì đổi sang `AsyncLocalStorage`; chỗ sửa nằm gọn trong file này.
 */
let currentTraceId: string | null = null;

export function setLogTrace(traceId: string | null) {
  currentTraceId = traceId;
}
export function getLogTrace(): string | null {
  return currentTraceId;
}

/** Chạy một hàm với `traceId` gắn vào mọi dòng log bên trong nó. */
export function withLogTrace<T>(traceId: string, fn: () => T): T {
  const truoc = currentTraceId;
  currentTraceId = traceId;
  try {
    return fn();
  } finally {
    currentTraceId = truoc;
  }
}

function emit(level: LogLevel, message: string, source: string, extra?: Record<string, unknown>) {
  const traceId = currentTraceId;
  if (JSON_MODE) {
    /* Một dòng, một object. Bộ gom log nào cũng đọc được, và `traceId` là khoá
       để nhảy thẳng sang trace tương ứng. */
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      source,
      msg: message,
      ...(traceId ? { traceId } : {}),
      ...(extra ?? {}),
    });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
    return;
  }

  const gio = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  /* Mã trace rút gọn khi in cho người: đủ để đối chiếu với trang Traces, không
     đủ dài để làm dòng log không đọc nổi. */
  const tid = traceId ? ` <${traceId.slice(-8)}>` : "";
  const suffix = extra && Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : "";
  const out = `${gio} [${source}]${tid} ${message}${suffix}`;
  if (level === "error") console.error(out);
  else if (level === "warn") console.warn(out);
  else console.log(out);
}

/** Giữ nguyên chữ ký cũ — hàng chục chỗ trong dự án đang gọi `log(msg)`. */
export function log(message: string, source = "express") {
  emit("info", message, source);
}

export const logger = {
  debug: (msg: string, extra?: Record<string, unknown>, source = "app") => emit("debug", msg, source, extra),
  info: (msg: string, extra?: Record<string, unknown>, source = "app") => emit("info", msg, source, extra),
  warn: (msg: string, extra?: Record<string, unknown>, source = "app") => emit("warn", msg, source, extra),
  error: (msg: string, extra?: Record<string, unknown>, source = "app") => emit("error", msg, source, extra),
};
