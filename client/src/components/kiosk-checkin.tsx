/**
 * Kiosk tự nhận phòng — khách quét thẻ căn cước, vào thẳng hội thoại.
 *
 * ĐÁNH ĐỔI, nói thẳng ở đây để lần sau còn siết được. Quét thẻ là mở phiên.
 * Số căn cước không phải bí mật — nó in trên thẻ và bị photocopy ở khắp nơi —
 * nên ai có ảnh chụp thẻ của một khách đang ở đều mở được hội thoại và hoá đơn
 * của người đó. Chủ dự án chọn thế có chủ đích: doanh nghiệp cần nhận phòng
 * nhanh và giảm tải cho lễ tân, phần an toàn tính sau.
 *
 * Chỗ siết nằm ở server (`/api/guest/checkin`), không phải ở đây.
 *
 * Sau khi quét xong, thứ nhận được là **mã đặt phòng** — rồi màn hình mở phiên
 * đúng như khách tự gõ mã. Không có khái niệm đăng nhập mới nào được thêm vào;
 * mọi thứ phía sau vẫn chạy trên cùng một cơ chế đã có.
 */
import { useState } from "react";
import { QrScanner } from "@/components/qr-scanner";
import { Button } from "@/components/ui/button";
import { AlertTriangle, IdCard, Loader2 } from "lucide-react";

const COPY: Record<string, { mo: string; huong: string; dang: string; quay: string }> = {
  vi: {
    mo: "Quét căn cước để nhận phòng",
    huong: "Đưa mã QR ở mặt sau thẻ căn cước vào khung. Hệ thống sẽ nhận phòng và mở trợ lý cho quý khách.",
    dang: "Đang nhận phòng…",
    quay: "Vui lòng tới quầy lễ tân.",
  },
  en: {
    mo: "Scan your ID to check in",
    huong: "Hold the QR code on your ID card up to the frame. We will check you in and open your assistant.",
    dang: "Checking you in…",
    quay: "Please see the front desk.",
  },
  ko: { mo: "신분증 스캔으로 체크인", huong: "신분증의 QR 코드를 화면에 비춰 주세요.", dang: "체크인 중…", quay: "프런트 데스크로 문의해 주세요." },
  zh: { mo: "扫描身份证办理入住", huong: "请将身份证上的二维码对准取景框。", dang: "正在办理入住…", quay: "请前往前台。" },
  ja: { mo: "身分証をスキャンしてチェックイン", huong: "身分証のQRコードを枠内に合わせてください。", dang: "チェックイン中…", quay: "フロントへお越しください。" },
  ru: { mo: "Сканируйте удостоверение", huong: "Поднесите QR-код удостоверения к рамке.", dang: "Оформляем заселение…", quay: "Обратитесь на стойку регистрации." },
};

export function KioskCheckin({ lang, onCode }: { lang: string; onCode: (code: string) => void }) {
  const t = COPY[lang] ?? COPY.vi;
  const [mo, setMo] = useState(false);
  const [dangGui, setDangGui] = useState(false);
  const [loi, setLoi] = useState<string | null>(null);

  const gui = async (qr: string) => {
    setLoi(null);
    setDangGui(true);
    try {
      const r = await fetch("/api/guest/checkin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ qr }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        /* Server đã viết sẵn câu tiếng Việt cho từng trường hợp — không tìm
           thấy, tên không khớp khít, trùng nhiều đặt phòng. Hiện nguyên văn
           thay vì dịch lại thành một câu chung chung. */
        setLoi(j.message ?? t.quay);
        return;
      }
      /* Chỉ cần mã đặt phòng: màn hình phía sau mở phiên đúng như khách tự gõ. */
      onCode(j.confirmationCode);
    } catch (e: any) {
      setLoi(String(e?.message ?? e));
    } finally {
      setDangGui(false);
    }
  };

  if (!mo)
    return (
      <Button
        type="button"
        variant="outline"
        className="mt-3 w-full"
        onClick={() => setMo(true)}
        data-testid="button-kiosk-open"
      >
        <IdCard className="mr-2 h-4 w-4" /> {t.mo}
      </Button>
    );

  return (
    <div className="mt-3 rounded-md border border-card-border p-3" data-testid="kiosk-panel">
      <p className="text-xs text-muted-foreground">{t.huong}</p>
      <div className="mt-2">
        <QrScanner onScan={gui} label={t.mo} />
      </div>

      {dangGui && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t.dang}
        </p>
      )}

      {loi && (
        <div className="mt-2 flex items-start gap-2 rounded border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p>{loi}</p>
        </div>
      )}

      <button
        type="button"
        onClick={() => {
          setMo(false);
          setLoi(null);
        }}
        className="mt-2 text-[11px] text-muted-foreground underline underline-offset-2"
      >
        Đóng
      </button>
    </div>
  );
}
