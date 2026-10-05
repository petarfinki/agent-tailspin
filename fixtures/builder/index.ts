// Synthetic Claude Code transcript builder. Emits JSONL in the observed real format
// (docs/format-notes.md) with internally consistent usage:
//   context[n] = context[n-1] + output[n-1] + new tool results + new injected content
// Tool result text uses 4 chars/token, so the char heuristic (3.5) and the context-delta method
// give distinguishable answers and tests can assert which one was used.

export const FIXTURE_CHARS_PER_TOKEN = 4;

type Obj = Record<string, unknown>;

export interface CallSpec {
  name: string;
  input: Obj;
  /** Result size in tokens (ground truth). */
  tokens: number;
  isError?: boolean;
  /** Full result text; padded to `tokens` if shorter. */
  text?: string;
  image?: boolean;
}

const pad = (head: string, tokens: number, filler: (i: number) => string): string => {
  const want = tokens * FIXTURE_CHARS_PER_TOKEN;
  let s = head;
  for (let i = 1; s.length < want; i++) s += filler(i);
  return s.slice(0, Math.max(want, head.length));
};

export function read(path: string, o: { tokens?: number; offset?: number; limit?: number; error?: string } = {}): CallSpec {
  const input: Obj = { file_path: path };
  if (o.offset !== undefined) input.offset = o.offset;
  if (o.limit !== undefined) input.limit = o.limit;
  if (o.error) return { name: "Read", input, tokens: 20, isError: true, text: `<tool_use_error>${o.error}</tool_use_error>` };
  const start = o.offset ?? 1;
  return {
    name: "Read",
    input,
    tokens: o.tokens ?? 800,
    text: pad("", o.tokens ?? 800, (i) => `${String(start + i - 1).padStart(6)}\tconst value${i} = compute(${i}); // synthetic\n`),
  };
}

export const edit = (path: string): CallSpec => ({
  name: "Edit",
  input: { file_path: path, old_string: "a", new_string: "b" },
  tokens: 30,
  text: `The file ${path} has been updated successfully.`,
});

export const write = (path: string): CallSpec => ({
  name: "Write",
  input: { file_path: path, content: "x" },
  tokens: 30,
  text: `File created successfully at: ${path}`,
});

export function bash(command: string, o: { tokens?: number; fail?: string; exit?: number; out?: string } = {}): CallSpec {
  const tokens = o.tokens ?? 60;
  if (o.fail !== undefined) {
    const head = `Exit code ${o.exit ?? 1}\n${o.fail}\n`;
    return { name: "Bash", input: { command }, tokens, isError: true, text: pad(head, tokens, (i) => `    at frame${i} (synthetic.js)\n`) };
  }
  return { name: "Bash", input: { command }, tokens, text: pad(o.out ?? "", tokens, (i) => `log line ${i}: ok\n`) };
}

export const tool = (name: string, input: Obj, tokens = 50): CallSpec => ({ name, input, tokens, text: pad("", tokens, () => "result ") });

export const image = (path: string, tokens = 1500): CallSpec => ({ name: "Read", input: { file_path: path }, tokens, image: true });

interface State {
  last: string | null;
  prevCtx: number;
  prevOut: number;
  pending: number;
}

export interface BuildResult {
  jsonl: string;
  lines: Obj[];
  /** Ground-truth result tokens by tool_use id. */
  truth: Map<string, number>;
  /** Tool ids in emission order (handy for assertions). */
  toolIds: string[];
}

export class SessionBuilder {
  private lines: Obj[] = [];
  private n = 0;
  private st: State = { last: null, prevCtx: 0, prevOut: 0, pending: 0 };
  private checkpoints = new Map<string, State>();
  private truth = new Map<string, number>();
  private toolIds: string[] = [];
  private t0 = Date.parse("2026-01-01T10:00:00Z");

  constructor(
    private opts: { model: string; cwd: string; sessionId: string; systemTokens: number; version: string; outTokens: number; thinking: boolean },
  ) {
    this.st.pending = opts.systemTokens;
  }

  private id(prefix: string): string {
    this.n++;
    return prefix === "uuid" ? `00000000-0000-4000-8000-${String(this.n).padStart(12, "0")}` : `${prefix}_${String(this.n).padStart(6, "0")}`;
  }

  private base(type: string, parent: string | null = this.st.last): Obj {
    return {
      parentUuid: parent,
      isSidechain: false,
      userType: "external",
      cwd: this.opts.cwd,
      sessionId: this.opts.sessionId,
      version: this.opts.version,
      gitBranch: "main",
      type,
      uuid: this.id("uuid"),
      timestamp: new Date(this.t0 + this.lines.length * 5000).toISOString(),
    };
  }

  private push(o: Obj): Obj {
    this.lines.push(o);
    if (typeof o.uuid === "string") this.st.last = o.uuid;
    return o;
  }

  user(text: string, o: { tokens?: number } = {}): this {
    const tokens = o.tokens ?? Math.ceil(text.length / FIXTURE_CHARS_PER_TOKEN);
    this.push({ ...this.base("user"), promptId: this.id("prompt"), message: { role: "user", content: text }, origin: { kind: "human" } });
    this.st.pending += tokens;
    return this;
  }

  /** Injected system-reminder style attachment (context grows, not a human prompt). */
  reminder(tokens: number): this {
    const text = "r".repeat(Math.round(tokens * 3.5));
    this.push({ ...this.base("attachment"), attachment: { type: "total_tokens_reminder" }, rendered: [text] });
    this.st.pending += tokens;
    return this;
  }

