/**
 * "Đang có N người hỏi trước bạn."
 *
 * VÌ SAO CÓ. Một lượt trả lời đo được 13,7 giây trên máy này, và Ollama phục vụ
 * tuần tự trên một GPU — nên ba người bấm gửi cùng lúc thì người thứ ba chờ
 * khoảng 41 giây. Trước component này, tất cả những gì họ thấy là một dấu xoay.
 * Người thứ ba đóng tab và nói sản phẩm hỏng, trong khi nó đang chạy đúng.
 *
 * Nó KHÔNG làm máy nhanh hơn. Nó chỉ nói ra thứ đang thật sự xảy ra — cùng lập
 * luận với thanh đo mức âm trên nút mic: câu hỏi trong đầu người dùng lúc đó là
 * "máy có nghe thấy tôi không", và im lặng là câu trả lời tệ nhất.
 */
import { useEffect, useState } from "react";

type TrangThaiHang = { dangChay: number; dangCho: number; truocBan: number; uocGiay: number };

const CHU: Record<string, (n: number, giay: number) => string> = {
  vi: (n, g) => `Đang có ${n} người hỏi trước bạn — khoảng ${g} giây nữa ạ.`,
  en: (n, g) => `${n} ${n === 1 ? "person is" : "people are"} ahead of you — about ${g}s.`,
  ko: (n, g) => `앞에 ${n}명이 대기 중입니다 — 약 ${g}초.`,
  ja: (n, g) => `${n}人お待ちです — あと約${g}秒。`,
  zh: (n, g) => `前面还有 ${n} 位 — 大约 ${g} 秒。`,
  ru: (n, g) => `Перед вами ${n} — примерно ${g} с.`,
};

/**
 * Chỉ nói khi có người thật sự ở phía trước.
 *
 * `truocBan` đã tính cả lượt của chính người này, nên một mình thì nó bằng 1.
 * Hiện "đang có 0 người trước bạn" là một câu vô nghĩa làm người ta lo, nên
 * ngưỡng là 2 — và đó cũng là lúc con số bắt đầu giải thích được sự chậm.
 */
export function QueueNotice({ lang }: { lang: string }) {
  const [hang, setHang] = useState<TrangThaiHang | null>(null);

  useEffect(() => {
    let alive = true;
    const doc = async () => {
      try {
        const r = await fetch("/api/queue");
        if (!r.ok) return;
        const j = (await r.json()) as TrangThaiHang;
        if (alive) setHang(j);
      } catch {
        /* Mất mạng giữa chừng thì im lặng: dòng chữ này là thông tin thêm, một
           lỗi của nó không được phép trở thành thông báo lỗi cho khách. */
      }
    };
    void doc();
    /* Hai giây: đủ nhanh để con số giảm thấy được, đủ chậm để bốn mươi lượt
       chờ không tự thành một nguồn tải mới trên chính cái máy đang tắc. */
    const t = setInterval(doc, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!hang || hang.truocBan < 2) return null;
  const truoc = hang.truocBan - 1;
  const noi = CHU[lang] ?? CHU.en;

  return (
    <span data-testid="queue-notice" className="text-[11px] text-muted-foreground">
      {noi(truoc, Math.max(1, hang.uocGiay))}
    </span>
  );
}
