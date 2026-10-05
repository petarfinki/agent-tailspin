# Tailspin — Agent Session Flight Recorder


**One-liner:** A local-first tool that reads your Claude Code session transcripts and shows *why* a session went badly: retry loops, redundant file reads, tool outputs that bloated the context, and what each of those cost.

**Status:** Pre-v0. This document is the source of truth for scope, architecture, and quality bar.

---

## 0. Instructions for Claude Code (read first)

You are building this project from scratch. Work in this order and do not skip ahead.

1. **Do Milestone 0 (format recon) before writing any parser code.** The transcript format described in section 5 is *recalled from memory and may be wrong or outdated*. The real files on this machine are the ground truth. Inspect them (`~/.claude/projects/`), record what you actually find in `docs/format-notes.md`, and fix the types in section 6 to match.
2. **Never commit real transcripts**, and never paste real transcript contents (prompts, code, paths, secrets) into committed files, issues, fixtures, or logs. When inspecting real files, look at structure and field names, not content. All fixtures must be synthetic (section 14).
3. **Tests before detectors.** Each detector gets a fixture session that should trigger it and at least two that look similar but should *not* (false-positive guards). Write those first.
4. **Precision over recall.** A wrong finding costs more trust than a missed one. When unsure, do not emit the finding, or emit it with `confidence: "low"` and exclude it from headline numbers.
5. **Everything is an estimate unless measured.** Label every number with how it was obtained (`measured` vs `estimated`) and say so in the UI.
6. **Keep dependencies minimal.** This ships via `npx`; install size and supply-chain surface matter. Justify each runtime dependency in the PR/commit message.
7. **Commit after each milestone** with a message describing what now works. If you need to deviate from this spec, write the deviation and reason in `docs/decisions.md` first.
8. **Ask me before** adding network calls of any kind, telemetry, or anything that writes outside the output directory.

---

## 1. Problem

Developers using coding agents (Claude Code first) routinely have sessions that go wrong in ways they can feel but cannot see:

- The agent reads the same large file again and again.
- One huge tool output (a log dump, a giant file, a `git diff`) enters the context and is re-read from cache on every later turn.
- The agent edits, runs tests, gets the same failure, and edits again, in a loop.
- The developer keeps correcting the same thing ("use pnpm, not npm") across many sessions, and it never becomes a rule.

Existing tools (e.g. `ccusage`) answer *"how much did I spend?"* They do not answer *"why was this session bad, and what should I change?"* That behavioral diagnosis is the gap.

## 2. Goals and non-goals

### Goals

- **Diagnose** a session: show the specific, evidence-backed reasons it burned tokens or time.
- **Quantify** the cost of each finding in tokens and (estimated) dollars, with clear provenance.
- **Be trustworthy:** fully local, no network, no telemetry, readable source, published precision numbers.
- **Be shareable:** a single self-contained HTML report that can be safely posted (redaction mode).
- **Be frictionless:** `npx agent-tailspin` with no config produces something useful in under 5 seconds.

### Non-goals (v0 through v0.2)

- Not a cost dashboard. Do not compete with `ccusage` on spend aggregation.
- Not an LLM-powered analyzer. Default behavior is fully offline and deterministic. Any LLM-assisted feature is opt-in and later.
- Not a live/streaming monitor. Post-hoc analysis of finished or in-progress transcript files only.
- Not a CLAUDE.md auto-editor. The tool never writes to user config files.
- No Cursor, Windsurf, or other agents in v0. The architecture must make them easy to add later (section 7).
- No cloud service, accounts, or hosted storage.

## 3. Users and primary scenarios

**User:** a developer who uses Claude Code daily, is cost- and context-aware, and is comfortable with a CLI.

| Scenario | What they run | What they get |
|---|---|---|
| "That last session felt wasteful." | `npx agent-tailspin` | Analysis of the most recent session for the current directory, summary in terminal, HTML report opens |
| "Show me my worst sessions this week." | `npx agent-tailspin list --since 7d` | Sessions ranked by findings/cost |
| "I want to show my team what happened." | `npx agent-tailspin analyze <id> --redact` | A safe-to-share HTML file |
| "I just want to try it." | `npx agent-tailspin --demo` | Bundled synthetic session and report |
| (v0.2) "What do I keep telling the agent?" | `npx agent-tailspin corrections` | Recurring corrections across sessions, suggested CLAUDE.md lines |

