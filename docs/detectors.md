# Detectors

All detectors run on the **active branch** only (not abandoned branches, not subagents). Every finding
carries non-empty evidence (step indices you can check in the report timeline), a confidence, and an
impact with its method. Thresholds are named constants in each detector file.

Token sizes of individual tool outputs are **estimates** (see "Estimation" below). Step usage, context
size, and totals are **measured** from the API usage the transcript records.

## Estimation

A tool result returned after step N is first sent to the model at step N+1.

1. **context-delta** (preferred): `context[N+1] − context[N] − output[N] − injected[N+1]`, where
   `injected` is the char-heuristic size of any non-tool content that arrived in between (reminder
   attachments, meta messages). Parallel results share the delta in proportion to their character size.
   Discarded when: a human prompt or a compaction sits between N and N+1, the delta is ≤ 0, or it is
   more than 3× away from the char heuristic (ambiguous attribution).
2. **char-heuristic**: `ceil(chars / 2.6)`. The ratio was calibrated on code-heavy sessions (source files,
   test and build logs) and will vary with content mix; prose, JSON, or minified output can be off by tens of
   percent. It's only the fallback, and every number says which method produced it (see decisions.md).
3. **image-default**: 1,600 tokens per image when it can't be measured. Findings built on it are `low`
   confidence and hidden by default.

## repeated-reads

**Intent:** the same file content entered the context more than once for no reason.

**Fires when**, for one normalized path (resolved against the session cwd, `./` and `..` collapsed):

- a `Read` returns content whose line range is **fully contained** in an earlier still-live read of the
  same path (ranges come from the result's `cat -n` line numbers, falling back to offset/limit),
- the earlier read wasn't an error, and the later result is at least 200 chars (not a stub),
- and **nothing invalidated** the earlier read in between:
  - `Edit` / `MultiEdit` / `Write` / `NotebookEdit` on that path,
  - a Bash command that could modify it: global modifiers (`git checkout|restore|stash|reset|pull|merge|rebase|apply|switch|…`,
    `prettier --write`, `eslint --fix`, `black`, `gofmt -w`, `ruff format`, `cargo fmt`, `npm run format`, `patch`, `rsync`, …)
    invalidate everything; targeted modifiers (`sed -i`, `perl -i`, `mv`, `cp`, `rm`, `touch`, `tee`, …)
    invalidate paths whose file name appears in the command; `>`/`>>` redirects invalidate their target,
  - an `edited_text_file` notice (the user edited the file themselves),
  - an `Agent`/`Task` call (a subagent may have changed anything),
  - a compaction (the earlier copy is gone).

**Emits** one finding per path with ≥ 2 redundant reads. `high` at ≥ 4 redundant reads or ≥ 20k
redundant tokens, else `warn`. Confidence `high`.

**Impact:** sum of the redundant reads' estimated sizes. Cost adds one cache write per redundant copy
plus its cache reads until compaction or session end.

**Known limitations:** Bash reads (`cat`, `head`) aren't counted yet. A Bash command that modifies a file
without naming it (e.g. a custom codegen script) isn't recognized as a modifier; the global-modifier
list is the guard. A file changed by an external process the agent can't see (watchers, other terminals
without an `edited_text_file` notice) makes a re-read legitimate but still flagged.

## output-lifetime

**Intent:** find the single tool outputs that cost the most *because they stayed in context*.

**Model:** an output of `S` tokens first appears at step N+1 (billed there as input/cache write) and is
re-sent with every later step until a compaction or the end of the branch.
`lifetimeTokens = S × laterSteps`. Cost is priced per later step at that step's measured cache-read ratio
(the cache-read share at the cache-read rate, the rest at the input rate).

**Fires when** `S ≥ 4,000` and `lifetimeTokens ≥ 100,000`; at most the top 5 per session.
`high` at ≥ 2M lifetime tokens or ≥ $1, else `warn`.

**Confidence:** `high` only for a context-delta estimate not adjacent to a compaction; `medium` for the
char heuristic; `low` for image defaults.

**Suggestions** are tool-specific (Read → line range or Grep; Bash → head/tail/grep or redirect; Grep →
narrow the pattern). Tools without a justified suggestion get none.

**Overlap:** skipped only for outputs whose lifetime another finding already counts (redundant read copies).
The first read of a re-read file and large failing outputs in a failure loop are still reported.

**Known limitations:** an output can be large *and necessary*. This detector says what it cost, not that
it was a mistake. Very large outputs Claude Code persists to disk only cost their preview, which is what
the transcript holds and what is measured.

## failure-loops

**Intent:** the agent keeps trying and keeps failing the same way.

**Failure:** a tool result with `is_error: true` (Bash failures also carry `Exit code N`).

**Error signature:** ANSI stripped; UUIDs, timestamps, hex addresses, absolute paths, durations, and
all numbers replaced; whitespace collapsed; hash of exit code + recognized error type
(`TypeError`, `E0308`, `TS2345`, `ERR_*`, `panic`, …) + first and last meaningful lines.

**Action:** tool name + normalized command (Bash) or path (other tools).

**Fires when** the same (action, signature) fails **≥ 3 times** in a chain where:

- consecutive failures are ≤ 15 steps apart,
- each consecutive pair has an `Edit`/`Write` in between (edit → test → same failure) **or** the exact
  same command (blind retry),
- no success and no *different* failure of the same action occurs in between (that's progress).

Bash commands matching the polling allowlist (`curl`, `wget`, `nc -z`, `sleep`, `pg_isready`, `wait-on`,
`kubectl get|wait|rollout status`, `gh run|pr view|watch|checks`, `docker ps|logs|inspect`, `lsof`) are
ignored. Override with `detectorOptions.pollingPatterns`.

**Severity:** `high` at ≥ 5 repetitions or when the loop spans ≥ 25% of the session's steps; else `warn`.
**Confidence:** `high` when the signature includes an error type or exit code, else `medium`.

**Impact:** new tokens (input + cache writes + output) of all steps from the first to the last failure;
the cost estimate includes those steps' cache reads.

**Known limitations:** a loop that alternates between two commands (e.g. `test` then `lint`) with the same
underlying failure is seen as two shorter chains. Tool errors that aren't flagged `is_error` (e.g. a
test runner that exits 0 on failure) are invisible.
