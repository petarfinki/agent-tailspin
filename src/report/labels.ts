// Hand labels for precision eval (PRODUCT.md §15). Isomorphic: shared by the report client and eval/run.ts.
import type { Finding } from "../core/types.js";

export type Verdict = "TP" | "FP" | "unclear";

export interface Label {
  sessionHash: string;
  findingId: string;
  label: Verdict;
  note?: string;
}

/** One label per finding, in finding order; unlabeled findings are "unclear". Same shape as `eval --template`. */
export function exportLabels(sessionHash: string, findings: Finding[], verdicts: Record<string, Verdict>): Label[] {
  return findings.map((f) => ({ sessionHash, findingId: f.id, label: verdicts[f.id] ?? "unclear", note: `${f.confidence} · ${f.title}` }));
}