## 4. Scope by version

### v0.1 (the weekend-sized MVP, the thing to ship first)

1. Claude Code JSONL adapter with correct token dedupe and branch handling.
2. Per-step token/context timeline.
3. Three detectors: **repeated reads**, **tool output lifetime cost**, **failure loops**.
4. CLI summary (terminal) + single-file HTML report.
5. `--redact` share mode.
6. `--demo` mode with a bundled synthetic session.
7. Detector test suite and a labeling/eval script (section 15).

### v0.2

- Cross-session **correction mining** and suggested CLAUDE.md snippet (copy-only, never write).
- Diff suggestions against the user's existing CLAUDE.md to avoid suggesting rules they already have.
- Compaction-thrash detector, "agent rewound a lot" detector.
- Subagent (sidechain) analysis.

### v0.3

- Static web version (GitHub Pages): drop a JSONL file, analysis runs entirely in the browser, nothing uploaded.
- Second adapter (Codex CLI is the likeliest candidate).
- Optional, opt-in LLM-assisted clustering for corrections.

---

## 5. Input data: Claude Code transcripts

> **Everything in this section is unverified recall. Milestone 0 exists to confirm or correct it.** The format is not a documented API and has changed between Claude Code versions.

**Location (believed):** `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, where `<encoded-cwd>` is the working directory with path separators replaced by `-`. Also check `CLAUDE_CONFIG_DIR` and `~/.config/claude/`. Support a direct file path argument.

**Line shape (believed):** one JSON object per line. Fields that have been seen on lines, varying by line `type`:

- `type`: e.g. `user`, `assistant`, `summary`, `system` (verify the full set)
- `uuid`, `parentUuid` (sessions form a **tree**, not a list)
- `sessionId`, `timestamp`, `cwd`, `gitBranch`, `version`
- `isSidechain` (subagent messages), possibly `isMeta`, `isCompactSummary` or similar compaction markers
- `message`: `{ id, role, model, content, usage, stop_reason }`
  - `content`: string or array of blocks: `text`, `thinking`, `tool_use` (`id`, `name`, `input`), `tool_result` (`tool_use_id`, `content`, `is_error`)
  - `usage`: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, possibly a `cache_creation` breakdown by TTL (5m vs 1h)
- Tool results may carry extra structured data (e.g. a `toolUseResult` field) beyond the `tool_result` block.

**Known pitfalls to handle (verify each in M0):**

1. **One API response split across multiple lines.** A single assistant message (same `message.id`) may be written as several JSONL lines (one per content block), each repeating the same `usage`. Summing naively double- or triple-counts tokens. Dedupe by `message.id`. Read `ccusage`'s source for prior art on this exact problem (read it, do not copy it blindly; check its license).
2. **Tree structure.** Rewinds, edits, and resumes create branches. Reconstruct the tree from `parentUuid`. "The session" for context-lifetime analysis is the **active branch** (path from the latest leaf to the root). Tokens spent on abandoned branches were still billed, so count them in totals but mark them `abandoned`, and do not run lifetime analysis on them.
3. **Sidechains.** Subagent messages are interleaved or stored separately. They have their own context window. v0: include their cost in totals, attribute them separately, and do not run detectors on them.
4. **Compaction.** Context is summarized and reset. A tool output stops costing cache-read tokens after a compaction boundary. Detect compaction via the summary/marker lines **and** via a sharp drop in context size between consecutive steps (belt and braces).
5. **Unknown and malformed lines.** Never crash on a bad line. Collect `ParseWarning`s, show a count in the report, continue.
6. **Streaming-incomplete sessions.** The last line may be truncated. Tolerate it.

**Parser rule:** unknown fields are ignored; unknown `type`s are skipped with a warning; every field access is guarded. Keep a `fixtures/format-versions/` directory with one tiny synthetic file per observed `version` range.

---

## 6. Core data model

These are the intended shapes. Adjust to match M0 findings, but keep the **separation**: raw parsing (adapter) → normalized `Session` → detectors → `Finding`s → renderers. Detectors and renderers must never see raw JSONL.

```ts
export type Iso = string;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;          // total
  cacheWrite5mTokens?: number;       // if the breakdown exists
  cacheWrite1hTokens?: number;
}

export type Provenance = "measured" | "estimated";

