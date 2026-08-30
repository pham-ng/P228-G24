/**
 * Sinh mã QR thẻ căn cước GIẢ, để demo.
 *
 * Vì sao cần: muốn thử luồng quét thì phải có cái để quét, mà không ai nên
 * chìa thẻ căn cước thật của mình ra trong một buổi demo. Cái này dựng đúng
 * định dạng bảy trường của thẻ thật, với **số hoàn toàn bịa**, và tự ghép tên
 * của một đặt phòng đang có trong hệ thống để luồng chạy tới cuối.
 *
 * Số căn cước mặc định bắt đầu bằng `000` — mã tỉnh này KHÔNG tồn tại (mã thật
 * chạy từ 001 đến 096), nên chuỗi sinh ra không thể trùng thẻ của người nào.
 * Có chủ ý: một mã QR demo trôi nổi mà lại trùng số thật thì là một tai nạn về
 * dữ liệu cá nhân.
 *
 * Dùng gói `qrcode` đã có sẵn trong dự án, không thêm phụ thuộc nào.
 */
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { QrCode } from "lucide-react";

/** Số bịa: `000` không phải mã tỉnh hợp lệ, nên không đụng thẻ thật của ai. */
const SO_GIA = "000123456789";

export function DemoQr({ tenGoiY }: { tenGoiY?: string }) {
  const [mo, setMo] = useState(false);
  const [ten, setTen] = useState(tenGoiY ?? "Nguyễn Văn An");
  const [anh, setAnh] = useState<string | null>(null);

  const payload = `${SO_GIA}|123456789|${ten}|01011990|Nam|Số 1, Phường Bến Nghé, Quận 1, TP.HCM|01012021`;

  useEffect(() => {
    if (!mo) return;
    let huy = false;
    QRCode.toDataURL(payload, { width: 320, margin: 2, errorCorrectionLevel: "M" })
      .then((d) => !huy && setAnh(d))
      .catch(() => !huy && setAnh(null));
    return () => {
      huy = true;
    };
  }, [mo, payload]);

  if (!mo)
    return (
      <Button type="button" variant="ghost" size="sm" onClick={() => setMo(true)} data-testid="button-demo-qr">
        <QrCode className="mr-1.5 h-3.5 w-3.5" /> Tạo mã QR mẫu để thử
      </Button>
    );

  return (
    <div className="rounded-md border border-dashed border-card-border p-4" data-testid="demo-qr">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Mã QR mẫu — dữ liệu giả</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Đúng định dạng thẻ thật, số căn cước bịa (bắt đầu bằng <code className="font-mono">000</code>, không phải mã
            tỉnh nào). Mở trên máy khác rồi quét bằng camera, hoặc in ra.
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => setMo(false)}>
          Đóng
        </Button>
      </div>

      <div className="mt-3 flex flex-wrap items-start gap-4">
        <div className="min-w-[200px] flex-1">
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground">Họ tên trên thẻ</label>
          <Input value={ten} onChange={(e) => setTen(e.target.value)} className="mt-1" data-testid="input-demo-name" />
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Đặt đúng tên của một khách đang có đặt phòng thì bước đối chiếu mới ra kết quả.
          </p>
          <p className="mt-2 break-all rounded bg-muted/40 p-2 font-mono text-[10px] leading-relaxed">{payload}</p>
        </div>
        {anh && (
          /* Nền trắng cố định: ở chế độ tối, mã QR trên nền tối thì máy quét đọc
             không ra — jsQR tìm ô vuông tối trên nền sáng. */
          <div className="rounded-md bg-white p-2">
            <img src={anh} alt="Mã QR mẫu" className="h-40 w-40" data-testid="img-demo-qr" />
          </div>
        )}
      </div>
    </div>
  );
}
