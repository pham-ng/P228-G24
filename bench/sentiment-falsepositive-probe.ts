/**
 * How often does the sentiment net fire on REAL guest traffic?
 *
 * There is no labelled complaint set in this repo — 295 conversations carry
 * both a sentiment label and guest messages, and 293 of them are "neutral", so
 * recall cannot be measured here at all. What CAN be measured without labels is
 * the precision side: run every real guest message through the net and look at
 * what it flags. A net that fires on 30% of "mấy giờ ăn sáng" is broken no
 * matter what a hand-written test says.
 *
 * Every message here was written by someone else — seed authors or live use —
 * which is the point. The 20-case check in the sentiment test was written by
 * the same person who wrote the prototypes, and that is not evidence.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { embed } from "../server/llm";
import { classifyVector, SENTIMENT_PROTOTYPES, SENTIMENT_MARGIN } from "../server/sentiment-net";

const LIMIT = Number(process.argv[2] || 250);

const db = new Database("data.db");
const rows = db
  .prepare(
    `select distinct body from messages
     where role='guest' and length(body) > 8
     order by id desc limit ?`,
  )
  .all(LIMIT) as { body: string }[];

/* Quick-reply chips ("🍽️ Menu nhà hàng") are button labels, not typed
   sentences — including them would flatter the false-positive rate. */
const msgs = rows.map((r) => r.body).filter((b) => !/^[\p{Emoji}\s]/u.test(b));
console.log(`${msgs.length} tin nhắn khách thật (đã bỏ ${rows.length - msgs.length} nhãn nút bấm)\n`);

const protoVecs = await embed(SENTIMENT_PROTOTYPES.map((p) => p.text));

const flagged: { text: string; margin: number }[] = [];
const BATCH = 32;
for (let i = 0; i < msgs.length; i += BATCH) {
  const slice = msgs.slice(i, i + BATCH);
  const vecs = await embed(slice);
  slice.forEach((text, j) => {
    const v = classifyVector(vecs[j], SENTIMENT_PROTOTYPES, protoVecs);
    if (v && v.label === "negative" && v.margin >= SENTIMENT_MARGIN) flagged.push({ text, margin: v.margin });
  });
  process.stderr.write(`\r  ${Math.min(i + BATCH, msgs.length)}/${msgs.length}   `);
}
process.stderr.write("\r" + " ".repeat(30) + "\r");

console.log(`Báo động: ${flagged.length}/${msgs.length} = ${((100 * flagged.length) / msgs.length).toFixed(1)}%\n`);
console.log("=== TẤT CẢ các tin bị gắn cờ (tự đọc và tự đánh giá) ===");
flagged
  .sort((a, b) => b.margin - a.margin)
  .forEach((f) => console.log(`  margin=${f.margin.toFixed(3)}  ${f.text.replace(/\s+/g, " ").slice(0, 96)}`));
process.exit(0);
