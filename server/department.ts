/**
 * Which department should actually do this?
 *
 * The offline path escalates through one tool, `escalate_to_human`, and that
 * tool hardcoded `dept: "front_desk"`. So a guest reporting a broken air
 * conditioner, a leaking shower, a cold breakfast and a spa booking all
 * produced front-desk tasks: measured on the demo dataset, 46 of 46 tasks
 * landed in one department. "Workload by department" was therefore a chart of
 * one bar, and the engineer who should fix the air-con never saw it.
 *
 * WHY KEYWORDS HERE, when the sentiment classifier deliberately is not.
 *
 * Sentiment is a judgement about a person — sarcasm, understatement, an implied
 * complaint — and keyword lists measurably cannot represent it (they scored
 * 8.3% recall against 89.2% for a trained head). Which department owns a
 * broken shower is not a judgement, it is a vocabulary: the words for water,
 * air-conditioning, towels and massage are few, stable, and do not depend on
 * the guest's mood. A lexicon is the right tool and costs nothing.
 *
 * Vietnamese is matched with and without diacritics, because roughly a quarter
 * of Vietnamese guests type without them.
 */
import { fold } from "./retrieval";

export type Dept = "front_desk" | "housekeeping" | "fnb" | "engineering" | "spa";

/**
 * Ordered by specificity, not by importance: the first department whose
 * vocabulary appears wins, so "the air conditioning in my room is broken"
 * reaches engineering rather than housekeeping on the word "room".
 *
 * Written per department rather than per language, so adding a language means
 * appending words, never restructuring.
 */
const LEXICON: { dept: Dept; words: RegExp }[] = [
  {
    dept: "engineering",
    words:
      /điều ho[àa]|dieu hoa|máy lạnh|may lanh|vòi (?:sen|nước)|voi (?:sen|nuoc)|rò (?:rỉ|nước)|ro (?:ri|nuoc)|bồn cầu|bon cau|tắc|nghẹt|nghet|mất điện|mat dien|ổ cắm|o cam|bóng đèn|bong den|đèn (?:hỏng|không sáng)|den (?:hong|khong sang)|tivi|tv |wifi|internet|mạng (?:yếu|chậm)|mang (?:yeu|cham)|thang máy|thang may|nóng lạnh|nong lanh|air.?con|aircon|a\/c\b|heater|leak|leaking|drip|clogged|blocked drain|power (?:cut|outage)|socket|light ?bulb|not working|broken|エアコン|冷房|水漏れ|故障|テレビ|電気|에어컨|누수|고장|배수|전구|텔레비|空调|漏水|故障|电视|插座|灯泡|马桶|кондиционер|течёт|течет|протека|розетк|лампочк|телевизор|не работает|засор/iu,
  },
  {
    dept: "housekeeping",
    /**
     * `gối` (pillow) and `dầu gội` (shampoo) appear ACCENTED only, deliberately.
     *
     * Folded, `gối` becomes `goi` — which is also `gọi`, the verb in "gọi đồ
     * ăn", "gọi taxi", "gọi lễ tân". The unaccented entry `goi ` was in this
     * list and routed a room-service order to housekeeping, because almost
     * every Vietnamese service request contains that word. `dầu gội` has the
     * same problem against `đầu gối` (knee).
     *
     * The cost of dropping the unaccented forms is that an unaccented pillow
     * request falls through to front_desk, which forwards it. The cost of
     * keeping them was every "gọi ..." request in the language.
     */
    words:
      /dọn phòng|don phong|khăn (?:tắm|mặt)|khan (?:tam|mat)|ga giường|ga giuong|chăn|chan ga|gối|bẩn|ban thiu|vệ sinh|ve sinh|thay (?:ga|khăn|khan)|giấy vệ sinh|giay ve sinh|dầu gội|clean(?:ing)?|housekeep|towel|bed ?sheet|linen|pillow|dirty|tidy|amenit(?:y|ies)|toilet paper|掃除|清掃|タオル|シーツ|枕|汚れ|청소|수건|침구|베개|더러|打扫|清洁|毛巾|床单|枕头|脏|убор|убра|уберит|полотенц|бель[ёе]|подушк|гряз/iu,
  },
  {
    dept: "fnb",
    /* Room service is F&B's largest job and the vocabulary was missing it: a
       guest naming a dish ("2 phần phở bò") matched nothing here, so the order
       fell through to whichever department's words happened to collide. Dish
       names cannot be enumerated, but the ordering VERBS can. */
    words:
      /nhà hàng|nha hang|bữa (?:sáng|trưa|tối)|bua (?:sang|trua|toi)|ăn sáng|an sang|buffet|thực đơn|thuc don|món ăn|mon an|đồ ăn|do an|đặt bàn|dat ban|quầy bar|quay bar|đồ uống|do uong|(?:gọi|goi|order|mang|đem|dem)\s+(?:(?!lễ tân|le tan|nhân viên|nhan vien|bác sĩ|bac si|bảo vệ|bao ve|taxi)\S+\s+){0,6}(?:lên|len)\s+phòng|phục vụ tại phòng|phuc vu tai phong|room ?service|restaurant|breakfast|lunch|dinner|menu|dish|food|drink|bar\b|table for|レストラン|朝食|夕食|メニュー|料理|飲み物|ルームサービス|予約.*席|레스토랑|조식|메뉴|음식|음료|룸서비스|餐厅|早餐|晚餐|菜单|食物|饮料|送餐|订.*桌|ресторан|завтрак|ужин|меню|блюд|напит|стол(?:ик)?/iu,
  },
  {
    dept: "spa",
    words:
      /spa\b|mát ?xa|mat ?xa|massage|xông hơi|xong hoi|sauna|liệu trình|lieu trinh|trị liệu|tri lieu|akoya|facial|treatment|jacuzzi|マッサージ|スパ|サウナ|施術|마사지|스파|사우나|트리트먼트|按摩|水疗|桑拿|理疗|масса|спа|сауна|процедур/iu,
  },
];

/**
 * `text` should be what the guest actually wrote, not the agent's reply — the
 * reply is written in service language ("I have passed this to a colleague")
 * and contains none of the words that identify the work.
 *
 * Returns `front_desk` when nothing matches, which is the correct default: a
 * request nobody can categorise is exactly what a front desk is for.
 */
export function departmentFor(text: string | null | undefined): Dept {
  if (!text) return "front_desk";
  const folded = fold(text);
  for (const { dept, words } of LEXICON) {
    if (words.test(text) || words.test(folded)) return dept;
  }
  return "front_desk";
}
