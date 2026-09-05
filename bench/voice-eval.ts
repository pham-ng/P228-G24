/**
 * Round-trip STT+TTS benchmark, using the SAME production code the guest hits.
 *
 *   npx tsx bench/voice-eval.ts <out.json>
 *
 * WHY ROUND-TRIP. There is no recorded corpus of real guests speaking into this
 * kiosk in six languages, and MOS (human listeners rating 1-5) needs people a
 * script cannot hire. The objective stand-in the field uses for TTS, and the
 * only STT signal available without a human-recorded corpus, is the same
 * measurement done once: synthesise the reference sentence with the product's
 * own TTS, feed the audio through the product's own STT, and score the
 * transcript against the sentence that went in. It answers "can this be
 * understood" for both halves in one pass — not "does it sound natural" (that
 * needs MOS) and not "how does OUR TTS+STT compare to a human speaker" (that
 * needs recordings — see `bench/asr-eval.ts`'s SOURCE.txt convention for why
 * synthetic audio is a FLOOR for comparison, never a number to hand a buyer).
 *
 * WHY THE PRODUCT'S OWN CODE, NOT A SEPARATE MODEL LOAD. `bench/tts-eval.ts`
 * loads Kokoro-82M directly and only ever covered English — the product moved
 * to Piper (vi/en/ko/zh/ru) and Kokoro+misaki (ja) since that script was
 * written. Importing `synthesise`/`synthesiseJa` from `server/tts*.ts` and
 * `transcribe` from `server/stt.ts` means this measures exactly what a guest's
 * tap on the mic and the speaker button actually run, including
 * `cleanTranscript`'s de-looping and the vi→PhoWhisper / other→whisper-small
 * routing — not a parallel implementation that could quietly drift from it.
 *
 * RESAMPLING. Piper voices ship at their own rate (usually 22050 Hz) and
 * Kokoro emits 24000 Hz; Whisper's feature extractor wants 16000 Hz exactly,
 * and a silent rate mismatch has already cost this project one full invalid
 * round of STT numbers (see aurea-voice memory) — so this script SHELLS OUT to
 * ffmpeg rather than re-deriving a resampler, and throws if ffmpeg is missing
 * rather than silently feeding the wrong rate through.
 */
import "dotenv/config";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { synthesise, ttsLangs, isTtsLang, type TtsLang } from "../server/tts";
import { synthesiseJa, jaAvailable, warmJaTts } from "../server/tts-ja";
import { decodeWav, transcribe, warmStt, type SttLang } from "../server/stt";
import { wer, cer, scoreEntities, summarise, pct, percentile, type CaseResult } from "./lib/speech-metrics";

type Case = { id: string; lang: string; ref: string; why: string };

const outPath = process.argv[2] ?? join(process.cwd(), "bench", "voice-eval-report.json");

const set = JSON.parse(
  readFileSync(join(process.cwd(), "bench", "data", "speech-testset.json"), "utf8"),
) as { cases: Case[] };

const tmp = mkdtempSync(join(tmpdir(), "aurea-voice-eval-"));

