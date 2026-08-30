/**
 * Voice selection and what gets read aloud.
 *
 * The rule under test is the one that decides whether this feature helps or
 * embarrasses: a voice must match the language of the text. Reading Japanese
 * through an English voice is not accented Japanese, it is noise — and this
 * project has already shipped the written form of that mistake twice (an
 * English sales line under a Japanese answer, an English booking form for a
 * Japanese guest). So `pickVoice` returns null rather than a near-miss, and the
 * button renders nothing.
 *
 *   npx tsx test/speech.test.ts
 */
import { pickVoice, forSpeech } from "../client/src/lib/speech";

let failures = 0;
function ok(cond: boolean, msg: string) {
  if (cond) console.log(`  PASS  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}

const v = (name: string, lang: string, isDefault = false) =>
  ({ name, lang, default: isDefault, localService: true, voiceURI: name }) as SpeechSynthesisVoice;

/* The voices actually installed on the development machine, measured. */
const REAL = [
  v("Microsoft An - Vietnamese (Vietnam)", "vi-VN", true),
  v("Microsoft David - English (United States)", "en-US", true),
  v("Microsoft Mark - English (United States)", "en-US"),
  v("Microsoft Zira - English (United States)", "en-US"),
];

console.log("=== A VOICE MUST MATCH THE LANGUAGE ===");
ok(pickVoice(REAL, "vi")?.lang === "vi-VN", "Vietnamese text gets the Vietnamese voice");
ok(pickVoice(REAL, "en")?.lang === "en-US", "English text gets an English voice");

/* The machine has no ja/ko/zh/ru voice. Every one of these must be silent
   rather than fall back to English. */
for (const lang of ["ja", "ko", "zh", "ru"])
  ok(pickVoice(REAL, lang) === null, `${lang} has no voice here, so nothing is offered — never English`);

console.log("=== NO SILENT FALLBACK, EVEN FOR AN UNKNOWN LANGUAGE ===");
/* A language the app does not support must not quietly become English either:
   the concierge does not answer in Thai, so a Thai voice request is a bug
   upstream and speaking it in English would hide that. */
/* Tested against a list that DOES contain English. The first version of this
   assertion used a fixture with no English voice, so it passed while the code
   was in fact falling back to English for every unknown language. */
for (const lang of ["th", "de", "xx", ""])
  ok(pickVoice(REAL, lang) === null, `"${lang || "(empty)"}" gets nothing — NOT the English voice sitting right there`);
ok(pickVoice([], "vi") === null, "a device with no voices at all is handled");

console.log("=== REGIONAL VARIANTS COUNT ===");
const REGIONAL = [v("zh-TW voice", "zh-TW"), v("Cantonese", "yue-HK"), v("pt-BR", "pt-BR")];
ok(pickVoice(REGIONAL, "zh")?.lang === "zh-TW", "zh matches zh-TW, not only zh-CN");
ok(pickVoice([v("ja-JP voice", "ja-JP")], "ja")?.lang === "ja-JP", "ja matches ja-JP");

console.log("=== THE OS DEFAULT WINS AMONG EQUALS ===");
const THREE = [v("Second", "en-GB"), v("Preferred", "en-US", true), v("Third", "en-AU")];
ok(pickVoice(THREE, "en")?.name === "Preferred", "the voice the OS marks default is the one the guest knows");

console.log("=== WHAT GETS READ ALOUD ===");
ok(!forSpeech("**Giá phòng** là *rẻ*").includes("*"), "markdown emphasis is not spoken as asterisks");
ok(forSpeech("## Tiêu đề\nNội dung").startsWith("Tiêu đề"), "heading marks are stripped");
ok(forSpeech("[Lotus](https://x.com) mở cửa") === "Lotus mở cửa", "a link is read as its text, not its URL");
ok(!forSpeech("Xem `get_folio` nhé").includes("`"), "inline code marks are stripped");

/* The number-spacing bug this project already fixed once: a price must survive
   intact, or the concierge reads "two point two hundred point zero zero zero". */
const price = forSpeech("Giá là 2.640.000đ cho một đêm");
ok(price.includes("2.640.000đ"), `a price keeps its dots and its đ (got "${price}")`);
ok(forSpeech("Giờ trả phòng 12:00").includes("12:00"), "a time keeps its colon");

ok(forSpeech("Dòng một\n\nDòng hai").includes("."), "a paragraph break becomes a pause, not a run-on");
ok(forSpeech("- một\n- hai").startsWith("một"), "list bullets are not read as hyphens");
ok(forSpeech("```\ncode\n```\nSau đó").trim() === "Sau đó", "a code block is skipped entirely");

console.log(failures === 0 ? "\nALL SPEECH TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
