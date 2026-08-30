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

  /* Releasing the microphone on unmount is not a tidiness detail: the browser
     shows a recording indicator for as long as the track is live, and a kiosk
     that appears to be listening after the guest navigated away is alarming. */
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      rec.current?.cancel();
    },
    [],
  );

  /* Whisper is told which language to expect, so an unknown profile language
     has to resolve to something. English is the right default here — unlike the
     speak button, where a wrong voice is noise, a wrong ASR hint on clear
     speech degrades gracefully. */
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
      /* Denied, or no microphone. Both are the guest's own device telling them
         something; repeating it as an error would be noise. */
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
    <div className="flex flex-col items-center">
      <Button
        type="button"
        variant={recording ? "destructive" : "outline"}
        size="icon"
        className="h-[42px] w-[42px] shrink-0"
        disabled={disabled || working}
        onClick={recording ? finish : begin}
        aria-label={recording ? t.rec : t.idle}
        title={working ? t.work : recording ? t.rec : t.idle}
        data-testid="button-mic"
      >
        {working ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : recording ? (
          <Square className="h-3.5 w-3.5" />
        ) : (
          <Mic className="h-4 w-4" />
        )}
      </Button>
      {recording && (
        /* A level meter, not a timer. The question a guest has while recording
           is "can it hear me", and a permission that was granted at the browser
           but muted at the OS looks identical to a working microphone without
           this. */
        <div className="mt-1 h-1 w-8 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div
            className="h-full rounded-full bg-destructive transition-[width] duration-75"
            style={{ width: `${Math.min(100, Math.round(level * 140))}%` }}
          />
        </div>
      )}
      {note && !recording && (
        <span className="mt-1 max-w-[9rem] text-center text-[10px] leading-tight text-muted-foreground">
          {note}
        </span>
      )}
    </div>
  );
}
