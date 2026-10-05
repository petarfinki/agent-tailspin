# Decisions and deviations from PRODUCT.md

- **npm instead of pnpm** for scripts: pnpm is not installed on the maintainer machine; nothing depends on pnpm features.
- **Active branch = message ids on the leaf→root path**, with tool results joined by `tool_use_id`
  (not by tree position). M0 showed parallel tool calls create forks that are not rewinds.
- **Split-message usage = per-field max** across lines of one `message.id` (subagent files show
  growing `output_tokens` across lines).
- **Subagents are discovered from `<session>/subagents/*.jsonl`**, not interleaved. v0.1 adds their
  usage to `sidechains` totals only.
- **Leaf = last tree line in file order** (not `last-prompt.leafUuid`, which marks the last *prompt* and
  would cut off the final reply). After a rewind the new branch is always written later in the file.
- **Totals are transcript-only (a lower bound).** M1 cross-check against Claude Code's own `cost-state`
  line on 5 local sessions: one matched to the cent ($13.111 vs $13.112, identical token counts); the
  others were 5–15% lower. The difference is API calls that never appear as transcript steps (auto-mode
  classifier requests, advisor calls, Haiku title calls). Per-step attribution is unaffected. ccusage was
  not used because running it needs a network install; cost-state is a first-party reference.
- **Zero runtime dependencies.** `node:util` `parseArgs` replaces `cac`/`commander`; ANSI colors are a
  few lines. Nothing to justify, nothing to audit.
