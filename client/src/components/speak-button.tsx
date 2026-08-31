/**
 * "Read this to me" on a concierge reply.
 *
 * Renders NOTHING when the guest's device has no voice for the language of the
 * answer. That is the whole design: a button that speaks Japanese text through
 * an English voice produces noise, and a guest who taps it once learns the
 * feature is broken. Absent beats wrong.
 */
import { useEffect, useRef, useState } from "react";
import { Volume2, Square, Loader2 } from "lucide-react";
import { pickVoice, speak, speechSupported, stopSpeaking, voicesReady } from "@/lib/speech";

const LABEL: Record<string, { play: string; stop: string }> = {
  vi: { play: "Nghe câu trả lời", stop: "Dừng đọc" },
  en: { play: "Read aloud", stop: "Stop" },
  ko: { play: "읽어주기", stop: "중지" },
  ja: { play: "読み上げ", stop: "停止" },
  zh: { play: "朗读", stop: "停止" },
  ru: { play: "Озвучить", stop: "Стоп" },
};

/**
 * Server đọc được ngôn ngữ nào — hỏi MỘT lần cho cả trang.
 *
 * Không có bộ nhớ đệm này thì mỗi bong bóng câu trả lời gọi `/api/guest/voice`
 * một lần; một hội thoại bốn mươi lượt là bốn mươi yêu cầu cho cùng một câu trả
 * lời không đổi trong suốt phiên.
 */
let serverLangsCache: Promise<string[]> | null = null;
function serverTtsLangs(): Promise<string[]> {
  if (!serverLangsCache) {
    serverLangsCache = fetch("/api/guest/voice")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (j?.tts ? (j.ttsLangs ?? []) : []))
      .catch(() => []);
  }
  return serverLangsCache;
}

