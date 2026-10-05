// Claude Code JSONL → Session. PURE: no fs, no node imports. See docs/format-notes.md.
import { addUsage, charTokens, emptyUsage } from "../../core/tokens.js";
import { normalizePath } from "../../core/text.js";
import type {
  Compaction,
  Exchange,
  ParseWarning,
  Session,
  Step,
  ToolCall,
  ToolResult,
  Usage,
} from "../../core/types.js";

/** Context shrinking by more than this fraction between steps counts as a compaction. */
export const COMPACTION_DROP_RATIO = 0.5;
/** ...but only when the earlier context was at least this large. */
export const COMPACTION_MIN_CONTEXT = 20_000;
/** A context-delta estimate further than this factor from the char heuristic is discarded as ambiguous. */
export const DELTA_SANITY_FACTOR = 3;
/** Rough token cost of one image when it can't be measured. */
export const IMAGE_TOKENS_DEFAULT = 1_600;

const TREE_TYPES = new Set(["user", "assistant", "attachment", "system"]);
const METADATA_TYPES = new Set([
  "summary",
  "file-history-snapshot",
  "file-history-delta",
  "ai-title",
  "custom-title",
  "last-prompt",
  "mode",
  "permission-mode",
  "queue-operation",
  "atis-latch",
  "agent-name",
  "cost-state",
  "tag",
  "pr-link",
  "worktree-state",
]);

type Obj = Record<string, unknown>;
interface Line {
  o: Obj;
  n: number; // 1-based line number
}

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function readUsage(u: unknown): Usage | undefined {
  if (!isObj(u)) return undefined;
  const cc = isObj(u.cache_creation) ? u.cache_creation : {};
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheWriteTokens: num(u.cache_creation_input_tokens),
    cacheWrite5mTokens: num(cc.ephemeral_5m_input_tokens),
    cacheWrite1hTokens: num(cc.ephemeral_1h_input_tokens),
  };
}

const maxUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: Math.max(a.inputTokens, b.inputTokens),
  outputTokens: Math.max(a.outputTokens, b.outputTokens),
  cacheReadTokens: Math.max(a.cacheReadTokens, b.cacheReadTokens),
  cacheWriteTokens: Math.max(a.cacheWriteTokens, b.cacheWriteTokens),
  cacheWrite5mTokens: Math.max(a.cacheWrite5mTokens, b.cacheWrite5mTokens),
  cacheWrite1hTokens: Math.max(a.cacheWrite1hTokens, b.cacheWrite1hTokens),
});

const contextOf = (u: Usage): number => u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;

/** Sum of all string lengths in a JSON value. */
function textChars(v: unknown): number {
  if (typeof v === "string") return v.length;
  if (Array.isArray(v)) return v.reduce<number>((s, x) => s + textChars(x), 0);
  if (isObj(v)) return Object.values(v).reduce<number>((s, x) => s + textChars(x), 0);
  return 0;
}

function contentText(c: unknown): string {
  if (typeof c === "string") return c;
  return arr(c)
    .map((b) => (isObj(b) && typeof b.text === "string" ? b.text : ""))
    .join("");
}

/** A prompt typed by the human (starts an Exchange). See format-notes "User lines". */
function humanPromptText(o: Obj): string | undefined {
  if (o.type !== "user" || o.isMeta === true || o.isCompactSummary === true) return undefined;
  const origin = isObj(o.origin) ? str(o.origin.kind) : undefined;
  if (origin !== undefined && origin !== "human") return undefined;
  const msg = isObj(o.message) ? o.message : undefined;
  const c = msg?.content;
  if (Array.isArray(c) && c.some((b) => isObj(b) && b.type === "tool_result")) return undefined;
  const text = contentText(c);
  if (!text || /^\s*<(local-command-stdout|local-command-caveat|task-notification)>/.test(text)) return undefined;
  return text;
}

interface MsgGroup {
  id: string;
  lines: Line[];
  usage: Usage;
  model?: string;
}

