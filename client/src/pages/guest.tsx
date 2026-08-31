import { useEffect, useMemo, useRef, useState, memo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowRight, Loader2, Moon, SendHorizonal, ShieldCheck, Sun, UserRound } from "lucide-react";
import { VinAureaMark, VinAureaCrest } from "@/components/logo";
import { Flag } from "@/components/flags";
import { MarkdownBody } from "@/components/markdown-body";
import { PackageActions, readRecommendation } from "@/components/package-actions";
import { DiningActions, readDiningReference } from "@/components/dining-actions";
import { RoomActions, readRoomReference } from "@/components/room-actions";
import { ServiceActions, readServiceReference } from "@/components/service-actions";
import { RoomServicePanel } from "@/components/room-service";
import { GuestRequestsPanel } from "@/components/guest-requests";
import { MyRequestsPanel } from "@/components/my-requests";
import { SourceAndFeedback } from "@/components/source-and-feedback";
import { QueueNotice } from "@/components/queue-notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MicButton } from "@/components/mic-button";
import { KioskCheckin } from "@/components/kiosk-checkin";
import { apiRequest } from "@/lib/queryClient";
import { clock } from "@/lib/format";
import { LANG_LABELS, type ConversationDetail, type GuestKey, type Hotel } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useSession } from "@/lib/session";

const ROOM_QUICK_CHIPS: Record<string, string[]> = {
  vi: [
    "🛏️ Deluxe giường đôi",
    "🛏️ Deluxe 2 giường đơn",
    "🏨 Grand Deluxe giường đôi",
    "🌟 Executive Suite",
    "🏡 Villa 2 phòng ngủ",
    "🌊 Villa 3 phòng ngủ hướng biển",
  ],
  en: [
    "🛏️ Deluxe Double Bed",
    "🛏️ Deluxe Twin Bed",
    "🏨 Grand Deluxe King",
    "🌟 Executive Suite",
    "🏡 2-Bedroom Villa",
  ],
};

/**
 * The in-room dining toggle.
 *
 * Deliberately NOT driven off `toolTrace` the way the room, dining and service
 * cards are. Those unfold when a tool was called, and `order_room_service` is a
 * tool — which is exactly why in-room dining never appeared on the offline path
 * the product ships with. A persistent control is the only affordance that
 * works without a tool loop.
 */
const REQUESTS_LABEL: Record<string, string> = {
  vi: "🛎️ Yêu cầu nhanh",
  en: "🛎️ Quick requests",
  ko: "🛎️ 빠른 요청",
  ja: "🛎️ クイックリクエスト",
  zh: "🛎️ 快捷请求",
  ru: "🛎️ Быстрые запросы",
};

const ROOM_SERVICE_LABEL: Record<string, string> = {
  vi: "🍜 Gọi đồ lên phòng",
  en: "🍜 Order to my room",
  ko: "🍜 룸서비스 주문",
  ja: "🍜 ルームサービス",
  zh: "🍜 客房送餐",
  ru: "🍜 Заказ в номер",
};

const PROMPTS: Record<string, string[]> = {
  en: [
    "🛏️ Room types & pricing",
    "🍽️ Restaurant menus & pricing",
    "💆 Spa treatments & hours",
    "🚪 Late check-out pricing",
    "🚠 Cable car schedule",
  ],
  vi: [
    "🛏️ Các hạng phòng & giá phòng",
    "🍽️ Menu nhà hàng",
    "🍲 Nhà hàng Lotus",
    "🥩 Nhà hàng Jasmine",
    "🥢 Nhà hàng Bách Giai",
    "💆 Dịch vụ Spa & giờ mở cửa",
    "🚪 Phí trả phòng muộn",
    "🚠 Giờ chạy cáp treo",
  ],
  ko: [
    "🛏️ 객실 종류 및 요금",
    "🍽️ 레스토랑 메뉴 및 가격",
    "💆 스파 트리트먼트 및 운영시간",
    "🚪 레이트 체크아웃 안내",
  ],
  zh: ["🛏️ 房型与价格", "🍽️ 餐厅菜单与价格", "💆 水疗 Spa 价格", "🚪 延迟退房费用"],
  ru: ["🛏️ Номера и цены", "🍽️ Меню ресторанов", "💆 Услуги спа", "🚪 Поздний выезд"],
  ja: ["🛏️ 客室と料金", "🍽️ レストランメニューと料金", "💆 スパの営業時間と料金", "🚪 レイトチェックアウト費用"],
};

const Bubble = memo(function Bubble({
  role,
  body,
  time,
  author,
}: {
  role: string;
  body: string;
  time: string;
  author?: string | null;
}) {
  if (role === "system") {
    return (
      <div className="my-3 text-center text-xs text-muted-foreground" data-testid="message-system">
        {body}
      </div>
    );
  }
  const mine = role === "guest";
  return (
    <div className={cn("flex gap-2.5", mine ? "justify-end" : "justify-start")}>
      {!mine && (
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/12 text-primary">
          {role === "staff" ? <UserRound className="h-3.5 w-3.5" /> : <VinAureaMark className="h-4 w-4" />}
        </div>
      )}
      <div className={cn("max-w-[82%] sm:max-w-[70%]", mine && "text-right")}>
        {!mine && (
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">
            {role === "staff" ? `${author ?? "Front desk"} · Front desk` : "VinAurea"}
          </div>
        )}
        <div
          data-testid={`message-${role}`}
          className={cn(
            "rounded-2xl px-3.5 py-2.5 text-left text-sm leading-relaxed",
            mine
              ? "whitespace-pre-wrap rounded-br-sm bg-primary text-primary-foreground"
              : role === "staff"
                ? "rounded-bl-sm border border-border bg-secondary"
                : "rounded-bl-sm border border-card-border bg-card",
          )}
        >
          {mine ? body : <MarkdownBody text={body} />}
        </div>
        <div className="mt-1 px-1 text-[10px] text-muted-foreground">{time}</div>
      </div>
    </div>
  );
});

/**
 * Sáu ngôn ngữ concierge trả lời được, ở MỘT chỗ duy nhất.
 *
 * Danh sách này trước đây nằm inline trong thanh chuyển ngôn ngữ. Màn hình
 * chọn lúc vào cần đúng sáu mục đó, và một bản chép thứ hai là cách chắc chắn
 * để chúng lệch nhau: thêm một ngôn ngữ ở một chỗ, khách chọn được ở màn hình
 * vào nhưng không đổi lại được trong lúc chat.
 *
 * `native` là tên ngôn ngữ VIẾT BẰNG CHÍNH NÓ. Người đang tìm tiếng Hàn tìm
 * chữ "한국어", không tìm chữ "Korean" — nhãn dịch sang tiếng Anh chỉ giúp
 * người đã đọc được tiếng Anh, tức là người ít cần màn hình này nhất.
 */