function resampleTo16k(wav: Buffer): Buffer {
  const inPath = join(tmp, `in-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  const outPath16 = inPath.replace(/\.wav$/, ".16k.wav");
  writeFileSync(inPath, wav);
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", inPath, "-ar", "16000", "-ac", "1", outPath16]);
  if (r.status !== 0) {
    throw new Error(
      `ffmpeg resample failed (exit ${r.status}): ${r.stderr?.toString().slice(0, 300) ?? "no stderr"}`,
    );
  }
  const out = readFileSync(outPath16);
  rmSync(inPath, { force: true });
  rmSync(outPath16, { force: true });
  return out;
}

await warmStt("vi");
await warmJaTts();

const perLang: Record<string, { results: CaseResult[]; refs: string[]; hyps: string[]; ttsRtf: number[]; ttsMs: number[]; sttRtf: number[]; voice: string; ttsUnavailable: boolean }> = {};

console.log(`cases: ${set.cases.length}\n`);

for (const c of set.cases) {
  const lang = c.lang;
  if (!perLang[lang])
    perLang[lang] = { results: [], refs: [], hyps: [], ttsRtf: [], ttsMs: [], sttRtf: [], voice: "", ttsUnavailable: false };
  const bucket = perLang[lang];

  let ttsOut: { wav: Buffer; ms: number; audioSeconds: number; voice: string };
  try {
    if (lang === "ja") {
      if (!jaAvailable()) {
        bucket.ttsUnavailable = true;
        console.log(`  ${c.id}  SKIP — server TTS tiếng Nhật không sẵn sàng trên máy này (rơi về giọng thiết bị trong sản phẩm thật)`);
        continue;
      }
      ttsOut = await synthesiseJa(c.ref);
    } else if (isTtsLang(lang) && ttsLangs().includes(lang)) {
      ttsOut = await synthesise(c.ref, lang as TtsLang);
    } else {
      bucket.ttsUnavailable = true;
      console.log(`  ${c.id}  SKIP — không có giọng máy chủ cho "${lang}"`);
      continue;
    }
  } catch (e) {
    console.log(`  ${c.id}  TTS LỖI: ${(e as Error).message}`);
    continue;
  }
  bucket.voice = ttsOut.voice;
  const ttsRtf = ttsOut.audioSeconds > 0 ? ttsOut.ms / 1000 / ttsOut.audioSeconds : 0;
  bucket.ttsRtf.push(ttsRtf);
  bucket.ttsMs.push(ttsOut.ms);

  let pcm16: ReturnType<typeof decodeWav>;
  try {
    pcm16 = decodeWav(resampleTo16k(ttsOut.wav));
  } catch (e) {
    console.log(`  ${c.id}  RESAMPLE LỖI: ${(e as Error).message}`);
    continue;
  }

  let stt;
  try {
    stt = await transcribe(pcm16, lang as SttLang);
  } catch (e) {
    console.log(`  ${c.id}  STT LỖI: ${(e as Error).message}`);
    continue;
  }
  bucket.sttRtf.push(stt.rtf);

  const w = wer(c.ref, stt.text);
  const ch = cer(c.ref, stt.text);
  const ent = scoreEntities(c.ref, stt.text);

  bucket.results.push({
    id: c.id, ref: c.ref, hyp: stt.text,
    wer: w.rate, cer: ch.rate,
    numbersRight: ent.numbersRight, polarityRight: ent.polarityRight,
    ms: stt.ms, audioSeconds: pcm16.seconds,
  });
  bucket.refs.push(c.ref);
  bucket.hyps.push(stt.text);

  const flag = [!ent.numbersRight ? "NUM" : "", !ent.polarityRight ? "POL" : ""].filter(Boolean).join("+");
  console.log(
    `  ${c.id}  TTS ${(ttsOut.ms / 1000).toFixed(2)}s (RTF ${ttsRtf.toFixed(2)})  ` +
      `STT ${(stt.ms / 1000).toFixed(2)}s (RTF ${stt.rtf.toFixed(2)})  ` +
      `WER ${pct(w.rate).padStart(6)}  CER ${pct(ch.rate).padStart(6)}  ${flag}`,
  );
  if (w.rate > 0) console.log(`      ref: ${c.ref}\n      got: ${stt.text}`);
}

rmSync(tmp, { recursive: true, force: true });

console.log("\n  lang | cases | tts unavail |    WER |    CER | numbers | polarity | TTS RTF p50 | STT RTF p50");
console.log("  " + "-".repeat(94));

const report: Record<string, unknown> = {
  ranAt: new Date().toISOString(),
  source:
    "ROUND-TRIP SYNTHETIC — sentences synthesised by the product's own server TTS (Piper vi/en/ko/zh/ru, Kokoro+misaki ja), " +
    "transcribed by the product's own server STT (PhoWhisper-small vi, whisper-small others), scored against the reference " +
    "text they were synthesised from. This is a FLOOR for comparing the two halves of the pipeline against each other, not a " +
    "measurement of how a real guest's voice performs — see bench/asr-eval.ts and bench/README-speech-eval.md for what a " +
    "human-recorded set would take.",
  perLanguage: {} as Record<string, unknown>,
};

for (const lang of Object.keys(perLang).sort()) {
  const b = perLang[lang];
  if (!b.results.length) {
    console.log(`  ${lang.padEnd(4)} |     0 |     ${b.ttsUnavailable ? "YES" : "no "}    |      — |      — |       — |        — |           — |           —`);
    (report.perLanguage as Record<string, unknown>)[lang] = {
      cases: 0,
      ttsUnavailable: b.ttsUnavailable,
      note: b.ttsUnavailable
        ? "Server TTS không khả dụng cho ngôn ngữ này trên máy đo — khách thật rơi về giọng thiết bị (không đo được ở đây)."
        : "Không có ca nào chạy được.",
    };
    continue;
  }
  const s = summarise(b.results, b.refs, b.hyps);
  const ttsRtfP50 = percentile(b.ttsRtf, 50);
  const sttRtfP50 = percentile(b.sttRtf, 50);
  console.log(
    `  ${lang.padEnd(4)} | ${String(s.cases).padStart(5)} |     ${b.ttsUnavailable ? "YES" : "no "}    | ${pct(s.wer).padStart(6)} | ${pct(s.cer).padStart(6)} | ` +
      `${pct(s.numberAccuracy).padStart(7)} | ${pct(s.polarityAccuracy).padStart(8)} | ${ttsRtfP50.toFixed(2).padStart(11)} | ${sttRtfP50.toFixed(2).padStart(11)}`,
  );
  (report.perLanguage as Record<string, unknown>)[lang] = {
    cases: s.cases,
    voice: b.voice,
    wer: s.wer,
    cer: s.cer,
    numberAccuracy: s.numberAccuracy,
    polarityAccuracy: s.polarityAccuracy,
    ttsRtfP50,
    ttsRtfP95: percentile(b.ttsRtf, 95),
    ttsMsP50: percentile(b.ttsMs, 50),
    sttRtfP50,
    sttRtfP95: percentile(b.sttRtf, 95),
    cases_detail: b.results,
  };
}

writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`\n  written: ${outPath}`);
process.exit(0);