export interface ToolResult {
  isError: boolean;
  sizeChars: number;
  /** Raw text kept in memory for analysis; stripped before any serialization in redacted mode. */
  text?: string;
  estTokens: number;
  estMethod: "context-delta" | "char-heuristic";
}

export interface ToolCall {
  id: string;
  name: string;                       // "Read", "Edit", "Bash", "Grep", ...
  input: unknown;                     // raw, never rendered directly
  result?: ToolResult;
}

export interface Step {
  index: number;                      // position on the active branch
  messageId: string;                  // deduped API message id
  sourceUuids: string[];              // all JSONL lines merged into this step
  timestamp: Iso;
  model?: string;
  usage: Usage;                       // measured from the API
  /** Prompt size at this call = input + cacheRead + cacheWrite. Measured. */
  contextTokens: number;
  toolCalls: ToolCall[];
  exchangeIndex: number;              // which human prompt this step belongs to
  isSidechain: boolean;
}

export interface Exchange {
  index: number;
  userTextChars: number;
  userText?: string;                  // stripped in redacted mode
  stepIndices: number[];
}

export interface Compaction {
  atStepIndex: number;
  detectedBy: "marker" | "context-drop" | "both";
  contextBefore: number;
  contextAfter: number;
}

export interface ParseWarning {
  line: number;
  kind: string;
  detail?: string;                    // never include raw content
}

export interface Session {
  id: string;
  source: "claude-code";
  clientVersion?: string;
  cwd?: string;
  gitBranch?: string;
  startedAt: Iso;
  endedAt: Iso;
  steps: Step[];                      // active branch only
  exchanges: Exchange[];
  compactions: Compaction[];
  abandoned: { stepCount: number; usage: Usage };
  sidechains: { stepCount: number; usage: Usage };
  warnings: ParseWarning[];
  totals: { usage: Usage; estCostUsd?: number; costProvenance: Provenance };
}

export type Severity = "info" | "warn" | "high";
export type Confidence = "low" | "medium" | "high";

export interface Evidence {
  stepIndex: number;
  toolCallId?: string;
  note: string;                       // short, redaction-safe description
}

export interface Finding {
  id: string;                         // stable: `${detector}:${hash of evidence}`
  detector: string;
  severity: Severity;
  confidence: Confidence;
  title: string;
  summary: string;
  evidence: Evidence[];               // REQUIRED, non-empty. No evidence, no finding.
  impact: {
    estTokens?: number;
    estCostUsd?: number;
    provenance: Provenance;
    method: string;                   // human-readable how-computed string
  };
  suggestion?: string;
}

export interface Detector {
  id: string;
  run(session: Session, ctx: DetectorContext): Finding[];
}