/**
 * Chữ trên giao diện khách, sáu thứ tiếng.
 *
 * Nguyên tắc phân định — có thứ KHÔNG dịch, và đó là chủ ý:
 *   - "VinAurea" là tên riêng. Tên thương hiệu dịch ra là mất thương hiệu.
 *   - "Wi-Fi", "spa", "check-in" giữ nguyên: người Việt dùng đúng những chữ
 *     đó hằng ngày, và "mạng không dây" nghe như sách giáo khoa năm 1998.
 *   - Mã đặt phòng, tên nhà hàng, tên món giữ nguyên — khách phải đối chiếu
 *     được với phiếu in trên tay.
 *
 * Ngược lại, mọi câu MÔ TẢ HÀNH VI của hệ thống đều phải dịch. Một dòng
 * "Front desk is with you" nằm dưới header tiếng Hàn không phải là 'ai cũng
 * hiểu' — nó là chỗ khách cần chắc chắn nhất rằng đang có người thật.
 */
const UI_COPY: Record<string, Record<string, string>> = {
  vi: {
    howToJoin: "Cách vào thử",
    joinBody: "Mỗi người chọn MỘT tài khoản khác nhau bên dưới — chọn trùng thì cả nhóm chung một cuộc trò chuyện và đọc được tin nhắn của nhau. Ô nào ghi \"đang dùng\" thì bỏ qua, chọn ô trống. Không cần mật khẩu.",
    inUse: "đang dùng",
    freeNow: "còn trống",
    hideChips: "Ẩn gợi ý",
    showChips: "Hiện gợi ý nhanh",
    moreChips: "Kéo xem thêm",
    micHint: "Bấm để nói",
    darkOn: "Chế độ tối",
    darkOff: "Chế độ sáng",
    greet: "Chào quý khách",
    myReq: "📋 Yêu cầu của tôi",
    handoffTitle: "Lễ tân đã nhận",
    handoffBody: "Nhân viên sẽ trả lời ngay trong hội thoại này. Quý khách không cần làm gì thêm.",
    room: "Phòng",
    withStaff: "Nhân viên lễ tân đang hỗ trợ",
    withAI: "Trợ lý AI · trả lời trong vài giây",
    switchGuest: "Đổi mã",
    sending: "Đang chuyển tới lễ tân…",
    composer: "Hỏi bất cứ điều gì, hoặc cho chúng tôi biết quý khách cần gì…",
    footer: "Mọi yêu cầu đều được ghi vào bảng điều hành của khách sạn. Nhân viên sẽ tham gia khi cần.",
    staffSignIn: "Nhân viên đăng nhập",
    loadingKeys: "Đang tải danh sách đặt phòng…",
    noneInHouse: "Hiện chưa có khách nào đang lưu trú.",
  },
  en: {
    howToJoin: "How to join",
    joinBody: "Pick a DIFFERENT account each — two people on the same one share a single conversation and can read each other's messages. Skip any marked \"in use\" and take a free one. No password needed.",
    inUse: "in use",
    freeNow: "free",
    hideChips: "Hide shortcuts",
    showChips: "Show quick shortcuts",
    moreChips: "Scroll for more",
    micHint: "Tap to speak",
    darkOn: "Dark mode",
    darkOff: "Light mode",
    greet: "Welcome",
    myReq: "📋 My requests",
    handoffTitle: "The front desk has this",
    handoffBody: "A team member will reply here. Nothing further is needed from you.",
    room: "Room",
    withStaff: "Front desk is with you",
    withAI: "AI assistant · replies in seconds",
    switchGuest: "Switch",
    sending: "Sending to the front desk…",
    composer: "Ask anything, or tell us what you need…",
    footer: "Requests are logged to the hotel's operations board. A human joins whenever it matters.",
    staffSignIn: "Hotel team sign-in",
    loadingKeys: "Loading reservations…",
    noneInHouse: "No one is checked in right now.",
  },
  ko: {
    howToJoin: "참여 방법",
    joinBody: "각자 다른 계정을 선택하세요. 같은 계정을 쓰면 대화가 공유됩니다. \"사용 중\" 표시는 건너뛰세요. 비밀번호는 필요 없습니다.",
    inUse: "사용 중",
    freeNow: "사용 가능",
    hideChips: "바로가기 숨기기",
    showChips: "바로가기 표시",
    moreChips: "옆으로 밀기",
    micHint: "눌러서 말하기",
    darkOn: "다크 모드",
    darkOff: "라이트 모드",
    greet: "환영합니다",
    myReq: "📋 내 요청",
    handoffTitle: "프런트가 확인했습니다",
    handoffBody: "담당자가 이 대화에서 답변드립니다. 추가로 하실 일은 없습니다.",
    room: "객실",
    withStaff: "프런트 직원이 응대 중입니다",
    withAI: "AI 어시스턴트 · 몇 초 내 응답",
    switchGuest: "번호 변경",
    sending: "프런트로 전달 중…",
    composer: "무엇이든 물어보시거나 필요하신 것을 말씀해 주세요…",
    footer: "모든 요청은 호텔 운영 보드에 기록되며, 필요할 때 직원이 참여합니다.",
    staffSignIn: "직원 로그인",
    loadingKeys: "예약 목록을 불러오는 중…",
    noneInHouse: "현재 투숙 중인 고객이 없습니다.",
  },
  zh: {
    howToJoin: "如何加入",
    joinBody: "每人选择不同的账号。选同一个会共用一个对话，能看到彼此的消息。跳过标记「使用中」的，选空闲的。无需密码。",
    inUse: "使用中",
    freeNow: "空闲",
    hideChips: "隐藏快捷方式",
    showChips: "显示快捷方式",
    moreChips: "向右滑动查看",
    micHint: "点击说话",
    darkOn: "深色模式",
    darkOff: "浅色模式",
    greet: "欢迎",
    myReq: "📋 我的请求",
    handoffTitle: "前台已接手",
    handoffBody: "工作人员会在此对话中回复您，您无需再做任何操作。",
    room: "房间",
    withStaff: "前台正在为您服务",
    withAI: "AI 助理 · 数秒内回复",
    switchGuest: "更换编码",
    sending: "正在转交前台…",
    composer: "有任何问题，或告诉我们您的需求…",
    footer: "所有请求都会记录到酒店运营看板，必要时由员工接手。",
    staffSignIn: "员工登录",
    loadingKeys: "正在加载预订…",
    noneInHouse: "目前没有在住客人。",
  },
  ja: {
    howToJoin: "参加方法",
    joinBody: "各自ちがうアカウントを選んでください。同じものだと会話が共有され、互いのメッセージが見えます。「使用中」は避けて空いているものを。パスワードは不要です。",
    inUse: "使用中",
    freeNow: "空き",
    hideChips: "ショートカットを隠す",
    showChips: "ショートカットを表示",
    moreChips: "横にスクロール",
    micHint: "タップして話す",
    darkOn: "ダークモード",
    darkOff: "ライトモード",
    greet: "ようこそ",
    myReq: "📋 リクエスト履歴",
    handoffTitle: "フロントが承りました",
    handoffBody: "担当者がこのチャットで返信いたします。お客様の追加操作は不要です。",
    room: "客室",
    withStaff: "フロント担当が対応しています",
    withAI: "AIアシスタント · 数秒で回答",
    switchGuest: "番号を変更",
    sending: "フロントへ転送しています…",
    composer: "何でもお尋ねください。ご要望をお聞かせください…",
    footer: "すべてのご依頼はホテルの運営ボードに記録され、必要に応じて担当者が対応します。",
    staffSignIn: "スタッフ ログイン",
    loadingKeys: "予約を読み込んでいます…",
    noneInHouse: "現在ご滞在中のお客様はいません。",
  },
  ru: {
    howToJoin: "Как подключиться",
    joinBody: "Каждый выбирает РАЗНЫЙ аккаунт — на одном вы попадёте в общий диалог и увидите сообщения друг друга. Пропускайте помеченные «занят». Пароль не нужен.",
    inUse: "занят",
    freeNow: "свободно",
    hideChips: "Скрыть подсказки",
    showChips: "Показать подсказки",
    moreChips: "Прокрутите вправо",
    micHint: "Нажмите, чтобы говорить",
    darkOn: "Тёмная тема",
    darkOff: "Светлая тема",
    greet: "Добро пожаловать",
    myReq: "📋 Мои заявки",
    handoffTitle: "Стойка регистрации приняла",
    handoffBody: "Сотрудник ответит здесь. От вас больше ничего не требуется.",
    room: "Номер",
    withStaff: "С вами сотрудник стойки регистрации",
    withAI: "AI-ассистент · ответ за секунды",
    switchGuest: "Сменить код",
    sending: "Передаём на стойку регистрации…",
    composer: "Спросите о чём угодно или скажите, что вам нужно…",
    footer: "Все заявки фиксируются на операционной панели отеля. Сотрудник подключается, когда это нужно.",
    staffSignIn: "Вход для персонала",
    loadingKeys: "Загружаем брони…",
    noneInHouse: "Сейчас нет заселённых гостей.",
  },
};

