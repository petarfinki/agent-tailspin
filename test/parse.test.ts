import { describe, expect, it } from "vitest";
import { parse } from "../src/adapters/claude-code/parse.js";
import { charTokens, totalTokens } from "../src/core/tokens.js";
import { getFixture } from "../fixtures/synthetic/catalog.js";
import { read, session } from "../fixtures/builder/index.js";

const parsed = (name: string) => {
  const b = getFixture(name).build();
  return { b, s: parse(b.jsonl) };
};

describe("parse", () => {
  it("dedupes split assistant lines: one step and one usage per message id", () => {
    const { b, s } = parsed("split-message-lines");
    expect(s.steps).toHaveLength(3);
    expect(s.steps[0]!.sourceUuids.length).toBe(5); // thinking + text + 3 tool_use lines
    expect(s.steps[0]!.toolCalls.map((c) => c.name)).toEqual(["Read", "Read", "Bash"]);
    const perMessage = new Map<string, number>();
    for (const l of b.lines as Array<Record<string, any>>)
      if (l.type === "assistant") perMessage.set(l.message.id, totalTokens({
        inputTokens: l.message.usage.input_tokens, outputTokens: l.message.usage.output_tokens,
        cacheReadTokens: l.message.usage.cache_read_input_tokens, cacheWriteTokens: l.message.usage.cache_creation_input_tokens,
        cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 }));
    const expected = [...perMessage.values()].reduce((a, x) => a + x, 0);
    expect(totalTokens(s.totals.usage)).toBe(expected);
  });

  it("attaches parallel tool results that sit off the leaf→root path", () => {
    const { s } = parsed("split-message-lines");
    for (const c of s.steps[0]!.toolCalls) expect(c.result).toBeDefined();
  });

  it("estimates tool result tokens by context delta, split across parallel results", () => {
    const { b, s } = parsed("split-message-lines");
    const calls = s.steps[0]!.toolCalls;
    for (const c of calls) {
      expect(c.result!.estMethod).toBe("context-delta");
      expect(Math.abs(c.result!.estTokens - b.truth.get(c.id)!)).toBeLessThanOrEqual(2);
    }
  });

  it("subtracts injected reminders from the delta", () => {
    const b = session().user("go").bash("make", { tokens: 5000 }).reminder(600).read("/w/a.ts", { tokens: 100 }).text().build();
    const r = parse(b.jsonl).steps[0]!.toolCalls[0]!.result!;
    expect(r.estMethod).toBe("context-delta");
    expect(Math.abs(r.estTokens - 5000)).toBeLessThanOrEqual(2);
  });

  it("falls back to the char heuristic when the delta is unusable", () => {
    const b = session().user("go").bash("make", { tokens: 5000 }).build(); // no following step
    const r = parse(b.jsonl).steps[0]!.toolCalls[0]!.result!;
    expect(r.estMethod).toBe("char-heuristic");
    expect(r.estTokens).toBe(charTokens(r.sizeChars));
  });

  it("selects the active branch after a rewind and counts abandoned tokens in totals", () => {
    const { s } = parsed("branching-rewind");
    expect(s.steps.map((st) => st.toolCalls[0]?.input.file_path ?? "text")).toEqual(["/work/demo-app/b.ts", "text"]);
    expect(s.abandoned.stepCount).toBe(3);
    expect(s.exchanges).toHaveLength(2);
    const active = s.steps.reduce((n, st) => n + totalTokens(st.usage), 0);
    expect(totalTokens(s.totals.usage)).toBe(active + totalTokens(s.abandoned.usage));
  });

  it("detects compaction by marker and context drop, and walks across the boundary", () => {
    const { s } = parsed("repeated-read-after-compaction");
    expect(s.steps).toHaveLength(4);
    // Context here stays under COMPACTION_MIN_CONTEXT, so only the markers can detect it.
    expect(s.compactions.map((c) => [c.atStepIndex, c.detectedBy])).toEqual([[1, "marker"], [2, "marker"]]);
  });

  it("detects compaction by context drop alone", () => {
    const b = getFixture("big-output-then-compaction").build();
    const boundary = b.lines.find((l) => l.subtype === "compact_boundary")!;
    const summary = b.lines.find((l) => l.isCompactSummary)!;
    // Drop the markers and re-link the line after them so the chain stays intact.
    const noMarkers = b.lines
      .filter((l) => l !== boundary && l !== summary)
      .map((l) => (l.parentUuid === summary.uuid ? { ...l, parentUuid: boundary.logicalParentUuid } : l));
    const s = parse(noMarkers.map((l) => JSON.stringify(l)).join("\n"));
    expect(s.compactions.map((c) => c.detectedBy)).toEqual(["context-drop"]);
  });

  it("tolerates a truncated last line", () => {
    const { s } = parsed("truncated-last-line");
    expect(s.warnings.map((w) => w.kind)).toContain("truncated-last-line");
    expect(s.steps.length).toBeGreaterThan(0);
  });

  it("skips unknown types with a warning and ignores unknown fields", () => {
    const { s } = parsed("unknown-fields-and-types");
    const w = s.warnings.find((x) => x.kind === "unknown-type");
    expect(w?.detail).toContain("brand-new-type");
    expect(w?.detail).toContain("× 2");
    expect(s.steps).toHaveLength(2);
  });

  it("never crashes on garbage", () => {
    for (const junk of ["", "\n\n", "null", "[1,2]", '{"type":"assistant"}', '{"type":"user","message":{"content":[null,1,{"type":"tool_result"}]}}'])
      expect(() => parse(junk)).not.toThrow();
  });

  it("reads Bash exit codes and errors", () => {
    const b = session().user("t").bash("pnpm test", { fail: "AssertionError: x", exit: 2 }).text().build();
    const r = parse(b.jsonl).steps[0]!.toolCalls[0]!.result!;
    expect(r).toMatchObject({ isError: true, exitCode: 2 });
  });

  it("keeps human prompts separate from tool results and meta lines", () => {
    const b = session().user("first").read("/w/a.ts").text().user("second").text().build();
    const s = parse(b.jsonl);
    expect(s.exchanges.map((e) => e.userText)).toEqual(["first", "second"]);
    expect(s.steps.map((st) => st.exchangeIndex)).toEqual([0, 0, 1]);
  });

  it("adds subagent usage to sidechain totals", () => {
    const main = session().user("delegate").read("/w/a.ts").text().build();
    const sub = session({ sessionId: "11111111-2222-4333-8444-555555555555" }).user("sub task").bash("ls").text().build();
    const s = parse(main.jsonl, { sidechains: [sub.jsonl] });
    expect(s.sidechains.count).toBe(1);
    expect(s.sidechains.stepCount).toBe(2);
    expect(s.steps).toHaveLength(2);
    void read;
  });
});

