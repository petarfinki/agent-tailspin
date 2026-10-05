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
- **`CHARS_PER_TOKEN = 2.6`, not 3.5.** Measured on ~30 large outputs across 6 local sessions with a
  clean context-delta estimate: chars/token ranged 1.6–3.1, median ≈ 2.6 (Read results include `cat -n`
  prefixes, which tokenize densely). 3.5 would underestimate the fallback by 25–40%. Re-measure when the
  tokenizer changes. This answers PRODUCT.md §20 Q6 for now.
- **D1 requires containment, not just overlap.** A later read counts as redundant only if an earlier live
  read already covered its whole range. "Overlap" would flag a whole-file read after a 50-line peek, which
  brings new content. Ranges come from the `cat -n` prefixes in the result when present (so a truncated
  whole-file read doesn't "cover" lines it never returned), else from offset/limit.
- **D1 extra invalidations:** `edited_text_file` attachments (the user edited the file), and any
  `Agent`/`Task` call (a subagent may have edited anything). Precision over recall.
- **D2 severity** (unspecified in PRODUCT.md): `high` at ≥ 2M lifetime tokens or ≥ $1, else `warn`.
  1M was too loud: on Opus 5.5 that's ~$0.30 and fires on most long sessions.
- **D3 chaining:** consecutive failures of one loop must be ≤ 15 steps apart (rather than all within one
  15-step window), so a long loop is reported once. A success, or a different error, from the same action
  breaks the chain (progress). Each consecutive pair needs an edit in between *or* an identical command.
- **D3 in redacted mode** shows an error type only if it is a generic built-in name (TypeError, …);
  custom error class names can carry project names.
