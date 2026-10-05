import { describe, expect, it } from "vitest";
import { parse } from "../src/adapters/claude-code/parse.js";
import { analyze, defaultPricing } from "../src/analyze.js";
import { outputLifetimes } from "../src/detectors/output-lifetime.js";
import { detectors } from "../src/detectors/index.js";
import { fixtures, getFixture } from "../fixtures/synthetic/catalog.js";
import { bash, edit, read, session } from "../fixtures/builder/index.js";

const run = (jsonl: string) => analyze(parse(jsonl), { minConfidence: "low" });
const runFixture = (name: string) => run(getFixture(name).build().jsonl);

describe("detector fixtures (expected finding counts)", () => {
  it.each(fixtures.map((f) => [f.name, f]))("%s", (_name, f) => {
    const { findings } = run(f.build().jsonl);
    for (const d of detectors) {
      expect({ detector: d.id, count: findings.filter((x) => x.detector === d.id).length }).toEqual({
        detector: d.id,
        count: f.expect[d.id] ?? 0,
      });
    }
  });
});

describe("finding invariants", () => {
  it("every finding has evidence, a method, and a stable id; output is deterministic", () => {
    for (const f of fixtures) {
      const a = run(f.build().jsonl);
      const b = run(f.build().jsonl);
      expect(JSON.stringify(a.findings)).toBe(JSON.stringify(b.findings));
      for (const x of a.findings) {
        expect(x.evidence.length).toBeGreaterThan(0);
        expect(x.impact.method.length).toBeGreaterThan(0);
        expect(x.id.startsWith(`${x.detector}:`)).toBe(true);
      }
    }
  });
});

describe("repeated-reads", () => {
  it("counts all normalized spellings of one path and reports redundant tokens", () => {
    const [f] = runFixture("repeated-read-positive").findings;
    expect(f!.title).toContain("src/db/pool.ts");
    expect(f!.title).toContain("4 times");
    expect(f!.evidence).toHaveLength(4);
    expect(f!.severity).toBe("warn"); // 3 redundant, ~9.6k tokens
    expect(f!.impact.estTokens).toBeGreaterThan(9000);
    expect(f!.impact.estTokens).toBeLessThan(10_000);
  });

  it("is high severity at 4+ redundant reads", () => {
    const b = session().user("x");
    for (let i = 0; i < 5; i++) b.read("/work/demo-app/src/a.ts", { tokens: 1000 });
    const [f] = run(b.text().build().jsonl).findings;
    expect(f!.severity).toBe("high");
  });

  it("does not treat a read past a truncated whole-file read as a repeat", () => {
    // First read returns lines 1..N only; a later offset read beyond N is new content.
    const b = session().user("x").read("/work/demo-app/big.ts", { tokens: 2000 }).read("/work/demo-app/big.ts", { tokens: 2000, offset: 5000, limit: 100 }).read("/work/demo-app/big.ts", { tokens: 2000, offset: 6000, limit: 100 });
    expect(run(b.text().build().jsonl).findings).toHaveLength(0);
  });

  it("suppresses when a global modifier (git checkout, formatter) ran in between", () => {
    for (const cmd of ["git checkout main", "npx prettier --write .", "git stash pop"]) {
      const b = session().user("x").read("/work/demo-app/a.ts", { tokens: 1000 }).bash(cmd).read("/work/demo-app/a.ts", { tokens: 1000 }).read("/work/demo-app/a.ts", { tokens: 1000 });
      expect(run(b.text().build().jsonl).findings.filter((f) => f.detector === "repeated-reads")).toHaveLength(0);
    }
  });

  it("ignores redirects to unrelated files and /dev/null", () => {
    const b = session().user("x").read("/work/demo-app/a.ts", { tokens: 1000 }).bash("pnpm test > /tmp/out.txt 2>&1").read("/work/demo-app/a.ts", { tokens: 1000 }).read("/work/demo-app/a.ts", { tokens: 1000 });
    expect(run(b.text().build().jsonl).findings.filter((f) => f.detector === "repeated-reads")).toHaveLength(1);
  });

  it("suppresses after a subagent ran (it may have edited files)", () => {
    const b = session().user("x").read("/work/demo-app/a.ts", { tokens: 1000 }).step([{ name: "Agent", input: { prompt: "fix" }, tokens: 100, text: "done" }]).read("/work/demo-app/a.ts", { tokens: 1000 }).read("/work/demo-app/a.ts", { tokens: 1000 });
    // Only the two reads after the Agent call remain comparable: one redundant read, not emitted.
    expect(run(b.text().build().jsonl).findings).toHaveLength(0);
  });
});

describe("output-lifetime", () => {
  it("fires with high confidence on a measured, long-lived output", () => {
    const [f] = runFixture("big-output-long-lived").findings;
    expect(f!.confidence).toBe("high");
    expect(f!.title).toContain("Bash");
    expect(f!.title).toContain("40 more steps");
    expect(f!.impact.estTokens).toBe(12_000 * 40);
    expect(f!.suggestion).toMatch(/head|tail|grep/);
  });

  it("truncates lifetime at a compaction", () => {
    const [f] = runFixture("big-output-then-compaction").findings;
    expect(f!.title).toContain("11 more steps");
    expect(f!.impact.estTokens).toBe(12_000 * 11);
  });

  it("is never high confidence on a char-heuristic estimate", () => {
    // Unlogged context growth right after the output makes the delta fail its sanity check.
    const b = session().user("x").bash("pnpm build", { tokens: 12_000 }).invisible(60_000);
    for (let i = 0; i < 30; i++) b.read(`/work/demo-app/m${i}.ts`, { tokens: 300 });
    const fs = run(b.text().build().jsonl).findings.filter((f) => f.detector === "output-lifetime");
    expect(fs).toHaveLength(1);
    expect(fs[0]!.confidence).toBe("medium");
  });

  it("caps at 5 findings per session", () => {
    const b = session().user("x");
    for (let i = 0; i < 8; i++) b.bash(`pnpm build --pkg ${i}`, { tokens: 6_000 });
    for (let i = 0; i < 30; i++) b.read(`/work/demo-app/m${i}.ts`, { tokens: 300 });
    expect(run(b.text().build().jsonl).findings.filter((f) => f.detector === "output-lifetime")).toHaveLength(5);
  });
});

