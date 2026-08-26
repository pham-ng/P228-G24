import "dotenv/config";
import { readFileSync } from "node:fs";
import { hybridSearch, corpusDocs } from "../server/retrieval";
import { relevantKeys } from "../server/ireval";
import { migrate } from "../server/storage";

type Case = { id: string; lang: string; query: string; relevant: any[] };
const golden = JSON.parse(readFileSync("bench/retrieval-golden.json", "utf8")) as { cases: Case[] };

async function main() {
  migrate();
  const docs = corpusDocs();
  const docKeyByTitle = new Map(docs.map((d) => [d.title, d.docKey]));
  let hits5 = 0;
  const misses: string[] = [];
  for (const c of golden.cases) {
    const rel = relevantKeys(docs, c.relevant);
    const r = await hybridSearch(c.query, { k: 5 });
    const gotKeys = r.results.map((x) => docKeyByTitle.get(x.title)).filter(Boolean) as string[];
    const hit = gotKeys.some((k) => rel.has(k));
    if (hit) hits5++;
    else misses.push(c.id);
  }
  console.log("hit@5 with depth-fix + phrase-boost:", hits5 + "/" + golden.cases.length, `(${(100*hits5/golden.cases.length).toFixed(1)}%)`);
  console.log("misses:", misses.join(", ") || "(none)");
}
main();
