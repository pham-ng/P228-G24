/**
 * Gieo những lượt trao đổi TÍCH CỰC vào dữ liệu demo, rồi để hệ thống tự chấm.
 *
 * Vì sao cần: bảng điều khiển đang 15 âm / 8 trung tính / **0 tích cực**, nên
 * nhìn như một khách sạn đang cháy. Dữ liệu mẫu chỉ gồm ca khiếu nại vì đó là
 * ca thú vị để dựng, không phải vì đó là thứ hay xảy ra.
 *
 * ĐIỀU QUAN TRỌNG: script này **không gán nhãn tay**. Nó chỉ thêm tin nhắn, rồi
 * gọi `analyseConversation()` — đúng bộ phân loại mà sản phẩm dùng thật — để tự
 * quyết nhãn. Gán "positive" bằng tay sẽ cho một bảng điều khiển đẹp mà không
 * ai kiểm chứng được, và đó là kiểu số liệu sụp đổ ngay câu hỏi đầu tiên của
 * người mua.
 *
 * Hệ quả: nếu bộ phân loại vẫn đọc ra "negative" thì nhãn vẫn là negative. Đó
 * là câu trả lời trung thực, và cũng là phép thử cho chính bộ phân loại.
 *
 * Lưu ý về bộ phân loại nhanh cục bộ (`sentiment-net`): nó **nhị phân** —
 * negative hoặc neutral, không có positive. Chỉ đường LLM
 * (`analyseConversation`) mới gán được positive. Nên bảng điều khiển chỉ có
 * cột tích cực khi đường LLM đã chạy.
 *
 *   npx tsx scripts/seed-positive.ts --dry     # xem sẽ thêm gì
 *   npx tsx scripts/seed-positive.ts
 */
import "dotenv/config";
import { storage, nowIso } from "../server/storage";
import { analyseConversation } from "../server/agent";

const dry = process.argv.includes("--dry");

/** Lượt khen thuần — cho hội thoại đang trung tính. */
const KHEN: Record<string, { guest: string; ai: string }[]> = {
  vi: [
    {
      guest: "Bữa sáng ở Lotus ngon lắm em ơi, nhân viên phục vụ cũng rất dễ thương.",
      ai: "Dạ em cảm ơn anh/chị nhiều ạ! Em sẽ chuyển lời khen tới bộ phận nhà hàng. Chúc anh/chị có một ngày thật đẹp tại resort ạ.",
    },
    {
      guest: "Phòng sạch sẽ, view biển đúng như hình. Rất hài lòng.",
      ai: "Dạ em rất vui khi nghe vậy ạ. Nếu anh/chị cần thêm bất cứ điều gì trong kỳ nghỉ, em luôn sẵn sàng hỗ trợ.",
    },
    {
      guest: "Cảm ơn em đã tư vấn tour đảo hôm qua, cả nhà đi rất vui.",
      ai: "Dạ em cảm ơn anh/chị đã chia sẻ ạ! Em rất mừng vì chuyến đi suôn sẻ. Anh/chị cần em đặt thêm hoạt động nào nữa không ạ?",
    },
  ],
  en: [
    {
      guest: "The spa treatment yesterday was excellent — please pass on my thanks to the therapist.",
      ai: "Thank you so much for letting us know. I will pass your compliment on to the Akoya Spa team. Do let me know if there is anything else I can arrange for you.",
    },
    {
      guest: "Check-in was quick and the room is lovely. Really enjoying our stay.",
      ai: "That is wonderful to hear, thank you. Please do not hesitate to reach out if you need anything at all during your stay.",
    },
  ],
  ja: [
    {
      guest: "朝食がとても美味しかったです。スタッフの対応も丁寧でした。",
      ai: "温かいお言葉をありがとうございます。レストランのスタッフに必ずお伝えいたします。どうぞごゆっくりお過ごしくださいませ。",
    },
  ],
  ko: [
    {
      guest: "수영장이 정말 깨끗하고 좋았어요. 감사합니다.",
      ai: "좋게 봐주셔서 감사합니다. 담당 부서에 칭찬 전달하겠습니다. 필요하신 것이 있으면 언제든 말씀해 주세요.",
    },
  ],
  zh: [
    {
      guest: "房间很干净，海景也很棒，非常满意。",
      ai: "非常感谢您的肯定！我们会把您的赞美转达给相关部门。如有任何需要，请随时告诉我。",
    },
  ],
  ru: [
    {
      guest: "Спасибо за помощь с трансфером, всё прошло отлично.",
      ai: "Благодарим вас за отзыв! Рады, что всё прошло гладко. Обращайтесь, если понадобится что-то ещё.",
    },
  ],
};

/**
 * Lượt KẾT THÚC TỐT — cho hội thoại bắt đầu bằng khiếu nại.
 *
 * Đây là mẫu có thật ở khách sạn: khách phàn nàn, bộ phận xử lý, khách hài
 * lòng. Bỏ qua nó thì dữ liệu demo chỉ còn khiếu nại chưa giải quyết, mà đó
 * không phải bức tranh của một khách sạn đang vận hành tốt.
 */