export interface DetectorContext {
  pricing: PricingTable;
  options: Record<string, unknown>;
}
```

**Adapter interface** (so Codex CLI etc. can be added later without touching detectors):

```ts
export interface SessionAdapter {
  id: string;                                         // "claude-code"
  discover(opts: DiscoverOpts): Promise<SessionRef[]>; // Node-only
  parse(input: string | AsyncIterable<string>): Session; // PURE, no fs, no node imports
}
```

---

## 7. Architecture and repo layout

**Language:** TypeScript (strict). **Runtime target:** Node 20+. **Distribution:** `npx agent-tailspin`.

**Hard rule:** everything under `src/core/`, `src/adapters/*/parse*`, `src/detectors/`, and `src/report/` must be **isomorphic**: no `node:*` imports, no `fs`, no `process`. This is what makes the v0.3 browser version nearly free. Enforce with an ESLint `no-restricted-imports` rule and a CI check. Only `src/cli/` and adapter `discover*` files may touch Node APIs.

```
agent-tailspin/
├── PRODUCT.md                 # this file
├── CLAUDE.md                  # repo conventions (see section 17)
├── docs/
│   ├── format-notes.md        # M0 output: what the real format looks like
│   ├── decisions.md           # deviations and design decisions
│   └── detectors.md           # precise definition of each detector
├── src/
│   ├── core/                  # types, token math, pricing, tree reconstruction
│   ├── adapters/
│   │   └── claude-code/       # discover.ts (node), parse.ts (pure)
│   ├── detectors/
│   │   ├── repeated-reads.ts
│   │   ├── output-lifetime.ts
│   │   ├── failure-loops.ts
│   │   └── index.ts
│   ├── redact/                # redaction applied to the Session model
│   ├── report/
│   │   ├── build-html.ts      # produces the single-file HTML string
│   │   ├── template.html
│   │   ├── style.css          # inlined at build time
│   │   └── client.ts          # vanilla TS, bundled and inlined at build time
│   └── cli/                   # arg parsing, terminal output, open-in-browser
├── fixtures/
│   ├── synthetic/             # generated sessions (committed)
│   ├── format-versions/       # tiny per-version samples
│   └── builder/               # fixture builder DSL
├── eval/
│   ├── labels/                # TP/FP labels (synthetic only in repo)
│   └── run.ts                 # computes precision per detector
├── scripts/
└── test/
```

**Tooling:** `tsup` or `esbuild` for bundling, `vitest` for tests, `eslint` + `prettier`. Single package for v0 (no monorepo until the web app exists).

**Dependency guidance (runtime):** aim for near-zero. A tiny arg parser (`cac` or `commander`) and `picocolors` are fine. Hand-roll terminal tables if it is under ~80 lines; otherwise a small table lib is acceptable. No UI framework in the report: vanilla TS compiled to one inline script. Avoid `zod` in the parser hot path unless bundle impact is measured and acceptable; hand-written type guards are fine.

---

## 8. Token and cost accounting

### Definitions

- **Step** = one deduped assistant API message (one model call).
- **Exchange** = one human prompt plus all steps until the next human prompt.
- **Context size at step N** = `inputTokens + cacheReadTokens + cacheWriteTokens` for that call. **Measured**, taken directly from `usage`.

### Per-step timeline

For each step compute: context size, delta vs previous step, output tokens, cache hit ratio, and flag compactions. This feeds the HTML timeline chart.

### Estimating a tool result's size in tokens

The transcript does not give per-block token counts. Estimate in this order:

1. **Context-delta (preferred):** For a tool result consumed by step N+1, `est ≈ contextTokens[N+1] − contextTokens[N] − outputTokens[N]`. This works because step N+1's prompt = step N's prompt + step N's output + new tool results + new user text. If step N issued **multiple parallel tool calls**, split the delta across their results proportionally to `sizeChars`. If a human message arrived in between, subtract an estimate of its size. Discard the estimate (fall back) if the result is negative or the step boundary is ambiguous (compaction, branch change).
2. **Char heuristic (fallback):** `ceil(sizeChars / 3.5)` for code/log-like text. Make the ratio a named constant.

Record which method was used in `estMethod`. The report must show it.

### Cost

- Ship `pricing.json`: per-million-token rates by model for input, output, cache read, and cache write (5m and 1h if applicable). **Do not hardcode prices in logic.** Verify against Anthropic's current pricing page when building; add a `pricingAsOf` date and show it in the report footer.
- Unknown model → show tokens only, no dollars, and say why.
- `--pricing <file>` lets users override.
- Dollar figures are always **estimates** (`provenance: "estimated"`) because plan-based (subscription) users are not billed per token. Phrase as "API-equivalent cost".

---

## 9. Detectors (v0.1)

Each detector must be documented in `docs/detectors.md` with: exact definition, algorithm, false-positive guards, and known limitations. Each emits `Finding`s with non-empty evidence.

### D1. `repeated-reads`: redundant file re-reads

**Intent:** The same content entered the context more than once without any reason.

**Counts as a finding when ALL hold:**
- Two or more `Read` calls (extend later to `cat`/`head` via Bash) target the same **normalized path** (resolve `./`, relative-to-cwd, symlink-agnostic string normalization).
- The requested ranges **overlap** (no offset/limit = whole file; a read of lines 1–50 followed by 400–450 is not a repeat).
- **No modification in between:** no `Edit`/`MultiEdit`/`Write`/`NotebookEdit` targeting that path between the reads, and no Bash call between them that plausibly modifies it (heuristic: `sed -i`, `>`/`>>` redirects naming the path, `mv`, `cp` to the path, `git checkout|restore|stash|reset|pull|merge|rebase`, formatters like `prettier --write`, `eslint --fix`, `black`, `gofmt -w`). If a possibly-modifying Bash call exists in between, **suppress** the finding (precision over recall).
- **No compaction in between.** After a compaction the earlier read is gone, so re-reading is legitimate.
- The earlier read's result was not an error.

**Impact:** `estTokens` = sum of estimated tokens of the redundant reads (all but the first). Also compute the **lifetime cost** of those redundant copies (see D2 mechanics) when measurable.

**Severity:** `high` if ≥ 4 redundant reads of one file or ≥ 20k redundant tokens; `warn` for ≥ 2 redundant reads; otherwise do not emit.

**Headline example:** "`src/db/pool.ts` was read 9 times without being edited in between (~34k tokens)."

### D2. `output-lifetime`: expensive tool outputs

**Intent:** Find the single tool outputs that cost the most *because they stayed in context*. This is the signature finding.

**Mechanics:** A tool result of `S` estimated tokens that enters at step N is carried in the prompt of every subsequent step until a compaction (or end of the active branch). Cost model:

- First appearance: counted as input or cache-write (already billed in that step's usage).
- Each later step: `S` tokens read from cache (or re-billed as input on a cache miss; use the step's actual cache-read ratio if available, otherwise assume cache read).
- `lifetimeTokens = S × (number of later steps before compaction/end)`.
- `lifetimeCostUsd` = priced at cache-read rates (state the assumption in `method`).

**Emit a finding when:** the result is among the top outputs by `lifetimeTokens` **and** both: `S ≥ 4,000` estimated tokens **and** `lifetimeTokens ≥ 100,000`. Cap at the top 5 per session. Thresholds are named constants.

**Confidence:** `high` if `estMethod === "context-delta"` and the delta estimate is consistent (non-negative, not near a compaction); `medium` for char-heuristic; never `high` on a char heuristic.

**Suggestion (text, deterministic):** based on the tool and input, e.g. for `Read` of a large file: "Read a line range or use Grep to locate the relevant section." For `Bash` with unbounded output: "Pipe through `head`/`tail`/`grep`, or redirect to a file and read selectively." Do not give suggestions you cannot justify for that specific tool.

**Headline example:** "One `Bash` output (~12k tokens) stayed in context for 41 more steps: ~490k cache-read tokens (est. $0.15 at current rates)."

### D3. `failure-loops`: retry loops without progress

**Intent:** The agent keeps trying and keeps failing the same way.

**Algorithm:**
1. For each tool result with `isError` or a Bash non-zero-exit marker (verify in M0 how Claude Code encodes this), compute an **error signature**: take the output, strip ANSI codes, absolute paths (replace with `<path>`), line/column numbers, timestamps, UUIDs, hex addresses, durations, and numeric literals; collapse whitespace; take the first and last meaningful lines plus any recognized error-type token (`TypeError`, `E0308`, `AssertionError`, exit code); hash.
2. Normalize the *action* too: tool name + normalized key args (for Bash, the command with volatile parts removed; for test runs, the command string).
3. Detect a loop when the same `(action-class, error-signature)` fails **≥ 3 times** within a window of 15 steps, with **at least one Edit/Write between consecutive failures** (that is the "edit → test → same failure → edit" loop) **or** the identical command is retried ≥ 3 times with no intervening change (blind retry).
4. **Guard:** if the error signature *changes* between attempts (progress), it is not a loop; if the failure count is high but each failure has a different signature, do not emit.
5. **Guard:** exclude deliberate polling patterns (e.g. waiting for a server: repeated `curl` against a port). Use a small allowlist and make it configurable.

**Impact:** tokens and cost of the steps from the first failure in the loop through the last (sum of per-step incremental usage, labeled estimated), plus step/time span.

**Severity:** `high` if ≥ 5 repetitions or the loop spans ≥ 25% of the session's steps; `warn` for 3–4.

**Evidence:** every failing step, in order, with the normalized signature (never the raw output in redacted mode).

### Explicitly deferred detectors (do not build in v0.1)

Compaction thrash, excessive rewinds, "agent forgot instructions after compaction", tool-call-per-prompt outliers, correction mining.

---

## 10. Outputs

### 10.1 CLI

Commands:

```
agent-tailspin                          # analyze the latest session for the current directory
agent-tailspin list [--since 7d] [--project <path>] [--limit N]
agent-tailspin analyze <session-id|path> [options]
agent-tailspin --demo                   # bundled synthetic session
agent-tailspin --version | --help
```

Options for `analyze` and the default command:

| Flag | Behavior |
|---|---|
| `--redact` | Produce a share-safe report (section 12) |
| `--out <file>` | HTML output path (default: temp/`./agent-tailspin-report-<id>.html`) |
| `--no-open` | Do not open the browser |
| `--json` | Print the findings and metrics as JSON to stdout, no HTML |
| `--pricing <file>` | Override pricing table |
| `--min-confidence <low\|medium\|high>` | Filter findings (default `medium`) |
| `--verbose` | Show parse warnings and detector diagnostics |

**Terminal summary** (keep it to one screen): session id, duration, steps, peak context, total tokens, API-equivalent estimated cost with a note about estimation, compaction count, then the top 3 findings with title, impact, and the evidence step numbers. End with the report path. If there are zero findings, say so plainly; do not invent any.

**Exit codes:** `0` success (including zero findings), `1` unexpected error, `2` bad usage/no sessions found. Never exit non-zero because of findings.

### 10.2 HTML report

One file. No network requests of any kind (no CDN, no web fonts, no analytics). Verify with a test that greps the output for `http://`/`https://` other than documentation links that are plain text, and a Playwright/headless check that makes zero requests (optional but good).

**Embedding:** serialize the (redacted, if applicable) report model as JSON into a `<script type="application/json">` block. **Escape `<`, `>`, `&`, U+2028, U+2029** in that JSON so transcript content can never break out of the script tag. Render all dynamic text with `textContent`, never `innerHTML`. Treat transcript content as hostile input.

**Layout (top to bottom):**
1. **Header:** session id, date, duration, steps, model(s), client version. Provenance note: "Token counts are measured. Per-output sizes and dollar figures are estimates."
2. **Summary cards:** peak context, total tokens, est. API-equivalent cost, compactions, finding count by severity.
3. **Context timeline (the hero visual):** SVG chart of context size per step, with markers for compactions and findings. Click a finding to highlight and scroll its evidence steps on the timeline. Hover shows step index, delta, tool names used.
4. **Findings list:** sorted by severity then impact. Each card: title, confidence badge, impact with provenance, short summary, suggestion, and an expandable evidence list (step numbers, tool names, redaction-safe notes).
5. **Top tool outputs by lifetime cost:** table (tool, est. size, steps in context, lifetime tokens, method).
6. **Tool usage breakdown:** counts and share of context by tool.
7. **Methodology footer:** detector definitions in plain language, estimation methods, pricing as-of date, parse warning count, tool version.

**Design:** clean, dense, readable. Light and dark via `prefers-color-scheme`. System font stack. Keyboard-accessible. No framework. Inline CSS under ~15 KB, client JS under ~40 KB minified. Total report size for a typical session under 500 KB.

### 10.3 `--json`

Stable, versioned schema (`schemaVersion: 1`) so other tools can consume it. Document it in `docs/json-schema.md`.

---

## 11. Quality bar for findings

Every finding must:

1. Have non-empty `evidence` pointing at concrete step indices a user can verify.
2. State its impact method in plain words.
3. Have a deterministic explanation (no LLM text in v0).
4. Be reproducible: same input → same output, byte for byte (sort everything, no timestamps of "now" in findings).
5. Pass its false-positive fixtures.

Do **not** present a single "wasted tokens" headline number in v0. Overlapping findings make the sum meaningless. Lead with specific, verifiable findings. If a total is shown later, de-duplicate overlapping token ranges and label it "up to".

---

## 12. Redaction (`--redact`)

The shareable report is the viral artifact, so redaction must be correct by construction.

**Rule: redact in the data model before serialization.** Never hide content with CSS or client-side logic. The redacted `Session`/report model must not contain the sensitive strings at all.

**Strip entirely:** user prompt text, assistant text, tool inputs (commands, patterns, file contents, diffs), tool outputs, `cwd`, git branch names (or hash them), error messages.

**Keep:** timestamps (optionally rounded), token counts, context sizes, tool names, step indices, finding structure, severity/confidence, error *signature hashes* (not text).

**Paths:** replace each distinct path with a stable per-report token like `file_01.ts` (keep the extension, drop directories and basename). Same path → same token within one report so repetition remains visible.

**Tests (mandatory):**
- Build a synthetic session seeded with sentinel strings (fake API keys like `sk-test-SENTINEL-123`, a fake home path, a fake email, a fake internal hostname). Run the full pipeline with `--redact` and assert that **none** of the sentinels appear anywhere in the HTML output or `--json` output.
- Snapshot the redacted model shape.

Document exactly what redaction does and does not guarantee in the README. Say plainly that token counts and tool-use patterns remain visible.

---

## 13. Demo mode

`--demo` loads a bundled **synthetic** session (generated by the fixture builder, committed as a static file) designed to exhibit all three detectors plus a compaction, with plausible but fake content. It must:

- Work offline, instantly, with no `~/.claude` present.
- Produce the exact report used in the README screenshot/GIF.
- Be clearly labeled "synthetic demo data" in the report header.

---

## 14. Fixtures and the synthetic session builder

Build a small DSL in `fixtures/builder/` for constructing transcripts programmatically, for example:

```ts
session()
  .user("Fix the flaky pool test")
  .assistant().read("src/db/pool.ts", { tokens: 3200 })
  .assistant().edit("src/db/pool.ts")
  .assistant().bash("pnpm test", { fail: "AssertionError: expected 3 to equal 4", outTokens: 1800 })
  .assistant().compact()
  .build();  // emits JSONL in the real format + expected Session
```

The builder must emit usage numbers that are **internally consistent** (context size grows by output + tool result tokens each step, cache reads track prior context) so context-delta estimation can be tested against known ground truth.

Required fixture sets, each with expected findings:

| Fixture | Expected |
|---|---|
| `repeated-read-positive` | D1 fires |
| `repeated-read-edit-between` | D1 does not fire |
| `repeated-read-after-compaction` | D1 does not fire |
| `repeated-read-different-ranges` | D1 does not fire |
| `big-output-long-lived` | D2 fires, high confidence |
| `big-output-then-compaction` | D2 lifetime truncated at compaction |
| `big-output-short-lived` | D2 does not fire |
| `failure-loop-edit-test` | D3 fires |
| `failure-progress-changing-errors` | D3 does not fire |
| `failure-polling-allowlisted` | D3 does not fire |
| `split-message-lines` | tokens counted once (dedupe) |
| `branching-rewind` | active-branch selection, abandoned tokens in totals |
| `truncated-last-line` | warning, no crash |
| `unknown-fields-and-types` | warnings, no crash |
| `sentinel-secrets` | redaction test |

Real transcripts are never committed. Fixtures from real sessions are rewritten by hand into synthetic equivalents.

---

## 15. Evaluation: publish precision numbers

This is the differentiator. Almost no tool in this space reports how often its findings are right.

**Protocol:**
1. The maintainer runs the tool on 15–20 of their own real sessions (kept private).
2. For each emitted finding, label it `TP` (true: genuinely wasteful/avoidable), `FP` (false), or `unclear`. Also note obvious misses (false negatives) when noticed.
3. `eval/run.ts` reads a labels file (`eval/labels/*.json`: `{ sessionHash, findingId, label }`) and prints precision per detector, with counts. The repo commits only **aggregate** numbers and **synthetic** labeled sets; real-session labels stay local.
4. The README publishes: sessions evaluated, findings per detector, precision per detector, and known failure modes. Update with each release.
5. A release is blocked if a detector's precision on the maintainer's labeled set falls below **80%**, or the detector ships with `confidence: "low"` and is excluded from default output.

---

## 16. Milestones and acceptance criteria

### M0: Format recon (do first, ~1–2 hours)
- Locate real transcripts, inspect structure (field names and shapes, **not content**).
- Verify or correct every claim in section 5. Check specifically: line `type` values, split-message behavior and dedupe key, `parentUuid`/branching, sidechain storage, compaction markers, how Bash failures and `is_error` are encoded, `usage` shape including cache TTL breakdown, how `Read` offsets/limits appear in `input`.
- Write `docs/format-notes.md`; update section 6 types if needed.
- **Done when:** the notes file exists and the parser design is based on observed reality.

### M1: Parser, model, timeline
- Pure `parse()` producing `Session` from JSONL text. Dedupe, tree/active-branch, sidechain accounting, compaction detection, defensive handling.
- Token timeline and context-delta estimation per section 8.
- Fixture builder + parser fixtures.
- **Done when:** parser fixtures pass; on a real local session, step count and total token usage are sane and (spot-checked) agree with `ccusage` totals within a small tolerance, with differences explained in `docs/decisions.md`.

### M2: Detectors
- D1, D2, D3 with fixtures from section 14 and `docs/detectors.md`.
- **Done when:** all positive/negative fixtures pass; output is deterministic; no detector emits a finding without evidence.

### M3: CLI
- Discovery, `list`, `analyze`, default command, `--json`, terminal summary, exit codes.
- **Done when:** `npx .` (local) analyzes the latest session for the current directory in under 5 seconds on a typical session, and prints the summary.

### M4: HTML report and redaction
- Template, inlined CSS/JS, timeline chart, findings, tables, methodology footer.
- Redaction pipeline and sentinel tests.
- **Done when:** the report works offline, makes zero network requests, passes the hostile-content test (transcript text containing `</script><img src=x onerror=alert(1)>` renders inert), and the redaction tests pass.

### M5: Demo, docs, eval, release
- `--demo`, README (with GIF and precision table), `docs/*`, eval script, labeled synthetic set, LICENSE (MIT or Apache-2.0), CI (lint, typecheck, test, isomorphic-import check), `npm publish` dry run.
- **Done when:** a fresh machine can run `npx agent-tailspin --demo` and see the report, and the README claims are backed by committed evidence.

### Definition of done for v0.1
All milestones complete, README has real precision numbers from a labeled set, and the maintainer has used the tool on their own sessions for at least a few days and fixed what annoyed them.

---

## 17. Suggested `CLAUDE.md` for the repo

Copy this into the repo root once it exists:

```md
# Tailspin: contributor/agent notes

- Read PRODUCT.md before changing scope. Record deviations in docs/decisions.md.
- Never commit real session transcripts or content derived from them. Fixtures are synthetic only.
- src/core, src/detectors, src/report, src/redact, and parse files in adapters must stay isomorphic: no node:* imports.
- Detectors: write the positive AND false-positive fixtures first. No finding without evidence. Precision over recall.
- All dynamic text in the HTML report is rendered via textContent. Treat transcript content as hostile.
- Redaction happens in the data model, never in the view layer.
- Output must be deterministic. Sort everything. No "now" timestamps inside findings.
- Label every number measured or estimated, with the method.
- No network calls, telemetry, or writes outside the chosen output path.
- Keep runtime dependencies minimal and justify each new one.
- Commands: `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm eval`.
```

---

## 18. Launch plan (after v0.1 is real)

1. **README first screen:** one-sentence pitch, the report GIF (from `--demo`), `npx agent-tailspin`, and the "fully local, no network" claim with a one-line explanation of how to verify it.
2. **README second screen:** the precision table and "what this does not do".
3. **Show HN:** lead with a concrete finding, e.g. "I found one tool output that cost me 490k cache-read tokens in a single session." Link the repo and the demo report. Be upfront about estimates and the unofficial transcript format.
4. **Communities:** r/ClaudeAI and r/mcp with a short technical write-up of the lifetime-cost idea (it is the interesting part).
5. **Follow-up post:** "What 20 of my own sessions taught me about where agent tokens go" using aggregate, non-sensitive numbers.
6. **Then** build v0.2 (cross-session corrections), driven by what people actually ask for.

---

## 19. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Transcript format changes or is undocumented | Defensive parser, versioned fixtures, clear "unofficial format" disclaimer, fast fix cycle, CI fixture per client version |
| Anthropic ships first-party session analytics | Differentiate on diagnosis, privacy, cross-session corrections, and open evaluation; keep the core small enough to adapt |
| Wrong findings erode trust | Precision-first detectors, evidence on every finding, published precision numbers, `--min-confidence` filter |
| Estimates mistaken for measurements | Provenance labels everywhere, no single "wasted" headline, methodology footer |
| Report leaks secrets when shared | Redaction in the data model, sentinel tests, plain documentation of guarantees |
| Name or package collision | Check npm/GitHub early; the name is cosmetic |
| Scope creep into a dashboard or an LLM analyzer | Non-goals in section 2; v0.1 limited to three detectors |

## 20. Open questions to resolve during M0/M1

1. Exactly how are compactions represented, and are tool results before compaction preserved in the file? (Affects D2 truncation.)
2. Are subagent transcripts in the same file or separate files, and do they share `sessionId`?
3. Does `usage` include a cache TTL breakdown, and does it matter for pricing accuracy?
4. How reliably can Bash failures be detected (`is_error`, exit code in output, neither)?
5. Do tool results for `Read` include line-number prefixes that inflate the size estimate?
6. What is the real-world error margin of context-delta estimation vs the char heuristic? (Measure on fixtures and a few real sessions; document it.)
7. Which Claude Code versions should be officially supported at v0.1?