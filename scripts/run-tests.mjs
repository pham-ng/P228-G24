#!/usr/bin/env node
// Cross-platform test runner: finds test/*.test.ts and runs each under tsx
// in its own process (these are hand-rolled scripts, not a test framework —
// each one asserts with a small `ok()` helper and exits non-zero on any
// failure, so a plain child-process loop is all a runner needs to be).
import { readdirSync, rmSync, existsSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = join(process.cwd(), "test");
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".test.ts"))
  .sort();

/**
 * Tests run against a THROWAWAY COPY of the database, never the real one.
 *
 * Several of these files exercise the real API end to end, which means they
 * create guests, conversations, messages and tasks. Without this they wrote
 * into `data.db` — the file the dev server serves from — so every run left a
 * handful of "Test Guest" rows behind. Across the August evaluation that
 * reached 432 junk conversations against 103 real ones, which drowned the
 * operations board and made every figure on the insights dashboard meaningless.
 *
 * It is a COPY rather than an empty file because `seedIfEmpty()` only creates
 * the core tables. The room packages, service groups and venue rows the tests
 * assert on arrive through `server/migrations/*`, fourteen scripts with no
 * runner that have been applied by hand over time. Starting from empty would
 * mean reimplementing that history; starting from a copy gives the tests the
 * same dataset a developer actually has.
 *
 * `storage.ts` already read DB_FILE; the runner simply never set it.
 */
const SOURCE_DB = process.env.DB_FILE || "data.db";
const TEST_DB = join(tmpdir(), `aurea-test-${process.pid}.db`);
const SUFFIXES = ["", "-wal", "-shm"];

if (existsSync(SOURCE_DB)) {
  /* Copy the WAL and shared-memory files too: with journal_mode=WAL the most
     recent commits may live only in the -wal, and a lone data.db would be a
     silently stale snapshot. SQLite recovers from them on first open. */
  for (const s of SUFFIXES) {
    if (existsSync(SOURCE_DB + s)) copyFileSync(SOURCE_DB + s, TEST_DB + s);
  }
  console.log(`DB test: ban sao cua ${SOURCE_DB} -> ${TEST_DB}`);
} else {
  console.log(`DB test: ${SOURCE_DB} khong ton tai, chay tren DB trong (seedIfEmpty).`);
  console.log("  Cac test can du lieu goi phong / nhom dich vu se that bai — chay migrations truoc.");
}

const env = { ...process.env, DB_FILE: TEST_DB, NODE_ENV: "test" };
const cleanup = () => {
  for (const s of SUFFIXES) {
    const f = TEST_DB + s;
    if (existsSync(f)) rmSync(f, { force: true });
  }
};
process.on("exit", cleanup);

let failed = 0;
for (const f of files) {
  console.log(`\n=== test/${f} ===`);
  const r = spawnSync("npx", ["tsx", join("test", f)], { stdio: "inherit", shell: true, env });
  if (r.status !== 0) failed++;
}

console.log(`\n${files.length - failed}/${files.length} test files passed.`);
process.exit(failed === 0 ? 0 : 1);
