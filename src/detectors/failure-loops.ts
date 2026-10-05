// D3: the agent keeps trying and keeps failing the same way.
// Definition and guards: docs/detectors.md#failure-loops
import { hash, stripAnsi } from "../core/text.js";
import type { Detector, Evidence, Finding, Session, ToolCall } from "../core/types.js";
import { WRITE_TOOLS, commandOf, filePathOf, findingId, fmtTokens, fmtUsd, stepCost } from "./util.js";

export const MIN_REPETITIONS = 3;
export const HIGH_REPETITIONS = 5;
/** Max steps between two failures of one loop. */
export const WINDOW_STEPS = 15;
export const HIGH_SPAN_FRACTION = 0.25;

/** Commands that legitimately fail until something becomes ready. Override via options.pollingPatterns. */
export const DEFAULT_POLLING_PATTERNS = [
  "\\bcurl\\b",
  "\\bwget\\b",
  "\\bnc\\s+-z",
  "\\bsleep\\b",
  "\\bpg_isready\\b",
  "\\bwait-on\\b",
  "\\bkubectl\\s+(get|wait|rollout\\s+status)\\b",
  "\\bgh\\s+(run|pr)\\s+(view|watch|checks|list)\\b",
  "\\bdocker\\s+(ps|logs|inspect)\\b",
  "\\blsof\\b",
];

/** Error type names safe to show in redacted reports (generic, not project-specific). */
const GENERIC_ERROR_TYPES = new Set(
  "Error TypeError ReferenceError SyntaxError RangeError AssertionError AssertionFailedError ValueError KeyError IndexError AttributeError ImportError ModuleNotFoundError NameError RuntimeError FileNotFoundError PermissionError TimeoutError ZeroDivisionError NullPointerException IllegalArgumentException IllegalStateException Traceback panic FAIL FAILED".split(" "),
);

const ERROR_TYPE = /\b([A-Z][A-Za-z]*(?:Error|Exception)|E\d{4}|TS\d{4}|ERR_[A-Z0-9_]+|panic|Traceback|FAIL(?:ED)?)\b/;

function normalizeLine(s: string): string {
  return s
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/g, "<time>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .replace(/(?:[A-Za-z]:)?(?:\/|\\)[^\s:'"()]+/g, "<path>")
    .replace(/\b\d+(\.\d+)?\s?(ms|s|sec|m|min|h)\b/g, "<dur>")
    .replace(/\d+/g, "N")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ErrorSignature {
  hash: string;
  errorType?: string;
  exitCode?: number;
}

export function errorSignature(text: string, exitCode?: number): ErrorSignature {
  const body = stripAnsi(text).replace(/^Exit code \d+\s*/, "");
  const errorType = ERROR_TYPE.exec(body)?.[1];
  const meaningful = body
    .split("\n")
    .map(normalizeLine)
    .filter((l) => /[A-Za-z]{2}/.test(l));
  const key = [exitCode ?? "", errorType ?? "", meaningful[0] ?? "", meaningful[meaningful.length - 1] ?? ""].join("|");
  return { hash: hash(key), errorType, exitCode };
}

function actionKey(call: ToolCall, cwd?: string): string {
  if (call.name === "Bash") return `Bash:${normalizeLine(commandOf(call))}`;
  return `${call.name}:${filePathOf(call, cwd) ?? ""}`;
}

interface Event {
  step: number;
  call: ToolCall;
  kind: "fail" | "ok" | "edit";
  action: string;
  sig?: ErrorSignature;
}

