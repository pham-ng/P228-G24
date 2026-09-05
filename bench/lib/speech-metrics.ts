/**
 * The numbers a buyer can check, for speech recognition and speech synthesis.
 *
 * These are the industry's metrics, not invented ones, because a hotel group
 * comparing Aurea against Google or a PMS vendor will ask for exactly these:
 *
 *   WER   word error rate      — (substitutions + deletions + insertions) / words
 *                                in the reference. The universal ASR number; every
 *                                published system quotes it.
 *   CER   character error rate — the same edit distance over characters. It is the
 *                                one that matters for Vietnamese, because a lost
 *                                tone mark ("mát" vs "mắt") is one wrong character
 *                                but a whole wrong word, and WER scores it the same
 *                                as complete nonsense.
 *
 * And two that the industry does NOT standardise but a hotel actually buys:
 *
 *   entity accuracy  — did it get the room number, the time, the party size, the
 *                      money? A transcript can be 92% right and still send someone
 *                      to room 350 instead of 305. This is what breaks a booking.
 *   polarity         — did "không mát" survive as a negation? Measured because
 *                      both models were caught turning "not cold" into "quite
 *                      cold", which inverts a complaint into a compliment.
 *
 * NORMALISATION IS NOT COSMETIC. whisper-small writes "16h" and PhoWhisper writes
 * "mười sáu giờ"; both are correct and raw WER punishes one of them for it. Every
 * serious ASR benchmark normalises before scoring, and refusing to would make the
 * comparison between the two models meaningless. What is stripped is spelled out
 * in `normalise` so a buyer can audit exactly what was forgiven.
 */

/* ------------------------------------------------------------ normalising */

/**
 * Digit words that are ONLY digits inside a dictated run.
 *
 * "không" is zero in "ba không năm" and is the negation everywhere else. Folding
 * it unconditionally turned "không mát" into "0 mát" and quietly deleted the
 * polarity this file is supposed to measure. Same for "lẻ" and "linh", which
 * are the zero-filler in a spoken number and ordinary words otherwise.
 */
const RUN_ONLY_DIGITS: Record<string, string> = { không: "0", linh: "0", lẻ: "0" };

const VI_DIGITS: Record<string, string> = {
  một: "1", mốt: "1",
  hai: "2",
  ba: "3",
  bốn: "4", tư: "4",
  năm: "5", lăm: "5", nhăm: "5",
  sáu: "6",
  bảy: "7", bẩy: "7",
  tám: "8",
  chín: "9",
};

const EN_DIGITS: Record<string, string> = {
  zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4",
  five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12",
};

/**
 * Nga — thêm 2026-09-05, cùng lý do VI_DIGITS/EN_DIGITS tồn tại: "пять" và
 * "5" là cùng một con số, khác cách viết, không phải hai câu trả lời khác
 * nhau. Không cần RUN_ONLY_DIGITS kiểu tiếng Việt — không có từ số Nga nào
 * trùng với một từ phủ định/thường dùng khác trong bộ 10 câu test (khác hẳn
 * "không" tiếng Việt vừa là số 0 vừa là phủ định).
 */
const RU_DIGITS: Record<string, string> = {
  ноль: "0", один: "1", одна: "1", одно: "1", два: "2", две: "2",
  три: "3", четыре: "4", пять: "5", шесть: "6", семь: "7", восемь: "8", девять: "9",
};

/**
 * Spoken numbers collapse to figures.
 *
 * A room number is dictated digit by digit — "ba không năm" — and written 305;
 * a time is "bảy giờ" to one model and "7 giờ" to another. Scoring either
 * spelling as an error would say the model failed when it heard the number
 * perfectly, so BOTH sides are folded to the same figure and the comparison
 * measures recognition rather than transcription style.
 *
 * Every digit word folds, alone or in a run — consistency is the whole job of a
 * normaliser, and a rule that folds "bảy giờ" but not "hai người" is two rules.
 * The one exception is `RUN_ONLY_DIGITS`, above.
 */
