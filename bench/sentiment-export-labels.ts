/**
 * Turn the feedback button into a labelled sentiment dataset.
 *
 * Every thumbs-down a guest presses is a labelled negative that cost nothing to
 * collect: the guest read an answer, judged it wrong or unhelpful, and said so.
 * Every thumbs-up is a labelled non-negative. The message that produced the
 * reply is sitting right there in the same conversation.
 *
 * Nothing here changes the schema — it joins `feedback` to the guest message
 * that preceded the rated reply, and writes the pair out as JSONL. That file is
 * what makes the "is the centroid good enough, or do we need a fine-tuned
 * head?" question answerable with evidence instead of opinion.
 *
 * Also exports the shadow-mode log lines if a log file is supplied, so a
 * deployment running with LOCAL_SENTIMENT_ACT unset accumulates a second,
 * larger (unlabelled) set to sample from.
 *
 *   npx tsx bench/sentiment-export-labels.ts [out.jsonl]
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import Database from "better-sqlite3";

const OUT = process.argv[2] || "bench/sentiment-labels.jsonl";
const db = new Database("data.db");

type Row = { id: number; conversationId: number; rating: number; comment: string | null; createdAt: string };
const feedback = db
  .prepare("select id, conversation_id as conversationId, rating, comment, created_at as createdAt from feedback")
  .all() as Row[];

const lines: string[] = [];
let noMessage = 0;

/* The client sends `messageId` with every rating and the API accepts it, but
 * the `feedback` table has no column for it, so the link to the exact reply is
 * dropped on write. Matching on timestamp is the best available substitute:
 * take the last guest message posted before the feedback arrived. It is right
 * in the ordinary case (guest asks, reads the answer, rates it) and wrong only
 * when a guest rates an older reply after sending newer messages.
 *
 * Worth fixing at the source — one column — because without it you cannot tell
 * WHICH answer a guest disliked, only which conversation. */
for (const f of feedback) {
  const guest = db
    .prepare(
      `select body from messages
       where conversation_id = ? and role = 'guest' and created_at <= ?
       order by created_at desc, id desc limit 1`,
    )
    .get(f.conversationId, f.createdAt) as { body: string } | undefined;

  if (!guest?.body) {
    noMessage++;
    continue;
  }
  lines.push(
    JSON.stringify({
      text: guest.body.replace(/\s+/g, " ").trim(),
      /* rating 1-2 is the thumbs-down path (see the feedback route, which
         escalates on rating < 3); 4-5 is a clear thumbs-up. 3 is deliberately
         dropped rather than guessed at. */
      label: f.rating <= 2 ? "negative" : f.rating >= 4 ? "not_negative" : null,
      rating: f.rating,
      comment: f.comment,
      source: "guest_feedback",
      conversationId: f.conversationId,
      at: f.createdAt,
    }),
  );
}

const usable = lines.filter((l) => JSON.parse(l).label !== null);
writeFileSync(OUT, usable.join("\n") + (usable.length ? "\n" : ""));

const byLabel: Record<string, number> = {};
usable.forEach((l) => {
  const k = JSON.parse(l).label;
  byLabel[k] = (byLabel[k] || 0) + 1;
});

console.log(`feedback rows      : ${feedback.length}`);
console.log(`  bỏ (không tìm được tin nhắn khách): ${noMessage}`);
console.log(`  bỏ (rating = 3, không rõ nhãn)    : ${lines.length - usable.length}`);
console.log(`ghi ra ${OUT}: ${usable.length} ví dụ có nhãn  ${JSON.stringify(byLabel)}`);

if (usable.length < 100) {
  console.log(
    `\nChưa đủ để kết luận. Cần vài trăm ví dụ trước khi so sánh backend —\n` +
      `đến lúc đó hãy chạy ở chế độ shadow (LOCAL_SENTIMENT_ACT không bật) và để nhãn tích lại.`,
  );
}