export function SpeakButton({ text, lang }: { text: string; lang: string }) {
  const [voice, setVoice] = useState<SpeechSynthesisVoice | null>(null);
  /** Server đọc được ngôn ngữ này không — dùng khi máy khách không có giọng. */
  const [serverCoGiong, setServerCoGiong] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [dangTai, setDangTai] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let alive = true;
    /* Resolved per mount rather than once at module load: the list is empty on
       the first call in every Chromium build (measured: 0, then 4). */
    voicesReady().then((v) => {
      if (alive) setVoice(pickVoice(v, lang));
    });
    serverTtsLangs().then((ls) => {
      if (alive) setServerCoGiong(ls.includes(lang));
    });
    return () => {
      alive = false;
    };
  }, [lang]);

  /**
   * Còn gắn trên màn hình hay không.
   *
   * Chỉ `pause()` trong cleanup là chưa đủ, và khoảng hở không nhỏ: giữa lúc
   * bấm và lúc có tiếng là toàn bộ thời gian tổng hợp — đo được **20 giây** cho
   * một câu trả lời tiếng Nhật. Trong khoảng đó `audioRef.current` vẫn là
   * `null`, nên cleanup không có gì để dừng; rồi `fetch` trả về, `new Audio()`
   * được tạo và `play()` chạy trên một component đã bị gỡ — khách đã rời trang
   * mà tiếng vẫn phát, không còn nút nào để tắt.
   *
   * Cờ này là thứ duy nhất còn sống sau khi cleanup chạy, nên nó là chỗ đúng
   * để chặn.
   */
  const alive = useRef(true);

  /* Stop when this message leaves the screen, or a guest scrolling away keeps
     hearing an answer they have moved on from. */
  useEffect(
    () => () => {
      alive.current = false;
      stopSpeaking();
      /* Audio của server không đi qua `speechSynthesis`, nên `stopSpeaking()`
         không chạm tới nó. Thiếu dòng này thì khách cuộn đi và vẫn nghe tiếp. */
      audioRef.current?.pause();
      audioRef.current = null;
    },
    [],
  );

  /**
   * ƯU TIÊN MODEL CỦA MÁY CHỦ. Giọng thiết bị là lưới đỡ.
   *
   * Trước đây ngược lại — `!voice && serverCoGiong` — nên Piper chỉ chạy khi
   * thiết bị không có giọng. Đo trên máy demo: bấm nút loa gọi
   * `speechSynthesis` 1 lần và gọi máy chủ 0 lần, vì Windows có sẵn Microsoft
   * An cho tiếng Việt. Model 413 MB nằm im, và mỗi khách nghe một giọng khác
   * nhau tuỳ máy họ cầm.
   *
   * Đảo lại vì đây là sản phẩm bán cho khách sạn, không phải tiện ích cá nhân:
   *   · Giọng đồng nhất trên mọi thiết bị. Khách sạn nghe thử trên iPad ở sảnh
   *     rồi ký hợp đồng, thì khách dùng iPhone phải nghe đúng giọng đó.
   *   · Kiểm soát được chất lượng. Giọng thiết bị là hộp đen của Apple/Google,
   *     có thể đổi sau một bản cập nhật hệ điều hành mà không ai báo.
   *   · Chạy hoàn toàn ngoại tuyến trên máy khách sạn — cùng lời hứa với STT.
   *
   * Cái giá là thật và đã đo: ~1,3 giây mỗi câu, RTF 0,34–0,46 trên CPU này,
   * cộng thêm tải lên chính máy đang chạy model trả lời. Vì vậy vẫn giữ đường
   * lui: ngôn ngữ máy chủ không đọc được (tiếng Nhật — giọng Piper duy nhất
   * cho ja phát âm sai vì thiếu OpenJTalk), hoặc lệnh gọi hỏng, thì rơi về
   * giọng thiết bị thay vì im lặng.
   */
  const dungServer = serverCoGiong;
  const coDuongLui = speechSupported() && !!voice;
  if (!dungServer && !coDuongLui) return null;
  const l = LABEL[lang] ?? LABEL.en;

  const phatTuServer = async () => {
    setSpeaking(true);
    /* Piper mất ~1,3 giây cho một câu. Giọng thiết bị phát ngay, nên trước đây
       không cần trạng thái chờ; giờ máy chủ là đường chính, và một nút bấm rồi
       im lặng hơn một giây đọc như nút hỏng. */
    setDangTai(true);
    try {
      const r = await fetch("/api/guest/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, lang }),
      });
      if (!r.ok) throw new Error(String(r.status));
      const blob = await r.blob();
      /* Khách đã rời đi trong lúc chờ tổng hợp. Không tạo audio, không phát,
         và không rơi về giọng thiết bị — im lặng mới là điều họ muốn. */
      if (!alive.current) return;
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      audioRef.current = a;
      /* Thu hồi URL khi xong, dù kết thúc bình thường hay lỗi: mỗi blob giữ
         nguyên bộ nhớ cho tới khi được thu hồi. */
      a.onplaying = () => setDangTai(false);
      const xong = () => {
        setDangTai(false);
        URL.revokeObjectURL(url);
        audioRef.current = null;
        setSpeaking(false);
      };
      a.onended = xong;
      a.onerror = xong;
      await a.play();
    } catch {
      /**
       * Máy chủ hỏng thì rơi về giọng thiết bị, không im lặng.
       *
       * Trước đây nhánh này chỉ `setSpeaking(false)`: khách bấm nút, không có
       * gì phát ra, không có lời giải thích. Khi máy chủ còn là lưới đỡ thì
       * hiếm khi chạm tới; giờ máy chủ là đường chính nên nó là đường mà một
       * tiến trình Piper chết, một câu quá dài, hay một lần khởi động lại
       * giữa chừng sẽ đi qua — và những chuyện đó xảy ra thật (đã gặp
       * `Piper lỗi 3221225794` từ một tiến trình server cũ).
       */
      setDangTai(false);
      /* Cùng lý do như trên: hỏng SAU khi khách rời đi thì không được rơi về
         giọng thiết bị, nếu không lỗi máy chủ lại thành tiếng nói ở một trang
         khách không còn xem. */
      if (coDuongLui && alive.current) {
        speak(text, voice!, { onEnd: () => setSpeaking(false) });
        return;
      }
      setSpeaking(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => {
        if (speaking) {
          stopSpeaking();
          audioRef.current?.pause();
          audioRef.current = null;
          setSpeaking(false);
          setDangTai(false);
          return;
        }
        if (dungServer) {
          void phatTuServer();
          return;
        }
        setSpeaking(true);
        speak(text, voice!, { onEnd: () => setSpeaking(false) });
      }}
      /* Cho biết giọng nào đang thật sự phát. Hai lần sai trước đó: đọc tên
         giọng thiết bị kể cả khi máy chủ mới là bên đọc, rồi ghi "Piper" cho
         cả tiếng Nhật — mà tiếng Nhật chạy Kokoro, không phải Piper. */
      title={`${speaking ? l.stop : l.play} · ${
        dungServer ? (lang === "ja" ? "giọng máy chủ (Kokoro)" : "giọng máy chủ (Piper)") : (voice?.name ?? "giọng thiết bị")
      }`}
      aria-label={speaking ? l.stop : l.play}
      data-testid="button-speak"
      className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {dangTai ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : speaking ? (
        <Square className="h-3.5 w-3.5" />
      ) : (
        <Volume2 className="h-3.5 w-3.5" />
      )}
    </button>
  );
}
