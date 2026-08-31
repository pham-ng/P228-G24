/**
 * Hàng đợi cho những việc chỉ chạy được một lúc một cái.
 *
 * VÌ SAO CÓ FILE NÀY. Ollama phục vụ tuần tự trên một GPU 4 GB, và một lượt trả
 * lời đo được **13,7 giây**. Trước file này không có gì xếp hàng: mười người bấm
 * gửi cùng lúc thì cả mười yêu cầu cùng lao vào, tranh nhau CPU, và người cuối
 * chờ hơn hai phút sau một dấu xoay không nói gì.
 *
 * Hàng đợi KHÔNG làm máy nhanh hơn. Nó đổi "chậm và im lặng" lấy "chậm nhưng
 * biết còn bao lâu" — và đó là khác biệt giữa một sản phẩm chậm và một sản phẩm
 * mà người dùng kết luận là hỏng. Cùng lập luận với nút loa: một nút bấm rồi im
 * hơn một giây đọc như nút hỏng.
 *
 * BA QUYẾT ĐỊNH:
 *
 *   · **chat = 1.** Không phải để tiết kiệm gì — Ollama vốn đã tuần tự, nên
 *     chạy song song hai lượt chỉ làm cả hai chậm đi. Đặt 1 để chỗ chờ nằm ở
 *     đây, nơi ĐẾM ĐƯỢC, thay vì nằm trong hàng đợi vô hình của Ollama.
 *   · **speech = 2.** Piper là tiến trình con nên không khoá vòng lặp sự kiện,
 *     nhưng đo được 6 yêu cầu song song làm mỗi yêu cầu chậm gấp 5 (1,5s → 7,3s)
 *     vì tranh CPU với chính model trả lời.
 *   · **Có trần hàng đợi.** Người thứ hai mươi thà bị từ chối ngay còn hơn chờ
 *     bốn phút rồi mới biết. Trần cộng với `Retry-After` là một câu trả lời
 *     trung thực; một hàng đợi không đáy thì không.
 */
import { log } from "./log";

export type SlotKind = "chat" | "speech";

/** Số việc chạy đồng thời cho mỗi loại. Ghi đè bằng biến môi trường khi cần. */
const GIOI_HAN: Record<SlotKind, number> = {
  chat: Math.max(1, Number(process.env.QUEUE_CHAT ?? 1)),
  speech: Math.max(1, Number(process.env.QUEUE_SPEECH ?? 2)),
};

/** Số người được xếp hàng trước khi từ chối thẳng. */
const TRAN: Record<SlotKind, number> = {
  chat: Math.max(1, Number(process.env.QUEUE_CHAT_MAX ?? 12)),
  speech: Math.max(1, Number(process.env.QUEUE_SPEECH_MAX ?? 12)),
};

/**
 * Bỏ cuộc nếu chờ quá lâu.
 *
 * Không có chốt này thì một lượt bị treo (model không trả lời, tiến trình con
 * chết) sẽ giữ slot mãi mãi và cả hàng đứng im — hỏng một lượt thành hỏng cả
 * dịch vụ. 13,7 giây một lượt, trần 12 người, nên 4 phút là rộng cho trường
 * hợp xấu nhất mà vẫn bắt được tình trạng kẹt thật.
 */
const HET_HAN_MS = Math.max(30_000, Number(process.env.QUEUE_TIMEOUT_MS ?? 240_000));

export class QueueFullError extends Error {
  constructor(
    readonly kind: SlotKind,
    readonly retryAfterSeconds: number,
  ) {
    super(`Hàng đợi ${kind} đã đầy.`);
    this.name = "QueueFullError";
  }
}

