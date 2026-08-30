/**
 * "Read this to me" on a concierge reply.
 *
 * Renders NOTHING when the guest's device has no voice for the language of the
 * answer. That is the whole design: a button that speaks Japanese text through
 * an English voice produces noise, and a guest who taps it once learns the
 * feature is broken. Absent beats wrong.
 */
import { useEffect, useState } from "react";
import { Volume2, Square } from "lucide-react";
import { pickVoice, speak, speechSupported, stopSpeaking, voicesReady } from "@/lib/speech";

const LABEL: Record<string, { play: string; stop: string }> = {
  vi: { play: "Nghe câu trả lời", stop: "Dừng đọc" },
  en: { play: "Read aloud", stop: "Stop" },
  ko: { play: "읽어주기", stop: "중지" },
  ja: { play: "読み上げ", stop: "停止" },
  zh: { play: "朗读", stop: "停止" },
  ru: { play: "Озвучить", stop: "Стоп" },
};

export function SpeakButton({ text, lang }: { text: string; lang: string }) {
  const [voice, setVoice] = useState<SpeechSynthesisVoice | null>(null);
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    let alive = true;
    /* Resolved per mount rather than once at module load: the list is empty on
       the first call in every Chromium build (measured: 0, then 4). */
    voicesReady().then((v) => {
      if (alive) setVoice(pickVoice(v, lang));
    });
    return () => {
      alive = false;
    };
  }, [lang]);

  /* Stop when this message leaves the screen, or a guest scrolling away keeps
     hearing an answer they have moved on from. */
  useEffect(() => () => stopSpeaking(), []);

  if (!speechSupported() || !voice) return null;
  const l = LABEL[lang] ?? LABEL.en;

  return (
    <button
      type="button"
      onClick={() => {
        if (speaking) {
          stopSpeaking();
          setSpeaking(false);
          return;
        }
        setSpeaking(true);
        speak(text, voice, { onEnd: () => setSpeaking(false) });
      }}
      title={`${speaking ? l.stop : l.play} · ${voice.name}`}
      aria-label={speaking ? l.stop : l.play}
      data-testid="button-speak"
      className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {speaking ? <Square className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
    </button>
  );
}
