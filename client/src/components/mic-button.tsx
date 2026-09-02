import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Mic, Square, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { startRecording, recordingSupported, type Recorder } from "@/lib/record";
import type { SpeechLang } from "@/lib/speech";

/**
 * Speak instead of typing.
 *
 * The transcript is put in the COMPOSER, never sent. Recognition on four
 * seconds of Vietnamese is good but not right: measured on this stack,
 * "trả phòng muộn" came back as "trả phòng nguyện". A guest can see and fix
 * that in the box; they cannot unsay it once it is a request the hotel has
 * acted on. The same reasoning as the approval gate — a machine's reading of an
 * instruction gets one human check before it becomes an instruction.
 *
 * The button is absent, not disabled, when the server has no model on disk or
 * the browser cannot record. A disabled control asks the guest to wonder what
 * they did wrong; the same rule the speak button follows for missing voices.
 */

type VoiceCaps = { stt: boolean; maxSeconds: number; sampleRate: number };

const LABELS: Record<SpeechLang, { idle: string; rec: string; work: string; fail: string; empty: string }> = {
  vi: {
    idle: "Nói thay vì gõ",
    rec: "Đang nghe — bấm để dừng",
    work: "Đang nhận dạng…",
    fail: "Chưa nhận được, anh/chị thử lại hoặc gõ giúp em ạ",
    empty: "Em chưa nghe rõ, anh/chị nói lại giúp em ạ",
  },
  en: {
    idle: "Speak instead of typing",
    rec: "Listening — tap to stop",
    work: "Transcribing…",
    fail: "That did not come through. Try again, or type it.",
    empty: "I did not catch that — could you say it again?",
  },
  ko: {
    idle: "말로 입력하기",
    rec: "듣는 중 — 눌러서 정지",
    work: "인식 중…",
    fail: "인식되지 않았습니다. 다시 시도하시거나 입력해 주세요.",
    empty: "잘 들리지 않았습니다. 다시 말씀해 주시겠어요?",
  },
  ja: {
    idle: "話して入力",
    rec: "聞いています — タップで停止",
    work: "認識中…",
    fail: "うまく聞き取れませんでした。もう一度お試しいただくか、入力してください。",
    empty: "聞き取れませんでした。もう一度お願いできますか。",
  },
  zh: {
    idle: "语音输入",
    rec: "正在聆听 — 点击停止",
    work: "识别中…",
    fail: "没有识别成功，请重试或直接输入。",
    empty: "没有听清，能再说一次吗？",
  },
  ru: {
    idle: "Говорите вместо ввода",
    rec: "Слушаю — нажмите, чтобы остановить",
    work: "Распознаю…",
    fail: "Не удалось распознать. Попробуйте ещё раз или напишите.",
    empty: "Я не расслышал — повторите, пожалуйста.",
  },
};