type Cho = { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

type TrangThai = { dangChay: number; hang: Cho[] };

const trangThai: Record<SlotKind, TrangThai> = {
  chat: { dangChay: 0, hang: [] },
  speech: { dangChay: 0, hang: [] },
};

/** Ước lượng giây cho mỗi việc — chỉ để nói với người dùng còn bao lâu. */
const GIAY_MOI_VIEC: Record<SlotKind, number> = { chat: 14, speech: 2 };

/**
 * Còn bao nhiêu người trước mặt, và ước chừng bao lâu nữa.
 *
 * `dangChay` được cộng vào vì người đang được phục vụ cũng là người phải đợi
 * xong. Đây là con số mà kiosk hiển thị trong lúc chờ.
 */
export function trangThaiHang(kind: SlotKind): {
  dangChay: number;
  dangCho: number;
  truocBan: number;
  uocGiay: number;
} {
  const t = trangThai[kind];
  const truocBan = t.dangChay + t.hang.length;
  return {
    dangChay: t.dangChay,
    dangCho: t.hang.length,
    truocBan,
    /* Chia cho số slot: hai việc chạy song song thì hàng ngắn đi một nửa. */
    uocGiay: Math.round((truocBan / GIOI_HAN[kind]) * GIAY_MOI_VIEC[kind]),
  };
}

function nhaSlot(kind: SlotKind): void {
  const t = trangThai[kind];
  t.dangChay--;
  const tiep = t.hang.shift();
  if (tiep) {
    clearTimeout(tiep.timer);
    t.dangChay++;
    tiep.resolve();
  }
}

function giuSlot(kind: SlotKind): Promise<void> {
  const t = trangThai[kind];
  if (t.dangChay < GIOI_HAN[kind]) {
    t.dangChay++;
    return Promise.resolve();
  }
  if (t.hang.length >= TRAN[kind]) {
    const doi = Math.ceil((t.hang.length / GIOI_HAN[kind]) * GIAY_MOI_VIEC[kind]);
    return Promise.reject(new QueueFullError(kind, doi));
  }
  return new Promise<void>((resolve, reject) => {
    const cho: Cho = {
      resolve,
      reject,
      timer: setTimeout(() => {
        /* Tự gỡ mình khỏi hàng — nếu không thì `nhaSlot` sau đó sẽ gọi
           `resolve` của một yêu cầu đã bỏ đi, và slot bị mất vĩnh viễn. */
        const i = t.hang.indexOf(cho);
        if (i >= 0) t.hang.splice(i, 1);
        reject(new QueueFullError(kind, 30));
      }, HET_HAN_MS),
    };
    t.hang.push(cho);
  });
}

/**
 * Chạy `fn` khi tới lượt.
 *
 * `finally` chứ không phải sau `await fn()`: một lượt ném lỗi mà không nhả slot
 * là cách hàng đợi tự siết cổ nó sau vài lỗi — hết slot, không ai vào được nữa,
 * và log thì không có gì bất thường.
 */
export async function xepHang<T>(kind: SlotKind, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  await giuSlot(kind);
  const cho = Date.now() - t0;
  if (cho > 1000) log(`queue: ${kind} chờ ${cho}ms trước khi chạy`);
  try {
    return await fn();
  } finally {
    nhaSlot(kind);
  }
}

/**
 * Còn chỗ để nhận thêm một người không — hỏi mà KHÔNG giữ slot.
 *
 * Cần tách khỏi `xepHang` vì tuyến chat phải từ chối TRƯỚC khi ghi tin nhắn
 * của khách vào cơ sở dữ liệu. Nếu kiểm sau, một lượt bị từ chối vẫn để lại
 * câu hỏi trong luồng, và khách gửi lại là có hai câu giống nhau.
 */
export function conChoDuoc(kind: SlotKind): boolean {
  const t = trangThai[kind];
  return t.dangChay < GIOI_HAN[kind] || t.hang.length < TRAN[kind];
}

/** Cho `/api/health` báo cáo. */
export function tomTatHang() {
  return {
    chat: { ...trangThaiHang("chat"), gioiHan: GIOI_HAN.chat, tran: TRAN.chat },
    speech: { ...trangThaiHang("speech"), gioiHan: GIOI_HAN.speech, tran: TRAN.speech },
  };
}
