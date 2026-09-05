/**
 * Guest handbook — the property's house rules ("Quy Định Chung", 24 điều) as a
 * readable, sectioned booklet the guest can open from the chat.
 *
 * Same authoritative Vietnamese text the concierge answers from (see migration
 * 012), so the booklet and the chat never diverge. Sections are controlled
 * (open-state in React), not native <details>: the guest thread polls for new
 * messages, and a native <details>'s open flag is wiped by that re-render — a
 * guest would watch a section they just opened snap shut. A Set of open indices
 * survives the polling and lets several sections stay open, which is what a
 * booklet wants. UI chrome is localised; the rule text stays in the official
 * Vietnamese, with a short note for guests reading in another language.
 */
import { useState } from "react";
import { BookOpen, ChevronDown, ShieldAlert } from "lucide-react";

const T = {
  title: { vi: "Nội quy khách sạn", en: "Hotel house rules", ko: "호텔 이용 규정", ja: "ホテル利用規約", zh: "酒店住宿规定", ru: "Правила отеля" },
  intro: {
    vi: "Quy Định Chung của Vinpearl / VinOasis — để mọi Quý khách có trải nghiệm an toàn và trọn vẹn nhất.",
    en: "Vinpearl / VinOasis house rules — for every guest's safety and best stay. Official text is in Vietnamese.",
    ko: "Vinpearl / VinOasis 이용 규정. 공식 원문은 베트남어입니다.",
    ja: "Vinpearl / VinOasis の利用規約。正式な原文はベトナム語です。",
    zh: "Vinpearl / VinOasis 住宿规定。正式文本为越南语。",
    ru: "Правила Vinpearl / VinOasis. Официальный текст — на вьетнамском.",
  },
  ask: {
    vi: "Cần hỏi thêm? Nhắn trực tiếp cho lễ tân trong khung chat.",
    en: "Questions? Just ask the concierge in the chat.",
    ko: "궁금한 점은 채팅으로 문의하세요.",
    ja: "ご不明点はチャットでお尋ねください。",
    zh: "有疑问？在聊天中直接询问礼宾。",
    ru: "Вопросы? Спросите консьержа в чате.",
  },
} as const;

type Lang = keyof (typeof T)["title"];
const tr = (m: Record<Lang, string>, lang: string): string => m[(lang as Lang) in m ? (lang as Lang) : "vi"];

/* Section titles localised; rule bodies stay in the authoritative Vietnamese.
   `fee`/`ban` mark the lines that carry a charge or a hard prohibition so they
   read at a glance. */
type Rule = { text: string; tone?: "fee" | "ban" };
type Section = { icon: string; title: Record<Lang, string>; rules: Rule[] };

