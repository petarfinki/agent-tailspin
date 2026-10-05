// D2: single tool outputs that cost the most because they stayed in context.
// Definition and guards: docs/detectors.md#output-lifetime
import type { Confidence, Detector, Evidence, Finding, PricingTable, Session, ToolCall } from "../core/types.js";
import { carryCost, commandOf, filePathOf, findingId, fmtTokens, fmtUsd, lastStepInContext } from "./util.js";

export const MIN_OUTPUT_TOKENS = 4_000;
export const MIN_LIFETIME_TOKENS = 100_000;
export const MAX_FINDINGS = 5;
export const HIGH_LIFETIME_TOKENS = 2_000_000;
export const HIGH_LIFETIME_USD = 1;

export interface OutputLifetime {
  step: number;
  call: ToolCall;
  tokens: number;
  /** Steps after first appearance that carried it. */
  laterSteps: number;
  lifetimeTokens: number;
  lifetimeCostUsd?: number;
  confidence: Confidence;
}

/** Every tool output on the active branch with its lifetime cost, largest first. */
export function outputLifetimes(session: Session, pricing: PricingTable): OutputLifetime[] {
  const out: OutputLifetime[] = [];
  for (const step of session.steps) {
    const first = step.index + 1;
    if (first >= session.steps.length) continue;
    for (const call of step.toolCalls) {
      const r = call.result;
      if (!r) continue;
      const last = lastStepInContext(session, step.index, call.id);
      const later = Math.max(0, last - first);
      const nearCompaction = session.compactions.some((c) => c.atStepIndex === first || c.atStepIndex === first + 1);
      const confidence: Confidence =
        r.estMethod === "context-delta" && !nearCompaction ? "high" : r.estMethod === "image-default" ? "low" : "medium";
      out.push({
        step: step.index,
        call,
        tokens: r.estTokens,
        laterSteps: later,
        lifetimeTokens: r.estTokens * later,
        lifetimeCostUsd: carryCost(session, first, last, r.estTokens, pricing),
        confidence,
      });
    }
  }
  return out.sort((a, b) => b.lifetimeTokens - a.lifetimeTokens || a.step - b.step || (a.call.id < b.call.id ? -1 : 1));
}

function suggestion(call: ToolCall): string | undefined {
  switch (call.name) {
    case "Read":
      return "Read a line range (offset/limit) or Grep for the relevant section instead of the whole file.";
    case "Bash":
      return "Pipe through head/tail/grep, or redirect to a file and read selectively.";
    case "Grep":
      return "Narrow the pattern or path, or list matching files first and read only what you need.";
    case "Glob":
      return "Narrow the glob pattern.";
    default:
      return undefined;
  }
}

export function describeCall(call: ToolCall, ctx: { displayPath(p: string): string; displayCommand(c: string): string }, cwd?: string): string {
  if (call.name === "Bash") return ctx.displayCommand(commandOf(call));
  const p = filePathOf(call, cwd);
  return p ? ctx.displayPath(p) : call.name;
}

export const outputLifetime: Detector = {
  id: "output-lifetime",
  run(session, ctx) {
    const findings: Finding[] = [];
    for (const o of outputLifetimes(session, ctx.pricing)) {
      if (findings.length >= MAX_FINDINGS || o.lifetimeTokens < MIN_LIFETIME_TOKENS) break;
      if (o.tokens < MIN_OUTPUT_TOKENS) continue;
      const what = describeCall(o.call, ctx, session.cwd);
      const evidence: Evidence[] = [
        { stepIndex: o.step, toolCallId: o.call.id, note: `${o.call.name} ${what} returned ~${fmtTokens(o.tokens)} tokens (${o.call.result!.estMethod})` },
        { stepIndex: o.step + 1 + o.laterSteps, note: `Still in context at step ${o.step + 1 + o.laterSteps}` },
      ];
      const cost = o.lifetimeCostUsd;
      findings.push({
        id: findingId("output-lifetime", evidence),
        detector: "output-lifetime",
        severity: o.lifetimeTokens >= HIGH_LIFETIME_TOKENS || (cost ?? 0) >= HIGH_LIFETIME_USD ? "high" : "warn",
        confidence: o.confidence,
        title: `One ${o.call.name} output (~${fmtTokens(o.tokens)} tokens) stayed in context for ${o.laterSteps} more steps`,
        summary: `${o.call.name} ${what} → ~${fmtTokens(o.lifetimeTokens)} cache-read tokens` + (cost !== undefined ? ` (est. ${fmtUsd(cost)} at current rates).` : "."),
        evidence,
        impact: {
          estTokens: o.lifetimeTokens,
          estCostUsd: cost,
          provenance: "estimated",
          method: `Output size (${o.call.result!.estMethod}) × ${o.laterSteps} later steps before compaction or session end, priced at each step's cache-read ratio (cache misses at the input rate).`,
        },
        suggestion: suggestion(o.call),
      });
    }
    return findings;
  },
};
