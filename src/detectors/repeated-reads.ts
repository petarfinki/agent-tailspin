// D1: the same file content entered the context more than once with no reason to re-read it.
// Definition and guards: docs/detectors.md#repeated-reads
import { basename, normalizePath } from "../core/text.js";
import { lookupPrice } from "../core/tokens.js";
import type { Detector, Evidence, Finding, Session, ToolCall } from "../core/types.js";
import { OPAQUE_WRITERS, WRITE_TOOLS, carryCost, commandOf, filePathOf, findingId, fmtTokens, fmtUsd, laterSteps } from "./util.js";

export const HIGH_REDUNDANT_READS = 4;
export const HIGH_REDUNDANT_TOKENS = 20_000;
export const MIN_REDUNDANT_READS = 2;
/** Results smaller than this are stubs/empties, not worth flagging. */
export const MIN_RESULT_CHARS = 200;

/** Bash commands that may change any file in the tree. */
const GLOBAL_MODIFIER =
  /\bgit\s+(checkout|restore|stash|reset|pull|merge|rebase|apply|cherry-pick|switch|am|revert)\b|\bprettier\b[^|;&]*(--write|-w\b)|\beslint\b[^|;&]*--fix|\bblack\b|\bgofmt\b[^|;&]*-w|\bruff\b[^|;&]*(format|--fix)|\bcargo\s+(fmt|fix)\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?(format|fmt|lint:fix|fix|codegen|generate)\b|\bpatch\b|\brsync\b|\btar\s+[^|;&]*x|\bunzip\b/;
/** Bash commands that may change the files they name. */
const TARGETED_MODIFIER = /\bsed\s+(-[a-zA-Z]*i|--in-place)|\bperl\s+-[a-zA-Z]*i|\b(mv|cp|rm|touch|tee|truncate|dd|install|ln|chmod|chown)\b/;
const REDIRECT_TARGETS = />{1,2}\s*([^\s&|;<>]+)/g;

interface LiveRead {
  step: number;
  call: ToolCall;
  start: number;
  end: number;
}

/** Actual line range from `cat -n` prefixes when present, else the requested range. */
function rangeOf(call: ToolCall): { start: number; end: number } {
  const off = typeof call.input.offset === "number" && call.input.offset > 0 ? call.input.offset : 1;
  const lim = typeof call.input.limit === "number" && call.input.limit > 0 ? call.input.limit : Infinity;
  const text = (call.result?.text ?? "").trimEnd();
  const first = /^\s*(\d+)\t/.exec(text);
  const tail = [...text.slice(-2000).matchAll(/(?:^|\n)\s*(\d+)\t/g)].pop();
  if (first && tail) return { start: Number(first[1]), end: Number(tail[1]) };
  return { start: off, end: lim === Infinity ? Infinity : off + lim - 1 };
}

function bashTouches(cmd: string, path: string, cwd?: string): boolean {
  if (GLOBAL_MODIFIER.test(cmd)) return true;
  const name = basename(path);
  if (TARGETED_MODIFIER.test(cmd) && cmd.includes(name)) return true;
  for (const m of cmd.matchAll(REDIRECT_TARGETS)) {
    const target = m[1]!;
    if (target === "/dev/null" || target.startsWith("&")) continue;
    if (normalizePath(target, cwd) === path || target.endsWith(name)) return true;
  }
  return false;
}

export const repeatedReads: Detector = {
  id: "repeated-reads",
  run(session, ctx) {
    const cwd = session.cwd;
    const live = new Map<string, LiveRead[]>();
    const redundant = new Map<string, { all: LiveRead[]; extra: LiveRead[] }>();
    const compactedAt = new Set(session.compactions.map((c) => c.atStepIndex));

    for (const step of session.steps) {
      if (compactedAt.has(step.index)) live.clear();
      for (const p of step.externalEdits) live.delete(p);
      // Writes first: parallel calls in one step are unordered, so assume the edit may land before the read.
      for (const call of step.toolCalls) {
        if (OPAQUE_WRITERS.has(call.name)) live.clear();
        else if (WRITE_TOOLS.has(call.name)) {
          const p = filePathOf(call, cwd);
          if (p) live.delete(p);
        } else if (call.name === "Bash") {
          const cmd = commandOf(call);
          for (const p of [...live.keys()]) if (bashTouches(cmd, p, cwd)) live.delete(p);
        }
      }
      for (const call of step.toolCalls) {
        if (call.name !== "Read" || !call.result || call.result.isError || call.result.isImage) continue;
        const p = filePathOf(call, cwd);
        if (!p) continue;
        const r: LiveRead = { step: step.index, call, ...rangeOf(call) };
        const prior = live.get(p) ?? [];
        const covering = prior.find((x) => x.start <= r.start && r.end <= x.end);
        if (covering && call.result.sizeChars >= MIN_RESULT_CHARS) {
          const g = redundant.get(p) ?? { all: [covering], extra: [] };
          if (!g.all.includes(covering)) g.all.push(covering);
          g.all.push(r);
          g.extra.push(r);
          redundant.set(p, g);
        }
        live.set(p, [...prior, r]);
      }
    }

    const findings: Finding[] = [];
    for (const [path, g] of [...redundant].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const n = g.extra.length;
      const tokens = g.extra.reduce((s, r) => s + r.call.result!.estTokens, 0);
      if (n < MIN_REDUNDANT_READS) continue;
      const severity = n >= HIGH_REDUNDANT_READS || tokens >= HIGH_REDUNDANT_TOKENS ? "high" : "warn";
      let lifetime = 0;
      let usd: number | undefined = 0;
      for (const r of g.extra) {
        const later = laterSteps(session, r.step);
        lifetime += r.call.result!.estTokens * later;
        const first = session.steps[r.step + 1];
        const p = lookupPrice(ctx.pricing, first?.model);
        const carry = carryCost(session, r.step + 1, r.step + 1 + later, r.call.result!.estTokens, ctx.pricing);
        usd = usd === undefined || !p || carry === undefined ? undefined : usd + (r.call.result!.estTokens * p.cacheWrite5m) / 1e6 + carry;
      }
      const all = [...g.all].sort((a, b) => a.step - b.step);
      const shown = ctx.displayPath(path);
      const methods = new Set(g.extra.map((r) => r.call.result!.estMethod));
      const evidence: Evidence[] = all.map((r) => ({
        stepIndex: r.step,
        toolCallId: r.call.id,
        note: `Read ${shown} (~${fmtTokens(r.call.result!.estTokens)} tokens)${g.extra.includes(r) ? " · redundant" : " · first read"}`,
      }));
      findings.push({
        id: findingId("repeated-reads", evidence),
        detector: "repeated-reads",
        severity,
        confidence: "high",
        title: `${shown} was read ${all.length} times without changes in between`,
        summary:
          `${n} redundant reads added ~${fmtTokens(tokens)} tokens to the context` +
          (lifetime ? `, then rode along for ~${fmtTokens(lifetime)} cache-read tokens` : "") +
          (usd !== undefined ? ` (est. ${fmtUsd(usd)}).` : "."),
        evidence,
        impact: {
          estTokens: tokens,
          estCostUsd: usd,
          provenance: "estimated",
          method: `Sum of estimated sizes of the redundant reads (${[...methods].sort().join(", ")}). Cost adds one cache write per copy plus cache reads until compaction or session end.`,
        },
        suggestion: "Keep the earlier read in mind, or read only the changed range (offset/limit) if you need to look again.",
      });
    }
    return findings;
  },
};
