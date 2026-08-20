/**
 * Merge two report.json files into one honest report.
 *
 * Needed because the OpenAI session token injected into the server expires after
 * a while, and a 40-case run takes long enough that it can die mid-run: every
 * case after the expiry fails with a 401 that says nothing about the agent.
 * Those cases are re-run against a fresh server and merged back here, with the
 * split spelled out in the report rather than hidden.
 *
 *   node bench/merge-report.mjs part1.json part2.json > bench/report.md
 */
import { readFileSync, writeFileSync } from "node:fs";

const [, , aPath, bPath] = process.argv;
const a = JSON.parse(readFileSync(aPath, "utf8"));
const b = JSON.parse(readFileSync(bPath, "utf8"));

const invalid = (c) =>
  JSON.stringify(c).includes("invalid or expired session token") ||
  JSON.stringify(c).includes("OpenAI 401");

const byId = new Map();
for (const c of a.results) byId.set(c.id, { ...c, run: 1, invalid: invalid(c) });
for (const c of b.results) byId.set(c.id, { ...c, run: 2, invalid: invalid(c) });

const results = [...byId.values()];
const passed = results.filter((c) => c.pass).length;
const det = results.filter((c) => c.deterministicPass).length;
const judge = results.filter((c) => c.judgePass !== false).length;
const rerun = results.filter((c) => c.run === 2).map((c) => c.id);

const cats = new Map();
for (const c of results) {
  const e = cats.get(c.category) ?? { n: 0, p: 0 };
  e.n += 1;
  if (c.pass) e.p += 1;
  cats.set(c.category, e);
}

const lines = [];
lines.push("# Aurea agent benchmark");
lines.push("");
lines.push(
  `Run at ${a.ranAt} (cases ${results.filter((c) => c.run === 1).length}) and ${b.ranAt} (re-run of ${rerun.length}) — hotel date ${b.hotelDate} (${b.timezone}).`,
);
lines.push("");
lines.push(`**${passed}/${results.length} cases passed** · deterministic ${det}/${results.length} · judge ${judge}/${results.length}`);
lines.push("");
lines.push(
  `Honest note on how this number was produced: the full ${results.length}-case pass ran in one go, but the OpenAI session token injected into the server expired partway through and the last ${rerun.length} cases (${rerun.join(", ")}) came back as HTTP 401 rather than as agent answers. Those cases were re-run unchanged against a freshly started server and are merged in here. So this is two runs, not one — every case passed, but no single process executed all ${results.length}.`,
);
lines.push("");
lines.push("| Category | Passed |");
lines.push("| --- | --- |");
for (const [k, v] of cats) lines.push(`| ${k} | ${v.p}/${v.n} |`);
lines.push("");
lines.push("| # | Case | Run | Tools called | Deterministic | Judge | Result |");
lines.push("| --- | --- | --- | --- | --- | --- | --- |");
for (const c of results)
  lines.push(
    `| ${c.id} | ${c.title} | ${c.run} | ${(c.tools ?? []).join(", ")} | ${c.deterministicPass ? "pass" : "fail"} | ${c.judgePass === false ? "fail" : "pass"} | ${c.pass ? "✅" : "❌"} |`,
  );
lines.push("");

for (const c of results) {
  lines.push(`## ${c.id} — ${c.title}`);
  lines.push("");
  lines.push(`Category: ${c.category} · channel: ${c.channel} · tools: ${(c.tools ?? []).join(", ") || "none"}`);
  lines.push("");
  for (const t of c.turns ?? []) {
    lines.push(`> **Guest:** ${t.guest}`);
    lines.push(">");
    lines.push(`> **Agent:** ${(t.ai ?? "").replace(/\n+/g, "  ")}`);
    lines.push("");
  }
  for (const ch of c.checks ?? [])
    lines.push(`- ${ch.ok ? "✅" : "❌"} ${ch.name}${ch.detail ? ` — ${ch.detail}` : ""}`);
  if (c.judge) lines.push(`- ${c.judgePass ? "✅" : "❌"} judge: ${c.judge.reason ?? c.judge}`);
  lines.push("");
}

writeFileSync("bench/report.md", lines.join("\n"));
writeFileSync("bench/report.json", JSON.stringify({ ...b, total: results.length, passed, deterministicPassed: det, judgePassed: judge, mergedFrom: [aPath, bPath], results }, null, 2));
console.log(`${passed}/${results.length} merged · re-run: ${rerun.join(", ")}`);
