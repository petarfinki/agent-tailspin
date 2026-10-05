// The serializable report model shared by --json and the HTML report. Isomorphic.
// Only whitelisted, display-safe fields are copied out of the Session. Schema: docs/json-schema.md
import type { Analysis } from "../analyze.js";
import { totalTokens } from "../core/tokens.js";
import type { Compaction, Confidence, EstMethod, Finding, Usage } from "../core/types.js";
import { describeCall, outputLifetimes } from "../detectors/output-lifetime.js";
import { redactSession } from "../redact/index.js";

export const SCHEMA_VERSION = 1;
export const TOP_OUTPUTS = 10;

export interface TimelinePoint {
  i: number;
  t: string;
  ctx: number;
  delta: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  input: number;
  tools: string[];
  exchange: number;
}

export interface ReportModel {
  schemaVersion: typeof SCHEMA_VERSION;
  generator: { name: "agent-tailspin"; version: string };
  synthetic: boolean;
  redacted: boolean;
  session: {
    id: string;
    source: string;
    clientVersion?: string;
    cwd?: string;
    gitBranch?: string;
    startedAt: string;
    endedAt: string;
    durationMs: number;
    models: string[];
    stepCount: number;
    exchangeCount: number;
    compactions: Compaction[];
    abandoned: { stepCount: number; totalTokens: number };
    sidechains: { count: number; stepCount: number; totalTokens: number };
    warnings: { count: number; byKind: Record<string, number> };
  };
  totals: {
    usage: Usage;
    totalTokens: number;
    peakContext: number;
    estCostUsd?: number;
    costNote?: string;
    provenance: { tokens: "measured"; cost: "estimated" };
  };
  timeline: TimelinePoint[];
  findings: Finding[];
  hiddenFindings: number;
  topOutputs: {
    step: number;
    toolCallId: string;
    tool: string;
    label: string;
    tokens: number;
    estMethod: EstMethod;
    laterSteps: number;
    lifetimeTokens: number;
    lifetimeCostUsd?: number;
    confidence: Confidence;
  }[];
  toolUsage: { tool: string; calls: number; errors: number; estTokens: number; share: number }[];
  pricing: { asOf: string; source: string };
}

export function buildReportModel(a: Analysis, meta: { version: string; synthetic?: boolean }): ReportModel {
  const raw = a.session;
  // Labels are computed from the raw session through the (possibly redacting) display functions,
  // then the session itself is redacted before anything else is read from it.
  const lifetimes = outputLifetimes(raw, a.pricing);
  const topOutputs = lifetimes.slice(0, TOP_OUTPUTS).map((o) => ({
    step: o.step,
    toolCallId: o.call.id,
    tool: o.call.name,
    label: describeCall(o.call, a, raw.cwd),
    tokens: o.tokens,
    estMethod: o.call.result!.estMethod,
    laterSteps: o.laterSteps,
    lifetimeTokens: o.lifetimeTokens,
    lifetimeCostUsd: o.lifetimeCostUsd,
    confidence: o.confidence,
  }));
  const s = a.redacted ? redactSession(raw) : raw;

  const usage = new Map<string, { calls: number; errors: number; estTokens: number }>();
  for (const st of s.steps)
    for (const c of st.toolCalls) {
      const u = usage.get(c.name) ?? { calls: 0, errors: 0, estTokens: 0 };
      u.calls++;
      if (c.result?.isError) u.errors++;
      u.estTokens += c.result?.estTokens ?? 0;
      usage.set(c.name, u);
    }
  const toolTokens = [...usage.values()].reduce((n, u) => n + u.estTokens, 0) || 1;
  const byKind: Record<string, number> = {};
  for (const w of s.warnings) byKind[w.kind] = (byKind[w.kind] ?? 0) + 1;

  return {
    schemaVersion: SCHEMA_VERSION,
    generator: { name: "agent-tailspin", version: meta.version },
    synthetic: !!meta.synthetic,
    redacted: a.redacted,
    session: {
      id: s.id,
      source: s.source,
      clientVersion: s.clientVersion,
      cwd: s.cwd,
      gitBranch: s.gitBranch,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      durationMs: Math.max(0, Date.parse(s.endedAt) - Date.parse(s.startedAt)) || 0,
      models: s.models,
      stepCount: s.steps.length,
      exchangeCount: s.exchanges.length,
      compactions: s.compactions,
      abandoned: { stepCount: s.abandoned.stepCount, totalTokens: totalTokens(s.abandoned.usage) },
      sidechains: { count: s.sidechains.count, stepCount: s.sidechains.stepCount, totalTokens: totalTokens(s.sidechains.usage) },
      warnings: { count: s.warnings.length, byKind },
    },
    totals: {
      usage: s.totals.usage,
      totalTokens: totalTokens(s.totals.usage),
      peakContext: s.steps.reduce((m, st) => Math.max(m, st.contextTokens), 0),
      estCostUsd: s.totals.estCostUsd,
      costNote: s.totals.costNote,
      provenance: { tokens: "measured", cost: "estimated" },
    },
    timeline: s.steps.map((st, i) => ({
      i,
      t: st.timestamp,
      ctx: st.contextTokens,
      delta: i ? st.contextTokens - s.steps[i - 1]!.contextTokens : st.contextTokens,
      out: st.usage.outputTokens,
      cacheRead: st.usage.cacheReadTokens,
      cacheWrite: st.usage.cacheWriteTokens,
      input: st.usage.inputTokens,
      tools: st.toolCalls.map((c) => c.name),
      exchange: st.exchangeIndex,
    })),
    findings: a.findings,
    hiddenFindings: a.hiddenCount,
    topOutputs,
    toolUsage: [...usage]
      .map(([tool, u]) => ({ tool, ...u, share: u.estTokens / toolTokens }))
      .sort((x, y) => y.estTokens - x.estTokens || (x.tool < y.tool ? -1 : 1)),
    pricing: { asOf: a.pricing.pricingAsOf, source: a.pricing.source },
  };
}