export const failureLoops: Detector = {
  id: "failure-loops",
  run(session, ctx) {
    const patterns = (Array.isArray(ctx.options.pollingPatterns) ? (ctx.options.pollingPatterns as string[]) : DEFAULT_POLLING_PATTERNS).map((p) => new RegExp(p));
    const events: Event[] = [];
    for (const step of session.steps) {
      for (const call of step.toolCalls) {
        if (WRITE_TOOLS.has(call.name)) {
          events.push({ step: step.index, call, kind: "edit", action: "" });
          continue;
        }
        if (!call.result) continue;
        if (call.name === "Bash" && patterns.some((p) => p.test(commandOf(call)))) continue;
        const action = actionKey(call, session.cwd);
        if (call.result.isError) events.push({ step: step.index, call, kind: "fail", action, sig: errorSignature(call.result.text, call.result.exitCode) });
        else events.push({ step: step.index, call, kind: "ok", action });
      }
    }

    // Build chains per (action, signature).
    const loops: Event[][] = [];
    const open = new Map<string, Event[]>();
    const close = (k: string) => {
      const c = open.get(k);
      if (c && c.length >= MIN_REPETITIONS) loops.push(c);
      open.delete(k);
    };
    let editSeq = 0;
    const editAt = new Map<Event, number>();
    for (const e of events) {
      if (e.kind === "edit") {
        editSeq++;
        continue;
      }
      editAt.set(e, editSeq);
      // Any other outcome of the same action breaks open chains for it (progress or success).
      for (const k of [...open.keys()]) {
        const [action, sig] = k.split("\u0000");
        if (action !== e.action) continue;
        if (e.kind === "ok" || sig !== e.sig!.hash) close(k);
      }
      if (e.kind !== "fail") continue;
      const k = `${e.action}\u0000${e.sig!.hash}`;
      const chain = open.get(k);
      if (chain) {
        const prev = chain[chain.length - 1]!;
        const editedBetween = editAt.get(prev)! < editSeq;
        const identical = commandOf(prev.call) === commandOf(e.call) && prev.call.name === e.call.name;
        if (e.step - prev.step <= WINDOW_STEPS && (editedBetween || identical)) {
          chain.push(e);
          continue;
        }
        close(k);
      }
      open.set(k, [e]);
    }
    for (const k of [...open.keys()]) close(k);

    return loops
      .sort((a, b) => a[0]!.step - b[0]!.step)
      .map((chain) => buildFinding(session, chain, editAt, ctx));
  },
};

function buildFinding(session: Session, chain: Event[], editsBefore: Map<Event, number>, ctx: Parameters<Detector["run"]>[1]): Finding {
  const first = chain[0]!;
  const last = chain[chain.length - 1]!;
  const sig = first.sig!;
  const shownType = sig.errorType && (!ctx.redacted || GENERIC_ERROR_TYPES.has(sig.errorType)) ? sig.errorType : undefined;
  const failure = [shownType, sig.exitCode !== undefined ? `exit ${sig.exitCode}` : undefined].filter(Boolean).join(", ") || "same error";
  const what = first.call.name === "Bash" ? ctx.displayCommand(commandOf(first.call)) : first.call.name;
  const steps = session.steps.slice(first.step, last.step + 1);
  const tokens = steps.reduce((n, s) => n + s.usage.inputTokens + s.usage.cacheWriteTokens + s.usage.outputTokens, 0);
  const costs = steps.map((s) => stepCost(s, ctx.pricing));
  const usd = costs.every((c) => c !== undefined) ? costs.reduce<number>((a, c) => a + c!, 0) : undefined;
  const spanSteps = last.step - first.step + 1;
  const minutes = (Date.parse(steps[steps.length - 1]!.timestamp) - Date.parse(steps[0]!.timestamp)) / 60_000;
  const blind = chain.every((e, i) => i === 0 || editsBefore.get(e) === editsBefore.get(chain[i - 1]!));
  const evidence: Evidence[] = chain.map((e) => ({
    stepIndex: e.step,
    toolCallId: e.call.id,
    note: `${e.call.name} failed${e.sig!.exitCode !== undefined ? ` (exit ${e.sig!.exitCode})` : ""} · ${shownType ?? "error"} · sig ${e.sig!.hash}`,
  }));
  return {
    id: findingId("failure-loops", evidence),
    detector: "failure-loops",
    severity: chain.length >= HIGH_REPETITIONS || spanSteps >= HIGH_SPAN_FRACTION * session.steps.length ? "high" : "warn",
    confidence: sig.errorType || sig.exitCode !== undefined ? "high" : "medium",
    title: `Same failure ${chain.length}× in a row: ${what}`,
    summary:
      `${blind ? "Retried without changes" : "Edit → run → same failure"} ${chain.length} times (${failure}) across steps ${first.step}–${last.step}` +
      (Number.isFinite(minutes) && minutes >= 1 ? `, ~${Math.round(minutes)} min` : "") +
      `. Those steps used ~${fmtTokens(tokens)} new tokens` +
      (usd !== undefined ? ` (est. ${fmtUsd(usd)}).` : "."),
    evidence,
    impact: {
      estTokens: tokens,
      estCostUsd: usd,
      provenance: "estimated",
      method: "New tokens (input + cache writes + output) of every step from the first to the last failure; cost includes those steps' cache reads.",
    },
    suggestion: blind
      ? "Stop retrying the identical command; read the error and change something first."
      : "After two identical failures, step back: re-read the error, check assumptions, or ask for help instead of editing again.",
  };
}
