#!/usr/bin/env node
// Cross-platform test runner: finds test/*.test.ts and runs each under tsx
// in its own process (these are hand-rolled scripts, not a test framework —
// each one asserts with a small `ok()` helper and exits non-zero on any
// failure, so a plain child-process loop is all a runner needs to be).
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const dir = join(process.cwd(), "test");
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".test.ts"))
  .sort();

let failed = 0;
for (const f of files) {
  console.log(`\n=== test/${f} ===`);
  const r = spawnSync("npx", ["tsx", join("test", f)], { stdio: "inherit", shell: true });
  if (r.status !== 0) failed++;
}

console.log(`\n${files.length - failed}/${files.length} test files passed.`);
process.exit(failed === 0 ? 0 : 1);
