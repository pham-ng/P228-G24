import { useQuery } from "@tanstack/react-query";
import { AureaLogo } from "@/components/logo";
import { Skeleton } from "@/components/ui/skeleton";
import { money } from "@/lib/format";

type PayInfo = {
  amount: number;
  currency: string;
  status: "pending" | "paid" | "expired" | string;
  method: string;
  expiresAt: string | null;
  hotelName: string;
  gatewayConnected: boolean;
  /** Data-URI PNG, or null when the hotel has no bank details configured. */
  qr: string | null;
  qrError: string | null;
  bankAccountName: string | null;
};

const METHOD_LABEL: Record<string, string> = {
  cash: "tiền mặt",
  card_on_file: "thẻ",
  bank_transfer: "chuyển khoản",
  payment_link: "liên kết thanh toán",
  room_charge: "ghi vào phòng",
};

/**
 * What a guest sees when they open a payment link.
 *
 * `create_payment_link` has always produced `/pay/<token>` and there has never
 * been a page behind it: the URL fell through to the SPA index and rendered
 * NotFound. A link the hotel sends a guest that leads to a blank page is worse
 * than sending no link.
 *
 * This page deliberately does NOT pretend to take money. Aurea holds no card
 * credentials and is connected to no gateway, so the honest thing is to show
 * the amount and say where to pay. When a real PSP is wired up,
 * `gatewayConnected` flips and a pay button belongs here.
 */
export default function PayPage() {
  const token = window.location.hash.replace(/^#/, "").split("?")[0].split("/").filter(Boolean).pop() ?? "";
  const { data, isLoading, isError } = useQuery<PayInfo>({
    queryKey: [`/api/pay/${token}`],
    enabled: token.length >= 8,
    retry: false,
  });

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <AureaLogo subtitle={data?.hotelName ?? "Thanh toán"} />
        </div>

        <div className="rounded-lg border border-card-border bg-card p-5">
          {isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-9 w-40" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : isError || !data ? (
            <>
              <h1 className="text-base font-semibold">Liên kết không hợp lệ</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Liên kết này không tồn tại hoặc đã hết hạn. Quý khách vui lòng liên hệ lễ tân để được
                hỗ trợ.
              </p>
            </>
          ) : data.status === "paid" ? (
            <>
              <p className="text-xs font-medium uppercase tracking-wide text-chart-2">Đã thanh toán</p>
              <p className="mt-1 font-mono text-2xl font-semibold">{money(data.amount)}</p>
              <p className="mt-3 text-sm text-muted-foreground">
                Khoản này đã được ghi nhận. Quý khách không cần thao tác gì thêm.
              </p>
            </>
          ) : data.status === "expired" ? (
            <>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Đã hết hạn
              </p>
              <p className="mt-1 font-mono text-2xl font-semibold text-muted-foreground">
                {money(data.amount)}
              </p>
              <p className="mt-3 text-sm text-muted-foreground">
                Liên kết đã quá hạn. Vui lòng liên hệ lễ tân để nhận liên kết mới hoặc thanh toán trực
                tiếp tại quầy.
              </p>
            </>
          ) : (
            <>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Số tiền cần thanh toán
              </p>
              <p className="mt-1 font-mono text-2xl font-semibold">{money(data.amount)}</p>

              {/* VietQR when the hotel has bank details, and a plain instruction
                  when it does not — never a payment button, because nothing
                  here can charge anything. */}
              {data.qr ? (
                <div className="mt-4 rounded-md border border-card-border p-4 text-center">
                  <p className="text-sm font-medium">Quét mã để chuyển khoản</p>
                  <img
                    src={data.qr}
                    alt="Mã VietQR"
                    className="mx-auto mt-3 h-56 w-56 rounded bg-white p-2"
                    data-testid="vietqr-image"
                  />
                  <p className="mt-3 text-xs text-muted-foreground">
                    Mở ứng dụng ngân hàng bất kỳ và quét mã. Số tiền và nội dung đã điền sẵn.
                  </p>
                  {data.bankAccountName && (
                    <p className="mt-1 text-xs font-medium">Người nhận: {data.bankAccountName}</p>
                  )}
                  <p className="mt-3 border-t border-card-border pt-3 text-xs text-muted-foreground">
                    Sau khi chuyển, vui lòng báo lễ tân để được xác nhận.
                  </p>
                </div>
              ) : (
                <div className="mt-4 rounded-md bg-muted/50 p-3 text-sm">
                  <p className="font-medium">Thanh toán tại quầy lễ tân</p>
                  <p className="mt-1 text-muted-foreground">
                    Quý khách vui lòng đưa màn hình này cho lễ tân, hoặc đọc số tiền ở trên. Hình
                    thức dự kiến: {METHOD_LABEL[data.method] ?? data.method}.
                  </p>
                  {data.qrError && (
                    <p className="mt-2 text-xs text-destructive">
                      Không tạo được mã QR chuyển khoản.
                    </p>
                  )}
                </div>
              )}

              {data.expiresAt && (
                <p className="mt-3 text-xs text-muted-foreground">
                  Có hiệu lực đến {new Date(data.expiresAt).toLocaleString("vi-VN")}.
                </p>
              )}
            </>
          )}
        </div>

        <p className="mt-4 text-center text-[11px] text-muted-foreground">
          Trang này không thu tiền và không lưu thông tin thẻ.
        </p>
      </div>
    </div>
  );
}