function parseLines(input: string, warnings: ParseWarning[]): Line[] {
  const raw = input.split("\n");
  while (raw.length && raw[raw.length - 1]!.trim() === "") raw.pop();
  const out: Line[] = [];
  raw.forEach((l, i) => {
    if (!l.trim()) return;
    try {
      const o: unknown = JSON.parse(l);
      if (isObj(o)) out.push({ o, n: i + 1 });
      else warnings.push({ line: i + 1, kind: "not-an-object" });
    } catch {
      warnings.push({ line: i + 1, kind: i === raw.length - 1 ? "truncated-last-line" : "malformed-json" });
    }
  });
  return out;
}

function groupAssistant(lines: Line[]): Map<string, MsgGroup> {
  const groups = new Map<string, MsgGroup>();
  for (const line of lines) {
    const o = line.o;
    if (o.type !== "assistant" || o.isApiErrorMessage === true) continue;
    const msg = isObj(o.message) ? o.message : undefined;
    const id = str(msg?.id);
    const usage = readUsage(msg?.usage);
    if (!id || !usage || msg?.model === "<synthetic>") continue;
    const g = groups.get(id);
    if (g) {
      g.lines.push(line);
      g.usage = maxUsage(g.usage, usage);
    } else groups.set(id, { id, lines: [line], usage, model: str(msg?.model) });
  }
  return groups;
}

export interface ParseOptions {
  /** Raw JSONL of subagent transcripts belonging to this session. */
  sidechains?: string[];
}