export function MicButton({
  code,
  lang,
  onText,
  disabled,
}: {
  /** The guest's confirmation code — the credential the endpoint checks. */
  code: string;
  /** The guest profile language, as a plain string like the speak button takes. */
  lang: string;
  /** Called with the transcript, for the composer to show and the guest to edit. */
  onText: (text: string) => void;
  disabled?: boolean;
}) {
  const { data: caps } = useQuery<VoiceCaps>({
    queryKey: ["/api/guest/voice"],
    /* Whether the weights are on disk does not change during a conversation. */
    staleTime: Infinity,
  });

  const [state, setState] = useState<"idle" | "recording" | "working">("idle");
  const [note, setNote] = useState("");
  const [level, setLevel] = useState(0);
  const rec = useRef<Recorder | null>(null);
  const frame = useRef<number>(0);

  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      rec.current?.cancel();
    },
    [],
  );

  const sttLang: SpeechLang = (lang in LABELS ? lang : "en") as SpeechLang;
  const t = LABELS[sttLang];
  if (!caps?.stt || !recordingSupported()) return null;

  const pump = () => {
    setLevel(rec.current?.level() ?? 0);
    frame.current = requestAnimationFrame(pump);
  };

  async function begin() {
    setNote("");
    try {
      rec.current = await startRecording(caps!.maxSeconds);
      setState("recording");
      frame.current = requestAnimationFrame(pump);
    } catch {
      setNote(t.fail);
      setState("idle");
    }
  }

  async function finish() {
    cancelAnimationFrame(frame.current);
    setLevel(0);
    const r = rec.current;
    rec.current = null;
    if (!r) return setState("idle");

    setState("working");
    try {
      const wav = await r.stop();
      if (!wav) {
        setNote(t.empty);
        return setState("idle");
      }
      const res = await fetch(
        `/api/guest/transcribe?code=${encodeURIComponent(code)}&lang=${encodeURIComponent(sttLang)}`,
        { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        setNote(body.message ?? t.fail);
        return setState("idle");
      }
      const out = (await res.json()) as { text: string };
      if (!out.text.trim()) setNote(t.empty);
      else onText(out.text.trim());
    } catch {
      setNote(t.fail);
    } finally {
      setState("idle");
    }
  }

  const recording = state === "recording";
  const working = state === "working";

  return (
    <div className="relative flex flex-col items-center group">
      {/* Dynamic Glow Aura when recording */}
      {recording && (
        <span className="absolute -inset-1 rounded-full bg-rose-500/30 animate-ping pointer-events-none" />
      )}

      <Button
        type="button"
        variant={recording ? "destructive" : "outline"}
        size="icon"
        className={`relative h-11 w-11 shrink-0 rounded-full transition-all duration-300 ${
          recording
            ? "bg-gradient-to-r from-rose-500 to-red-600 text-white shadow-lg shadow-rose-500/40 ring-4 ring-rose-500/20 scale-105"
            /* Trạng thái nghỉ phải TỰ MỜI GỌI. Bản cũ là `bg-background/80` với
               viền `primary/20` — gần như trong suốt, nên đứng cạnh nút gửi tô
               đặc thì nó trông như bị vô hiệu hoá. Đây chính là lý do phải dán
               thêm nhãn "Bấm để nói ↓"; tô nền nhạt và đậm viền lên thì nhãn đó
               thành thừa. */
            : "border-primary/40 bg-primary/10 text-primary shadow-sm hover:bg-primary/20 hover:border-primary/60 hover:scale-105 hover:shadow-md hover:shadow-primary/20"
        }`}
        disabled={disabled || working}
        onClick={recording ? finish : begin}
        aria-label={recording ? t.rec : t.idle}
        title={working ? t.work : recording ? t.rec : t.idle}
        data-testid="button-mic"
      >
        {working ? (
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
        ) : recording ? (
          <Square className="h-4 w-4 fill-current animate-pulse text-white" />
        ) : (
          <Mic className="h-5 w-5 text-primary transition-transform group-hover:scale-110" />
        )}
      </Button>

      {/* Friendly Audio Visualizer Wave / Level Meter */}
      {recording && (
        <div
          className="mt-1.5 flex items-center justify-center gap-0.5 px-2 py-0.5 rounded-full bg-rose-500/10 border border-rose-500/20 backdrop-blur-xs animate-in fade-in zoom-in-95 duration-200"
          aria-hidden
        >
          <div
            className="w-1 rounded-full bg-rose-500 transition-all duration-75"
            style={{ height: `${Math.max(4, Math.min(16, Math.round(level * 40)))}px` }}
          />
          <div
            className="w-1 rounded-full bg-rose-500 transition-all duration-75"
            style={{ height: `${Math.max(6, Math.min(20, Math.round(level * 70)))}px` }}
          />
          <div
            className="w-1 rounded-full bg-rose-500 transition-all duration-75"
            style={{ height: `${Math.max(4, Math.min(16, Math.round(level * 45)))}px` }}
          />
        </div>
      )}

      {/* Thông báo NỔI lên trên nút, không nằm trong dòng chảy bố cục.
          Trước đây nó là phần tử thường nên khi hiện ("Chưa nhận được, anh/chị
          thử lại…") nó đội chiều cao cả hàng nhập tin lên và đẩy nút gửi lệch
          đi — thấy rõ trong ảnh người dùng gửi. Nổi lên thì hàng đứng yên. */}
      {note && !recording && (
        <span className="absolute bottom-full left-1/2 z-20 mb-1.5 w-max max-w-[12rem] -translate-x-1/2 rounded-md border border-border bg-popover px-2 py-1 text-center text-[10px] font-medium leading-tight text-popover-foreground shadow-md animate-in fade-in">
          {note}
        </span>
      )}
    </div>
  );
}