const SECTIONS: Section[] = [
  {
    icon: "📋",
    title: { vi: "Lưu trú & thủ tục", en: "Stay & check-in", ko: "숙박 및 수속", ja: "宿泊・手続き", zh: "入住与手续", ru: "Проживание" },
    rules: [
      { text: "Mang theo giấy tờ tùy thân hợp lệ theo Luật lưu trú khi nhận phòng." },
      { text: "Tuân thủ quy định của Nhà nước và Khách sạn về an toàn phòng, chống dịch bệnh." },
      { text: "Thực hiện các thủ tục khác theo quy định của Vinpearl và cơ quan quản lý lưu trú địa phương tại từng thời điểm." },
    ],
  },
  {
    icon: "🚭",
    title: { vi: "Hút thuốc", en: "Smoking", ko: "흡연", ja: "喫煙", zh: "吸烟", ru: "Курение" },
    rules: [
      { text: "Hút thuốc (kể cả thuốc lá điện tử) chỉ được phép tại nơi có biển cho phép hoặc ngoài ban công phòng." },
      { text: "Hút thuốc nơi không được phép: phí phục hồi, làm sạch sâu, khử mùi 3.000.000 VNĐ cho một lần ở nếu bị phát hiện.", tone: "fee" },
    ],
  },
  {
    icon: "🍳",
    title: { vi: "Bếp & nấu nướng", en: "Kitchen & cooking", ko: "주방 및 조리", ja: "キッチン・調理", zh: "厨房与烹饪", ru: "Кухня" },
    rules: [
      { text: "Tại biệt thự/căn hộ: bếp CHỈ dùng để hâm nóng thức ăn.", tone: "ban" },
      { text: "NGHIÊM CẤM mọi hình thức nấu nướng, chế biến gây mùi, gây khói hoặc không đảm bảo an toàn cháy nổ — kể cả mang bếp riêng vào nấu.", tone: "ban" },
      { text: "Nướng BBQ tại sân vườn/khuôn viên phải đăng ký với Trung tâm Dịch vụ Khách hàng (có phí). Khách sạn không chịu trách nhiệm về vệ sinh an toàn thực phẩm khi khách tự chế biến." },
      { text: "Sử dụng thiết bị điện đúng mục đích; khi ra khỏi phòng, trả thiết bị điện về nguyên trạng." },
    ],
  },
  {
    icon: "🥡",
    title: { vi: "Đồ mang vào phòng", en: "Items brought in", ko: "반입 물품", ja: "持ち込み", zh: "携带入内", ru: "Что нельзя вносить" },
    rules: [
      { text: "Không mang đồ ăn/đồ uống mua bên ngoài vào Khách sạn. Nếu mang vào: thông báo Ban quản lý, phí dịch vụ bổ sung 1.175.000 đồng/lần và ký Giấy miễn trừ trách nhiệm.", tone: "fee" },
      { text: "Không mang trái cây, thực phẩm nặng mùi (sầu riêng, mít, các loại mắm…) vào phòng.", tone: "ban" },
      { text: "Tuyệt đối không mang vũ khí, hóa chất hay chất nổ vào khu vực Khách sạn vào bất kỳ lúc nào.", tone: "ban" },
      { text: "Thú nuôi không được phép mang vào khu vực Khách sạn.", tone: "ban" },
    ],
  },
  {
    icon: "🛏️",
    title: { vi: "Trong phòng & tài sản", en: "In the room & valuables", ko: "객실 및 귀중품", ja: "客室・貴重品", zh: "客房与财物", ru: "В номере" },
    rules: [
      { text: "Cất vật dụng có giá trị trong két an toàn tại phòng hoặc gửi quầy Lễ tân. Khách sạn không chịu trách nhiệm pháp lý nếu khách không thực hiện theo quy định." },
      { text: "Khi ra khỏi phòng: khóa cửa an toàn và không đưa chìa khóa phòng cho người khác." },
      { text: "Khách bồi thường thiệt hại khi làm hư hỏng vật dụng, trang thiết bị trong phòng — mức bồi thường theo danh mục giá từng món đồ trong phòng.", tone: "fee" },
    ],
  },
  {
    icon: "🤝",
    title: { vi: "Ứng xử, trang phục & tiếng ồn", en: "Conduct, dress & noise", ko: "행동·복장·소음", ja: "行動・服装・騒音", zh: "行为·着装·噪音", ru: "Поведение" },
    rules: [
      { text: "Cư xử đúng mực nơi công cộng: đến trước phục vụ trước; ưu tiên phụ nữ mang thai, người khuyết tật, người già yếu; không gây ồn ào, la hét; quản lý trẻ em." },
      { text: "Mặc trang phục thích hợp ở khu vực chung (tiền sảnh, nhà hàng…). Tuyệt đối không khỏa thân, kể cả trẻ em.", tone: "ban" },
      { text: "Tiếng ồn: sau 22:00, âm lượng tivi không quá mức 10; không mở loa hay nói chuyện quá lớn. Tiếng ồn bị coi là quá mức khi làm khách khác khó chịu." },
    ],
  },
  {
    icon: "🏊",
    title: { vi: "Hồ bơi, bãi biển & di chuyển", en: "Pool, beach & transport", ko: "수영장·해변·이동", ja: "プール・ビーチ・移動", zh: "泳池·海滩·出行", ru: "Бассейн и пляж" },
    rules: [
      { text: "Tuân thủ giờ hoạt động hồ bơi (thay đổi theo thời tiết/mùa). Hồ bơi đóng cửa muộn nhất 22:00 — không sử dụng sau 22:00." },
      { text: "Không tắm biển sau 19:00 (không có cứu hộ sau 19:00). Bơi ngoài giờ, khách tự chịu trách nhiệm an toàn, không khiếu nại." },
      { text: "Tuân thủ quy định an toàn khi di chuyển bằng xe trong khu vực Khách sạn." },
    ],
  },
  {
    icon: "👥",
    title: { vi: "Khách đến thăm", en: "Visitors", ko: "방문객", ja: "訪問者", zh: "访客", ru: "Гости" },
    rules: [
      { text: "Khách mời: thông báo Lễ tân và gửi giấy tờ tùy thân của khách mời; gặp tại phòng phải được khách lưu trú đồng ý và trực tiếp đón." },
      { text: "Vì lý do an ninh, khách mời không được vào phòng nghỉ sau 20:00. Muốn ở lại qua đêm phải đăng ký với Lễ tân và trả phí lưu trú theo quy định." },
    ],
  },
  {
    icon: "⚖️",
    title: { vi: "Hành vi bị cấm & xử lý", en: "Prohibited conduct", ko: "금지 행위", ja: "禁止行為", zh: "禁止行为", ru: "Запрещено" },
    rules: [
      { text: "Nghiêm cấm mọi hành vi vi phạm pháp luật trong Khách sạn: đánh bạc, mại dâm, sử dụng chất kích thích/sản phẩm bị cấm, gây gổ đánh nhau… Khách chịu trách nhiệm trước pháp luật Việt Nam.", tone: "ban" },
      { text: "Ban quản lý có thể yêu cầu khách rời Khách sạn mà không hoàn trả chi phí nếu cố tình vi phạm quy định, nội quy." },
      { text: "Gói phòng có vé VinWonders: tuân thủ quy định độ tuổi, chiều cao, cân nặng và điều kiện an toàn từng trò chơi (xem thêm tại website VinWonders)." },
    ],
  },
];

