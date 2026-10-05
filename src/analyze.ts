// Session → findings. Isomorphic; shared by the CLI and (later) the browser build.
import pricingJson from "./core/pricing.json";
import { sessionCost } from "./core/tokens.js";
import { extname } from "./core/text.js";
import type { Confidence, DetectorContext, Finding, PricingTable, Session, Severity } from "./core/types.js";
import { detectors } from "./detectors/index.js";

export const defaultPricing = pricingJson as PricingTable;

const CONF: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
const SEV: Record<Severity, number> = { info: 0, warn: 1, high: 2 };

export interface AnalyzeOptions {
  pricing?: PricingTable;
  minConfidence?: Confidence;
  redact?: boolean;
  detectorOptions?: Record<string, unknown>;
}

export interface Analysis {
  session: Session;
  findings: Finding[];
  /** Findings dropped by --min-confidence. */
  hiddenCount: number;
  /** Path → display label (redacted tokens in --redact mode). */
  displayPath(path: string): string;
  displayCommand(command: string): string;
  redacted: boolean;
  pricing: PricingTable;
}

/** Stable per-report path tokens: same path → same token, extension kept. */
export function pathTokenizer(): (p: string) => string {
  const seen = new Map<string, string>();
  return (p) => {
    let t = seen.get(p);
    if (!t) {
      t = `file_${String(seen.size + 1).padStart(2, "0")}${extname(p).toLowerCase()}`;
      seen.set(p, t);
    }
    return t;
  };
}

export function analyze(session: Session, opts: AnalyzeOptions = {}): Analysis {
  const pricing = opts.pricing ?? defaultPricing;
  const redacted = !!opts.redact;
  const cwd = session.cwd ? session.cwd.replace(/\/+$/, "") + "/" : undefined;
  const displayPath = redacted ? pathTokenizer() : (p: string) => (cwd && p.startsWith(cwd) ? p.slice(cwd.length) : p);
  const displayCommand = redacted
    ? () => "a shell command"
    : (c: string) => {
        const one = c.split("\n")[0]!.trim();
        return one.length > 80 ? one.slice(0, 77) + "…" : one;
      };
  const ctx: DetectorContext = { pricing, redacted, displayPath, displayCommand, options: opts.detectorOptions ?? {} };
  session.totals = { ...session.totals, ...sessionCost(session.usageByModel, pricing) };

  const raw = detectors.flatMap((d) => d.run(session, ctx));
  // Skip a lifetime finding only when another finding's impact already includes that output's lifetime
  // (redundant read copies). Merely appearing as evidence elsewhere (a first read, a failing output) isn't enough.
  const claimed = new Set(raw.flatMap((f) => f.evidence.filter((e) => e.includesLifetime).map((e) => e.toolCallId)));
  const all = raw.filter((f) => f.detector !== "output-lifetime" || !claimed.has(f.evidence[0]!.toolCallId));
  const min = CONF[opts.minConfidence ?? "medium"];
  const findings = all
    .filter((f) => CONF[f.confidence] >= min)
    .sort((a, b) => SEV[b.severity] - SEV[a.severity] || (b.impact.estTokens ?? 0) - (a.impact.estTokens ?? 0) || (a.id < b.id ? -1 : 1));
  return { session, findings, hiddenCount: all.length - findings.length, displayPath, displayCommand, redacted, pricing };
}

