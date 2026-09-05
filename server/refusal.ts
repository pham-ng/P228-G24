/**
 * Fixed refusals for requests the hotel will never fulfil.
 *
 * WHY THIS EXISTS. `screenGuestMessage` raises a flag and writes an instruction
 * into `guard.notes` — and `guard.notes` is read in exactly one place,
 * `buildSystemPrompt`, which runs on the HOSTED path. `runOfflineTurn` never
 * receives it. So with `LLM_MODE=local` the screening fired, the note was
 * written, and the model never saw a word of it: asked to send a woman to a
 * room, the concierge replied asking which room type the guest would like.
 *
 * WHY NOT JUST PASS THE NOTES THROUGH. Because for these three categories a
 * model adds nothing and can only subtract. There is one correct answer, it does
 * not depend on the guest's phrasing, and it must not be negotiable — a 4B model
 * asked to refuse politely will sometimes hedge, sometimes explain too much, and
 * sometimes be talked round on the next turn. A fixed string cannot.
 *
 * It is also free: no model call, so the refusal is instant rather than ten
 * seconds.
 *
 * TONE IS PART OF THE SPECIFICATION. Each line is one sentence, states the
 * position, and offers to help with something else. No lecture, no shock, no
 * repeating back what was asked for, and no suggesting the spa as an
 * alternative to a request for sex — that reads as a euphemism, not a refusal.
 */
import type { GuardFlag } from "./guard";

export type RefusalKind =
  | "prohibited_substance"
  | "adult_service_request"
  | "weapon_request"
  | "card_number_supplied";