export function HandbookPanel({ lang }: { lang: string }) {
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const toggle = (i: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  return (
    <div
      className="mt-3 overflow-hidden rounded-xl border border-primary/25 bg-card/90"
      data-testid="handbook-panel"
    >
      <div className="flex items-start gap-2.5 border-b border-border/40 bg-primary/[0.04] px-3.5 py-3">
        <BookOpen className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        <div>
          <h4 className="text-sm font-bold text-foreground">{tr(T.title, lang)}</h4>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">{tr(T.intro, lang)}</p>
        </div>
      </div>

      <div className="max-h-[52vh] overflow-y-auto px-2 py-2">
        {SECTIONS.map((s, i) => {
          const isOpen = open.has(i);
          return (
            <div key={i} className="border-b border-border/30 last:border-b-0">
              <button
                type="button"
                onClick={() => toggle(i)}
                aria-expanded={isOpen}
                data-testid={`handbook-section-${i}`}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-2.5 text-[13px] font-semibold text-foreground outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-primary/50"
              >
                <span className="text-base leading-none">{s.icon}</span>
                <span className="flex-1 text-left">{tr(s.title, lang)}</span>
                <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                  {s.rules.length}
                </span>
                <ChevronDown
                  className={"h-4 w-4 shrink-0 text-muted-foreground transition-transform " + (isOpen ? "rotate-180" : "")}
                />
              </button>
              {isOpen && (
                <ul className="space-y-2 px-2 pb-3 pl-3">
                  {s.rules.map((r, j) => (
                    <li key={j} className="flex gap-2 text-[12.5px] leading-relaxed">
                      <span
                        className={
                          "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full " +
                          (r.tone === "ban" ? "bg-destructive" : r.tone === "fee" ? "bg-amber-500" : "bg-primary/40")
                        }
                      />
                      <span className={r.tone ? "text-foreground" : "text-foreground/85"}>{r.text}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-1.5 border-t border-border/40 px-3.5 py-2 text-[11px] text-muted-foreground">
        <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-primary/70" />
        <span>{tr(T.ask, lang)}</span>
      </div>
    </div>
  );
}
