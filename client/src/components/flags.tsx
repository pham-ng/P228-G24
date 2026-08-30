/**
 * Cờ vẽ bằng SVG, không dùng emoji.
 *
 * LÝ DO, đo được chứ không phải sở thích: Windows **chưa bao giờ** ship glyph cờ
 * emoji. Chuỗi 🇻🇳 là hai ký tự Regional Indicator, và font Windows không có
 * bảng ghép cặp cho chúng — nên trình duyệt vẽ đúng thứ nó có: hai chữ cái
 * "VN". Màn hình chọn ngôn ngữ vì thế hiện "VN · GB · KR · CN · JP · RU" trên
 * mọi máy Windows, tức là trên phần lớn máy tính bảng đặt ở sảnh khách sạn.
 *
 * Đó là lỗi không sửa được bằng CSS hay bằng font fallback — chỉ sửa được bằng
 * cách không dùng emoji nữa.
 *
 * Cờ ở đây được ĐƠN GIẢN HOÁ có chủ ý. Ở 20×14 pixel, Union Jack vẽ đủ 100%
 * thành một mớ vạch xám, và bát quái trên cờ Hàn Quốc thành bốn chấm bẩn. Mọi
 * bộ icon cờ nghiêm túc đều đơn giản hoá ở cỡ này; giữ lại thứ giúp NHẬN RA —
 * màu nền, hình chính, bố cục — và bỏ thứ chỉ đọc được khi phóng to.
 */

const box = "shrink-0 rounded-[2px] ring-1 ring-black/10";

export function Flag({ code, className = "h-3.5 w-5" }: { code: string; className?: string }) {
  const cls = `${box} ${className}`;
  switch (code) {
    case "vi":
      return (
        <svg viewBox="0 0 30 20" className={cls} aria-hidden="true">
          <rect width="30" height="20" fill="#DA251D" />
          <path d="M15 5.2l1.5 4.6h4.8l-3.9 2.8 1.5 4.6L15 14.4l-3.9 2.8 1.5-4.6-3.9-2.8h4.8z" fill="#FFCD00" />
        </svg>
      );
    case "en":
      return (
        <svg viewBox="0 0 30 20" className={cls} aria-hidden="true">
          <rect width="30" height="20" fill="#012169" />
          {/* Chéo trắng rồi chéo đỏ mảnh — đủ để nhận ra Union Jack ở cỡ này. */}
          <path d="M0 0l30 20M30 0L0 20" stroke="#fff" strokeWidth="4" />
          <path d="M0 0l30 20M30 0L0 20" stroke="#C8102E" strokeWidth="1.8" />
          <path d="M15 0v20M0 10h30" stroke="#fff" strokeWidth="6" />
          <path d="M15 0v20M0 10h30" stroke="#C8102E" strokeWidth="3.4" />
        </svg>
      );
    case "ko":
      return (
        <svg viewBox="0 0 30 20" className={cls} aria-hidden="true">
          <rect width="30" height="20" fill="#fff" />
          {/**
           * Thái cực, vẽ đúng cách: một đĩa ĐỎ, rồi một hình chữ S XANH đè lên
           * nửa dưới. Bản đầu tôi xếp chồng bốn path nửa-cung mâu thuẫn nhau và
           * kết quả là một vòng tròn nhoè — đúng lỗi "vẽ chi tiết không nhìn
           * được rồi tưởng là đã vẽ".
           *
           * Bát quái rút còn hai cặp vạch chéo ở hai góc: ở 14 pixel, tám quẻ
           * đầy đủ chỉ còn là vệt xám, còn hai cặp vạch thì vẫn đọc ra được đây
           * là cờ Hàn Quốc chứ không phải cờ Nhật.
           */}
          <circle cx="15" cy="10" r="4.6" fill="#CD2E3A" />
          <path d="M15 5.4a2.3 2.3 0 0 1 0 4.6 2.3 2.3 0 0 0 0 4.6 4.6 4.6 0 0 1 0-9.2z" fill="#0047A0" />
          <g stroke="#000" strokeWidth=".85" strokeLinecap="round" opacity=".85">
            <path d="M4.8 6.4l2.6 1.8M4.8 8l2.6 1.8" />
            <path d="M22.6 11.9l2.6 1.8M22.6 13.5l2.6 1.8" />
          </g>
        </svg>
      );
    case "zh":
      return (
        <svg viewBox="0 0 30 20" className={cls} aria-hidden="true">
          <rect width="30" height="20" fill="#DE2910" />
          <path d="M6 3.4l1.2 3.6H11l-3 2.2 1.1 3.6L6 10.6 2.9 12.8 4 9.2 1 7h3.8z" fill="#FFDE00" />
          <g fill="#FFDE00">
            <circle cx="12.4" cy="3.2" r="1" />
            <circle cx="14.8" cy="5.4" r="1" />
            <circle cx="14.8" cy="8.6" r="1" />
            <circle cx="12.4" cy="10.6" r="1" />
          </g>
        </svg>
      );
    case "ja":
      return (
        <svg viewBox="0 0 30 20" className={cls} aria-hidden="true">
          <rect width="30" height="20" fill="#fff" />
          <circle cx="15" cy="10" r="5.4" fill="#BC002D" />
        </svg>
      );
    case "ru":
      return (
        <svg viewBox="0 0 30 20" className={cls} aria-hidden="true">
          <rect width="30" height="20" fill="#fff" />
          <rect y="6.67" width="30" height="6.67" fill="#0039A6" />
          <rect y="13.33" width="30" height="6.67" fill="#D52B1E" />
        </svg>
      );
    default:
      return <span className={cls} />;
  }
}
