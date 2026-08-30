/**
 * Huy hiệu VinAurea — vương miện, khiên, chữ V, lá hai bên.
 *
 * VẼ LẠI THÀNH VECTOR, không cắt nền từ ảnh. Ảnh raster đưa vào đây sẽ mờ trên
 * màn hình Retina, nặng vài trăm KB, và có một nền không bao giờ khớp hoàn hảo
 * với nền trang. Vector thì sắc ở mọi cỡ, nặng vài KB, và không có nền để mà
 * phải xoá.
 *
 * HAI BẢN, và lý do phải có hai:
 *
 *   - `VinAureaCrest` — bản đầy đủ, có lá và chi tiết. Dùng ở trang chủ, nơi nó
 *     là trọng tâm và được vẽ ở 80–120px.
 *   - `VinAureaMark` — bản rút gọn: chỉ vương miện + khiên + chữ V, không lá.
 *     Dùng ở header và ở avatar mỗi câu trả lời, tức 16–28px. Các nhánh lá ở cỡ
 *     đó chỉ còn là vệt bẩn quanh khiên — chi tiết không đọc được không phải là
 *     chi tiết, nó là nhiễu.
 *
 * MÀU: bản đầy đủ dùng gradient vàng cố định vì đó là bản sắc thương hiệu, và
 * vàng đọc được trên cả nền sáng lẫn nền tối. Bản rút gọn dùng `currentColor`
 * để thừa hưởng màu của header và của chế độ tối — một logo có mã màu cứng là
 * một logo sẽ tàng hình ở một trong hai chế độ.
 */

/** Vương miện + khiên + chữ V. Không lá — bản này phải sống ở 16px. */
export function VinAureaMark({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 34" fill="none" className={className} aria-hidden="true" data-testid="logo-mark">
      {/* Vương miện: ba đỉnh, đủ để đọc ra là vương miện ở cỡ nhỏ. */}
      <path
        d="M9 8.4 7.2 4.9l3.1 1.9L16 2.6l5.7 4.2 3.1-1.9L23 8.4z"
        fill="currentColor"
      />
      {/* Khiên. */}
      <path
        d="M6.6 11h18.8v9.2c0 4.9-3.6 8.7-9.4 11.6C10.2 28.9 6.6 25.1 6.6 20.2z"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      {/* Chữ V, nét đặc để không biến mất khi thu nhỏ. */}
      <path d="M12.1 15h2.6l1.3 6.4L17.3 15h2.6l-2.6 10.4h-2.6z" fill="currentColor" />
    </svg>
  );
}

/** Bản đầy đủ có lá, cho trang chủ. */
export function VinAureaCrest({ className = "h-24 w-24" }: { className?: string }) {
  return (
    <svg viewBox="0 0 96 104" fill="none" className={className} aria-hidden="true" data-testid="logo-crest">
      <defs>
        <linearGradient id="va-gold" x1="20" y1="6" x2="76" y2="98" gradientUnits="userSpaceOnUse">
          <stop stopColor="#E9C46A" />
          <stop offset=".45" stopColor="#C8912F" />
          <stop offset="1" stopColor="#9A6B1E" />
        </linearGradient>
      </defs>
      <g stroke="url(#va-gold)" fill="none" strokeLinejoin="round" strokeLinecap="round">
        {/* --- Vương miện: năm đỉnh, viên ngọc ở mỗi đỉnh --- */}
        <path d="M32 22.5 27.5 11l7.6 4.6L48 5l12.9 10.6 7.6-4.6L64 22.5z" strokeWidth="2.1" />
        <circle cx="48" cy="3.4" r="2.1" fill="url(#va-gold)" stroke="none" />
        <circle cx="26.4" cy="9.6" r="1.7" fill="url(#va-gold)" stroke="none" />
        <circle cx="69.6" cy="9.6" r="1.7" fill="url(#va-gold)" stroke="none" />
        <path d="M31 25.6h34" strokeWidth="2.1" />

        {/* --- Khiên, hai đường viền như bản gốc --- */}
        <path d="M29 30h38v25.4c0 12.4-9.2 21.6-19 27.2-9.8-5.6-19-14.8-19-27.2z" strokeWidth="2.3" />
        <path d="M33.4 34.4h29.2v20.8c0 10-7.2 17.7-14.6 22.4-7.4-4.7-14.6-12.4-14.6-22.4z" strokeWidth="1.2" opacity=".65" />

        {/* --- Lá / cánh hai bên, cong lên ôm lấy khiên --- */}
        <path d="M27.5 82c-7.8-2.4-12.6-7.6-14.4-15.6-1.8-8-.4-15.4 4.2-22.2 1.6 5 1.4 9.6-.6 13.8" strokeWidth="1.9" />
        <path d="M24.6 76.6c-5.4-2.6-8.6-6.8-9.6-12.6" strokeWidth="1.4" opacity=".7" />
        <path d="M68.5 82c7.8-2.4 12.6-7.6 14.4-15.6 1.8-8 .4-15.4-4.2-22.2-1.6 5-1.4 9.6.6 13.8" strokeWidth="1.9" />
        <path d="M71.4 76.6c5.4-2.6 8.6-6.8 9.6-12.6" strokeWidth="1.4" opacity=".7" />
        {/* Hai nhánh vắt dưới chân khiên, khép bố cục lại. */}
        <path d="M26 86.5c6.6 1.2 12 4.2 16.2 9" strokeWidth="1.7" />
        <path d="M70 86.5c-6.6 1.2-12 4.2-16.2 9" strokeWidth="1.7" />
      </g>

      {/* --- Chữ V, serif, đặc --- */}
      <path
        d="M38.6 42.5h5.9l3.5 18.6 3.5-18.6h5.9l-6.7 28h-5.4z"
        fill="url(#va-gold)"
      />
      {/* Ánh lấp lánh, đúng như bản gốc — nhỏ, không tranh chỗ với chữ V. */}
      <path d="M37 38.5l.9 1.9 1.9.9-1.9.9-.9 1.9-.9-1.9-1.9-.9 1.9-.9z" fill="url(#va-gold)" opacity=".9" />
      <path d="M59 38.5l.9 1.9 1.9.9-1.9.9-.9 1.9-.9-1.9-1.9-.9 1.9-.9z" fill="url(#va-gold)" opacity=".9" />
      <path d="M48 74l.7 1.5 1.5.7-1.5.7-.7 1.5-.7-1.5-1.5-.7 1.5-.7z" fill="url(#va-gold)" opacity=".75" />
    </svg>
  );
}

export function VinAureaLogo({ subtitle }: { subtitle?: string }) {
  return (
    <div className="flex items-center gap-2.5" data-testid="logo">
      <VinAureaMark className="h-7 w-7 text-primary" />
      <div className="leading-none">
        {/* "Vin" mảnh, "Aurea" đậm — một từ hai trọng lượng, để đọc như một cái
            tên chứ không phải hai sản phẩm dán vào nhau. */}
        <div className="font-serif text-base tracking-tight">
          <span className="font-normal">Vin</span>
          <span className="font-semibold">Aurea</span>
        </div>
        {subtitle ? (
          <div className="mt-0.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            {subtitle}
          </div>
        ) : null}
      </div>
    </div>
  );
}

