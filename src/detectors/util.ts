import { hash, normalizePath } from "../core/text.js";
import { lookupPrice, priceUsage } from "../core/tokens.js";
import type { Evidence, PricingTable, Session, Step, ToolCall } from "../core/types.js";

export const WRITE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
/** Tools that may change files we can't see (subagents). */
export const OPAQUE_WRITERS = new Set(["Agent", "Task"]);

export const findingId = (detector: string, evidence: Evidence[]): string =>
  `${detector}:${hash(evidence.map((e) => `${e.stepIndex}:${e.toolCallId ?? ""}`).join(","))}`;

export function filePathOf(call: ToolCall, cwd?: string): string | undefined {
  const p = call.input.file_path ?? call.input.notebook_path ?? call.input.path;
  return typeof p === "string" && p ? normalizePath(p, cwd) : undefined;
}

export const commandOf = (call: ToolCall): string => (typeof call.input.command === "string" ? call.input.command : "");

/** Index of the last step that still carries a result produced at step `i` (before compaction/end). */
export function lastStepInContext(session: Session, i: number): number {
  const next = session.compactions.find((c) => c.atStepIndex > i + 1);
  return next ? next.atStepIndex - 1 : session.steps.length - 1;
}

/** Steps after the result's first appearance (step i+1) that re-read it from context. */
export const laterSteps = (session: Session, i: number): number => Math.max(0, lastStepInContext(session, i) - (i + 1));

export function stepCost(step: Step, pricing: PricingTable): number | undefined {
  const p = lookupPrice(pricing, step.model);
  return p ? priceUsage(step.usage, p) : undefined;
}

/** Cost of carrying `tokens` through steps (from, to], at each step's cache-read ratio. */
export function carryCost(session: Session, from: number, to: number, tokens: number, pricing: PricingTable): number | undefined {
  let usd = 0;
  for (let k = from + 1; k <= to; k++) {
    const s = session.steps[k]!;
    const p = lookupPrice(pricing, s.model);
    if (!p) return undefined;
    const ratio = s.contextTokens ? s.usage.cacheReadTokens / s.contextTokens : 1;
    usd += (tokens * (ratio * p.cacheRead + (1 - ratio) * p.input)) / 1e6;
  }
  return usd;
}

export const fmtTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n));

export const fmtUsd = (n: number): string => (n >= 1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(2)}` : `<$0.01`);