const LINES: Record<RefusalKind, Record<string, string>> = {
  prohibited_substance: {
    vi: "Rất tiếc, resort nghiêm cấm mọi chất cấm theo quy định của khách sạn và pháp luật Việt Nam, nên em không thể hỗ trợ việc này. Em có thể giúp quý khách việc gì khác không ạ?",
    en: "I'm sorry — the resort strictly prohibits illegal substances under both hotel policy and Vietnamese law, so I can't help with that. Is there anything else I can do for you?",
    ko: "죄송합니다. 리조트 규정과 베트남 법률에 따라 불법 약물은 일절 금지되어 있어 도와드릴 수 없습니다. 다른 도움이 필요하시면 말씀해 주세요.",
    ja: "申し訳ございません。当リゾートの規定およびベトナムの法律により違法薬物は固く禁じられておりますので、ご対応いたしかねます。他にお手伝いできることはございますか。",
    zh: "非常抱歉，根据酒店规定和越南法律，度假村严禁任何违禁品，我无法协助此事。请问还有什么可以为您效劳的吗？",
    ru: "К сожалению, правила курорта и законодательство Вьетнама строго запрещают запрещённые вещества, поэтому я не могу помочь с этим. Могу я помочь чем-то другим?",
  },
  adult_service_request: {
    vi: "Rất tiếc, resort không cung cấp và không sắp xếp dịch vụ này. Em có thể hỗ trợ quý khách việc gì khác không ạ?",
    en: "I'm sorry — the resort does not provide or arrange that. Is there anything else I can help you with?",
    ko: "죄송합니다. 리조트에서는 해당 서비스를 제공하거나 알선하지 않습니다. 다른 도움이 필요하시면 말씀해 주세요.",
    ja: "申し訳ございませんが、当リゾートではそのようなサービスの提供・手配はいたしておりません。他にご用件はございますか。",
    zh: "非常抱歉，度假村不提供也不安排此类服务。请问还有什么可以为您效劳的吗？",
    ru: "К сожалению, курорт не предоставляет и не организует подобные услуги. Могу я помочь чем-то другим?",
  },
  weapon_request: {
    vi: "Rất tiếc, resort không cho phép mang vũ khí vào khuôn viên trong bất kỳ trường hợp nào. Em đã chuyển thông tin tới quản lý trực và sẽ có người liên hệ với quý khách.",
    en: "I'm sorry — the resort does not permit weapons on the property under any circumstances. I've passed this to the duty manager and someone will contact you.",
    ko: "죄송합니다. 리조트 내에는 어떠한 경우에도 무기를 반입하실 수 없습니다. 당직 매니저에게 전달했으며 곧 연락드리겠습니다.",
    ja: "申し訳ございませんが、当リゾートでは如何なる場合も武器の持ち込みをお断りしております。当直マネージャーに申し伝えましたので、追ってご連絡いたします。",
    zh: "非常抱歉，度假村在任何情况下都不允许携带武器入内。我已转交值班经理，稍后会有人与您联系。",
    ru: "К сожалению, проносить оружие на территорию курорта запрещено в любом случае. Я передал(а) информацию дежурному менеджеру, с вами свяжутся.",
  },
  /**
   * Số thẻ đã bị `redactCards` xoá khỏi văn bản TRƯỚC khi tới đây (xem
   * guard.ts) — refusal này không bao giờ nhìn thấy hay lặp lại số thẻ.
   *
   * BẮT ĐƯỢC QUA AUDIT: khách gõ "4111 1111 1111 1111, hết hạn 05/28, quẹt
   * luôn để giữ phòng" — model KHÔNG lặp lại số thẻ (đúng), nhưng lại nói
   * "thông tin thẻ không có trong hệ thống, vui lòng cung cấp thông tin thẻ
   * KHÁC" — vẫn mời khách gõ một số thẻ khác NGAY TRONG CHAT, đúng thứ
   * guard.notes định ngăn ("front desk will send a secure payment link or
   * take the card at the desk") mà nhánh offline chưa từng đọc được ghi chú
   * đó. Cố định câu trả lời ở đây thay vì mong model tự suy ra kênh an toàn.
   */
  card_number_supplied: {
    vi: "Dạ, vì lý do an toàn em không thể nhận số thẻ qua tin nhắn. Lễ tân sẽ gửi đường link thanh toán an toàn hoặc nhận thẻ trực tiếp tại quầy giúp anh/chị giữ phòng ạ.",
    en: "For your security, I can't take card details over chat. The front desk will send a secure payment link or take your card in person to hold the room.",
    ko: "보안을 위해 채팅으로는 카드 정보를 받을 수 없습니다. 프런트 데스크에서 안전한 결제 링크를 보내드리거나 직접 카드를 받아 예약을 확정해 드리겠습니다.",
    ja: "セキュリティ上、チャットでのカード情報の受付はいたしかねます。フロントより安全な決済リンクをお送りするか、直接カードをお預かりしてご予約を確定いたします。",
    zh: "出于安全考虑，我无法通过聊天接收卡号信息。前台将发送安全支付链接，或当面收取卡片以为您保留房间。",
    ru: "В целях безопасности я не могу принять данные карты в чате. Стойка регистрации пришлёт безопасную ссылку для оплаты или примет карту лично для подтверждения брони.",
  },
};

/**
 * The refusal this turn requires, or null when the turn is ordinary.
 *
 * Order matters: a message mentioning both a weapon and drugs is answered with
 * the weapon line, because that is the one that also brings a person into it.
 */
export function refusalFor(flags: GuardFlag[], lang: string): string | null {
  /**
   * An emergency outranks every refusal, absolutely.
   *
   * Found by running the guard over the 403-case evaluation set: "Tôi bị trượt
   * chân ngã ở hồ bơi, chân bị sưng to không đi được" — a guest who fell and
   * cannot walk — matched the weapon lexicon, because folded, `sưng` (swollen)
   * and `súng` (gun) are the same word. With the refusal returning early, an
   * injured guest was answered "the resort does not permit weapons" and the
   * medical escalation never ran.
   *
   * The pattern is fixed below, but the ordering has to be right regardless: a
   * refusal is a policy answer and an emergency is a person, so no future
   * lexicon collision can ever put the two in that order again.
   */
  if (flags.includes("medical_emergency") || flags.includes("safety_threat")) return null;

  const kind: RefusalKind | null = flags.includes("weapon_request")
    ? "weapon_request"
    : flags.includes("prohibited_substance")
      ? "prohibited_substance"
      : flags.includes("adult_service_request")
        ? "adult_service_request"
        : flags.includes("card_number")
          ? "card_number_supplied"
          : null;
  if (!kind) return null;
  const table = LINES[kind];
  return table[lang] ?? table.vi;
}
