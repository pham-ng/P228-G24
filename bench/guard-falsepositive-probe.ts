/**
 * Does the screening refuse guests it should be answering?
 *
 * Every guard in this codebase is a trade: catching more means firing more, and
 * firing on an ordinary question is the failure that happens every day rather
 * than never. The prohibited-items lexicon was just widened from drugs-only to
 * three categories across six languages, so the question "will it now block
 * real guests" deserves a number rather than an argument.
 *
 * Run against the release evaluation set — 403 atomic cases plus every turn of
 * 60 conversations, all of them things a real guest asks. NONE of them should
 * be refused. Anything that trips is a false positive on genuine traffic and is
 * printed in full so the pattern behind it can be fixed or removed.
 *
 *   npx tsx bench/guard-falsepositive-probe.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { screenGuestMessage, type GuardFlag } from "../server/guard";

const data = JSON.parse(
  readFileSync(join(process.cwd(), "bench/baselines/kiosk-validation/FINAL-LOCAL-EVAL-CASES.json"), "utf8"),
) as {
  atomic: { case_id: string; language: string; user_query: string; category: string }[];
  conversations: { conv_id: string; turns: { user?: string; user_query?: string }[] }[];
};

type Utterance = { id: string; lang: string; text: string };

const utterances: Utterance[] = [
  ...data.atomic.map((c) => ({ id: c.case_id, lang: c.language, text: c.user_query })),
  ...data.conversations.flatMap((c, ci) =>
    (c.turns ?? []).map((t, ti) => ({
      id: `${c.conv_id ?? `conv${ci}`}#${ti + 1}`,
      lang: "?",
      text: t.user ?? t.user_query ?? "",
    })),
  ),
].filter((u) => typeof u.text === "string" && u.text.trim().length > 0);

/* The flags that REFUSE or divert a guest. Emergency flags are excluded: those
   escalating on a real evaluation case is correct behaviour, not a false
   positive. */
const REFUSING: GuardFlag[] = [
  "prohibited_substance",
  "adult_service_request",
  "weapon_request",
  "prompt_injection",
  "third_party_disclosure",
];

console.log(`${utterances.length} câu khách thật (${data.atomic.length} atomic + ${utterances.length - data.atomic.length} lượt hội thoại)\n`);

const hits: { u: Utterance; flags: GuardFlag[] }[] = [];
const byFlag: Record<string, number> = {};

for (const u of utterances) {
  const flags = screenGuestMessage(u.text).flags.filter((f) => REFUSING.includes(f));
  if (!flags.length) continue;
  hits.push({ u, flags });
  for (const f of flags) byFlag[f] = (byFlag[f] ?? 0) + 1;
}

if (!hits.length) {
  console.log("Không câu nào bị chặn. 0 báo nhầm trên toàn bộ bộ đánh giá.");
} else {
  console.log(`${hits.length}/${utterances.length} câu bị chặn — xem từng câu:\n`);
  for (const { u, flags } of hits) {
    console.log(`  [${u.lang}] ${u.id}  {${flags.join(",")}}`);
    console.log(`      ${u.text.slice(0, 110)}`);
  }
  console.log("\ntheo loại cờ:");
  for (const [f, n] of Object.entries(byFlag).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${f.padEnd(24)} ${n}`);
  }
}

const rate = (100 * hits.length) / utterances.length;
console.log(`\ntỉ lệ báo nhầm: ${rate.toFixed(2)}%`);
process.exit(0);
