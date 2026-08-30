/**
 * Quét mã QR bằng camera.
 *
 * Dùng `jsqr` chứ không dùng `BarcodeDetector` sẵn của trình duyệt. API đó
 * nhanh hơn và không tốn thư viện, nhưng **đo được là nó vắng mặt** trên trình
 * duyệt tôi kiểm thử, và Safari cũng không có. Một tính năng để demo cho doanh
 * nghiệp mà "tuỳ trình duyệt" thì không dùng được. `jsqr` là JS thuần, không
 * phụ thuộc native, chạy ở mọi nơi.
 *
 * CAMERA ĐÒI BỐI CẢNH BẢO MẬT. Trình duyệt chỉ cho `getUserMedia` trên
 * `https://` hoặc `localhost`. Chạy demo ở `http://192.168.x.x` trong mạng
 * khách sạn thì camera **bị chặn thẳng**, và thông báo mặc định của trình duyệt
 * không nói vì sao. Component này kiểm trước và nói rõ — vì đây đúng là cái bẫy
 * sẽ đợi sẵn khi mang máy đi demo tại chỗ.
 */
import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { Button } from "@/components/ui/button";
import { Camera, CameraOff, AlertTriangle } from "lucide-react";

export function QrScanner({ onScan, label = "Bật camera quét" }: { onScan: (text: string) => void; label?: string }) {
  const [dangBat, setDangBat] = useState(false);
  const [loi, setLoi] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  /* Giữ callback trong ref: vòng lặp quét chạy ngoài chu kỳ render, và bắt
     `onScan` theo giá trị sẽ khoá nó ở lần render đầu tiên. */
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  const tat = () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setDangBat(false);
  };

  /* Tắt camera khi rời trang. Thiếu dòng này thì đèn camera vẫn sáng sau khi
     lễ tân chuyển sang màn hình khác — vừa lộ liễu vừa tốn pin. */
  useEffect(() => () => tat(), []);

  const bat = async () => {
    setLoi(null);
    if (!window.isSecureContext) {
      setLoi(
        `Trình duyệt chặn camera vì trang đang chạy trên ${location.protocol}//. Camera chỉ hoạt động qua https hoặc localhost. Dùng máy quét cầm tay, hoặc dán nội dung mã vào ô bên trên.`,
      );
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setLoi("Trình duyệt này không hỗ trợ camera.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        /* `environment` = camera sau trên điện thoại/tablet. Máy tính để bàn chỉ
           có một camera nên trình duyệt bỏ qua yêu cầu này. */
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      setDangBat(true);
      const v = videoRef.current!;
      v.srcObject = stream;
      await v.play();
      quetVongLap();
    } catch (e: any) {
      const ten = String(e?.name ?? "");
      setLoi(
        ten === "NotAllowedError"
          ? "Bạn đã từ chối quyền camera. Mở lại quyền trong thanh địa chỉ rồi thử lại."
          : ten === "NotFoundError"
            ? "Máy này không có camera nào."
            : `Không mở được camera: ${e?.message ?? e}`,
      );
      tat();
    }
  };

  const quetVongLap = () => {
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c || !streamRef.current) return;

    if (v.readyState === v.HAVE_ENOUGH_DATA) {
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      if (ctx) {
        ctx.drawImage(v, 0, 0, c.width, c.height);
        const img = ctx.getImageData(0, 0, c.width, c.height);
        /* `dontInvert`: mã QR trên thẻ căn cước luôn là nền sáng chữ tối. Thử cả
           hai chiều làm chậm gấp đôi mà không thêm được ca nào đọc được. */
        const found = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
        if (found?.data) {
          tat();
          onScanRef.current(found.data);
          return;
        }
      }
    }
    rafRef.current = requestAnimationFrame(quetVongLap);
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        {dangBat ? (
          <Button type="button" variant="outline" onClick={tat} data-testid="button-cam-off">
            <CameraOff className="mr-1.5 h-3.5 w-3.5" /> Tắt camera
          </Button>
        ) : (
          <Button type="button" variant="outline" onClick={bat} data-testid="button-cam-on">
            <Camera className="mr-1.5 h-3.5 w-3.5" /> {label}
          </Button>
        )}
      </div>

      {loi && (
        <div className="flex items-start gap-2 rounded border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p>{loi}</p>
        </div>
      )}

      {/* Video luôn nằm trong DOM nhưng chỉ hiện khi bật: gắn `srcObject` vào một
          phần tử chưa tồn tại là cách nhanh nhất để có một khung hình đen. */}
      <div className={dangBat ? "relative w-full max-w-md overflow-hidden rounded-md border border-card-border" : "hidden"}>
        <video ref={videoRef} playsInline muted className="w-full" />
        {/* Khung ngắm: nói cho người cầm thẻ biết đưa vào đâu. */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-40 w-40 rounded-lg border-2 border-primary/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
        </div>
        <p className="absolute bottom-2 left-0 right-0 text-center text-[11px] text-white drop-shadow">
          Đưa mã QR trên thẻ vào trong khung
        </p>
      </div>
      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}