export function parse(input: string, opts: ParseOptions = {}): Session {
  const warnings: ParseWarning[] = [];
  const lines = parseLines(input, warnings);

  // ---- classify lines ----
  const unknownTypes = new Map<string, { first: number; count: number }>();
  const tree: Line[] = [];
  const sidechainLines: Line[] = [];
  for (const line of lines) {
    const t = str(line.o.type) ?? "(none)";
    if (TREE_TYPES.has(t)) (line.o.isSidechain === true ? sidechainLines : tree).push(line);
    else if (!METADATA_TYPES.has(t)) {
      const u = unknownTypes.get(t);
      if (u) u.count++;
      else unknownTypes.set(t, { first: line.n, count: 1 });
    }
  }
  for (const [t, u] of unknownTypes)
    warnings.push({ line: u.first, kind: "unknown-type", detail: `type "${t.slice(0, 40)}" × ${u.count}` });

  // ---- active branch: walk leaf → root, following logicalParentUuid across compaction boundaries ----
  const byUuid = new Map<string, Line>();
  for (const line of tree) {
    const u = str(line.o.uuid);
    if (u) byUuid.set(u, line);
  }
  const path: Line[] = [];
  const leaf = [...tree].reverse().find((l) => str(l.o.uuid));
  const seen = new Set<string>();
  for (let cur = leaf; cur; ) {
    const u = str(cur.o.uuid)!;
    if (seen.has(u)) {
      warnings.push({ line: cur.n, kind: "parent-cycle" });
      break;
    }
    seen.add(u);
    path.push(cur);
    const parent = str(cur.o.parentUuid) ?? str(cur.o.logicalParentUuid);
    if (!parent) break;
    const next = byUuid.get(parent);
    if (!next) {
      warnings.push({ line: cur.n, kind: "dangling-parent" });
      break;
    }
    cur = next;
  }
  path.reverse(); // root → leaf
  const pathPos = new Map<Line, number>(path.map((l, i) => [l, i]));

  // ---- steps: deduped assistant messages with at least one line on the path ----
  const groups = groupAssistant(tree);
  const active: { g: MsgGroup; pos: number }[] = [];
  const abandoned = { stepCount: 0, usage: emptyUsage() };
  const usageByModel: Record<string, Usage> = {};
  const addModel = (model: string | undefined, u: Usage) => {
    const k = model ?? "unknown";
    usageByModel[k] = addUsage(usageByModel[k] ?? emptyUsage(), u);
  };
  for (const g of groups.values()) {
    addModel(g.model, g.usage);
    const positions = g.lines.map((l) => pathPos.get(l)).filter((p): p is number => p !== undefined);
    if (positions.length) active.push({ g, pos: Math.min(...positions) });
    else {
      abandoned.stepCount++;
      abandoned.usage = addUsage(abandoned.usage, g.usage);
    }
  }
  active.sort((a, b) => a.pos - b.pos);

  // ---- tool results, joined by tool_use_id regardless of tree position ----
  const results = new Map<string, Obj>();
  for (const line of tree) {
    if (line.o.type !== "user" || !isObj(line.o.message)) continue;
    for (const b of arr(line.o.message.content))
      if (isObj(b) && b.type === "tool_result" && typeof b.tool_use_id === "string")
        results.set(b.tool_use_id, b);
  }

  const steps: Step[] = active.map(({ g }, index) => {
    const toolCalls: ToolCall[] = [];
    for (const line of g.lines) {
      const msg = line.o.message as Obj;
      for (const b of arr(msg.content)) {
        if (!isObj(b) || b.type !== "tool_use" || typeof b.id !== "string") continue;
        const call: ToolCall = { id: b.id, name: str(b.name) ?? "?", input: isObj(b.input) ? b.input : {} };
        const r = results.get(b.id);
        if (r) call.result = readResult(r);
        toolCalls.push(call);
      }
    }
    return {
      index,
      messageId: g.id,
      sourceUuids: g.lines.map((l) => str(l.o.uuid) ?? ""),
      timestamp: str(g.lines[0]!.o.timestamp) ?? "",
      model: g.model,
      usage: g.usage,
      contextTokens: contextOf(g.usage),
      toolCalls,
      exchangeIndex: -1,
      externalEdits: [],
    };
  });

  // ---- walk the path between steps: prompts, injected content, compaction markers, external edits ----
  const stepAtPos = new Map<number, number>(active.map(({ pos }, i) => [pos, i]));
  const exchanges: Exchange[] = [];
  const extraChars: number[] = steps.map(() => 0); // non-tool content added before step i
  const promptBefore: boolean[] = steps.map(() => false);
  const markerBefore = new Set<number>();
  const cwd = str(leaf?.o.cwd);
  let nextStep = 0;
  for (let p = 0; p < path.length; p++) {
    const si = stepAtPos.get(p);
    if (si !== undefined) {
      nextStep = si + 1;
      continue;
    }
    const o = path[p]!.o;
    if (nextStep >= steps.length && o.type !== "user") continue;
    const prompt = humanPromptText(o);
    if (prompt !== undefined) {
      exchanges.push({ index: exchanges.length, userTextChars: prompt.length, userText: prompt, firstStepIndex: nextStep });
      if (nextStep < steps.length) promptBefore[nextStep] = true;
    }
    if (nextStep >= steps.length) continue;
    if ((o.type === "system" && o.subtype === "compact_boundary") || o.isCompactSummary === true) markerBefore.add(nextStep);
    if (o.type === "attachment" && isObj(o.attachment)) {
      extraChars[nextStep]! += textChars(o.rendered);
      const a = o.attachment;
      if (a.type === "edited_text_file" && typeof a.filename === "string")
        steps[nextStep]!.externalEdits.push(normalizePath(a.filename, cwd));
    } else if (o.type === "user" && prompt === undefined && isObj(o.message)) {
      const c = o.message.content;
      if (!(Array.isArray(c) && c.some((b) => isObj(b) && b.type === "tool_result"))) extraChars[nextStep]! += contentText(c).length;
    } else if (prompt !== undefined) extraChars[nextStep]! += prompt.length;
  }
  let ex = -1;
  for (const s of steps) {
    while (ex + 1 < exchanges.length && exchanges[ex + 1]!.firstStepIndex <= s.index) ex++;
    s.exchangeIndex = ex;
  }

  // ---- compactions: markers and/or sharp context drops ----
  const compactions: Compaction[] = [];
  for (let i = 1; i < steps.length; i++) {
    const before = steps[i - 1]!.contextTokens;
    const after = steps[i]!.contextTokens;
    const drop = before >= COMPACTION_MIN_CONTEXT && after < before * (1 - COMPACTION_DROP_RATIO);
    const marker = markerBefore.has(i);
    if (drop || marker)
      compactions.push({ atStepIndex: i, detectedBy: drop && marker ? "both" : marker ? "marker" : "context-drop", contextBefore: before, contextAfter: after });
  }
  const compactedAt = new Set(compactions.map((c) => c.atStepIndex));

  // ---- tool result token estimates (PRODUCT.md §8) ----
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    const withResult = s.toolCalls.filter((c) => c.result);
    if (!withResult.length) continue;
    const next = steps[i + 1];
    const textResults = withResult.filter((c) => !c.result!.isImage);
    const images = withResult.filter((c) => c.result!.isImage);
    let delta: number | undefined;
    if (next && !compactedAt.has(i + 1) && !promptBefore[i + 1]) {
      delta = next.contextTokens - s.contextTokens - s.usage.outputTokens - charTokens(extraChars[i + 1]!);
    }
    if (images.length === 1 && textResults.length === 0 && delta !== undefined && delta > 0) {
      Object.assign(images[0]!.result!, { estTokens: delta, estMethod: "context-delta" });
      continue;
    }
    for (const c of images) Object.assign(c.result!, { estTokens: IMAGE_TOKENS_DEFAULT, estMethod: "image-default" });
    const chars = textResults.reduce((n, c) => n + c.result!.sizeChars, 0);
    const textDelta = delta === undefined ? undefined : delta - images.length * IMAGE_TOKENS_DEFAULT;
    const heur = charTokens(chars);
    const usable =
      textDelta !== undefined && chars > 0 && textDelta > 0 && textDelta <= heur * DELTA_SANITY_FACTOR && textDelta >= heur / DELTA_SANITY_FACTOR;
    for (const c of textResults) {
      const r = c.result!;
      if (usable) Object.assign(r, { estTokens: Math.round((textDelta * r.sizeChars) / chars), estMethod: "context-delta" });
      else Object.assign(r, { estTokens: charTokens(r.sizeChars), estMethod: "char-heuristic" });
    }
  }

  // ---- sidechains (subagent files, or legacy interleaved isSidechain lines) ----
  const sidechains = { count: 0, stepCount: 0, usage: emptyUsage() };
  const sideSources = [sidechainLines, ...(opts.sidechains ?? []).map((t) => parseLines(t, []))];
  for (const src of sideSources) {
    const gs = groupAssistant(src);
    if (!gs.size) continue;
    sidechains.count++;
    for (const g of gs.values()) {
      sidechains.stepCount++;
      sidechains.usage = addUsage(sidechains.usage, g.usage);
      addModel(g.model, g.usage);
    }
  }

  const activeUsage = steps.reduce((u, s) => addUsage(u, s.usage), emptyUsage());
  const stamps = tree.map((l) => str(l.o.timestamp)).filter((t): t is string => !!t).sort();
  const firstWithSession = lines.find((l) => typeof l.o.sessionId === "string");
  return {
    id: str(firstWithSession?.o.sessionId) ?? "unknown",
    source: "claude-code",
    clientVersion: str(leaf?.o.version),
    cwd,
    gitBranch: str(leaf?.o.gitBranch),
    startedAt: stamps[0] ?? "",
    endedAt: stamps[stamps.length - 1] ?? "",
    steps,
    exchanges,
    compactions,
    abandoned,
    sidechains,
    warnings,
    models: [...new Set(steps.map((s) => s.model).filter((m): m is string => !!m))].sort(),
    usageByModel,
    totals: { usage: addUsage(addUsage(activeUsage, abandoned.usage), sidechains.usage) },
  };
}

function readResult(block: Obj): ToolResult {
  const c = block.content;
  const isImage = Array.isArray(c) && c.some((b) => isObj(b) && b.type === "image");
  const text = contentText(c);
  const m = /^Exit code (\d+)/.exec(text);
  return {
    isError: block.is_error === true,
    exitCode: m ? Number(m[1]) : undefined,
    isImage,
    sizeChars: isImage ? textChars(c) : text.length,
    text,
    estTokens: 0,
    estMethod: "char-heuristic",
  };
}