export function foldSpokenDigits(tokens: string[]): string[] {
  const out: string[] = [];
  /* Both forms are carried through the run, because a run of ONE must come back
     out as the original word. Keeping only the digit turned "không mát" into
     "0 mát" and deleted the negation this whole file exists to protect. */
  let run: Array<{ word: string; digit: string; runOnly: boolean }> = [];
  const flush = () => {
    /* A run may not END on a zero-word. "phòng ba không năm không mát" is room
       305 followed by a negation, and absorbing that trailing "không" produced
       room 3050 and silently deleted the complaint — caught by the evaluation
       this file scores, on the one case written to catch exactly that.
       Vietnamese says a trailing zero as "mươi"/"trăm", never "không", so a run
       ending in one has collided with the next word. A LEADING zero-word stays:
       mobile numbers really do start "không chín ba". */
    const trimmed: string[] = [];
    while (run.length && run[run.length - 1].runOnly) trimmed.unshift(run.pop()!.word);

    if (run.length >= 2) out.push(run.map((r) => r.digit).join(""));
    else out.push(...run.map((r) => (r.runOnly ? r.word : r.digit)));
    out.push(...trimmed);
    run = [];
  };
  for (const tk of tokens) {
    const runOnly = RUN_ONLY_DIGITS[tk] !== undefined;
    const d = runOnly ? RUN_ONLY_DIGITS[tk] : (VI_DIGITS[tk] ?? EN_DIGITS[tk] ?? RU_DIGITS[tk]);
    if (d !== undefined && d.length === 1) run.push({ word: tk, digit: d, runOnly });
    else {
      flush();
      out.push(tk);
    }
  }
  flush();
  return out;
}

/**
 * Time and money written as figures, however the model chose to spell them.
 *
 * NOTE ON `\b`: JavaScript's word boundary is defined on `[A-Za-z0-9_]`, so
 * `\bđồng\b` never matches — "đ" is not a word character, and there is no
 * boundary between a space and it. That silently disabled the money rule and
 * scored "2.640.000 đồng" against "2640000đ" as two errors. Unicode-aware
 * lookarounds are used instead wherever a pattern touches a Vietnamese letter.
 */
const NOT_WORD = "(?<![\\p{L}\\p{N}])";
const NOT_WORD_AFTER = "(?![\\p{L}\\p{N}])";

function canonicalUnits(s: string): string {
  return (
    s
      /* 16:30 keeps its minutes; 16:00 is just "16 giờ". Done before the bare
         hour rule so the minutes are not thrown away. */
      .replace(/(\d{1,2}):(\d{2})/gu, (_m, h, mm) => (mm === "00" ? `${h} giờ` : `${h} giờ ${Number(mm)}`))
      /* 16h / 16 giờ / 16 h -> "16 giờ". Whisper picks a different one of these
         on almost every run and none of them is an error. */
      .replace(new RegExp(`(\\d{1,2})\\s*(?:h|giờ|gio|o'clock)${NOT_WORD_AFTER}`, "gu"), "$1 giờ")
      /* 2.640.000 / 2,640,000 / 2640000 are one number. */
      .replace(/(?<!\d)(\d{1,3}(?:[.,]\d{3})+)(?!\d)/gu, (m) => m.replace(/[.,]/g, ""))
      /* đ / vnd / đồng are one unit. */
      .replace(new RegExp(`${NOT_WORD}(?:vnd|vnđ|đồng|dong|đ)${NOT_WORD_AFTER}`, "gu"), " đ ")
      .replace(/(\d)\s*đ(?![\p{L}\p{N}])/gu, "$1 đ")
  );
}