describe("token accounting invariants", () => {
  it("totals equal the sum over unique message ids, for every fixture (parallel calls, rewinds, compaction)", async () => {
    const { fixtures } = await import("../fixtures/synthetic/catalog.js");
    for (const f of fixtures) {
      const b = f.build();
      const byId = new Map<string, number>();
      for (const l of b.lines as Array<Record<string, any>>) {
        const u = l.type === "assistant" && typeof l.message === "object" ? l.message.usage : undefined;
        if (u) byId.set(l.message.id, u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens);
      }
      const s = parse(b.jsonl);
      if (f.name === "truncated-last-line") continue; // last message line is cut off on purpose
      expect({ f: f.name, t: totalTokens(s.totals.usage) }).toEqual({ f: f.name, t: [...byId.values()].reduce((a, x) => a + x, 0) });
      expect(s.steps.length + s.abandoned.stepCount).toBe(byId.size);
    }
  });
});

describe("real compaction shape (manual /compact, 2.1.289)", () => {
  it("detects the compaction by marker even when context barely drops, and records preserved results", () => {
    const { s } = parsed("compaction-manual-real-shape");
    expect(s.compactions).toHaveLength(1);
    expect(s.compactions[0]!.detectedBy).toBe("marker");
    expect(s.compactions[0]!.contextAfter / s.compactions[0]!.contextBefore).toBeGreaterThan(0.5); // big system prompt
    expect(s.steps).toHaveLength(6);
    expect(s.exchanges).toHaveLength(2);
  });

  it("marks file_unchanged stubs", () => {
    const { s } = parsed("repeated-read-unchanged-stubs");
    expect(s.steps.slice(1, 4).every((st) => st.toolCalls[0]!.result!.unchanged)).toBe(true);
    expect(s.steps[0]!.toolCalls[0]!.result!.unchanged).toBe(false);
  });

  it("maps preservedMessages uuids to the preserved tool calls", () => {
    const { b, s } = parsed("big-output-preserved-across-compaction");
    expect(s.compactions[0]!.preservedToolCallIds).toEqual([b.toolIds[0]]);
  });
});