  /** The user edited a file outside the agent (Claude Code emits an `edited_text_file` attachment). */
  editedExternally(path: string): this {
    this.push({ ...this.base("attachment"), attachment: { type: "edited_text_file", filename: path, snippet: "…" } });
    return this;
  }

  private usage(ctx: number, out: number): Obj {
    const input = 3;
    const cacheRead = Math.min(this.st.prevCtx, ctx - input);
    const write = ctx - input - cacheRead;
    return {
      input_tokens: input,
      cache_creation_input_tokens: write,
      cache_read_input_tokens: cacheRead,
      cache_creation: { ephemeral_5m_input_tokens: write, ephemeral_1h_input_tokens: 0 },
      output_tokens: out,
      service_tier: "standard",
    };
  }

  /** One assistant API call with the given tool calls (parallel when more than one). */
  step(calls: CallSpec[], o: { outTokens?: number; text?: string } = {}): this {
    const out = o.outTokens ?? this.opts.outTokens;
    const ctx = this.st.prevCtx + this.st.prevOut + this.st.pending;
    const usage = this.usage(ctx, out);
    const msgId = this.id("msg");
    const requestId = this.id("req");
    const blocks: Obj[] = [];
    if (this.opts.thinking) blocks.push({ type: "thinking", thinking: "", signature: "sig" });
    if (o.text) blocks.push({ type: "text", text: o.text });
    const ids = calls.map(() => this.id("toolu"));
    calls.forEach((c, i) => blocks.push({ type: "tool_use", id: ids[i], name: c.name, input: c.input, caller: { type: "direct" } }));
    const blockLine = new Map<number, string>();
    blocks.forEach((b, bi) => {
      const line = this.push({
        ...this.base("assistant"),
        requestId,
        message: { id: msgId, type: "message", role: "assistant", model: this.opts.model, content: [b], stop_reason: calls.length ? "tool_use" : "end_turn", usage },
      });
      blockLine.set(bi, line.uuid as string);
    });
    const firstTool = blocks.length - calls.length;
    let newTokens = 0;
    calls.forEach((c, i) => {
      const content = c.image
        ? [{ type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(4000) } }]
        : (c.text ?? pad("", c.tokens, () => "x"));
      const block: Obj = { tool_use_id: ids[i], type: "tool_result", content };
      if (c.name === "Bash" || c.isError) block.is_error = !!c.isError;
      this.push({
        ...this.base("user", blockLine.get(firstTool + i)!),
        promptId: "p",
        message: { role: "user", content: [block] },
        toolUseResult: c.name === "Bash" ? { stdout: "", stderr: "", interrupted: false, isImage: false, noOutputExpected: false } : { type: c.image ? "image" : "text" },
        sourceToolAssistantUUID: blockLine.get(firstTool + i),
      });
      this.truth.set(ids[i]!, c.tokens);
      this.toolIds.push(ids[i]!);
      newTokens += c.tokens;
    });
    this.st = { ...this.st, prevCtx: ctx, prevOut: out, pending: newTokens };
    return this;
  }

  read(...a: Parameters<typeof read>): this { return this.step([read(...a)]); }
  edit(path: string): this { return this.step([edit(path)]); }
  write(path: string): this { return this.step([write(path)]); }
  bash(...a: Parameters<typeof bash>): this { return this.step([bash(...a)]); }

  /** Final assistant text reply (end_turn). */
  text(text = "Done.", o: { outTokens?: number } = {}): this {
    return this.step([], { text, outTokens: o.outTokens ?? 80 });
  }

  /** Compaction: boundary marker + summary; context resets to system prompt + summary. */
  compact(o: { summaryTokens?: number } = {}): this {
    const summaryTokens = o.summaryTokens ?? 2000;
    const prev = this.st.last;
    this.push({ ...this.base("system", null), subtype: "compact_boundary", logicalParentUuid: prev, content: "Conversation compacted", compactMetadata: { trigger: "auto", preTokens: this.st.prevCtx } });
    this.push({ ...this.base("user"), isCompactSummary: true, message: { role: "user", content: "s".repeat(summaryTokens * FIXTURE_CHARS_PER_TOKEN) } });
    this.st = { ...this.st, prevCtx: this.opts.systemTokens, prevOut: 0, pending: summaryTokens };
    return this;
  }

  checkpoint(name: string): this {
    this.checkpoints.set(name, { ...this.st });
    return this;
  }

  rewindTo(name: string): this {
    const s = this.checkpoints.get(name);
    if (!s) throw new Error(`no checkpoint ${name}`);
    this.st = { ...s };
    return this;
  }

  /** Append an arbitrary line (for unknown types / fields tests). */
  raw(o: Obj): this {
    this.lines.push(o);
    return this;
  }

  build(): BuildResult {
    return {
      jsonl: this.lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      lines: this.lines,
      truth: this.truth,
      toolIds: this.toolIds,
    };
  }
}

export function session(
  o: { model?: string; cwd?: string; sessionId?: string; systemTokens?: number; outTokens?: number; thinking?: boolean } = {},
): SessionBuilder {
  return new SessionBuilder({
    model: o.model ?? "claude-opus-5-5",
    cwd: o.cwd ?? "/work/demo-app",
    sessionId: o.sessionId ?? "11111111-2222-4333-8444-555555555555",
    systemTokens: o.systemTokens ?? 12_000,
    version: "2.1.289",
    outTokens: o.outTokens ?? 150,
    thinking: o.thinking ?? false,
  });
}