/**
 * Trung — chữ số Hán tự trong một CHUỖI ≥2 KÝ TỰ LIÊN TIẾP thành số Ả Rập.
 *
 * `foldSpokenDigits()` ở trên dựa trên tách theo dấu cách — vô dụng với tiếng
 * Trung, vì không có dấu cách giữa các "từ" nên `text.split(" ")` trả về
 * NGUYÊN CÂU làm một token duy nhất. Sửa bằng thay thế trực tiếp trên chuỗi,
 * TRƯỚC bước tách theo dấu cách.
 *
 * CHỈ gộp khi có ÍT NHẤT 2 ký tự số liên tiếp ("三零五" = 305), không đụng
 * một ký tự đơn lẻ — lý do bắt buộc, không phải thận trọng thừa: "一" (một)
 * là một trong những chữ Hán thường gặp nhất, nằm trong vô số từ ghép thường
 * ("一起", "一定", "一下"...). Thay toàn bộ "一" thành "1" bất kể ngữ cảnh sẽ
 * phá nát hầu hết câu tiếng Trung dài — tệ hơn nhiều so với lỗi đang muốn sửa.
 * Yêu cầu chuỗi ≥2 ký tự vừa đủ AN TOÀN (từ ghép tiếng Trung hầu như không
 * bao giờ xếp liền hai ký tự số) vừa đủ BẮT ĐƯỢC đúng ca cần bắt: số phòng/
 * giờ đọc rời từng chữ số như khách thật hay làm.
 *
 * Cố ý KHÔNG gồm "两" (biến thể của "hai" dùng trước lượng từ, "两位" = hai
 * người) — nó thường đứng MỘT MÌNH nên không lọt qua điều kiện ≥2, và gộp nó
 * riêng lẻ sẽ mở lại đúng rủi ro của "一" ở trên.
 */
const ZH_DIGIT_CHARS: Record<string, string> = {
  零: "0", 〇: "0", 一: "1", 二: "2", 三: "3", 四: "4",
  五: "5", 六: "6", 七: "7", 八: "8", 九: "9",
};
function foldChineseDigitRuns(text: string): string {
  return text.replace(/[零〇一二三四五六七八九]{2,}/gu, (run) =>
    [...run].map((ch) => ZH_DIGIT_CHARS[ch]).join(""),
  );
}

/**
 * Reduce a transcript to what was actually said.
 *
 * Removes exactly: case, punctuation, repeated whitespace, and the difference
 * between a figure and its spoken form. It does NOT remove diacritics — that
 * would forgive the tone errors this is meant to catch.
 */
export function normalise(text: string): string {
  let t = text.toLowerCase().normalize("NFC");
  t = foldChineseDigitRuns(t);
  /* Units FIRST. Stripping punctuation before this destroyed the very
     characters the unit rules match on: "16:00" had already become "16 00" and
     "2.640.000" had become three separate numbers, so neither rule ever fired
     and both models were being scored as wrong for writing a time correctly. */
  t = canonicalUnits(t);
  t = t.replace(/[.,!?;:…"“”'’`()[\]{}<>«»–—]/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  return foldSpokenDigits(t.split(" ").filter(Boolean)).join(" ");
}

/* ------------------------------------------------------------ edit distance */

export type Edits = { sub: number; del: number; ins: number; hits: number; total: number; rate: number };

/** Levenshtein alignment, reported as the three error kinds WER is defined on. */
export function align<T>(ref: T[], hyp: T[]): Edits {
  const n = ref.length;
  const m = hyp.length;
  /* Full DP table: the backtrace is what separates a substitution from a
     deletion plus an insertion, and WER is defined on that distinction. */
  const d: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++)
      d[i][j] =
        ref[i - 1] === hyp[j - 1]
          ? d[i - 1][j - 1]
          : 1 + Math.min(d[i - 1][j - 1], d[i - 1][j], d[i][j - 1]);

  let i = n;
  let j = m;
  let sub = 0;
  let del = 0;
  let ins = 0;
  let hits = 0;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && ref[i - 1] === hyp[j - 1] && d[i][j] === d[i - 1][j - 1]) {
      hits++;
      i--;
      j--;
    } else if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + 1) {
      sub++;
      i--;
      j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      del++;
      i--;
    } else {
      ins++;
      j--;
    }
  }
  /* Denominator is the REFERENCE length, per the standard definition — which is
     why WER can exceed 100% when a model hallucinates extra words. */
  return { sub, del, ins, hits, total: n, rate: n === 0 ? (m === 0 ? 0 : 1) : (sub + del + ins) / n };
}

