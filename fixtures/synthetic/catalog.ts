// Synthetic fixture catalog (PRODUCT.md §14). Each entry builds a session and states what must happen.
// `npm run fixtures` writes them to fixtures/synthetic/*.jsonl; a test checks the files don't drift.
import { bash, read, session, tool, type BuildResult } from "../builder/index.js";

export interface Fixture {
  name: string;
  build(): BuildResult;
  /** Expected finding count per detector id (omitted detectors: 0). */
  expect: Record<string, number>;
}

const P = "/work/demo-app/src/db/pool.ts";

export const fixtures: Fixture[] = [
  {
    name: "repeated-read-positive",
    expect: { "repeated-reads": 1 },
    build: () =>
      session()
        .user("Why is the pool test flaky?")
        .read(P, { tokens: 3200 })
        .bash("pnpm test pool", { tokens: 200 })
        .read(P, { tokens: 3200 })
        .read("src/db/pool.ts", { tokens: 3200 }) // relative to cwd, same file
        .bash("grep -n acquire src/db/pool.ts", { tokens: 100 })
        .read("./src/db/pool.ts", { tokens: 3200 })
        .text()
        .build(),
  },
  {
    name: "repeated-read-edit-between",
    expect: {},
    build: () =>
      session()
        .user("Fix the pool")
        .read(P, { tokens: 3200 })
        .edit(P)
        .read(P, { tokens: 3200 })
        .edit(P)
        .read(P, { tokens: 3200 })
        .bash("sed -i 's/a/b/' src/db/pool.ts")
        .read(P, { tokens: 3200 })
        .text()
        .build(),
  },
  {
    name: "repeated-read-after-compaction",
    expect: {},
    build: () =>
      session()
        .user("Fix the pool")
        .read(P, { tokens: 3200 })
        .compact()
        .read(P, { tokens: 3200 })
        .compact()
        .read(P, { tokens: 3200 })
        .text()
        .build(),
  },
  {
    name: "repeated-read-different-ranges",
    expect: {},
    build: () =>
      session()
        .user("Look at the big file")
        .read(P, { tokens: 1200, offset: 1, limit: 50 })
        .read(P, { tokens: 1200, offset: 400, limit: 50 })
        .read(P, { tokens: 1200, offset: 900, limit: 50 })
        .read(P, { tokens: 1200, offset: 51, limit: 100 })
        .text()
        .build(),
  },
  {
    name: "repeated-read-external-edit",
    expect: {},
    build: () =>
      session()
        .user("Check the pool")
        .read(P, { tokens: 3200 })
        .text()
        .editedExternally(P)
        .user("I changed it, look again")
        .read(P, { tokens: 3200 })
        .text()
        .editedExternally(P)
        .user("and again")
        .read(P, { tokens: 3200 })
        .text()
        .build(),
  },
  {
    name: "big-output-long-lived",
    expect: { "output-lifetime": 1 },
    build: () => {
      const b = session().user("Why does the build fail?").bash("pnpm build 2>&1", { tokens: 12_000 });
      for (let i = 0; i < 40; i++) b.step([read(`/work/demo-app/src/mod${i}.ts`, { tokens: 300 })]);
      return b.text().build();
    },
  },
  {
    name: "big-output-then-compaction",
    expect: { "output-lifetime": 1 },
    build: () => {
      const b = session().user("Why does the build fail?").bash("pnpm build 2>&1", { tokens: 12_000 });
      for (let i = 0; i < 12; i++) b.step([read(`/work/demo-app/src/mod${i}.ts`, { tokens: 300 })]);
      b.compact();
      for (let i = 0; i < 20; i++) b.step([read(`/work/demo-app/src/other${i}.ts`, { tokens: 300 })]);
      return b.text().build();
    },
  },
  {
    name: "big-output-short-lived",
    expect: {},
    build: () =>
      session()
        .user("Show me the log")
        .bash("cat build.log", { tokens: 12_000 })
        .read("/work/demo-app/src/a.ts", { tokens: 300 })
        .text()
        .build(),
  },
  {
    name: "failure-loop-edit-test",
    expect: { "failure-loops": 1 },
    build: () => {
      const b = session().user("Make the pool test pass");
      for (let i = 0; i < 4; i++) {
        b.edit(P);
        b.bash("pnpm test pool", { fail: "AssertionError: expected 3 to equal 4", tokens: 1800 });
      }
      return b.text().build();
    },
  },
  {
    name: "failure-progress-changing-errors",
    expect: {},
    build: () =>
      session()
        .user("Make the tests pass")
        .edit(P)
        .bash("pnpm test", { fail: "TypeError: pool.acquire is not a function", tokens: 800 })
        .edit(P)
        .bash("pnpm test", { fail: "ReferenceError: timeout is not defined", tokens: 800 })
        .edit(P)
        .bash("pnpm test", { fail: "AssertionError: expected 3 to equal 4", tokens: 800 })
        .edit(P)
        .bash("pnpm test", { fail: "AssertionError: expected 2 to equal 1 in release()", tokens: 800 })
        .text()
        .build(),
  },
  {
    name: "failure-polling-allowlisted",
    expect: {},
    build: () =>
      session()
        .user("Start the server and wait for it")
        .bash("pnpm dev &", { tokens: 50 })
        .bash("curl -sf http://localhost:3000/health", { fail: "curl: (7) Failed to connect to localhost port 3000", exit: 7 })
        .bash("curl -sf http://localhost:3000/health", { fail: "curl: (7) Failed to connect to localhost port 3000", exit: 7 })
        .bash("curl -sf http://localhost:3000/health", { fail: "curl: (7) Failed to connect to localhost port 3000", exit: 7 })
        .bash("curl -sf http://localhost:3000/health", { fail: "curl: (7) Failed to connect to localhost port 3000", exit: 7 })
        .text()
        .build(),
  },
  {
    name: "failure-loop-blind-retry",
    expect: { "failure-loops": 1 },
    build: () =>
      session()
        .user("Install deps")
        .bash("pnpm install", { fail: "ERR_PNPM_FETCH_404 GET https://registry.example/pkg: Not Found - 404", tokens: 400 })
        .bash("pnpm install", { fail: "ERR_PNPM_FETCH_404 GET https://registry.example/pkg: Not Found - 404", tokens: 400 })
        .bash("pnpm install", { fail: "ERR_PNPM_FETCH_404 GET https://registry.example/pkg: Not Found - 404", tokens: 400 })
        .text()
        .build(),
  },
  {
    name: "failure-fixed-in-between",
    expect: {},
    build: () =>
      session()
        .user("Fix and keep going")
        .edit(P)
        .bash("pnpm test pool", { fail: "AssertionError: expected 3 to equal 4", tokens: 800 })
        .edit(P)
        .bash("pnpm test pool", { tokens: 200 })
        .edit(P)
        .bash("pnpm test pool", { fail: "AssertionError: expected 3 to equal 4", tokens: 800 })
        .edit(P)
        .bash("pnpm test pool", { tokens: 200 })
        .edit(P)
        .bash("pnpm test pool", { fail: "AssertionError: expected 3 to equal 4", tokens: 800 })
        .text()
        .build(),
  },
  {
    name: "split-message-lines",
    expect: {},
    build: () =>
      session({ thinking: true })
        .user("Read three files")
        .step([read("/work/demo-app/a.ts", { tokens: 900 }), read("/work/demo-app/b.ts", { tokens: 300 }), bash("ls", { tokens: 40 })], { text: "Reading." })
        .step([tool("Grep", { pattern: "pool" }, 120)])
        .text()
        .build(),
  },
  {
    name: "branching-rewind",
    expect: {},
    build: () =>
      session()
        .user("Try approach A")
        .checkpoint("start")
        .read("/work/demo-app/a.ts", { tokens: 900 })
        .edit("/work/demo-app/a.ts")
        .text()
        .rewindTo("start")
        .user("Actually, try approach B")
        .read("/work/demo-app/b.ts", { tokens: 400 })
        .text()
        .build(),
  },
  {
    name: "truncated-last-line",
    expect: {},
    build: () => {
      const r = session().user("hi").read("/work/demo-app/a.ts", { tokens: 500 }).text().build();
      return { ...r, jsonl: r.jsonl.trimEnd().slice(0, -40) };
    },
  },
  {
    name: "unknown-fields-and-types",
    expect: {},
    build: () =>
      session()
        .raw({ type: "file-history-snapshot", messageId: "x", snapshot: {} })
        .raw({ type: "brand-new-type", sessionId: "11111111-2222-4333-8444-555555555555", payload: 1 })
        .raw({ type: "brand-new-type" })
        .raw({ type: "assistant", message: "not an object" })
        .user("hi")
        .read("/work/demo-app/a.ts", { tokens: 500 })
        .raw({ type: "user", uuid: "u-x", parentUuid: null, someFutureField: { nested: [1, 2] } })
        .text()
        .build(),
  },
  {
    name: "sentinel-secrets",
    expect: { "repeated-reads": 1, "failure-loops": 1 },
    build: () => {
      const secretPath = "/Users/sentinel-home/corp-secret-project/src/config/secrets.ts";
      const b = session({ cwd: "/Users/sentinel-home/corp-secret-project" })
        .user("Use key sk-test-SENTINEL-123 and email sentinel.person@example-corp.test against db.internal.sentinel-corp.test");
      b.read(secretPath, { tokens: 2000 });
      b.read(secretPath, { tokens: 2000 });
      b.read(secretPath, { tokens: 2000 });
      for (let i = 0; i < 3; i++) {
        b.edit(secretPath);
        b.bash("API_KEY=sk-test-SENTINEL-123 curlx https://db.internal.sentinel-corp.test/migrate", {
          fail: "AuthError: key sk-test-SENTINEL-123 rejected for sentinel.person@example-corp.test at /Users/sentinel-home/corp-secret-project",
          tokens: 500,
        });
      }
      return b.text().build();
    },
  },
];

export const SENTINELS = [
  "sk-test-SENTINEL-123",
  "sentinel-home",
  "corp-secret-project",
  "sentinel.person@example-corp.test",
  "db.internal.sentinel-corp.test",
  "secrets.ts",
];

export const getFixture = (name: string): Fixture => {
  const f = fixtures.find((x) => x.name === name);
  if (!f) throw new Error(`unknown fixture ${name}`);
  return f;
};

