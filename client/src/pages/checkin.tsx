/**
 * Nhận phòng — quét thẻ căn cước, đối chiếu, giao phòng.
 *
 * CÁCH QUÉT. Trang này nhận dữ liệu từ **máy quét mã vạch cắm USB** — loại
 * khách sạn vẫn dùng. Máy đó hoạt động như một bàn phím: nó gõ nội dung mã QR
 * vào ô đang được chọn rồi nhấn Enter. Không cần thư viện, không xin quyền
 * camera, chạy offline. Dự án có `qrcode` để SINH mã, không có thư viện nào để
 * ĐỌC mã; quét bằng camera sẽ cần thêm phụ thuộc mới.
 *
 * VÌ SAO ĐÂY LÀ TRANG CỦA NHÂN VIÊN, không phải kiosk cho khách tự làm.
 * Số căn cước không phải bí mật — nó in trên thẻ, bị photocopy ở mọi khách sạn,
 * ngân hàng, sân bay. Nếu quét thẻ là mở được phiên của khách thì một tấm ảnh
 * chụp thẻ mở được hội thoại, hoá đơn, và quyền gọi đồ tính vào phòng người ta.
 *
 * Nên ở đây thẻ chỉ dùng để ĐIỀN PHIẾU. Người xác thực là lễ tân: họ nhìn mặt,
 * đối chiếu tấm thẻ đang cầm, rồi bấm xác nhận. Sau khi nhận phòng xong, khách
 * nhận MÃ ĐẶT PHÒNG — và mã đó vẫn là chìa khoá vào phiên trò chuyện, đúng như
 * trước khi có tính năng này.
 *
 * QR do ứng dụng VNeID sinh ra là chuyện khác: nó động, gắn với phiên đã xác
 * thực, và mạnh hơn hẳn. Nhưng muốn biết nó thật hay là ảnh chụp màn hình thì
 * phải gọi hệ thống của C06 — tức phải là đối tác tích hợp chính thức. Trang
 * này không đọc loại đó, và sẽ báo "không đúng định dạng" thay vì đoán.
 */
import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { StaffShell } from "@/components/staff-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiRequest } from "@/lib/queryClient";
import { AlertTriangle, Check, KeyRound, ScanLine, UserCheck } from "lucide-react";
import { QrScanner } from "@/components/qr-scanner";
import { DemoQr } from "@/components/demo-qr";

type Card = {
  idNumber: string;
  oldIdNumber: string | null;
  fullName: string;
  dob: string;
  gender: "male" | "female" | "other";
  permanentAddress: string;
  issuedAt: string;
};
type Match = {
  reservationId: number;
  confirmationCode: string;
  guestName: string;
  roomNumber: string | null;
  checkIn: string;
  checkOut: string;
  status: string;
  nameMatch: "exact" | "likely";
  daKhaiBao: boolean;
};
type Done = { confirmationCode: string; room: { number: string }; lodgingMissing: string[] };

const GIOI = { male: "Nam", female: "Nữ", other: "Khác" } as const;

/** Che số căn cước trên màn hình. Bốn số cuối đủ để đối chiếu với thẻ đang cầm. */
const che = (s: string) => (s.length <= 4 ? s : "•".repeat(s.length - 4) + s.slice(-4));