export const wer = (ref: string, hyp: string): Edits =>
  align(normalise(ref).split(" ").filter(Boolean), normalise(hyp).split(" ").filter(Boolean));

export const cer = (ref: string, hyp: string): Edits =>
  align([...normalise(ref).replace(/ /g, "")], [...normalise(hyp).replace(/ /g, "")]);

/* ------------------------------------------------------------- entities */

export type Entities = {
  /** Every number in the utterance, in order: rooms, times, prices, party size. */
  numbers: string[];
  /** Whether the utterance is a negation. Inverting one inverts a complaint. */
  negated: boolean;
};

const NEGATORS = /\b(không|chưa|đừng|no|not|n't|없|ない|ません|不|没|не|нет)\b/;

/**
 * Pull out the parts a wrong transcript would actually cost money.
 *
 * Deliberately crude — every figure, in order — because the failure being
 * guarded against is 305 heard as 350, and that shows up as a changed figure
 * whatever role the figure plays in the sentence.
 */
export function entitiesOf(text: string): Entities {
  const n = normalise(text);
  return {
    numbers: (n.match(/\d+/g) ?? []).filter((x) => x.length > 0),
    negated: NEGATORS.test(n),
  };
}

export type EntityScore = { numbersRight: boolean; polarityRight: boolean; refNumbers: string[]; hypNumbers: string[] };

export function scoreEntities(ref: string, hyp: string): EntityScore {
  const r = entitiesOf(ref);
  const h = entitiesOf(hyp);
  return {
    numbersRight: r.numbers.length === h.numbers.length && r.numbers.every((v, i) => v === h.numbers[i]),
    polarityRight: r.negated === h.negated,
    refNumbers: r.numbers,
    hypNumbers: h.numbers,
  };
}

/* --------------------------------------------------------------- summary */

export type CaseResult = {
  id: string;
  ref: string;
  hyp: string;
  wer: number;
  cer: number;
  numbersRight: boolean;
  polarityRight: boolean;
  ms: number;
  audioSeconds: number;
};

export type Summary = {
  cases: number;
  /* Corpus WER is total edits over total reference words, NOT the mean of the
     per-utterance rates. Averaging the rates lets one badly-scored four-word
     sentence outweigh a correct twenty-word one, and every published WER is
     computed the corpus way. */
  wer: number;
  cer: number;
  numberAccuracy: number;
  polarityAccuracy: number;
  rtfP50: number;
  rtfP95: number;
  msP50: number;
  msP95: number;
};

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  /* Nearest-rank. On the small sets these evaluations run, interpolating
     invents a value that no utterance actually took. */
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

export function summarise(results: CaseResult[], refs: string[], hyps: string[]): Summary {
  let wSub = 0;
  let wTot = 0;
  let cSub = 0;
  let cTot = 0;
  for (let i = 0; i < refs.length; i++) {
    const w = wer(refs[i], hyps[i]);
    const c = cer(refs[i], hyps[i]);
    wSub += w.sub + w.del + w.ins;
    wTot += w.total;
    cSub += c.sub + c.del + c.ins;
    cTot += c.total;
  }
  const rtfs = results.map((r) => (r.audioSeconds > 0 ? r.ms / 1000 / r.audioSeconds : 0));
  const ms = results.map((r) => r.ms);
  return {
    cases: results.length,
    wer: wTot ? wSub / wTot : 0,
    cer: cTot ? cSub / cTot : 0,
    numberAccuracy: results.length ? results.filter((r) => r.numbersRight).length / results.length : 0,
    polarityAccuracy: results.length ? results.filter((r) => r.polarityRight).length / results.length : 0,
    rtfP50: percentile(rtfs, 50),
    rtfP95: percentile(rtfs, 95),
    msP50: percentile(ms, 50),
    msP95: percentile(ms, 95),
  };
}

export const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
