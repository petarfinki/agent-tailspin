// Redaction in the data model (PRODUCT.md §12). Isomorphic.
// Strips every transcript string from the Session; finding text is already built with redacted
// display functions (see analyze()), so nothing downstream ever holds the raw content.
import type { Session } from "../core/types.js";

export function redactSession(s: Session): Session {
  return {
    ...s,
    cwd: undefined,
    gitBranch: undefined,
    exchanges: s.exchanges.map((e) => ({ ...e, userText: undefined })),
    warnings: s.warnings.map((w) => ({ line: w.line, kind: w.kind })),
    steps: s.steps.map((st) => ({
      ...st,
      externalEdits: [],
      toolCalls: st.toolCalls.map((c) => ({
        ...c,
        input: {},
        result: c.result && { ...c.result, text: "" },
      })),
    })),
  };
}
