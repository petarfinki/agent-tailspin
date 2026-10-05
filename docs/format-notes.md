# Claude Code transcript format: observed notes (M0)

Observed on 2026-10-05 from 11 local JSONL files (7 main sessions, 4 subagent files),
Claude Code versions **2.1.273 – 2.1.289**. Only structure, field names, types, and counts were
inspected, using `scripts/format-recon.mjs` (it never prints free-text values). Re-run it when a new
client version ships and update this file.

Legend: **[obs]** observed locally, **[prior]** not observed locally; based on prior knowledge of
the format, handled defensively, needs confirmation on a session that exhibits it.

## Location

- [obs] `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. `<encoded-cwd>` = cwd with `/` (and `.`)
  replaced by `-`. `CLAUDE_CONFIG_DIR` overrides `~/.claude`; `~/.config/claude` does not exist here.
- [obs] **Subagents are in separate files:** `<encoded-cwd>/<session-id>/subagents/agent-<agentId>.jsonl`
  plus `agent-<agentId>.meta.json` (`agentType`, `description`, `toolUseId`, `spawnDepth`, …).
  `toolUseId` links back to the parent's `Agent` tool_use. Subagent lines carry the **parent's
  `sessionId`**, `isSidechain: true`, and `agentId`.
- [obs] `<session-id>/tool-results/*.txt` hold large tool outputs persisted to disk (see below).
- [obs] One `sessionId` per main file.

## Line types

[obs] `type` values: `user`, `assistant`, `attachment`, `system`, `file-history-snapshot`,
`file-history-delta`, `ai-title`, `last-prompt`, `mode`, `permission-mode`, `queue-operation`,
`atis-latch`, `agent-name`, `cost-state`.

- Only `user`, `assistant`, `attachment`, `system` participate in the `uuid`/`parentUuid` tree.
- [obs] **No `summary` type** was seen. The parser treats unknown types as metadata (skip, no warning
  for the known metadata types above; warning for genuinely unknown ones).
- [obs] `last-prompt` has `leafUuid`: the current leaf of the conversation. It always resolved to an
  existing uuid. Used as the preferred active leaf.
- [obs] `system.subtype`: `turn_duration`, `stop_hook_summary`, `away_summary`, `local_command`,
  `informational`.

## Common fields on tree lines

[obs] `uuid`, `parentUuid` (null on the root), `sessionId`, `timestamp` (ISO), `cwd`, `gitBranch`,
`version`, `isSidechain`, `userType`, `entrypoint`. `user` lines also have `promptId`.

## Assistant lines and split messages

- [obs] `message`: `{ id, role, model, type, content, stop_reason, usage, ... }`. `requestId` on the line.
- [obs] **Every assistant line has exactly one content block.** A single API response with N blocks
  (thinking, text, tool_use…) is written as N lines sharing `message.id` and `requestId`.
  1–5+ lines per id are common.
- [obs] **Main sessions:** all lines of a split message carry identical `usage`.
  **Subagent files:** in 18/42 split messages `usage.output_tokens` grows across lines; the last line
  always had the max. **Dedupe rule:** one step per `message.id`; usage = per-field max across its
  lines (equals the last line's usage in every observed case).
- [obs] Split lines are not always chained parent→child: a tool_result line can sit between them.
- [obs] API error placeholders: `isApiErrorMessage: true`, `message.model: "<synthetic>"`. Not billed;
  not a step.
- [obs] `usage`: `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`, `cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`
  (**TTL breakdown exists**), `output_tokens_details.thinking_tokens`, `server_tool_use`,
  `service_tier`, `iterations[]` (per-iteration usage; top-level fields are used).
- [obs] `content[].tool_use`: `{ id, name, input, caller }`. `Read` input: `file_path`, optional
  `offset`, `limit`. `Bash` input: `command`, `description`, `timeout`, `run_in_background`.
  `Edit`/`Write`: `file_path`.
- [obs] Models seen: `claude-opus-5`, `claude-opus-5-5`. A `cost-state` line also reports model ids
  with a `[1m]` suffix variant.

## User lines

- [obs] Tool results: `message.content` is an array of `tool_result` blocks
  `{ tool_use_id, content: string | [{type:text}|{type:image}], is_error? }`. Also a top-level
  `toolUseResult` with tool-specific structured data and `sourceToolAssistantUUID`.
- [obs] **Human prompt** (what starts an Exchange): `message.content` is a string (or text blocks),
  no tool_result, `isMeta` not true, and `origin.kind` absent or `"human"`. Other origins seen:
  `task-notification`, `coordinator`, `peer` (not human prompts). Strings starting with
  `<local-command-stdout>` / `<local-command-caveat>` are slash-command output, not prompts.
- [obs] `turnOrigin`, `promptSource` (`typed`, `system`) are present only on newer lines; not relied on.

## Tree / branching

- [obs] **Forks exist without any rewind.** All 82 multi-child nodes were a `tool_use` assistant line
  whose children are the next split line of the same message *and* its `tool_result` user line
  (parallel tool calls). So "path from leaf to root" alone would drop some tool results.
- [obs] No real rewinds/edits were present locally. [prior] A rewind produces sibling `user` prompts
  (or sibling assistant messages with different `message.id`) under one parent.
- **Parser design:** the active branch is the set of **message ids and user lines on the
  leaf→root path**; tool results attach to their tool_use by `tool_use_id`, regardless of tree position.
  Assistant message ids not on the path are **abandoned** (counted in totals, no detectors).

## Bash failures and errors

- [obs] Failed Bash: `is_error: true` on the tool_result, content starts with `Exit code <N>` (12/13).
  Successful Bash: `is_error: false`, never starts with `Exit code`.
- [obs] Bash `toolUseResult`: `stdout`, `stderr`, `interrupted`, `isImage`, `noOutputExpected`,
  optionally `returnCodeInterpretation`, `timedOutAfterMs`, `persistedOutputPath`,
  `persistedOutputSize`. **No `exitCode` field.**
- [obs] Non-Bash tools usually omit `is_error` (undefined = success). Tool-level failures (e.g. Write)
  use `is_error: true` with a `<tool_use_error>` wrapper.

## Large outputs

- [obs] Large Bash outputs are persisted to `tool-results/<id>.txt`; the transcript (and therefore the
  model's context) only has a `<persisted-output>` preview. `toolUseResult.persistedOutputSize` holds
  the full size. **Size what's in the transcript content**, not the persisted size, because that's what
  entered the context.

## Read results

- [obs] Text `Read` results carry `cat -n` style line-number prefixes (`^\s*\d+\t`) on every line.
  These count toward context, so they are kept in `sizeChars` (they really are billed).
- [obs] Image reads: `content` is `[{type:image, source:{type:base64,…}}]`, `toolUseResult.type: image`.
  Size of base64 is **not** representative of tokens: image results use the char heuristic only when
  context-delta is unavailable, flagged `confidence: low`.

## Compaction

**Verified for manual `/compact` only** (one throwaway session, 2.1.289, 2026-10-05). Auto-compaction near
the context limit was not observed and may write different markers; the context-drop check is the
fallback for it.

- [obs] A `system` line with `subtype: "compact_boundary"`, **`parentUuid: null`**, `logicalParentUuid`
  pointing at the last pre-compaction line, `level: "info"`, and `compactMetadata`:
  `{ trigger: "manual", preTokens, postTokens, durationMs, preservedMessages: { anchorUuid, uuids[], allUuids[] },
  preservedSegment: { headUuid, anchorUuid, tailUuid } }`.
- [obs] Then a `user` line with `isCompactSummary: true` and `isVisibleInTranscriptOnly: true` (the summary).
  `preservedMessages.anchorUuid` is this line.
- [obs] **Compaction can keep messages:** `preservedMessages.allUuids` lists pre-compaction lines that stay in
  context (in the test, the final assistant turn). The parser maps them to tool calls
  (`Compaction.preservedToolCallIds`); a preserved output's lifetime continues past the boundary.
- [obs] After the boundary, Claude Code **re-attaches recently read files** as `attachment` lines with
  `attachment.type: "file"` and the content in `rendered[].content`. In the test, "read the file again" was
  answered from that attachment with no tool call.
- [obs] Pre-compaction lines remain in the file. The parser follows `logicalParentUuid` across the boundary.
- [obs] **The context-drop check alone would miss it:** context went 41k → 36k (−14%) because the system
  prompt and tool definitions were ~35k. Markers carried detection; the drop check (≥ 50% from ≥ 20k) is
  only a fallback for unmarked compactions.

## Re-reads of unchanged files

- [obs] Claude Code 2.1.289 answers a re-read of an unchanged file with a short stub (~90 chars,
  `toolUseResult.type: "file_unchanged"`) instead of the content. The parser marks these
  (`ToolResult.unchanged`), and repeated-reads ignores them. On current Claude Code, whole-file re-reads of
  unchanged files are therefore already cheap; repeated-reads mainly fires on older clients and on cases
  the stub doesn't cover.

## Answers to PRODUCT.md §20

1. Compaction representation: verified for manual `/compact` (see above); pre-compaction lines stay, and
   some may be preserved in context. Auto-compaction unverified.
2. Subagents: separate files, same `sessionId` as the parent, `isSidechain: true`.
3. TTL breakdown: yes (`cache_creation.ephemeral_5m/1h_input_tokens`). Priced separately.
4. Bash failures: reliably `is_error: true` + `Exit code N` prefix.
5. Read line-number prefixes: yes; they are real context tokens.
6. Context-delta error margin: measured against fixtures (exact by construction) — real-session margin TBD.
7. Supported versions at v0.1: 2.1.27x–2.1.28x (observed).
