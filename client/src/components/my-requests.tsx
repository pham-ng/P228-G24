/**
 * "Những gì tôi đã nhờ" — trạng thái mọi yêu cầu của khách.
 *
 * Khoảng trống này lớn hơn nó trông có vẻ: khách đặt được spa, gọi được đồ ăn,
 * xin được báo thức, rồi KHÔNG có chỗ nào xem chúng đang ở đâu. Cách duy nhất
 * để kiểm tra là hỏi lại chatbot — mà chatbot cũng không tra được, vì
 * `get_request_status` là một tool chỉ chạy trên luồng hosted.
 *
 * Ba nguồn (yêu cầu, đơn chờ duyệt, đặt dịch vụ) gộp thành MỘT danh sách, vì
 * với khách chúng là một thứ. Chia theo bảng là bắt khách học sơ đồ cơ sở dữ
 * liệu của khách sạn.
 */
import { useQuery } from "@tanstack/react-query";
import { Check, Clock, Loader2, X, ClipboardList } from "lucide-react";

type Item = {
  kind: string;
  source: "request" | "approval" | "booking";
  summary: string;
  status: string;
  scheduledFor: string | null;
  amount: number | null;
  createdAt: string;
};

const T = {
  title: { vi: "Yêu cầu của tôi", en: "My requests", ko: "내 요청", ja: "リクエスト履歴", zh: "我的请求", ru: "Мои заявки" },
  empty: {
    vi: "Quý khách chưa gửi yêu cầu nào.",
    en: "You haven't sent any requests yet.",
    ko: "아직 보낸 요청이 없습니다.",
    ja: "まだご依頼はありません。",
    zh: "您还没有提交任何请求。",
    ru: "Вы ещё не отправляли заявок.",
  },
  /* Trạng thái viết theo cách KHÁCH hiểu, không phải theo tên cột trong DB.
     "pending" với kỹ sư là một enum; với khách nó phải nói rõ ai đang giữ việc
     và họ cần làm gì tiếp (không cần làm gì cả). */
  waiting: {
    vi: "Đang chờ lễ tân xác nhận",
    en: "Waiting for the front desk",
    ko: "프런트 확인 대기 중",
    ja: "フロントの確認待ち",
    zh: "等待前台确认",
    ru: "Ожидает подтверждения",
  },
  inProgress: { vi: "Đang thực hiện", en: "In progress", ko: "진행 중", ja: "対応中", zh: "处理中", ru: "В работе" },
  done: { vi: "Đã xong", en: "Done", ko: "완료", ja: "完了", zh: "已完成", ru: "Готово" },
  declined: { vi: "Không thực hiện được", en: "Not possible", ko: "처리 불가", ja: "対応できません", zh: "无法处理", ru: "Невозможно" },
  loading: { vi: "Đang tải…", en: "Loading…", ko: "불러오는 중…", ja: "読み込み中…", zh: "加载中…", ru: "Загрузка…" },
} as const;

type Lang = keyof (typeof T)["title"];
const tr = (lang: string, k: keyof typeof T) => T[k][(lang in T.title ? lang : "en") as Lang];

/** Tên loại yêu cầu, cho khách đọc. */
const KIND: Record<string, Record<string, string>> = {
  vi: {
    wake_up: "Báo thức", housekeeping: "Dọn phòng", amenity: "Đồ dùng", laundry: "Giặt là",
    luggage: "Hành lý", book_service: "Đặt dịch vụ", order_room_service: "Gọi đồ lên phòng",
    service_booking: "Đặt dịch vụ", request_late_checkout: "Trả phòng muộn",
    request_early_checkin: "Nhận phòng sớm", cancel_reservation: "Huỷ đặt phòng",
  },
  en: {
    wake_up: "Wake-up call", housekeeping: "Housekeeping", amenity: "Amenities", laundry: "Laundry",
    luggage: "Luggage", book_service: "Service booking", order_room_service: "In-room dining",
    service_booking: "Service booking", request_late_checkout: "Late check-out",
    request_early_checkin: "Early check-in", cancel_reservation: "Cancellation",
  },
};

/** Ba trạng thái khách quan tâm, gộp từ nhiều enum khác nhau ở ba bảng. */
function bucket(status: string): "waiting" | "inProgress" | "done" | "declined" {
  if (["done", "confirmed", "approved", "completed"].includes(status)) return "done";
  if (["cancelled", "rejected", "declined"].includes(status)) return "declined";
  if (["in_progress"].includes(status)) return "inProgress";
  return "waiting";
}

const vnd = (n: number, cur: string) => (cur === "VND" ? `${n.toLocaleString("vi-VN")}₫` : `${n} ${cur}`);

export function MyRequestsPanel({ code, lang }: { code: string | null; lang: string }) {
  const { data, isLoading } = useQuery<{ currency: string; items: Item[] }>({
    queryKey: ["/api/guest/my-requests?code=" + encodeURIComponent(code ?? "")],
    enabled: !!code,
    /* Trạng thái đổi ở phía nhân viên, không phải ở đây — nên phải tự hỏi lại.
       20 giây đủ để khách thấy "đã xong" mà không dội API. */
    refetchInterval: 20_000,
  });

  if (!code) return null;
  const items = data?.items ?? [];

  return (
    <div className="mt-3 rounded-xl border border-primary/25 bg-card/90 p-3.5" data-testid="my-requests-panel">
      <h4 className="flex items-center gap-2 border-b border-border/40 pb-2 text-xs font-bold text-foreground">
        <ClipboardList className="h-4 w-4 shrink-0 text-primary" />
        {tr(lang, "title")}
      </h4>

      {isLoading && <p className="pt-2.5 text-[11px] text-muted-foreground">{tr(lang, "loading")}</p>}
      {!isLoading && !items.length && (
        <p className="pt-2.5 text-[11px] text-muted-foreground">{tr(lang, "empty")}</p>
      )}

      <ul className="space-y-1.5 pt-2">
        {items.map((it, i) => {
          const b = bucket(it.status);
          const Icon = b === "done" ? Check : b === "declined" ? X : b === "inProgress" ? Loader2 : Clock;
          const tone =
            b === "done"
              ? "text-emerald-600 dark:text-emerald-400"
              : b === "declined"
                ? "text-destructive"
                : "text-muted-foreground";
          const kindName = (KIND[lang] ?? KIND.en)[it.kind] ?? (KIND.en[it.kind] ?? it.kind);
          return (
            <li
              key={`${it.source}-${it.createdAt}-${i}`}
              data-testid="my-request-row"
              className="flex items-start gap-2 border-b border-dashed border-border/30 py-1.5 last:border-none"
            >
              <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${tone}`} />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-foreground/90">{kindName}</div>
                <div className="truncate text-[11px] text-muted-foreground">{it.summary}</div>
                <div className={`text-[11px] font-medium ${tone}`}>{tr(lang, b)}</div>
              </div>
              {it.amount ? (
                <span className="shrink-0 text-[11px] font-bold text-amber-600 dark:text-amber-400">
                  {vnd(it.amount, data?.currency ?? "VND")}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