export default function CheckinPage() {
  const qc = useQueryClient();
  const [qr, setQr] = useState("");
  const [card, setCard] = useState<Card | null>(null);
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [loi, setLoi] = useState<string | null>(null);
  const [xong, setXong] = useState<Done | null>(null);
  const oNhap = useRef<HTMLInputElement>(null);

  const quet = useMutation({
    /* `apiRequest` trả về `Response`, KHÔNG phải JSON đã phân tích. Quên
       `.json()` thì mutation vẫn "thành công", server vẫn trả 200, và màn
       hình vẫn trống — không có lỗi nào ở đâu cả. Đã dính đúng lỗi này. */
    mutationFn: async (value: string) =>
      (await (await apiRequest("POST", "/api/checkin/scan", { qr: value })).json()) as any,
    onMutate: () => {
      setLoi(null);
      setCard(null);
      setMatches(null);
      setXong(null);
    },
    onSuccess: (d) => {
      setCard(d.card);
      setMatches(d.matches);
    },
    onError: (e: any) => setLoi(String(e?.message ?? e).replace(/^\d+:\s*/, "")),
  });

  const nhanPhong = useMutation({
    mutationFn: async (m: Match) => {
      if (!card) throw new Error("Chưa có dữ liệu thẻ.");
      const res = await apiRequest("POST", `/api/reservations/${m.reservationId}/check-in`, {
        fullName: card.fullName,
        idType: "national_id",
        idNumber: card.idNumber,
        /* Thẻ CCCD chỉ cấp cho công dân Việt Nam, nên quốc tịch suy ra được.
           Khách nước ngoài đi đường hộ chiếu ở trang Khai báo lưu trú. */
        nationality: "Việt Nam",
        dob: card.dob,
        gender: GIOI[card.gender],
        permanentAddress: card.permanentAddress,
      });
      return (await res.json()) as any;
    },
    onSuccess: (d) => {
      setXong(d);
      setMatches(null);
      qc.invalidateQueries({ queryKey: ["/api/registrations"] });
      qc.invalidateQueries({ queryKey: ["/api/reservations"] });
    },
    onError: (e: any) => setLoi(String(e?.message ?? e).replace(/^\d+:\s*/, "")),
  });

  const lamLai = () => {
    setQr("");
    setCard(null);
    setMatches(null);
    setLoi(null);
    setXong(null);
    oNhap.current?.focus();
  };

  return (
    <StaffShell title="Nhận phòng" description="Quét thẻ căn cước, đối chiếu, giao phòng">
      <div className="space-y-4 p-4 sm:p-6">
        {/* --- ô quét --- */}
        <section className="rounded-md border border-card-border bg-card p-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <ScanLine className="h-4 w-4" /> Quét thẻ căn cước
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Đặt con trỏ vào ô dưới rồi quét bằng máy đọc mã cầm tay — nó tự gõ và tự Enter. Không có máy quét thì dán
            nội dung mã QR vào đây.
          </p>
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (qr.trim()) quet.mutate(qr.trim());
            }}
          >
            <Input
              ref={oNhap}
              autoFocus
              value={qr}
              onChange={(e) => setQr(e.target.value)}
              placeholder="Nội dung mã QR trên thẻ CCCD…"
              className="font-mono text-xs"
              data-testid="input-qr"
            />
            <Button type="submit" disabled={!qr.trim() || quet.isPending} data-testid="button-scan">
              {quet.isPending ? "Đang đọc…" : "Đọc thẻ"}
            </Button>
            {(card || loi || xong) && (
              <Button type="button" variant="outline" onClick={lamLai}>
                Xoá
              </Button>
            )}
          </form>

          {/* Camera cho lúc không có máy quét cầm tay — và cho buổi demo. */}
          <div className="mt-3 space-y-3">
            <QrScanner onScan={(text) => { setQr(text); quet.mutate(text); }} />
            <DemoQr />
          </div>

          {loi && (
            <div className="mt-3 flex items-start gap-2 rounded border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div>
                <p className="font-medium">{loi}</p>
                {/* Không đoán bừa. Dữ liệu này đi vào giấy tờ nộp cho công an. */}
                <p className="mt-0.5 opacity-80">
                  Nhập tay ở trang <b>Lưu trú</b> nếu thẻ không đọc được.
                </p>
              </div>
            </div>
          )}
        </section>

        {/* --- thẻ đọc được --- */}
        {card && (
          <section className="rounded-md border border-card-border bg-card p-4" data-testid="card-read">
            <h2 className="text-sm font-semibold">Thông tin trên thẻ</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Đối chiếu với tấm thẻ đang cầm và khuôn mặt khách trước khi xác nhận.
            </p>
            <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Họ tên</dt>
                <dd className="font-medium">{card.fullName}</dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Số căn cước</dt>
                {/* Che trên màn hình: màn hình lễ tân quay ra sảnh. */}
                <dd className="font-mono">{che(card.idNumber)}</dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Ngày sinh</dt>
                <dd>{card.dob}</dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Giới tính</dt>
                <dd>{GIOI[card.gender]}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Nơi thường trú</dt>
                <dd>{card.permanentAddress}</dd>
              </div>
            </dl>
          </section>
        )}

        {/* --- đặt phòng khớp --- */}
        {matches && (
          <section className="rounded-md border border-card-border bg-card p-4">
            <h2 className="text-sm font-semibold">Đặt phòng khớp</h2>
            {matches.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Không có đặt phòng nào đến hôm nay hoặc đang ở khớp với tên này. Kiểm tra lại họ tên, hoặc tìm theo mã
                đặt phòng ở trang <b>Đặt phòng</b>.
              </p>
            ) : (
              <div className="mt-3 space-y-2">
                {matches.map((m) => (
                  <div
                    key={m.reservationId}
                    className="flex flex-wrap items-center justify-between gap-3 rounded border border-card-border p-3"
                    data-testid="row-match"
                  >
                    <div className="text-sm">
                      <p className="font-medium">
                        {m.guestName}{" "}
                        {m.nameMatch === "likely" && (
                          /* Nói thẳng khi tên không trùng khít, thay vì lặng lẽ
                             coi là đúng — lễ tân là người quyết. */
                          <span className="ml-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-600">
                            tên không trùng khít — kiểm lại thẻ
                          </span>
                        )}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {m.confirmationCode} · phòng {m.roomNumber ?? "chưa gắn"} · {m.checkIn} → {m.checkOut}
                        {m.daKhaiBao && " · đã có phiếu lưu trú"}
                      </p>
                    </div>
                    {m.status === "in_house" ? (
                      <span className="text-xs text-muted-foreground">đã nhận phòng</span>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() => nhanPhong.mutate(m)}
                        disabled={nhanPhong.isPending}
                        data-testid="button-checkin"
                      >
                        <UserCheck className="mr-1.5 h-3.5 w-3.5" />
                        {nhanPhong.isPending ? "Đang xử lý…" : "Xác nhận nhận phòng"}
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* --- xong --- */}
        {xong && (
          <section className="rounded-md border border-primary/40 bg-primary/5 p-4" data-testid="checkin-done">
            <div className="flex items-center gap-2 text-sm font-semibold text-primary">
              <Check className="h-4 w-4" /> Đã nhận phòng — phòng {xong.room.number}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">Đọc mã này cho khách để mở trợ lý trên điện thoại:</p>
            {/* To và rõ: lễ tân đọc nó qua quầy cho khách đang đứng đợi. */}
            <p className="mt-1 font-mono text-2xl font-semibold tracking-wider" data-testid="text-code">
              {xong.confirmationCode}
            </p>
            <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <KeyRound className="h-3 w-3" /> Mã đặt phòng vẫn là chìa khoá vào phiên — thẻ căn cước không thay thế nó.
            </p>
            {xong.lodgingMissing.length > 0 && (
              <p className="mt-2 rounded border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-700 dark:text-amber-400">
                Phiếu lưu trú còn thiếu: <b>{xong.lodgingMissing.join(", ")}</b> — bổ sung ở trang Lưu trú trước khi nộp.
              </p>
            )}
            <Button className="mt-3" size="sm" variant="outline" onClick={lamLai}>
              Nhận phòng cho khách tiếp theo
            </Button>
          </section>
        )}
      </div>
    </StaffShell>
  );
}
