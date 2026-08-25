/**
 * Vietnamese labels + plain-language help for each observability signal code.
 *
 * The raw codes (tool_needs_input, retrieval_empty…) are precise but English and
 * technical. This dictionary lets the Traces page show a short Vietnamese label
 * with a tooltip a non-technical operator — or a customer in a demo — can read.
 * The raw code stays available in the tooltip so an engineer can still grep it.
 *
 * Keep in step with SignalCode in server/observability.ts.
 */

export type SignalMeta = { label: string; help: string };

export const SIGNAL_VI: Record<string, SignalMeta> = {
  tool_error: {
    label: "Công cụ lỗi",
    help: "Công cụ agent gọi bị lỗi hoặc trả về lỗi.",
  },
  tool_needs_input: {
    label: "Thiếu thông tin",
    help: "Agent gọi công cụ trước khi khách cung cấp đủ dữ kiện (tên, ngày, số người…). Công cụ đã từ chối và yêu cầu hỏi thêm.",
  },
  tool_blocked: {
    label: "Yêu cầu bất khả thi",
    help: "Công cụ không thực hiện được yêu cầu như đang nêu — ví dụ ngày trả trước ngày nhận, hết phòng, hoặc quá số người cho phép.",
  },
  tool_repeat: {
    label: "Gọi lặp",
    help: "Cùng một công cụ được gọi lại với tham số y hệt trong một lượt — thường là dấu hiệu agent bị lặp vòng.",
  },
  empty_tool_result: {
    label: "Kết quả rỗng",
    help: "Công cụ trả về không có dữ liệu dùng được.",
  },
  unknown_tool: {
    label: "Công cụ không tồn tại",
    help: "Agent gọi một công cụ không có trong hệ thống.",
  },
  bad_arguments: {
    label: "Tham số sai định dạng",
    help: "Tham số agent truyền cho công cụ không phải JSON hợp lệ.",
  },
  router_guessed: {
    label: "Định tuyến đoán",
    help: "Tin nhắn không khớp từ khoá nào, nên hệ thống tạm dùng bộ công cụ mặc định. Không phải lỗi, chỉ là mức tin cậy thấp.",
  },
  family_dropped: {
    label: "Cắt bớt công cụ",
    help: "Một nhóm công cụ mà câu hỏi cần đã bị cắt do vượt ngân sách token. Đây là nguyên nhân hay gặp khi câu trả lời bị thiếu ý.",
  },
  capability_miss: {
    label: "Không tra được năng lực",
    help: "Agent đi tìm một năng lực mà bộ định tuyến không xác định được; nó được cấp toàn bộ công cụ để tự chọn ở bước sau.",
  },
  retrieval_empty: {
    label: "Tra cứu rỗng",
    help: "Tra cứu kho tri thức không trả về đoạn văn nào khớp.",
  },
  retrieval_degraded: {
    label: "Tra cứu suy giảm",
    help: "Mất nhánh tìm theo ngữ nghĩa (embedding); chỉ còn tìm bằng từ khoá. Kết quả có thể kém chính xác hơn.",
  },
  numeric_fabrication: {
    label: "Bịa số",
    help: "Bộ kiểm số phát hiện con số (giá, %, giờ) trong câu trả lời không có nguồn từ công cụ nào trong lượt này.",
  },
  reply_repaired: {
    label: "Đã sửa câu trả lời",
    help: "Bộ kiểm số đã cắt bỏ câu chứa số không có nguồn trước khi gửi cho khách.",
  },
  forced_escalation: {
    label: "Buộc chuyển nhân viên",
    help: "Một lớp bảo vệ (không phải model tự quyết) đã chuyển cuộc trò chuyện cho nhân viên xử lý.",
  },
  empty_reply: {
    label: "Không có câu trả lời",
    help: "Model không tạo ra câu trả lời nào; hệ thống đã dùng câu dự phòng và chuyển nhân viên.",
  },
  max_rounds_hit: {
    label: "Chạm giới hạn vòng",
    help: "Vòng gọi công cụ đạt trần mà vẫn chưa ra câu trả lời cuối.",
  },
  language_mismatch: {
    label: "Sai ngôn ngữ",
    help: "Câu trả lời không cùng ngôn ngữ với tin nhắn của khách (ví dụ khách viết tiếng Việt nhưng trả lời tiếng Anh).",
  },
  failover: {
    label: "Chuyển nhà cung cấp",
    help: "Nhà cung cấp AI chính bị lỗi nên bản dự phòng đã trả lời thay.",
  },
  provider_error: {
    label: "Lỗi nhà cung cấp",
    help: "Một lệnh gọi tới mô hình AI bị lỗi.",
  },
};

/** Vietnamese word for a severity level. */
export const SEVERITY_VI: Record<"info" | "warn" | "error", string> = {
  info: "Thông tin",
  warn: "Cảnh báo",
  error: "Lỗi",
};

/** Label for a code, falling back to the raw code when unknown. */
export function signalLabel(code: string): string {
  return SIGNAL_VI[code]?.label ?? code;
}

export function signalHelp(code: string): string {
  return SIGNAL_VI[code]?.help ?? code;
}
