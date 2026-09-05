/**
 * WAV parsing, silence rejection and hallucination cleanup.
 * Pure: no model, no network — the audio is synthesised in the test.
 *
 *   npx tsx test/stt.test.ts
 */
import { decodeWav, hasSignal, cleanTranscript, modelFor, isSttLang, STT_SAMPLE_RATE } from "../server/stt";

let failures = 0;
function ok(cond: boolean, msg: string) {
  if (cond) console.log(`  PASS  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}
function throws(fn: () => unknown, match: RegExp, msg: string) {
  try {
    fn();
    ok(false, msg);
  } catch (e) {
    ok(match.test((e as Error).message), `${msg} (${(e as Error).message})`);
  }
}

/** Build a WAV the same way the browser's encoder does, for round-tripping. */
function wav(samples: number[][], rate = STT_SAMPLE_RATE, bits = 16, format = 1): Buffer {
  const channels = samples.length;
  const frames = samples[0].length;
  const bytes = frames * channels * (bits / 8);
  const b = Buffer.alloc(44 + bytes);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + bytes, 4);
  b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(format, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * channels * (bits / 8), 28);
  b.writeUInt16LE(channels * (bits / 8), 32);
  b.writeUInt16LE(bits, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(bytes, 40);
  /* Only 16-bit bodies are written. The other widths exist in this helper to
     produce a header the decoder must refuse, and it refuses on the header. */
  if (bits === 16)
    for (let i = 0; i < frames; i++)
      for (let c = 0; c < channels; c++)
        b.writeInt16LE(Math.round(samples[c][i] * 32767), 44 + (i * channels + c) * 2);
  return b;
}

const tone = (n: number, amp = 0.5) =>
  Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * 440 * i) / STT_SAMPLE_RATE));

console.log("=== WAV DECODING ===");
const mono = decodeWav(wav([tone(16000)]));
ok(mono.rate === 16000, "sample rate is read from the header");
ok(mono.samples.length === 16000, "every frame is decoded");
ok(Math.abs(mono.seconds - 1) < 1e-9, "duration is frames over rate");
ok(Math.max(...mono.samples) > 0.4 && Math.min(...mono.samples) < -0.4, "samples are scaled to -1..1");

/* Whisper's feature extractor takes only the first channel, which on some
   phones is the quieter one — so a stereo upload is mixed, not truncated. */
const stereo = decodeWav(wav([tone(800, 1.0), tone(800, 0.0)]));
ok(stereo.samples.length === 800, "stereo is reported as frames, not samples");
ok(Math.max(...stereo.samples) > 0.4, "a channel carrying audio survives the downmix");
ok(Math.max(...stereo.samples) < 0.6, "and it is averaged with the silent channel, not taken alone");

console.log("=== BAD UPLOADS ARE REFUSED, NOT GUESSED ===");
throws(() => decodeWav(Buffer.alloc(10)), /Not a WAV/, "a short buffer is not a WAV");
throws(() => decodeWav(Buffer.from("this is a text file, honestly".padEnd(64))), /Not a WAV/, "text is not a WAV");
throws(() => decodeWav(wav([tone(100)], 16000, 16, 3)), /uncompressed PCM/, "float WAV is refused");
throws(() => decodeWav(wav([tone(100)], 16000, 8)), /16-bit/, "8-bit WAV is refused");

/* A body truncated in transit must not make the parser read past its buffer. */
const cut = wav([tone(4000)]).subarray(0, 44 + 100);
const short = decodeWav(cut);
ok(short.samples.length === 50, "a truncated upload decodes only the bytes that arrived");

console.log("=== SILENCE ===");
ok(hasSignal(decodeWav(wav([tone(16000)]))), "a tone has signal");
ok(!hasSignal(decodeWav(wav([Array(16000).fill(0)]))), "digital silence has none");
ok(!hasSignal(decodeWav(wav([tone(16000, 0.001)]))), "room tone is below the floor");
ok(hasSignal(decodeWav(wav([tone(16000, 0.02)]))), "quiet speech is above it");

console.log("=== HALLUCINATION CLEANUP ===");
/* Whisper pads short clips to 30 seconds and then narrates the padding. These
   are the two shapes it produces, and neither is something a guest said. */
ok(cleanTranscript("[Music]") === "", "a bare non-speech tag becomes empty");
ok(cleanTranscript("(tiếng nhạc) mấy giờ ăn sáng") === "mấy giờ ăn sáng", "a tag is stripped from real speech");
ok(cleanTranscript("【音楽】朝食は") === "朝食は", "CJK brackets are stripped too");
ok(
  cleanTranscript("cảm ơn quý vị cảm ơn quý vị cảm ơn quý vị") === "cảm ơn quý vị",
  "a phrase looped three times collapses to one",
);
ok(
  cleanTranscript("cho tôi đặt bàn ăn tối lúc bảy giờ") === "cho tôi đặt bàn ăn tối lúc bảy giờ",
  "ordinary speech is left exactly alone",
);
/* The loop guard must not eat a sentence that merely repeats a word. */
ok(
  cleanTranscript("dạ vâng dạ vâng ạ em nghe rồi") === "dạ vâng dạ vâng ạ em nghe rồi",
  "a partial repeat inside a longer sentence is kept",
);
/* Caught live from moonshine-tiny-ko once its token budget was widened past
   the paper's own "6 tokens/sec" cap to stop truncating real sentences — the
   whole utterance said exactly twice, a different shape from the padding
   loop above (that one needs 3+ repeats of a ≤6-word unit). */
ok(
  cleanTranscript("저희 방은 성인 두 명과 다섯 살 어린이 한 명입니다 저희 방은 성인 두 명과 다섯 살 어린이 한 명입니다") ===
    "저희 방은 성인 두 명과 다섯 살 어린이 한 명입니다",
  "a whole sentence said exactly twice collapses to one",
);
/* The 4-word-per-half floor must not eat a guest genuinely saying a short
   phrase twice for emphasis. */
ok(cleanTranscript("please please help me now") === "please please help me now", "a short doubled phrase is kept");
ok(cleanTranscript("no no no no") === "no no no no", "a very short repeat stays under the 4-word floor");
ok(cleanTranscript("   ") === "", "whitespace is empty");
ok(cleanTranscript("ok") === "ok", "a two-letter answer survives");

console.log("=== MODEL ROUTING ===");
/* PhoWhisper is a Vietnamese fine-tune, not a multilingual model: Korean spoken
   into it returns Vietnamese-shaped nonsense rather than an error, so only
   Vietnamese may reach it. */
ok(modelFor("vi").includes("PhoWhisper"), "Vietnamese gets the Vietnamese specialist");
/* moonshine-tiny-ko measured (bench/voice-eval.ts, 10 real Korean cases)
   beating the multilingual model on every axis — WER 45.2%->32.1%, CER
   17.6%->11.3%, number accuracy 50%->70%, ~4-5x faster — same reason
   Vietnamese gets its own specialist instead of the shared model. */
ok(modelFor("ko").includes("moonshine"), "Korean gets the Korean specialist");
for (const l of ["en", "ja", "zh", "ru"] as const)
  ok(modelFor(l).includes("whisper-small") && !modelFor(l).includes("Pho"), `${l} gets the multilingual model`);

ok(isSttLang("vi") && isSttLang("ru"), "supported languages are accepted");
ok(!isSttLang("th") && !isSttLang("") && !isSttLang(undefined), "anything else is rejected before it reaches a model");

console.log(failures === 0 ? "\nALL STT TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
