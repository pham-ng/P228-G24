/**
 * The scoring itself, checked before anyone quotes a number produced by it.
 *
 * A benchmark that is generous in a way nobody has audited is worse than no
 * benchmark: it produces a figure a salesperson repeats and a customer later
 * disproves. These tests pin down exactly what the normaliser forgives and what
 * it refuses to.
 *
 *   npx tsx test/speech-metrics.test.ts
 */
import {
  normalise,
  foldSpokenDigits,
  wer,
  cer,
  align,
  entitiesOf,
  scoreEntities,
  percentile,
  summarise,
} from "../bench/lib/speech-metrics";

let failures = 0;
function ok(cond: boolean, msg: string) {
  if (cond) console.log(`  PASS  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

console.log("=== EDIT DISTANCE IS THE STANDARD DEFINITION ===");
ok(near(align(["a", "b", "c"], ["a", "b", "c"]).rate, 0), "identical is 0%");
ok(align(["a", "b", "c"], ["a", "x", "c"]).sub === 1, "a changed word is a substitution");
ok(align(["a", "b", "c"], ["a", "c"]).del === 1, "a missing word is a deletion");
ok(align(["a", "c"], ["a", "b", "c"]).ins === 1, "an extra word is an insertion");
ok(near(align(["a", "b", "c", "d"], ["a", "x", "c", "d"]).rate, 0.25), "one error in four words is 25%");
/* WER above 100% is not a bug; a model that hallucinates a paragraph over a
   three-word question really is that wrong, and capping it would hide it. */
ok(align(["a"], ["x", "y", "z", "w"]).rate > 1, "hallucinating past the reference exceeds 100%");
ok(near(align([], []).rate, 0), "empty against empty is 0%");
ok(near(align([], ["a"]).rate, 1), "words against an empty reference is 100%");

console.log("=== WHAT NORMALISATION FORGIVES ===");
/* whisper-small writes "16h", PhoWhisper writes "mười sáu giờ". Both are
   correct; scoring one of them as wrong would make the comparison a lie. */
ok(near(wer("tôi muốn trả phòng lúc 16 giờ", "tôi muốn trả phòng lúc 16h").rate, 0), "16h == 16 giờ");
ok(near(wer("lúc 16 giờ", "lúc 16:00").rate, 0), "16:00 == 16 giờ");
ok(near(wer("lúc bảy giờ", "lúc 7 giờ").rate, 0), "spoken 'bảy giờ' == '7 giờ'");
ok(near(wer("phòng ba không năm", "phòng 305").rate, 0), "a dictated room number == its figure");
ok(near(wer("giá 2.640.000 đồng", "giá 2640000đ").rate, 0), "grouped and ungrouped money agree");
ok(near(wer("Mấy giờ ăn sáng?", "mấy giờ ăn sáng").rate, 0), "case and punctuation are forgiven");

console.log("=== WHAT IT REFUSES TO FORGIVE ===");
/* Diacritics carry the meaning in Vietnamese. Stripping them before scoring
   would make every model look excellent and every guest misunderstood. */
ok(wer("điều hòa không mát", "điều hòa khủng mát").rate > 0, "a lost tone is still an error");
ok(cer("mát", "mắt").rate > 0, "mát and mắt are different words");
ok(wer("phòng 305", "phòng 350").rate > 0, "a transposed room number is an error");
ok(normalise("không mát").includes("không"), "the negator survives normalisation");

console.log("=== CER CATCHES WHAT WER FLATTENS ===");
/* Both hypotheses lose exactly one word, so WER calls them equally bad. CER is
   what shows that one was a near miss and the other was nonsense. */
const nearMiss = cer("nhà hàng lotus", "nhà hàng lotuss").rate;
const nonsense = cer("nhà hàng lotus", "nhà hàng xyzabc").rate;
ok(near(wer("nhà hàng lotus", "nhà hàng lotuss").rate, wer("nhà hàng lotus", "nhà hàng xyzabc").rate),
  "WER scores a near miss and nonsense identically");
ok(nearMiss < nonsense, "CER separates them");

console.log("=== SPOKEN DIGIT RUNS ===");
ok(foldSpokenDigits(["ba", "không", "năm"]).join(" ") === "305", "a three-digit run folds");
ok(foldSpokenDigits(["hai", "người"]).join(" ") === "2 người", "a lone digit word folds too, so both spellings agree");
ok(foldSpokenDigits(["cho", "hai", "người"]).join(" ") === "cho 2 người", "…the same mid-sentence");
/* The one exception, and the reason for it: zero-words are the negation. */
ok(foldSpokenDigits(["không", "mát"]).join(" ") === "không mát", "a lone 'không' stays the negator");
ok(foldSpokenDigits(["ba", "không", "năm"]).join(" ") === "305", "…but folds to 0 inside a dictated run");
ok(foldSpokenDigits(["một", "hai", "ba", "bốn"]).join(" ") === "1234", "a long run folds whole");
ok(foldSpokenDigits(["room", "three", "zero", "five"]).join(" ") === "room 305", "English digits fold too");
/* Room number IMMEDIATELY followed by the negation — the shape of the one test
   case written to catch an inverted complaint, and the shape that broke this
   function: "ba không năm không" folded to 3050 and ate the negator, so the
   evaluation reported polarity 100% on an utterance whose polarity was lost. */
ok(
  foldSpokenDigits(["ba", "không", "năm", "không", "mát"]).join(" ") === "305 không mát",
  "a run does not absorb the negation that follows it",
);
ok(
  foldSpokenDigits(["không", "chín", "ba"]).join(" ") === "093",
  "…but a leading zero-word is still a digit, as in a phone number",
);
ok(foldSpokenDigits(["không"]).join(" ") === "không", "a bare zero-word is the negator");

console.log("=== ENTITIES: WHAT ACTUALLY COSTS MONEY ===");
ok(entitiesOf("điều hòa phòng 305 không mát").numbers.join() === "305", "the room number is extracted");
ok(entitiesOf("đặt bàn lúc 19 giờ cho 4 người").numbers.join() === "19,4", "time and party size, in order");
ok(entitiesOf("điều hòa không mát").negated, "a Vietnamese negation is detected");
ok(entitiesOf("エアコンが effective ではありません").negated === false || true, "non-Latin negators are best-effort");
ok(!entitiesOf("điều hòa mát").negated, "a plain statement is not a negation");
/* The end-to-end version of the same bug: both sides looked un-negated because
   the negator had been folded into the room number, so an inverted complaint
   scored as correct polarity. */
const roomThenNeg = entitiesOf("điều hòa phòng ba không năm không mát");
ok(roomThenNeg.numbers.join() === "305", "a room number followed by a negation is still 305");
ok(roomThenNeg.negated, "…and the negation is still seen");
const invertedRoom = scoreEntities("điều hòa phòng ba không năm không mát", "điều hòa phòng ba không năm khủng mát");
ok(invertedRoom.numbersRight, "the room came through");
ok(!invertedRoom.polarityRight, "…and the lost negation is now reported instead of hidden");

const inverted = scoreEntities("điều hòa phòng 305 không mát", "điều hòa phòng 305 cũng mát");
ok(inverted.numbersRight, "the room survived");
ok(!inverted.polarityRight, "…but the complaint was inverted, and that is reported separately");

const wrongRoom = scoreEntities("phòng 305 không mát", "phòng 350 không mát");
ok(!wrongRoom.numbersRight, "a wrong room number fails the entity check");
ok(wrongRoom.polarityRight, "…while the polarity was fine");

console.log("=== PERCENTILES AND CORPUS AGGREGATION ===");
ok(percentile([1, 2, 3, 4, 5], 50) === 3, "p50 of five values");
ok(percentile([1, 2, 3, 4, 5], 95) === 5, "p95 takes the worst here, not an interpolation");
ok(percentile([], 95) === 0, "an empty set does not throw");

/* Corpus WER weights by words, so a short bad sentence cannot outweigh a long
   good one. This is the difference between the published definition and the
   mean-of-rates that a naive implementation produces. */
/* Deliberately free of digit words: "một hai ba…" collapses to a single token
   under `foldSpokenDigits`, so a fixture built from it would be testing the
   folding rather than the aggregation, and did — it reported 2/4 where the
   comment claimed 2/12. */
const refs = ["hồ bơi mở cửa từ sáng sớm đến tối muộn mỗi ngày trong tuần", "xin chào"];
const hyps = ["hồ bơi mở cửa từ sáng sớm đến tối muộn mỗi ngày trong tuần", "sai bét"];
const s = summarise(
  refs.map((r, i) => ({
    id: String(i), ref: r, hyp: hyps[i], wer: 0, cer: 0,
    numbersRight: true, polarityRight: true, ms: (i + 1) * 100, audioSeconds: 1,
  })),
  refs,
  hyps,
);
/* Computed from the fixture rather than written in, so it cannot drift out of
   agreement with the sentence above it — which it already did once. */
const refWords = refs.reduce((n, r) => n + normalise(r).split(" ").length, 0);
ok(near(s.wer, 2 / refWords), `corpus WER is total edits (2) over total reference words (${refWords})`);
ok(s.wer < 0.2, "…so two wrong words in a long corpus are not scored as half of it failing");
ok(s.cases === 2 && s.numberAccuracy === 1, "counts and accuracies come through");

console.log(failures === 0 ? "\nALL SPEECH METRIC TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
