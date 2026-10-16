# `--json` output (schemaVersion 1)

`agent-tailspin analyze <id> --json` prints one JSON object. The TypeScript source of truth is
`ReportModel` in `src/report/model.ts`. Fields are only added within a schema version; renames or
removals bump `schemaVersion`.

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | `1` | |
| `generator` | `{ name, version }` | |
| `synthetic` | boolean | true for `--demo` |
| `redacted` | boolean | true with `--redact` |
| `session.id`, `source`, `clientVersion` | string | `source` is `"claude-code"` |
| `session.cwd`, `gitBranch` | string? | omitted when redacted |
| `session.startedAt`, `endedAt` | ISO string | |
| `session.durationMs`, `stepCount`, `exchangeCount` | number | steps are deduped API calls on the active branch |
| `session.models` | string[] | |
| `session.compactions[]` | `{ atStepIndex, detectedBy: "marker" \| "context-drop" \| "both", contextBefore, contextAfter }` | |
| `session.abandoned`, `session.sidechains` | `{ stepCount, totalTokens }` (+ `count` for sidechains) | included in totals, not in the timeline |
| `session.warnings` | `{ count, byKind }` | parse warnings, no content |
| `totals.usage` | `{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cacheWrite5mTokens, cacheWrite1hTokens }` | measured |
| `totals.totalTokens`, `peakContext` | number | measured |
| `totals.estCostUsd` | number? | API-equivalent estimate; absent when a model is unpriced (`costNote` says why) |
| `timeline[]` | `{ i, t, ctx, delta, out, cacheRead, cacheWrite, input, tools[], exchange }` | one per step; `ctx` = input + cache read + cache write |
| `findings[]` | `Finding` | see below; sorted by severity, then impact |
| `hiddenFindings` | number | filtered by `--min-confidence` |
| `topOutputs[]` | `{ step, toolCallId, tool, label, tokens, estMethod, laterSteps, lifetimeTokens, lifetimeCostUsd?, confidence }` | top 10 by lifetime tokens; `label` is a path/command (a token when redacted) |
| `toolUsage[]` | `{ tool, calls, errors, estTokens, share }` | |
| `pricing` | `{ asOf, source }` | |
| `labeling?` | `{ sessionHash }` | only with `--label`; `sessionHash` matches `eval --template` (`synthetic:demo` for `--demo`) |

## Finding

```ts
{
  id: string;            // `${detector}:${hash}`; stable for the same evidence
  detector: "repeated-reads" | "output-lifetime" | "failure-loops";
  severity: "warn" | "high";
  confidence: "low" | "medium" | "high";
  title: string;
  summary: string;
  evidence: { stepIndex: number; toolCallId?: string; note: string }[]; // never empty
  impact: { estTokens?: number; estCostUsd?: number; provenance: "estimated"; method: string };
  suggestion?: string;
}
```

`estMethod` values: `context-delta`, `char-heuristic`, `image-default` (see docs/detectors.md).
