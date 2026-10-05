// One-screen terminal summary (PRODUCT.md §10.1).
import { fmtTokens, fmtUsd } from "../detectors/util.js";
import type { ReportModel } from "../report/model.js";
import { bold, cyan, dim, green, red, yellow } from "./style.js";

export const fmtDuration = (ms: number): string => {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

const shortModel = (m: string) => m.replace(/^claude-/, "");

export function summary(r: ReportModel, verbose = false): string {
  const s = r.session;
  const t = r.totals;
  const lines: string[] = [];
  const when = s.startedAt ? s.startedAt.slice(0, 16).replace("T", " ") : "unknown time";
  lines.push(
    `${bold("tailspin")} ${dim("·")} session ${s.id.slice(0, 8)} ${dim("·")} ${when} ${dim("·")} ${fmtDuration(s.durationMs)} ${dim("·")} ${s.stepCount} steps` +
      (s.models.length ? ` ${dim("·")} ${s.models.map(shortModel).join(", ")}` : "") +
      (r.synthetic ? ` ${yellow("(synthetic demo data)")}` : ""),
  );
  const cost = t.estCostUsd !== undefined ? `~${fmtUsd(t.estCostUsd)} API-equivalent ${dim("(estimated)")}` : dim(t.costNote ?? "cost unknown");
  lines.push(
    `  peak context ${fmtTokens(t.peakContext)} ${dim("·")} ${fmtTokens(t.totalTokens)} tokens ${dim("(measured)")} ${dim("·")} ${cost} ${dim("·")} ${s.compactions.length} compaction${s.compactions.length === 1 ? "" : "s"}`,
  );
  if (s.abandoned.stepCount || s.sidechains.stepCount)
    lines.push(dim(`  includes ${s.abandoned.stepCount} abandoned-branch steps and ${s.sidechains.stepCount} subagent steps in totals`));
  lines.push("");

  const f = r.findings;
  if (!f.length) {
    lines.push(green("  No findings.") + dim(" Nothing in this session matched a detector at the current confidence level."));
  } else {
    const high = f.filter((x) => x.severity === "high").length;
    lines.push(`  ${bold(String(f.length))} finding${f.length === 1 ? "" : "s"} ${dim(`(${high} high, ${f.length - high} warn)`)}`);
    for (const x of f.slice(0, 3)) {
      const badge = x.severity === "high" ? red("● HIGH") : yellow("● WARN");
      lines.push(`  ${badge}  ${x.title}`);
      const impact = [
        x.impact.estTokens !== undefined ? `~${fmtTokens(x.impact.estTokens)} tokens` : undefined,
        x.impact.estCostUsd !== undefined ? `est. ${fmtUsd(x.impact.estCostUsd)}` : undefined,
        `${x.confidence} confidence`,
        `steps ${[...new Set(x.evidence.map((e) => e.stepIndex))].join(", ")}`,
      ].filter(Boolean);
      lines.push(`          ${dim(impact.join(" · "))}`);
    }
    if (f.length > 3) lines.push(dim(`  … and ${f.length - 3} more in the report`));
  }
  if (r.hiddenFindings) lines.push(dim(`  ${r.hiddenFindings} lower-confidence finding(s) hidden (--min-confidence low to show)`));
  if (s.warnings.count) {
    lines.push(dim(`  ${s.warnings.count} parse warning(s)` + (verbose ? ": " + Object.entries(s.warnings.byKind).map(([k, n]) => `${k} ×${n}`).join(", ") : " (--verbose for details)")));
  }
  return lines.join("\n");
}

export const linkLine = (path: string): string => `\n  Report: ${cyan(path)}`;
