// Core data model. Isomorphic: no node:* imports anywhere under src/core.
// Adapter → Session → detectors → Finding[] → renderers. Detectors and renderers never see raw JSONL.

export type Iso = string;
export type Provenance = "measured" | "estimated";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number; // total
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
}

export type EstMethod = "context-delta" | "char-heuristic" | "image-default";

export interface ToolResult {
  isError: boolean;
  /** Parsed from a Bash `Exit code N` prefix when present. */
  exitCode?: number;
  isImage: boolean;
  /** Chars of the tool_result content as it entered the context (persisted outputs: the preview only). */
  sizeChars: number;
  /** Raw text, kept in memory for analysis only. Never serialized into reports. */
  text: string;
  estTokens: number;
  estMethod: EstMethod;
}

export interface ToolCall {
  id: string;
  name: string; // "Read", "Edit", "Bash", ...
  input: Record<string, unknown>; // raw, never rendered directly
  result?: ToolResult;
}

export interface Step {
  index: number; // position on the active branch
  messageId: string; // deduped API message id
  sourceUuids: string[]; // all JSONL lines merged into this step
  timestamp: Iso;
  model?: string;
  usage: Usage; // measured
  /** Prompt size at this call = input + cacheRead + cacheWrite. Measured. */
  contextTokens: number;
  toolCalls: ToolCall[];
  exchangeIndex: number; // which human prompt this step belongs to (-1 before the first)
  /** Paths the user edited outside the agent, reported before this step (Claude Code `edited_text_file`). */
  externalEdits: string[];
}

export interface Exchange {
  index: number;
  userTextChars: number;
  userText?: string; // stripped in redacted mode
  /** Index of the first step after this prompt (steps.length if none). */
  firstStepIndex: number;
}

export interface Compaction {
  /** First step after the compaction. */
  atStepIndex: number;
  detectedBy: "marker" | "context-drop" | "both";
  contextBefore: number;
  contextAfter: number;
}

export interface ParseWarning {
  line: number;
  kind: string;
  detail?: string; // never raw content
}

export interface Session {
  id: string;
  source: "claude-code";
  clientVersion?: string;
  cwd?: string;
  gitBranch?: string;
  startedAt: Iso;
  endedAt: Iso;
  steps: Step[]; // active branch only
  exchanges: Exchange[];
  compactions: Compaction[];
  abandoned: { stepCount: number; usage: Usage };
  sidechains: { count: number; stepCount: number; usage: Usage };
  warnings: ParseWarning[];
  models: string[];
  /** All billed usage (active, abandoned, sidechains) keyed by model id, for costing. */
  usageByModel: Record<string, Usage>;
  totals: { usage: Usage; estCostUsd?: number; costNote?: string };
}

export type Severity = "info" | "warn" | "high";
export type Confidence = "low" | "medium" | "high";

export interface Evidence {
  stepIndex: number;
  toolCallId?: string;
  note: string; // short, redaction-safe
  /** This finding's impact already includes the lifetime cost of this output (so output-lifetime skips it). */
  includesLifetime?: boolean;
}

export interface Finding {
  id: string; // `${detector}:${hash of evidence}`
  detector: string;
  severity: Severity;
  confidence: Confidence;
  title: string;
  summary: string;
  evidence: Evidence[]; // non-empty
  impact: {
    estTokens?: number;
    estCostUsd?: number;
    provenance: Provenance;
    method: string;
  };
  suggestion?: string;
}

export interface ModelPrice {
  input: number; // USD per million tokens
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export interface PricingTable {
  pricingAsOf: string;
  source: string;
  models: Record<string, ModelPrice>;
}

export interface DetectorContext {
  pricing: PricingTable;
  /** True in --redact mode: finding text must not contain transcript content. */
  redacted: boolean;
  /** How a path appears in finding text. Redacted mode maps paths to stable tokens. */
  displayPath(path: string): string;
  /** How a shell command appears in finding text. Redacted mode hides it. */
  displayCommand(command: string): string;
  options: Record<string, unknown>;
}

export interface Detector {
  id: string;
  run(session: Session, ctx: DetectorContext): Finding[];
}

export interface SessionRef {
  id: string;
  path: string;
  projectDir: string;
  mtimeMs: number;
  sidechainPaths: string[];
}
