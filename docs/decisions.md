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
- **Totals count each API request once** (dedupe by `message.id`; split lines share one `requestId`).
  Cross-check against Claude Code's own `cost-state` line on 5 local sessions:
  - without subagents: one matched to the cent ($13.111 vs $13.112, identical token counts), two were
    ~5% lower (unexplained; ~1–3k uncached input tokens of difference),
  - with subagents (2 sessions): 13–15% lower. Counting each streamed subagent line separately reproduces
    cost-state within 0.2% and 3% ($16.734 vs $16.703, $12.79 vs $13.21). Subagent split lines carry
    cumulative usage snapshots of one request, so cost-state most likely sums snapshots. We keep
    count-once, since one request is billed once. Inference, not confirmed.
  - Ruled out: auto-mode classifier calls (the exact-match session had 332 classifier-tagged lines), and
    background-agent `outputFile`s (symlinks to the subagent transcripts, no extra requests).
  ccusage was not used because running it needs a network install; cost-state is a first-party reference.
- **Zero runtime dependencies.** `node:util` `parseArgs` replaces `cac`/`commander`; ANSI colors are a
  few lines. Nothing to justify, nothing to audit.
- **`CHARS_PER_TOKEN = 2.6`, not 3.5.** Measured on ~30 large outputs across 6 local sessions of one
  developer, all code-heavy (TypeScript/Python sources, test and build logs), with a clean context-delta
  estimate: chars/token ranged 1.6–3.1, median ≈ 2.6 (`cat -n` prefixes tokenize densely). 3.5 would
  underestimate those by 25–40%. Prose, JSON, minified files, or non-English text will differ; this is a
  fallback only, used when context-delta isn't available, and always labeled. Re-measure when the
  tokenizer changes or with more contributors' sessions.
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
- **No double-reporting, narrowly:** an `output-lifetime` finding is dropped only when another finding's
  impact already *includes that output's lifetime* (evidence flagged `includesLifetime`). Today that is only
  redundant read copies. The first read of a re-read file, and large failing outputs inside a failure
  loop, keep their lifetime finding. Being listed as evidence elsewhere isn't enough.
- **Default report path is the OS temp directory** (`$TMPDIR/agent-tailspin/report-<id>.html`), so running
  the tool never drops files into the user's project. `--out` overrides.
- **Compaction verified on a real manual `/compact`** (2026-10-05). Added from what it showed:
  preserved messages (`compactMetadata.preservedMessages`) keep outputs alive across the boundary for D1 and
  D2; `file_unchanged` re-read stubs are ignored by D1; the fixture builder emits the observed shape
  (`compaction-manual-real-shape`). Auto-compaction remains unverified.
- **`--label` report mode** (2026-10-16): TP/FP/unclear buttons per finding, verdicts in `localStorage`
  (per session hash), and an "Export labels" download in the `eval/run.ts` format. Off by default so normal
  and shared reports stay clean; defaults to `--min-confidence low` like `eval --template`. No free-text
  notes, so an export carries nothing beyond finding titles already in the report. Labels other people send
  must not count toward the release gate, which stays on the maintainer's own labels (PRODUCT.md §15).