/** Chữ cho ngôn ngữ này, lùi về tiếng Anh khi thiếu. */
const t = (lang: string, key: string) => (UI_COPY[lang] ?? UI_COPY.en)[key] ?? UI_COPY.en[key];
const LANGS = [
  { code: "vi", label: "VN", native: "Tiếng Việt" },
  { code: "en", label: "EN", native: "English" },
  { code: "ko", label: "KO", native: "한국어" },
  { code: "zh", label: "ZH", native: "中文" },
  { code: "ja", label: "JA", native: "日本語" },
  { code: "ru", label: "RU", native: "Русский" },
] as const;

/** Câu mời nhập mã, mỗi thứ tiếng một câu — màn hình vào phải tự giải thích
 *  được bằng ngôn ngữ khách vừa chọn, không thì việc chọn chẳng để làm gì. */
const ENTRY_COPY: Record<string, { pick: string; code: string; open: string; hint: string; lead: string; quote: string; by: string }> = {
  vi: { pick: "Chọn ngôn ngữ", code: "Mã đặt phòng", open: "Mở", hint: "Mã in trên phiếu nhận phòng, ví dụ VPNT-4Q18ZM", lead: "Trợ lý của quý khách trả lời bằng tiếng của quý khách, suốt ngày đêm — và làm được việc thật: đặt bàn, gọi đồ lên phòng, xin trả phòng muộn, gọi kỹ thuật.", quote: "Trợ lý đồng hành cùng quý khách trong suốt kỳ nghỉ.", by: "Phát triển bởi nhóm P228" },
  en: { pick: "Choose your language", code: "Confirmation code", open: "Open", hint: "On your check-in slip, e.g. VPNT-4Q18ZM", lead: "Your concierge answers in your language, around the clock — and can actually act on requests: book a table, order to the room, arrange a late departure, call engineering.", quote: "An assistant that stays with you throughout your holiday.", by: "Developed by team P228" },
  ko: { pick: "언어 선택", code: "예약 번호", open: "열기", hint: "체크인 확인서에 있습니다, 예: VPNT-4Q18ZM", lead: "컨시어지가 고객님의 언어로 24시간 응대하며, 실제로 처리해 드립니다: 레스토랑 예약, 룸서비스 주문, 레이트 체크아웃, 시설 요청.", quote: "휴가 내내 곁에서 함께하는 어시스턴트입니다.", by: "P228 팀 개발" },
  zh: { pick: "选择语言", code: "预订确认码", open: "打开", hint: "见入住单，例如 VPNT-4Q18ZM", lead: "礼宾服务全天候以您的语言回复，并能实际办理：餐厅订位、客房送餐、延迟退房、报修。", quote: "假期全程陪伴您的智能助理。", by: "由 P228 团队开发" },
  ja: { pick: "言語を選択", code: "予約番号", open: "開く", hint: "チェックイン控えに記載、例: VPNT-4Q18ZM", lead: "コンシェルジュがお客様の言語で24時間対応し、実際に手配いたします：レストランのご予約、ルームサービス、レイトチェックアウト、設備のご依頼。", quote: "ご滞在のあいだ、ずっとそばにいるアシスタントです。", by: "P228 チーム開発" },
  ru: { pick: "Выберите язык", code: "Код бронирования", open: "Открыть", hint: "В вашем ваучере, например VPNT-4Q18ZM", lead: "Консьерж отвечает на вашем языке круглосуточно — и действительно выполняет заявки: бронь столика, заказ в номер, поздний выезд, вызов техника.", quote: "Ассистент, который сопровождает вас весь отпуск.", by: "Разработано командой P228" },
};
function KeyPicker({ onPick, lang, onLang }: { onPick: (code: string) => void; lang: string; onLang: (l: string) => void }) {
  /* 404 is the normal answer now — the directory is opt-in (EXPOSE_GUEST_KEYS=1)
     because it lists every guest's code, name and room. `isError` is what tells
     the picker to show nothing rather than "Loading reservations…" forever. */
  const { data: keys, isError: keysOff, isLoading: keysLoading } = useQuery<GuestKey[]>({
    queryKey: ["/api/guest/keys"],
    retry: false,
  });
  const { data: hotel } = useQuery<Hotel>({ queryKey: ["/api/hotel"] });
  const [code, setCode] = useState("");
  const copy = ENTRY_COPY[lang] ?? ENTRY_COPY.en;
  /**
   * Tài khoản CHƯA CÓ AI dùng xếp lên trước.
   *
   * Khi nhiều người cùng thử, ai cũng bấm vào cái tên đầu tiên nhìn thấy — rồi
   * cả nhóm chung một hội thoại, đọc tin nhắn của nhau, và model lấy lịch sử
   * của người khác làm ngữ cảnh. Đưa ô trống lên đầu là cách rẻ nhất để việc
   * đúng cũng là việc dễ nhất; cái nhãn bên dưới chỉ là lớp giải thích thứ hai.
   */
  const sapXep = (a: GuestKey, b: GuestKey) =>
    Number(a.dangDung ?? false) - Number(b.dangDung ?? false);
  const inHouse = (keys ?? []).filter((k) => k.status === "in_house").sort(sapXep);
  const others = (keys ?? []).filter((k) => k.status !== "in_house");
  const soTrong = inHouse.filter((k) => !k.dangDung).length;

  return (
    <div className="mx-auto flex min-h-[100dvh] w-full max-w-xl flex-col justify-center px-5 py-12">
      {/* Khối nhận diện căn giữa. Phần còn lại của trang giữ căn trái, vì một
          ô nhập liệu và một hàng nút căn giữa thì mắt không biết bắt đầu đọc từ
          đâu — căn giữa hợp với thứ để NGẮM, căn trái hợp với thứ để DÙNG. */}
      <div className="flex flex-col items-center text-center">
        <VinAureaCrest className="h-24 w-24" />
        <h1 className="mt-3 font-serif text-2xl font-semibold tracking-tight">
          {hotel?.name ?? "VinAurea"}
        </h1>
        {/* Một câu, không phải danh sách tính năng.
            Bản trước liệt kê bốn việc hệ thống làm được — đó là câu trả lời cho
            câu hỏi "sản phẩm này có gì", mà người vừa nhận phòng thì chưa hỏi
            câu đó. Câu này nói đúng điều sản phẩm thực sự làm — trả lời bằng
            tiếng của khách — mà không bắt ai đọc một đoạn văn. */}
        <p className="mt-2.5 max-w-sm font-serif text-[15px] italic leading-relaxed text-muted-foreground">
          {copy.quote}
        </p>
        {/* Ghi công tách thành dòng riêng, nhỏ và nhạt hơn.
            Gộp tên nhóm vào chính câu chào sẽ biến nó thành chú thích đồ án —
            khách đọc dòng đầu để biết sản phẩm làm gì, dòng sau để biết ai làm,
            và hai việc đó không nên tranh nhau cùng một cỡ chữ. */}
        <p className="mt-2 text-[11px] tracking-wide text-muted-foreground/70">{copy.by}</p>
      </div>

      {/* Ngôn ngữ đứng TRƯỚC ô nhập mã, không phải sau.
          Một khách không đọc được tiếng Việt sẽ không hiểu ô kia đòi gì; hỏi
          ngôn ngữ trước rồi mới hỏi mã là thứ tự khiến màn hình tự giải thích
          được. Nhãn dưới đây đổi theo lựa chọn, ngay lập tức. */}
      <div className="mt-7">
        <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {copy.pick}
        </div>
        <div className="mt-2.5 flex flex-wrap gap-2" data-testid="entry-language">
          {LANGS.map((l) => (
            <button
              key={l.code}
              type="button"
              onClick={() => onLang(l.code)}
              data-testid={`entry-lang-${l.code}`}
              aria-pressed={lang === l.code}
              className={cn(
                "flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-all",
                lang === l.code
                  ? "border-primary bg-primary/10 text-foreground shadow-sm"
                  : "border-border bg-card text-muted-foreground hover:border-primary/50 hover:text-foreground",
              )}
            >
              <Flag code={l.code} className="h-3.5 w-5" />
              <span className="font-medium">{l.native}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="mt-6 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {copy.code}
      </div>
      <form
        className="mt-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim()) onPick(code.trim().toUpperCase());
        }}
      >
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={copy.hint}
          className="font-mono"
          data-testid="input-code"
        />
        <Button type="submit" data-testid="button-open-chat">
          {copy.open} <ArrowRight className="ml-1 h-4 w-4" />
        </Button>
      </form>

      {/* Kiosk: khách chưa có mã thì quét thẻ, hệ thống nhận phòng rồi tự mở phiên. */}
      <KioskCheckin lang={lang} onCode={onPick} />

      {/* Hidden entirely when the directory is off, which is the default. The
          code field above is the real way in; this was only ever a demo aid. */}
      <div className="mt-8" hidden={keysOff}>
        {/**
          * Hướng dẫn cho người vào thử.
          *
          * Không phải trang trí: khi mở link cho một nhóm cùng thử, thứ hỏng
          * trước tiên không phải phần mềm mà là việc mọi người chọn trùng một
          * tài khoản. Ba dòng ở đây rẻ hơn nhiều so với một buổi thử có dữ liệu
          * trộn vào nhau rồi không đọc lại được.
          */}
        <div className="rounded-lg border border-primary/25 bg-primary/[0.04] px-3.5 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-primary">
            {t(lang, "howToJoin")}
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-foreground/80">{t(lang, "joinBody")}</p>
        </div>

        <div className="mt-4 flex items-baseline justify-between">
          <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            In house now
          </div>
          <div className="text-[11px] text-muted-foreground">
            {soTrong}/{inHouse.length} {t(lang, "freeNow")}
          </div>
        </div>
        <div className="mt-2 grid gap-1.5">
          {inHouse.map((k) => (
            <button
              key={k.confirmationCode}
              onClick={() => onPick(k.confirmationCode)}
              data-testid={`key-${k.confirmationCode}`}
              /* Vẫn bấm được khi đang có người: người bỏ dở giữa chừng phải quay
                 lại đúng hội thoại của mình được. Làm mờ để nói "đừng chọn cái
                 này", không phải "cấm". */
              className={`hover-elevate flex items-center gap-3 rounded-md border px-3 py-2.5 text-left ${
                k.dangDung ? "border-dashed border-border bg-muted/30 opacity-70" : "border-card-border bg-card"
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium">{k.guestName}</span>
                  {k.dangDung && (
                    <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                      {t(lang, "inUse")}
                      {k.phutTruoc != null && ` · ${k.phutTruoc}′`}
                    </span>
                  )}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  Room {k.room} · {LANG_LABELS[k.lang] ?? k.lang}
                  {k.vipTier !== "none" && ` · ${k.vipTier}`}
                </div>
              </div>
              <span className="font-mono text-[11px] text-muted-foreground">
                {k.confirmationCode}
              </span>
            </button>
          ))}
          {inHouse.length === 0 && (
            <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
              {keysLoading ? t(lang, "loadingKeys") : t(lang, "noneInHouse")}
            </div>
          )}
        </div>
        {others.length > 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              Arriving & past stays ({others.length})
            </summary>
            <div className="mt-2 grid gap-1.5">
              {others.map((k) => (
                <button
                  key={k.confirmationCode}
                  onClick={() => onPick(k.confirmationCode)}
                  data-testid={`key-${k.confirmationCode}`}
                  className="hover-elevate flex items-center gap-3 rounded-md border border-card-border bg-card px-3 py-2 text-left"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{k.guestName}</div>
                    <div className="text-xs text-muted-foreground">
                      {k.status.replace("_", " ")} · {k.checkIn} → {k.checkOut}
                    </div>
                  </div>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {k.confirmationCode}
                  </span>
                </button>
              ))}
            </div>
          </details>
        )}
      </div>

      <Link
        href="/staff"
        className="mt-10 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        data-testid="link-staff"
      >
        <ShieldCheck className="h-3.5 w-3.5" /> {t(lang, "staffSignIn")}
      </Link>
    </div>
  );
}

/**
 * What the kiosk is actually doing while the guest waits.
 *
 * Every line here has to be TRUE of the turn in progress. The previous set
 * claimed "Tính toán ưu đãi thành viên…" / "Applying member entitlements…" on
 * every single turn — it showed while answering "mấy giờ ăn sáng?", where no
 * entitlement is read and no member price exists. A progress line that
 * describes work the system is not doing is a small lie the guest can catch,
 * and it is the kind that makes them distrust the parts that are true.
 *
 * The three that remain map to real stages of the offline pipeline: routing
 * (classifyLocal), retrieval (hybridSearch), generation (one model call).
 *
 * All six production languages, because a Korean or Russian guest waiting
 * eight seconds at an English spinner is the same gap as the answer itself
 * coming back in the wrong language — the kiosk stops feeling like it is
 * speaking to them.
 */
const REASONING_STEPS: Record<string, string[]> = {
  vi: ["Đang phân tích yêu cầu...", "Đang tìm trong kho tri thức...", "Đang soạn câu trả lời..."],
  en: ["Analysing your request...", "Searching the knowledge base...", "Writing your answer..."],
  ko: ["요청을 분석하고 있습니다...", "자료를 검색하고 있습니다...", "답변을 작성하고 있습니다..."],
  ja: ["ご質問を確認しています...", "資料を検索しています...", "回答を作成しています..."],
  zh: ["正在分析您的问题...", "正在检索资料...", "正在撰写回复..."],
  ru: ["Анализируем ваш запрос...", "Ищем в базе знаний...", "Готовим ответ..."],
};

function ReasoningIndicator({ lang }: { lang: string }) {
  const steps = REASONING_STEPS[lang] ?? REASONING_STEPS.en;
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setStepIndex((i) => Math.min(i + 1, steps.length - 1));
    }, 2000); // Change step every 2 seconds
    return () => clearInterval(interval);
  }, [steps]);

  return <span className="animate-pulse">{steps[stepIndex]}</span>;
}

export default function GuestPage() {
  // Deep link support: #/?code=AUR-8F31KQ opens straight into that guest's thread.
  const initialCode = (() => {
    const hash = window.location.hash.replace(/^#/, "");
    const q = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "";
    return new URLSearchParams(q).get("code");
  })();
  const [code, setCode] = useState<string | null>(initialCode);
  /**
   * Ngôn ngữ khách CHỌN, tách khỏi ngôn ngữ lưu trong hồ sơ khách.
   *
   * Hồ sơ nói khách nói tiếng gì; màn hình vào nói khách muốn ĐỌC tiếng gì
   * lúc này. Hai thứ khác nhau: một cặp vợ chồng dùng chung mã đặt phòng,
   * hay một khách Nhật thạo tiếng Anh hơn, đều làm hồ sơ sai với thực tế
   * ngay lúc đó. Lựa chọn của khách thắng, và `null` nghĩa là chưa chọn —
   * lúc đó hồ sơ mới được dùng, thay vì ép mặc định tiếng Việt cho mọi người.
   *
   * Nhớ lại qua các lần mở nhờ localStorage: khách quét lại mã QR ở sảnh
   * không nên phải chọn lại ngôn ngữ mỗi lần. Bọc try/catch vì trình duyệt
   * ở chế độ riêng tư ném lỗi ngay ở bước đọc.
   */
  const [pickedLang, setPickedLang] = useState<string | null>(() => {
    try {
      return localStorage.getItem("aurea-lang");
    } catch {
      return null;
    }
  });
  const chooseLang = (l: string) => {
    setPickedLang(l);
    try {
      localStorage.setItem("aurea-lang", l);
    } catch {
      /* Riêng tư / bị chặn — lựa chọn vẫn có tác dụng trong phiên này. */
    }
  };
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  const endRef = useRef<HTMLDivElement>(null);

  const session = useQuery<ConversationDetail & { conversationId: number }>({
    queryKey: ["guest-session", code],
    enabled: !!code,
    queryFn: async () => {
      const res = await apiRequest("POST", "/api/guest/session", { code });
      return res.json();
    },
  });

  const conversationId = session.data?.conversationId;

  // Poll so a staff takeover reply lands in the guest thread without a refresh.
  const live = useQuery<ConversationDetail>({
    queryKey: [`/api/conversations/${conversationId}?code=${encodeURIComponent(code ?? "")}`],
    enabled: !!conversationId,
    refetchInterval: 5000,
  });

  const rawDetail = live.data ?? session.data;
  /**
   * Ngôn ngữ khách chọn ghi đè ngôn ngữ trong hồ sơ — ở ĐÚNG MỘT chỗ.
   *
   * `detail.guest.lang` được đọc ở tám nơi (thẻ phòng, thẻ dịch vụ, nút đọc to,
   * bảng gọi đồ, yêu cầu nhanh, nhãn chip…). Ghi đè tại nguồn nghĩa là thêm
   * một ngôn ngữ hay một thành phần mới không phải nhớ đọc biến nào; sửa từng
   * nơi dùng là cách chắc chắn để bỏ sót một chỗ và khách thấy giao diện lẫn
   * hai thứ tiếng — lỗi mà dự án này đã gặp hai lần ở dạng khác.
   */
  const detail =
    rawDetail && pickedLang
      ? { ...rawDetail, guest: { ...rawDetail.guest, lang: pickedLang } }
      : rawDetail;
  /* Ngôn ngữ dùng cho CHỮ GIAO DIỆN. Tách tên riêng ra vì `detail` có thể chưa
     tải xong, mà header và ô soạn đã cần chữ ngay ở khung hình đầu tiên. */
  const uiLang = pickedLang ?? rawDetail?.guest.lang ?? "vi";

  /**
   * Nói cho trình duyệt biết trang đang viết bằng tiếng gì.
   *
   * Không phải chi tiết trợ năng — nó là thứ quyết định trình duyệt có TỰ DỊCH
   * trang hay không. `index.html` khai cố định `lang="en"` trong khi nội dung
   * là tiếng Việt, nên Chrome/Edge thấy chênh lệch và đề nghị dịch; máy nào đã
   * bật "luôn dịch" thì nó dịch im lặng.
   *
   * Đo được trong một buổi thử thật, hai người xem CÙNG một hội thoại: máy này
   * hiện "nếu ngủ khách sạn có bao cafe sáng không", máy kia hiện bản tiếng Anh
   * bắt đầu bằng "If…". Cơ sở dữ liệu chỉ lưu một chuỗi tiếng Việt duy nhất.
   *
   * Cập nhật theo lá cờ khách chọn, nên khách Hàn chọn 한국어 thì trang khai
   * `ko` và trình duyệt của họ không đòi dịch nữa.
   */
  useEffect(() => {
    document.documentElement.lang = uiLang;
  }, [uiLang]);

  const send = useMutation({
    mutationFn: async (body: string) => {
      const res = await apiRequest("POST", `/api/conversations/${conversationId}/messages`, {
        from: "guest",
        body,
      });
      return res.json() as Promise<ConversationDetail>;
    },
    onSuccess: (data) => {
      qc.setQueryData([`/api/conversations/${conversationId}?code=${encodeURIComponent(code ?? "")}`], data);
      setError(null);
    },
    onError: (e: Error) => setError(e.message),
  });

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [detail?.messages.length, send.isPending]);

  /* Whether the GUEST has shown interest in rooms — their own words only.
   *
   * This used to read the last message in the thread, which is the AI's reply,
   * with a boundary-less alternation that included bare "phong", "gia" and
   * "giá". Almost every answer this concierge writes contains one of them:
   * "Wi-Fi miễn phí trong toàn bộ phòng, biệt thự…" matched "phòng" and
   * unfolded five room-shopping chips under a wifi answer. "gia" also matched
   * inside "Bách Giai", "gia đình" and "giai đoạn", so a restaurant question
   * did it too.
   *
   * Rooms are the thing the guest asks about, not the thing our own sentence
   * happens to mention — so this reads the draft they are typing and their
   * own last message, and matches on words that only appear when someone is
   * shopping for a room. */
  const roomRelated = useMemo(() => {
    const lastGuestText =
      [...(detail?.messages ?? [])].reverse().find((m) => m.role === "guest")?.body ?? "";
    const text = `${draft} ${lastGuestText}`.toLowerCase();
    return /(?:^|[^\p{L}])(?:deluxe|delu|villa|suite|hạng phòng|hang phong|loại phòng|loai phong|đặt phòng|dat phong|room type|room rate|book a room)(?:[^\p{L}]|$)/u.test(
      text,
    );
  }, [draft, detail?.messages]);

  const [roomServiceOpen, setRoomServiceOpen] = useState(false);
  const [requestsOpen, setRequestsOpen] = useState(false);
  const [myReqOpen, setMyReqOpen] = useState(false);

  /**
   * Khách ẩn được hàng gợi ý, và lựa chọn đó được nhớ.
   *
   * Hàng chip luôn hiện là đúng cho người vừa mở lần đầu — họ chưa biết hỏi
   * được gì. Nó sai với người đã dùng quen: mười cái nút chiếm một dải màn hình
   * suốt cuộc hội thoại để mời làm những việc họ không định làm.
   *
   * Nhớ trong `localStorage` chứ không phải state: ẩn xong mà tải lại trang nó
   * hiện lại thì cái nút ẩn đó vô nghĩa.
   */
  const [chipsAn, setChipsAn] = useState(() => {
    try {
      return localStorage.getItem("aurea.chips.hidden") === "1";
    } catch {
      /* Chế độ riêng tư, hoặc trình duyệt chặn lưu trữ. Không phải lỗi — chỉ là
         lựa chọn không được nhớ qua các lần mở. */
      return false;
    }
  });
  const doiChips = (an: boolean) => {
    setChipsAn(an);
    try {
      localStorage.setItem("aurea.chips.hidden", an ? "1" : "0");
    } catch {
      /* xem trên */
    }
  };

  /**
   * Còn chip ở bên phải màn hình hay không.
   *
   * Hàng chip cuộn ngang và thanh cuộn bị ẩn (`scrollbar-none`) để không chiếm
   * chiều cao trên điện thoại — nhưng như vậy **không còn dấu hiệu nào** cho
   * biết còn nội dung bên phải. Người mới vào thấy bốn cái nút và tưởng chỉ có
   * bốn, trong khi tiếng Việt có tám.
   */
  const chipScroller = useRef<HTMLDivElement | null>(null);
  const [conChipPhai, setConChipPhai] = useState(false);
  const doChipPhai = () => {
    const el = chipScroller.current;
    if (!el) return;
    /* Trừ 8px: cuộn tới cuối thường lệch vài phần trăm pixel, và không có biên
       này thì mũi tên nhấp nháy ở cuối hàng. */
    setConChipPhai(el.scrollLeft + el.clientWidth < el.scrollWidth - 8);
  };
  /**
   * NHÓM 3.2 — nhắc một lần rằng nút micro dùng để nói.
   *
   * Nút micro là một hình tròn 14 pixel cạnh ô nhập tin và không nói gì về
   * việc nó làm. Nhắc MỘT lần rồi nhớ vào localStorage: nhắc mãi thì thành
   * phiền, mà không nhắc thì tính năng coi như không tồn tại.
   */
  const [micHintSeen, setMicHintSeen] = useState(() => {
    try {
      return localStorage.getItem("aurea-mic-hint") === "1";
    } catch {
      return true; // không lưu được thì thà im lặng còn hơn nhắc mỗi lần mở
    }
  });
  const dismissMicHint = () => {
    setMicHintSeen(true);
    try {
      localStorage.setItem("aurea-mic-hint", "1");
    } catch {
      /* riêng tư / bị chặn — vẫn ẩn trong phiên này */
    }
  };
  /**
   * NHÓM 4 — chế độ tối cho khách.
   *
   * Dashboard nhân viên có nút này từ đầu; kiosk khách thì không — mà khách
   * mới là người mở điện thoại trên giường lúc mười một giờ đêm. Dùng lại
   * đúng `toggleTheme` của SessionProvider (nó bật/tắt class `dark` trên
   * <html>), nên không có hệ thống theme thứ hai để hai bên lệch nhau.
   */
  const { theme, toggleTheme } = useSession();

  const prompts = useMemo(() => {
    const lang = detail?.guest.lang ?? "en";
    const base = PROMPTS[lang] ?? PROMPTS.en;
    /* No English fallback here. ROOM_QUICK_CHIPS only covers vi and en, and
       falling back handed a Russian guest "🛏️ Deluxe Double Bed" sitting next
       to "🛏️ Номера и цены" in the same row. A chip the guest cannot read is
       worse than no chip — `base` already offers rooms in their language. */
    const roomChips = ROOM_QUICK_CHIPS[lang];
    if (roomRelated && roomChips) {
      return Array.from(new Set([...roomChips, ...base]));
    }
    return base;
  }, [detail?.guest.lang, roomRelated]);

  /**
   * Tính lại "còn chip bên phải" khi danh sách hoặc bề rộng đổi.
   *
   * Không chỉ lúc cuộn: số chip đổi theo ngôn ngữ (tiếng Việt tám, tiếng Nga
   * bốn) và theo việc lượt vừa rồi có nói tới phòng hay không. Chỉ nghe sự kiện
   * `scroll` thì mũi tên không bao giờ xuất hiện cho tới khi khách đã tự cuộn —
   * tức là sau khi họ đã tự phát hiện ra điều mà mũi tên định nói với họ.
   *
   * Đo BA lần bằng ba cơ chế, và không cái nào thừa:
   *
   *   · ngay lập tức — đủ cho trường hợp thường;
   *   · `requestAnimationFrame` — sau khi trình duyệt dựng xong bố cục, vì đo
   *     ngay trong effect thì `scrollWidth` vẫn là của lần dựng trước;
   *   · `ResizeObserver` — vì rAF **bị hoãn khi tab đang ẩn**. Đo được: mở
   *     trang trong một khung bị thu lại thì `innerWidth` là 0, rAF không chạy,
   *     và mũi tên không bao giờ xuất hiện kể cả khi khung mở ra sau đó.
   *     ResizeObserver kích hoạt đúng lúc phần tử nhận được kích thước thật.
   */
  useEffect(() => {
    doChipPhai();
    const id = requestAnimationFrame(doChipPhai);
    const el = chipScroller.current;
    const ro = el ? new ResizeObserver(doChipPhai) : null;
    if (el && ro) ro.observe(el);
    window.addEventListener("resize", doChipPhai);
    return () => {
      cancelAnimationFrame(id);
      ro?.disconnect();
      window.removeEventListener("resize", doChipPhai);
    };
  }, [prompts, chipsAn, roomServiceOpen, requestsOpen, myReqOpen]);

  if (!code) return <KeyPicker onPick={setCode} lang={pickedLang ?? "vi"} onLang={chooseLang} />;

  if (session.isError) {
    return (
      <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm text-muted-foreground">
          We couldn't find a reservation for that code.
        </p>
        <Button variant="outline" onClick={() => setCode(null)} data-testid="button-back">
          Try another code
        </Button>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const human = detail.conversation.mode === "human";
  const submit = () => {
    const body = draft.trim();
    if (!body || send.isPending) return;
    setDraft("");
    send.mutate(body);
  };

  return (
    <div className="mx-auto flex h-[100dvh] max-w-2xl flex-col bg-background">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <VinAureaMark className="h-7 w-7 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-serif text-sm font-semibold">VinAurea</div>
          <div className="truncate text-xs text-muted-foreground">
            {detail.guest.name} · {t(uiLang, "room")} {detail.room?.number ?? "—"} ·{" "}
            {human ? t(uiLang, "withStaff") : t(uiLang, "withAI")}
          </div>
        </div>
        <div className="flex items-center gap-1 rounded-full border border-border bg-secondary/50 p-1" data-testid="language-switcher">
          {LANGS.map((l) => {
            const active = (detail.guest.lang ?? "vi") === l.code;
            return (
              <button
                key={l.code}
                /* Ghi vào cùng một state với màn hình vào, không vào cache của
                   React Query. Bản trước sửa cache, và khi màn hình vào bắt đầu
                   ghi đè `detail.guest.lang` bằng lựa chọn của khách thì thanh
                   này lập tức trông như hỏng: bấm cờ, cache đổi, rồi bị ghi đè
                   lại ngay ở lượt render sau. Hai chỗ cùng sửa một giá trị thì
                   phải cùng ghi vào một nơi. */
                onClick={() => chooseLang(l.code)}
                className={cn(
                  "flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium transition-all",
                  active
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-background/80 hover:text-foreground",
                )}
                title={`Switch language to ${l.label}`}
                data-testid={`flag-${l.code}`}
              >
                <Flag code={l.code} className="h-3 w-[18px]" />
                <span className="text-[10px] font-semibold">{l.label}</span>
              </button>
            );
          })}
        </div>
        <button
          onClick={toggleTheme}
          title={theme === "light" ? t(uiLang, "darkOn") : t(uiLang, "darkOff")}
          aria-label={theme === "light" ? t(uiLang, "darkOn") : t(uiLang, "darkOff")}
          data-testid="button-theme-guest"
          className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {theme === "light" ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />}
        </button>
        <button
          onClick={() => setCode(null)}
          className="text-xs text-muted-foreground hover:text-foreground"
          data-testid="button-switch-guest"
        >
          {t(uiLang, "switchGuest")}
        </button>
      </header>

      {/**
        * `translate="no"` CHỈ trên luồng hội thoại, không trên cả trang.
        *
        * Chữ giao diện thì dịch thoải mái. Nhưng nội dung ở đây là giá tiền và
        * tên hạng phòng, và trình dịch của trình duyệt sẽ định dạng lại số:
        * `2.640.000đ` là đúng ở tiếng Việt và biến thành một con số khác khi bị
        * đọc theo quy ước tiếng Anh. Cả `numguard.ts` lẫn lớp giá tồn tại để
        * ngăn đúng chuyện đó xảy ra phía máy chủ; để trình duyệt làm lại nó ở
        * bước cuối cùng thì vô hiệu hoá toàn bộ công đó.
        *
        * Khách muốn đọc bằng thứ tiếng khác thì bấm lá cờ — trợ lý trả lời
        * bằng sáu ngôn ngữ, đó mới là đường đúng, và nó giữ nguyên con số.
        */}
      <div
        className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5"
        data-testid="thread"
        translate="no"
      >
        {/**
          * NHÓM 4.2 — lời chào khi chưa có tin nhắn nào.
          *
          * Hội thoại rỗng trước đây là một vùng trắng: khách vừa quét QR,
          * nhìn thấy một ô nhập tin và không biết hỏi được những gì. Lời
          * chào có TÊN và SỐ PHÒNG nói ngay rằng hệ thống biết họ là ai —
          * đó là thứ trấn an, không phải một câu chào chung chung.
          *
          * Không dùng lời chào giả làm bong bóng chat: nó không phải câu
          * model sinh ra, và trộn vào dòng hội thoại sẽ làm hỏng cả bản ghi
          * lẫn lịch sử cảm xúc tính từ nó — cùng lý do ghi chú đặt dịch vụ
          * được viết dưới role `system` chứ không phải `guest`.
          */}
        {detail.messages.length === 0 && (
          <div className="flex flex-col items-center py-10 text-center" data-testid="empty-greeting">
            <VinAureaCrest className="h-16 w-16 opacity-90" />
            <p className="mt-3 text-sm font-medium text-foreground">
              {t(uiLang, "greet")}, {detail.guest.name}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t(uiLang, "room")} {detail.room?.number ?? "—"}
            </p>
          </div>
        )}
        {detail.messages.map((m, i) => {
          /* Follow-up taps belong to the concierge's latest turn only: leaving
             chips live on older messages lets a guest answer a question that has
             already moved on. */
          const isLastAi = m.role === "ai" && i === detail.messages.length - 1;
          const rec = isLastAi ? readRecommendation(m.toolTrace) : null;
          const dining = m.role === "ai" ? readDiningReference(m.toolTrace) : [];
          const rooms = m.role === "ai" ? readRoomReference(m.toolTrace) : [];
          const svcGroups = m.role === "ai" ? readServiceReference(m.toolTrace) : [];
          return (
            <div key={m.id}>
              <Bubble role={m.role} body={m.body} author={m.authorName} time={clock(m.createdAt)} />
              {rec && (
                <div className="ml-9 mt-1">
                  <PackageActions
                    rec={rec}
                    lang={detail.guest.lang}
                    disabled={send.isPending}
                    onSend={(text) => send.mutate(text)}
                  />
                </div>
              )}
              {dining.length > 0 && (
                <div className="ml-9 mt-1">
                  <DiningActions venues={dining} lang={detail.guest.lang} />
                </div>
              )}
              {rooms.length > 0 && (
                <div className="ml-9 mt-1">
                  <RoomActions rooms={rooms} lang={detail.guest.lang} onSend={(text) => send.mutate(text)} />
                </div>
              )}
              {svcGroups.length > 0 && (
                <div className="ml-9 mt-1">
                  <ServiceActions groups={svcGroups} lang={detail.guest.lang} code={code} />
                </div>
              )}
              {m.role === "ai" && (
                <SourceAndFeedback
                  messageId={m.id}
                  conversationId={detail.conversation.id}
                  code={code}
                  toolTrace={m.toolTrace}
                  lang={detail.guest.lang}
                  body={m.body}
                  isLast={isLastAi}
                />
              )}
            </div>
          );
        })}
        {send.isPending && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-testid="typing">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {human ? t(uiLang, "sending") : <ReasoningIndicator lang={uiLang} />}
            {/* Chỉ hiện khi thật sự có người phía trước — xem queue-notice.tsx. */}
            {!human && <QueueNotice lang={uiLang} />}
          </div>
        )}
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/**
        * VIỆC 4 — trạng thái chuyển người.
        *
        * Một nửa số lượt (50/101 trên bộ eval) kết thúc bằng chuyển người, và
        * trước đây khách chỉ thấy một dòng chữ lẫn trong bong bóng chat. Thứ
        * làm khách thôi lo không phải câu trả lời nhanh, mà là biết CÓ NGƯỜI
        * ĐANG CẦM việc này — nên nó phải là một dải băng đứng yên ở đầu màn
        * hình, không phải một câu trôi đi khi hội thoại dài thêm.
        */}
      {human && (
        <div
          className="mx-4 mb-2 shrink-0 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2"
          data-testid="handoff-banner"
        >
          <div className="flex items-center gap-1.5 text-xs font-bold text-primary">
            <UserRound className="h-3.5 w-3.5" />
            {t(uiLang, "handoffTitle")}
          </div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-foreground/75">{t(uiLang, "handoffBody")}</p>
        </div>
      )}

      {/* In-room dining. A control rather than a chip: a chip sends a message
          to the model, and the whole point here is that no model is involved. */}
      <div className="shrink-0 px-4">
        {roomServiceOpen && <RoomServicePanel code={code} lang={detail.guest.lang} />}
        {requestsOpen && <GuestRequestsPanel code={code} lang={detail.guest.lang} />}
        {myReqOpen && <MyRequestsPanel code={code} lang={detail.guest.lang} />}
      </div>

      {/* Dynamic Quick Action Chips — Always visible so the guest doesn't have to type everything */}
      {/**
        * NHÓM 3.1 — một dòng cuộn ngang, không xuống hàng.
        *
        * Đo trên iPhone 375px: mười chip xuống 2–3 hàng và đẩy ô nhập tin
        * xuống dưới mép màn hình. Cuộn ngang giữ chiều cao cố định, và ô nhập
        * tin — thứ khách thật sự cần chạm — luôn ở chỗ ngón tay đang đặt.
        *
        * `scrollbar-none` chỉ ẩn thanh cuộn, không tắt cuộn: trên điện thoại
        * vốn không có thanh cuộn, còn trên máy tính chuột vẫn kéo ngang được.
        */}
      {chipsAn ? (
        <div className="flex shrink-0 justify-center px-4 pb-2">
          <button
            type="button"
            onClick={() => doiChips(false)}
            data-testid="chip-show"
            className="hover-elevate rounded-full border border-dashed border-border px-3 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
          >
            {t(uiLang, "showChips")}
          </button>
        </div>
      ) : (
      <div className="relative shrink-0">
      <div
        ref={chipScroller}
        onScroll={doChipPhai}
        /* pr-16: chừa chỗ cho nút ẩn và mũi tên nằm đè bên phải, nếu không chip
           cuối cùng chui xuống dưới chúng và không bấm được. */
        className="flex gap-1.5 overflow-x-auto px-4 pb-2 pr-16 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <button
          onClick={() => setRoomServiceOpen((v) => !v)}
          data-testid="chip-room-service"
          className={`hover-elevate shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-xs transition-colors ${
            roomServiceOpen
              ? "border-primary/60 bg-primary/15 text-primary"
              : "border-border bg-card hover:border-primary/40 hover:bg-primary/10"
          }`}
        >
          {ROOM_SERVICE_LABEL[detail.guest.lang] ?? ROOM_SERVICE_LABEL.en}
        </button>
        <button
          onClick={() => setRequestsOpen((v) => !v)}
          data-testid="chip-requests"
          className={`hover-elevate shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-xs transition-colors ${
            requestsOpen
              ? "border-primary/60 bg-primary/15 text-primary"
              : "border-border bg-card hover:border-primary/40 hover:bg-primary/10"
          }`}
        >
          {REQUESTS_LABEL[detail.guest.lang] ?? REQUESTS_LABEL.en}
        </button>
        <button
          onClick={() => setMyReqOpen((v) => !v)}
          data-testid="chip-my-requests"
          className={`hover-elevate shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-xs transition-colors ${
            myReqOpen
              ? "border-primary/60 bg-primary/15 text-primary"
              : "border-border bg-card hover:border-primary/40 hover:bg-primary/10"
          }`}
        >
          {t(uiLang, "myReq")}
        </button>
        {prompts.map((p) => (
          <button
            key={p}
            onClick={() => send.mutate(p)}
            disabled={send.isPending}
            data-testid="prompt-chip"
            className="hover-elevate shrink-0 whitespace-nowrap rounded-full border border-border bg-card px-3 py-1 text-xs transition-colors hover:bg-primary/10 hover:border-primary/40 disabled:opacity-50"
          >
            {p}
          </button>
        ))}
      </div>

        {/**
          * Dấu hiệu "còn nữa ở bên phải".
          *
          * Vệt mờ nói rằng hàng chip bị cắt chứ không kết thúc; mũi tên là nút
          * thật, bấm được — trên máy tính không có ngón tay để vuốt, và người
          * mới vào không đoán ra là kéo ngang được. Cả hai chỉ hiện khi THẬT SỰ
          * còn nội dung, nên chúng không thành đồ trang trí.
          */}
        {/**
          * KHÔNG dùng "hover-elevate" ở hai nút dưới đây.
          *
          * index.css dòng 280 đặt "position: relative" cho lớp đó, và nó thắng
          * "absolute" của Tailwind. Hậu quả không phải là lệch một chút: khi
          * phần tử đang ở chế độ relative thì "right-3" DỊCH nó sang trái 12px
          * thay vì neo vào mép phải. Đo trên màn hình thật: x = -12 và x = -36,
          * tức cả hai nút nằm ngoài màn hình, xếp chồng bên dưới hàng chip.
          *
          * Hai nút đã có hiệu ứng hover riêng nên không mất gì khi bỏ lớp đó.
          */}
        {conChipPhai && (
          <>
            <div className="pointer-events-none absolute bottom-2 right-0 top-0 w-16 bg-gradient-to-l from-background to-transparent" />
            <button
              type="button"
              onClick={() => chipScroller.current?.scrollBy({ left: 220, behavior: "smooth" })}
              data-testid="chip-scroll-right"
              aria-label={t(uiLang, "moreChips")}
              title={t(uiLang, "moreChips")}
              className="absolute right-9 top-0 flex h-[26px] w-[26px] items-center justify-center rounded-full border border-border bg-card text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
            >
              ›
            </button>
          </>
        )}
        <button
          type="button"
          onClick={() => doiChips(true)}
          data-testid="chip-hide"
          aria-label={t(uiLang, "hideChips")}
          title={t(uiLang, "hideChips")}
          className="absolute right-3 top-0 flex h-[26px] w-[26px] items-center justify-center rounded-full border border-border bg-card text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
        >
          ×
        </button>
      </div>
      )}

      {!micHintSeen && (
        <div className="mx-4 mb-1.5 flex shrink-0 items-center justify-end gap-2">
          <span className="rounded-full bg-primary/10 px-2.5 py-1 text-[11px] text-primary">
            {t(uiLang, "micHint")} ↓
          </span>
          <button
            onClick={dismissMicHint}
            className="text-[11px] text-muted-foreground underline underline-offset-2"
            data-testid="dismiss-mic-hint"
          >
            ✕
          </button>
        </div>
      )}
      <div className="shrink-0 border-t border-border p-3">
        <div className="flex items-end gap-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder={t(uiLang, "composer")}
            className="max-h-32 min-h-[42px] resize-none"
            data-testid="input-message"
          />
          <MicButton
            code={code}
            lang={detail?.guest.lang ?? "en"}
            disabled={send.isPending}
            /* Appended, not replaced: a guest who typed half a sentence and then
               spoke the rest should keep both. */
            onText={(text) => setDraft((d) => (d.trim() ? d.replace(/s*$/, " ") + text : text))}
          />
          <Button
            onClick={submit}
            disabled={!draft.trim() || send.isPending}
            size="icon"
            className="h-[42px] w-[42px] shrink-0"
            data-testid="button-send"
          >
            <SendHorizonal className="h-4 w-4" />
          </Button>
        </div>
        <p className="mt-1.5 text-[10px] text-muted-foreground">
          {t(uiLang, "footer")}
        </p>
      </div>
    </div>
  );
}
