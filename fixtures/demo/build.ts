// The bundled --demo session: synthetic, plausible, and exhibiting every detector plus a compaction.
// Regenerate with `npm run fixtures`; the README screenshot comes from this exact file.
import { read, session, tool } from "../builder/index.js";

const ROOT = "/home/dev/acme-api";
const POOL = `${ROOT}/src/db/pool.ts`;

export function buildDemo() {
  const b = session({ cwd: ROOT, sessionId: "d3m0d3m0-0000-4000-8000-000000000001", systemTokens: 14_000, thinking: true });
  b.user("The connection pool test is flaky in CI. Can you find out why and fix it?");
  b.step([read(POOL, { tokens: 4200 }), read(`${ROOT}/test/pool.test.ts`, { tokens: 2600 })], { text: "Let me look at the pool and its test." });
  b.bash("pnpm vitest run test/pool.test.ts", { fail: "AssertionError: expected 3 to equal 4 (activeConnections after release)", tokens: 1900 });
  b.bash("pnpm vitest run 2>&1", { tokens: 15_500, out: " RUN  v3.2.0 /home/dev/acme-api\n" });
  b.read(POOL, { tokens: 4200 });
  b.step([tool("Grep", { pattern: "release\\(", path: "src" }, 600)]);
  b.read(POOL, { tokens: 4200 });
  b.bash("git log --oneline -15 -- src/db/pool.ts", { tokens: 300 });
  b.read(POOL, { tokens: 4200 });
  b.step([read(`${ROOT}/src/db/client.ts`, { tokens: 2400 }), read(`${ROOT}/src/config.ts`, { tokens: 1100 })]);
  b.read(POOL, { tokens: 4200 });
  for (let i = 0; i < 4; i++) {
    b.edit(POOL);
    b.bash("pnpm vitest run test/pool.test.ts", { fail: "AssertionError: expected 3 to equal 4 (activeConnections after release)", tokens: 1900 });
  }
  b.step([read(`${ROOT}/src/db/transaction.ts`, { tokens: 2900 })], { text: "Same failure four times. Stepping back to check how transactions return connections." });
  for (const f of ["src/db/health.ts", "src/db/retry.ts", "src/db/metrics.ts", "test/helpers/db.ts", "test/setup.ts", "vitest.config.ts"])
    b.read(`${ROOT}/${f}`, { tokens: 1400 });
  b.bash("grep -rn 'pool.release' src test", { tokens: 700 });
  for (let i = 0; i < 8; i++) b.step([tool("Grep", { pattern: `acquire${i}`, path: "src" }, 250)]);
  b.compact({ summaryTokens: 3500 });
  b.read(POOL, { tokens: 4200 });
  b.edit(`${ROOT}/src/db/transaction.ts`);
  b.bash("pnpm vitest run test/pool.test.ts", { tokens: 400, out: " ✓ test/pool.test.ts (12 tests) 412ms\n" });
  b.bash("pnpm vitest run", { tokens: 900, out: " Test Files  48 passed (48)\n" });
  b.text("Fixed: `withTransaction` released the connection twice on rollback, so the pool's active count drifted. All 48 test files pass.");
  b.user("Nice. Add a changelog entry too.");
  b.read(`${ROOT}/CHANGELOG.md`, { tokens: 1800 });
  b.edit(`${ROOT}/CHANGELOG.md`);
  b.text("Added under Unreleased → Fixed.");
  return b.build();
}
