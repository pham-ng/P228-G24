/**
 * Lời chào — trả lời cố định, không đi qua model.
 *
 * VÌ SAO PHẢI CỐ ĐỊNH
 *
 * "xin chào" không có gì để tra cứu. Nhưng nó vẫn đi vào luồng knowledge, và
 * truy xuất luôn trả về năm đoạn nào đó — đo được: giờ nhà hàng, nội quy nhà,
 * chính sách trẻ em — với `topScore` 0,0082, tức đúng sàn RRF, tức vô nghĩa.
 * Rồi model 4B được yêu cầu chào khách dựa trên tài liệu nội quy.
 *
 * Nó ứng biến, và ứng biến sai:
 *
 *   "xin chào" → "Chào bạn, tôi là lễ tân của khách sạn.
 *                 **Bạn có thể hỗ trợ tôi** về những vấn đề nào?"
 *
 * Trợ lý mời khách giúp đỡ mình. Đây là câu đầu tiên khách nghe thấy, và nó
 * hỏng ở đúng chỗ không được phép hỏng — vai vế.
 *
 * Một lời chào có đúng một câu trả lời đúng. Chạy nó qua truy xuất và một model
 * 4B tốn tám giây để nhận về một câu mà mỗi lần một khác, và thỉnh thoảng đảo
 * vai. Cùng lập luận với `refusal.ts` và `clarify.ts`: chỗ nào chỉ có một câu
 * trả lời đúng thì đừng để model đoán.
 *
 * HẸP CÓ CHỦ ĐÍCH. Chỉ bắt lời chào TRỐNG. "Chào em, mấy giờ ăn sáng?" có câu
 * hỏi bên trong nên đi tiếp như thường — chào rồi bỏ mất câu hỏi còn tệ hơn.
 */
import { fold } from "./retrieval";

export type GreetLang = "vi" | "en" | "ko" | "ja" | "zh" | "ru";

/**
 * Danh sách lời chào, viết ở dạng tự nhiên rồi ĐEM FOLD luôn.
 *
 * Viết sẵn dạng đã bỏ dấu là mời lỗi: `fold("Здравствуйте")` cho
 * `"здравствуите"` — chữ `й` bị tách và mất dấu trăng — nên một mục viết tay
 * `"здравствуйте"` không bao giờ khớp, và lời chào tiếng Nga rơi thẳng vào
 * model. Fold cả hai vế bằng cùng một hàm thì không thể lệch.
 */
const RAW_GREETINGS = [
  "xin chao", "chao ban", "chao em", "chao anh", "chao chi", "chao", "alo",
  "hello", "hi", "hey", "good morning", "good afternoon", "good evening",
  "안녕하세요", "안녕", "こんにちは", "こんばんは", "おはよう", "もしもし",
  "你好", "您好", "早上好", "晚上好",
  "здравствуйте", "привет", "добрый день", "добрый вечер",
];

const GREETINGS = RAW_GREETINGS.map((g) => fold(g));

/**
 * Ký tự cho thấy còn có một câu hỏi kèm theo.
 *
 * Dấu hỏi là tín hiệu rõ nhất, nhưng tiếng Việt hay hỏi mà không có dấu hỏi
 * ("chào em cho anh hỏi mấy giờ ăn sáng"), nên bắt cả từ để hỏi.
 */
const HAS_QUESTION =
  /[?？]|\b(may gio|bao nhieu|o dau|the nao|khi nao|co the|cho hoi|muon|can|lam sao|what|when|where|how|why|can i|do you|is there)\b/i;

const REPLY: Record<GreetLang, string> = {
  vi: "Dạ em chào anh/chị, em là trợ lý của khách sạn ạ. Em có thể giúp anh/chị tra giờ mở cửa các tiện ích, thực đơn và giá nhà hàng, chính sách nhận/trả phòng, hoặc chuyển yêu cầu tới bộ phận phù hợp. Anh/chị cần em hỗ trợ điều gì ạ?",
  en: "Hello, I am the hotel assistant. I can look up opening hours, restaurant menus and prices, check-in and check-out policies, or pass a request to the right department. How may I help you?",
  ko: "안녕하세요, 호텔 어시스턴트입니다. 시설 운영 시간, 레스토랑 메뉴와 가격, 체크인·체크아웃 규정을 안내해 드리거나 요청 사항을 담당 부서로 전달해 드릴 수 있습니다. 무엇을 도와드릴까요?",
  ja: "いらっしゃいませ。ホテルのアシスタントでございます。施設の営業時間、レストランのメニューと料金、チェックイン・チェックアウトのご案内、また各部門へのお取り次ぎも承ります。どのようなご用件でしょうか。",
  zh: "您好，我是酒店智能助理。我可以为您查询各设施的开放时间、餐厅菜单与价格、入住和退房政策，也可以将您的需求转交给相应部门。请问需要什么帮助？",
  ru: "Здравствуйте, я ассистент отеля. Могу подсказать часы работы, меню и цены ресторанов, правила заезда и выезда, а также передать вашу просьбу в нужную службу. Чем могу помочь?",
};

/**
 * Câu này có phải một lời chào trống không.
 *
 * Trả `null` với mọi thứ còn lại, kể cả lời chào có kèm câu hỏi — im lặng ở
 * đây chỉ tốn một lượt gọi model, còn nhận nhầm thì nuốt mất câu hỏi của khách.
 */
export function greetingReply(text: string, lang: GreetLang = "vi"): string | null {
  const raw = text.trim();
  if (!raw || raw.length > 40) return null;

  const f = fold(raw).replace(/[.,!…~]+/g, " ").replace(/\s+/g, " ").trim();
  if (!f) return null;
  if (HAS_QUESTION.test(f) || HAS_QUESTION.test(raw)) return null;

  /* Toàn bộ câu phải là lời chào, không chỉ bắt đầu bằng nó: "chào em" đúng,
     "chao gia phong deluxe" thì không. */
  const hit = GREETINGS.some((g) => f === g || f === `${g} a` || f === `${g} ạ`);
  if (!hit) return null;

  return REPLY[lang] ?? REPLY.en;
}
