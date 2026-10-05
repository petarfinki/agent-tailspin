# Decisions and deviations from PRODUCT.md

- **npm instead of pnpm** for scripts: pnpm is not installed on the maintainer machine; nothing depends on pnpm features.
- **Active branch = message ids on the leaf→root path**, with tool results joined by `tool_use_id`
  (not by tree position). M0 showed parallel tool calls create forks that are not rewinds.
- **Split-message usage = per-field max** across lines of one `message.id` (subagent files show
  growing `output_tokens` across lines).
- **Subagents are discovered from `<session>/subagents/*.jsonl`**, not interleaved. v0.1 adds their
  usage to `sidechains` totals only.
- **Leaf selection:** last `last-prompt.leafUuid` if it resolves, otherwise the latest-timestamp
  tree node.
