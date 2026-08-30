/**
 * Reading a reply aloud, using the voices the guest's own device already has.
 *
 * WHY THIS AND NOT A MODEL. The machine this runs on has 133 MiB of free VRAM —
 * qwen3.5:4b holds 3.1 GB and bge-m3 was already exiled to the CPU to make room
 * — and 1.7 GB of available RAM against 23 GB committed. There is nowhere to put
 * a TTS model without evicting the concierge itself, and losing full GPU
 * residency was measured at 42 tok/s -> 3.8 tok/s. `speechSynthesis` costs zero
 * bytes on the server and runs on the guest's phone, which already ships voices
 * for every language this concierge answers in.
 *
 * THE RULE THAT MATTERS: a voice must match the language of the text. Speaking
 * Japanese through an English voice does not produce accented Japanese, it
 * produces noise — and this project has twice shipped the written form of that
 * same mistake (an English sales line under a Japanese answer, an English
 * booking form for a Japanese guest). So when no voice matches, there is no
 * speak button at all. Never a fallback voice.
 *
 * Voices load asynchronously and the first `getVoices()` returns [] in every
 * Chromium build — measured here returning 0 then 4. Anything that reads the
 * list once at module load will conclude the device is mute.
 */

export type SpeechLang = "vi" | "en" | "ko" | "ja" | "zh" | "ru";

/** BCP-47 prefixes to accept per app language. `zh` covers zh-CN/zh-TW/zh-HK. */
const PREFIX: Record<SpeechLang, string[]> = {
  vi: ["vi"],
  en: ["en"],
  ko: ["ko"],
  ja: ["ja"],
  zh: ["zh", "cmn", "yue"],
  ru: ["ru"],
};

export function speechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
}

/**
 * Resolve the voice list once it is actually populated.
 *
 * Resolves with whatever exists after the timeout rather than hanging: a device
 * with genuinely no voices must produce an answer, not a pending promise that
 * leaves a button in a loading state forever.
 */
export function voicesReady(timeoutMs = 2000): Promise<SpeechSynthesisVoice[]> {
  if (!speechSupported()) return Promise.resolve([]);
  return new Promise((resolve) => {
    const now = window.speechSynthesis.getVoices();
    if (now.length) return resolve(now);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.speechSynthesis.onvoiceschanged = null;
      resolve(window.speechSynthesis.getVoices());
    };
    window.speechSynthesis.onvoiceschanged = finish;
    setTimeout(finish, timeoutMs);
  });
}

/**
 * The best voice for this language, or null — never a near-miss.
 *
 * An unknown language returns null rather than falling back to English. The
 * first version of this defaulted the lookup to `"en"`, so a Thai request drew
 * an English voice — the exact failure the module exists to prevent, and the
 * test missed it because the fixture had no English voice to fall back TO.
 * Wrong here is worse than silent: the concierge answers in six languages, so a
 * seventh reaching this function means something upstream is already broken and
 * speaking it in English hides that instead of showing it.
 */
export function pickVoice(voices: SpeechSynthesisVoice[], lang: string): SpeechSynthesisVoice | null {
  const prefixes = PREFIX[lang as SpeechLang];
  if (!prefixes) return null;
  const matches = voices.filter((v) => prefixes.some((p) => v.lang.toLowerCase().startsWith(p)));
  if (!matches.length) return null;
  /* A voice the OS marks default for the language is the one the guest is used
     to hearing; otherwise take the first match. */
  return matches.find((v) => v.default) ?? matches[0];
}

/**
 * Strip what should not be read out.
 *
 * The concierge answers in markdown and quotes prices as `2.640.000đ`. A screen
 * reader saying "asterisk asterisk" or spelling a price digit by digit is worse
 * than silence, and the number-spacing bug this project already fixed once
 * (`2. 200. 000`) is exactly what a naive replace would reintroduce.
 */
export function forSpeech(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/(\*\*|__|\*|_)/g, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\|/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, ". ")
    .trim();
}

/**
 * Speak, cancelling anything already speaking.
 *
 * One utterance at a time is not a nicety: two replies read over each other is
 * unintelligible, and `speechSynthesis` queues by default rather than replacing.
 */
export function speak(
  text: string,
  voice: SpeechSynthesisVoice,
  opts: { onEnd?: () => void; rate?: number } = {},
): void {
  if (!speechSupported()) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(forSpeech(text));
  u.voice = voice;
  u.lang = voice.lang;
  /* Slightly under normal: a concierge reading a price or a check-out time is
     giving the guest something to write down. */
  u.rate = opts.rate ?? 0.95;
  u.onend = () => opts.onEnd?.();
  u.onerror = () => opts.onEnd?.();
  window.speechSynthesis.speak(u);
}

export function stopSpeaking(): void {
  if (speechSupported()) window.speechSynthesis.cancel();
}