const GIAI_QUYET: Record<string, { guest: string; ai: string }[]> = {
  vi: [
    {
      guest: "Bộ phận kỹ thuật lên xử lý nhanh lắm, giờ ổn rồi. Cảm ơn em nhé.",
      ai: "Dạ em cảm ơn anh/chị đã kiên nhẫn ạ. Em rất mừng vì sự việc đã được xử lý. Nếu còn bất cứ vấn đề gì, anh/chị nhắn em ngay nhé.",
    },
    {
      guest: "Lễ tân đã đổi phòng cho gia đình tôi, phòng mới rất ổn. Cảm ơn resort.",
      ai: "Dạ em rất vui vì anh/chị đã hài lòng với phòng mới ạ. Em xin lỗi vì sự bất tiện lúc đầu, và cảm ơn anh/chị đã cho chúng em cơ hội khắc phục.",
    },
  ],
  en: [
    {
      guest: "The team sorted it out within the hour. Thanks for following up so quickly.",
      ai: "Thank you for your patience, and I am glad it is resolved. Please reach out any time if anything else comes up during your stay.",
    },
  ],
  ko: [
    {
      guest: "빠르게 처리해 주셔서 감사합니다. 지금은 문제없습니다.",
      ai: "기다려 주셔서 감사합니다. 해결되어 다행입니다. 다른 불편한 점이 있으시면 언제든 알려 주세요.",
    },
  ],
  zh: [
    {
      guest: "问题已经解决了，处理得很快，谢谢。",
      ai: "感谢您的耐心等待，很高兴问题已经解决。如还有任何需要，请随时联系我。",
    },
  ],
  ru: [
    {
      guest: "Вопрос решили быстро, спасибо за оперативность.",
      ai: "Спасибо за терпение, рады, что всё решилось. Обращайтесь, если понадобится помощь.",
    },
  ],
  ja: [
    {
      guest: "すぐに対応していただき、ありがとうございました。もう問題ありません。",
      ai: "お待たせして申し訳ございませんでした。解決できて安心いたしました。何かございましたらいつでもお申し付けください。",
    },
  ],
};

const pick = <T,>(bang: Record<string, T[]>, lang: string, i: number): T | null => {
  const ds = bang[lang] ?? bang.vi;
  return ds.length ? ds[i % ds.length] : null;
};

async function main() {
  const convs = storage
    .listConversations()
    .map((c) => ({ c, g: storage.getGuest(c.guestId) }))
    .filter((x) => !!x.g);

  /* Chọn hội thoại nào: mọi hội thoại trung tính (thêm lời khen thuần), và một
     nửa số âm (thêm đoạn kết đã giải quyết). Giữ lại một phần âm — một bảng
     điều khiển không còn ca âm nào là một bảng không ai tin. */
  /**
   * Bỏ qua hội thoại ĐÃ được gieo ở lượt trước.
   *
   * Không có chốt này thì chạy lần hai sẽ chồng thêm một lời cảm ơn nữa lên
   * cùng một hội thoại — khách cảm ơn hai lần liên tiếp về hai chuyện khác
   * nhau, và bản ghi trông giả ngay từ cái nhìn đầu tiên.
   */
  const daGieo = (id: number) => {
    const cuoi = storage.listMessages(id).slice(-6).map((m) => m.body).join(" ");
    return /cảm ơn em nhé|đã đổi phòng cho gia đình|pass on my thanks|sorted it out|처리해 주셔서|已经解决|решили быстро|対応していただき|ngon lắm em ơi|view biển đúng như hình|tư vấn tour đảo/i.test(cuoi);
  };

  const trungTinh = convs.filter((x) => x.c.sentiment === "neutral" && !daGieo(x.c.id));
  const am = convs.filter((x) => x.c.sentiment === "negative" && !daGieo(x.c.id));
  const amCanSua = am.slice(0, Math.ceil((am.length * 2) / 3));

  const viec: { id: number; loai: string; guest: string; ai: string; ten: string }[] = [];
  trungTinh.forEach((x, i) => {
    const m = pick(KHEN, x.g!.lang, i);
    if (m) viec.push({ id: x.c.id, loai: "khen", ...m, ten: x.g!.name });
  });
  amCanSua.forEach((x, i) => {
    const m = pick(GIAI_QUYET, x.g!.lang, i);
    if (m) viec.push({ id: x.c.id, loai: "đã giải quyết", ...m, ten: x.g!.name });
  });

  console.log(`sẽ thêm ${viec.length} lượt trao đổi:`);
  for (const v of viec) console.log(`  #${String(v.id).padEnd(4)} ${v.loai.padEnd(14)} ${v.ten}`);
  console.log(`giữ nguyên ${am.length - amCanSua.length} hội thoại âm — bảng không còn ca âm nào là bảng không ai tin.`);

  if (dry) {
    console.log("\n--dry: không ghi gì.");
    return;
  }

  for (const v of viec) {
    const t = nowIso();
    storage.addMessage({
      conversationId: v.id,
      role: "guest",
      authorName: null,
      body: v.guest,
      toolTrace: null,
      latencyMs: null,
      createdAt: t,
    });
    storage.addMessage({
      conversationId: v.id,
      role: "ai",
      authorName: "VinAurea",
      body: v.ai,
      toolTrace: null,
      latencyMs: 0,
      createdAt: t,
    });
    storage.updateConversation(v.id, { lastMessageAt: t });
  }
  console.log(`\nđã thêm ${viec.length * 2} tin nhắn. Giờ để HỆ THỐNG tự chấm lại…`);

  let doi = 0;
  for (const v of viec) {
    const truoc = storage.getConversation(v.id)!.sentiment;
    try {
      await analyseConversation(v.id);
    } catch (e: any) {
      console.log(`  #${v.id} chấm lỗi: ${e?.message ?? e}`);
      continue;
    }
    const sau = storage.getConversation(v.id)!.sentiment;
    if (truoc !== sau) doi++;
    console.log(`  #${String(v.id).padEnd(4)} ${truoc} → ${sau}`);
  }

  const all = storage.listConversations();
  console.log(`\n${doi}/${viec.length} hội thoại đổi nhãn. Bảng điều khiển giờ:`);
  for (const s of ["positive", "neutral", "negative"])
    console.log(`  ${s.padEnd(10)} ${all.filter((c) => c.sentiment === s).length}`);
}
main();