describe("failure-loops", () => {
  it("reports every failing step with a signature and severity by repetitions", () => {
    const [f] = runFixture("failure-loop-edit-test").findings;
    expect(f!.evidence).toHaveLength(4);
    expect(f!.title).toContain("4");
    expect(f!.summary).toContain("AssertionError");
    expect(f!.severity).toBe("high"); // spans >= 25% of the session
    expect(new Set(f!.evidence.map((e) => e.note.match(/sig [0-9a-f]+/)![0])).size).toBe(1);
  });

  it("treats volatile parts (paths, numbers, durations) as the same signature", () => {
    const b = session().user("x");
    for (let i = 0; i < 3; i++) {
      b.step([edit("/w/a.ts")]);
      b.step([bash("pnpm test", { fail: `AssertionError at /tmp/run-${i}/a.test.ts:${10 + i}:5 after ${100 + i}ms`, tokens: 300 })]);
    }
    expect(run(b.text().build().jsonl).findings.filter((f) => f.detector === "failure-loops")).toHaveLength(1);
  });

  it("respects a custom polling allowlist", () => {
    const b = session().user("x");
    for (let i = 0; i < 3; i++) b.bash("./wait-for-db.sh", { fail: "db not ready", tokens: 50 });
    const jsonl = b.text().build().jsonl;
    expect(run(jsonl).findings).toHaveLength(1);
    expect(analyze(parse(jsonl), { minConfidence: "low", detectorOptions: { pollingPatterns: ["wait-for-db"] } }).findings).toHaveLength(0);
  });

  it("does not chain failures more than 15 steps apart", () => {
    const b = session().user("x");
    for (let i = 0; i < 3; i++) {
      b.step([edit("/w/a.ts")]);
      b.step([bash("pnpm test", { fail: "AssertionError: x", tokens: 300 })]);
      for (let j = 0; j < 15; j++) b.step([read(`/w/f${i}-${j}.ts`, { tokens: 100 })]);
    }
    expect(run(b.text().build().jsonl).findings.filter((f) => f.detector === "failure-loops")).toHaveLength(0);
  });
});

describe("analyze", () => {
  it("filters by confidence and computes cost", () => {
    const r = analyze(parse(getFixture("big-output-long-lived").build().jsonl), { minConfidence: "high" });
    expect(r.findings).toHaveLength(1);
    expect(r.session.totals.estCostUsd).toBeGreaterThan(0);
  });
});

describe("cross-detector overlap", () => {
  const filler = (b: ReturnType<typeof session>, n: number) => {
    for (let i = 0; i < n; i++) b.step([read(`/w/filler${i}.ts`, { tokens: 200 })]);
    return b;
  };

  it("keeps the lifetime finding for the first read of a re-read file", () => {
    const b = session().user("x").read("/w/big.ts", { tokens: 20_000 });
    filler(b, 3).read("/w/big.ts", { tokens: 20_000 }).read("/w/big.ts", { tokens: 20_000 });
    const fs = run(filler(b, 30).text().build().jsonl).findings;
    const d1 = fs.find((f) => f.detector === "repeated-reads")!;
    const d2 = fs.filter((f) => f.detector === "output-lifetime");
    const firstRead = d1.evidence[0]!.toolCallId;
    expect(d2.map((f) => f.evidence[0]!.toolCallId)).toContain(firstRead);
    // ...but not for the redundant copies, whose lifetime D1 already counts.
    for (const e of d1.evidence.slice(1)) expect(d2.map((f) => f.evidence[0]!.toolCallId)).not.toContain(e.toolCallId);
  });

  it("keeps the lifetime finding for a huge failing output inside a failure loop", () => {
    const b = session().user("x");
    for (let i = 0; i < 3; i++) b.edit("/w/a.ts").bash("pnpm test", { fail: "AssertionError: boom", tokens: 9_000 });
    const fs = run(filler(b, 30).text().build().jsonl).findings;
    expect(fs.filter((f) => f.detector === "failure-loops")).toHaveLength(1);
    expect(fs.filter((f) => f.detector === "output-lifetime").length).toBeGreaterThan(0);
  });
});

describe("compaction semantics", () => {
  it("D2 lifetime continues across a compaction that preserved the output", () => {
    const [f] = runFixture("big-output-preserved-across-compaction").findings;
    expect(f!.title).toContain("20 more steps");
  });

  it("D2 lifetime stops at a compaction that didn't preserve it (real shape)", () => {
    const s = parse(getFixture("compaction-manual-real-shape").build().jsonl);
    const firstRead = outputLifetimes(s, defaultPricing).find((o) => o.step === 1)!;
    expect(s.compactions[0]!.atStepIndex).toBe(4);
    expect(firstRead.laterSteps).toBe(1); // carried by step 3 only, dropped at the boundary
  });
});
