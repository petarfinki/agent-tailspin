// agent-tailspin CLI. The only place (with discover.ts) allowed to touch Node APIs.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { discover, readSession, resolveSession } from "../adapters/claude-code/discover.js";
import { parse } from "../adapters/claude-code/parse.js";
import { analyze } from "../analyze.js";
import type { Confidence, PricingTable, SessionRef } from "../core/types.js";
import { fmtTokens, fmtUsd } from "../detectors/util.js";
import { buildHtml } from "../report/build-html.js";
import { buildReportModel } from "../report/model.js";
import { bold, dim, red, yellow } from "./style.js";
import { fmtDuration, linkLine, summary } from "./summary.js";

declare const __VERSION__: string | undefined;
declare const __DEMO_GZ_B64__: string | undefined;
declare const __CLIENT_JS__: string | undefined;
const VERSION = typeof __VERSION__ !== "undefined" ? __VERSION__ : "0.0.0-dev";

const HELP = `agent-tailspin ${VERSION}: why did that Claude Code session go badly?

Usage:
  agent-tailspin                          analyze the latest session for the current directory
  agent-tailspin list [--since 7d] [--project <path>] [--limit N]
  agent-tailspin analyze <session-id|path> [options]
  agent-tailspin --demo                   bundled synthetic session

Options:
  --redact                 share-safe report: no prompts, code, commands, outputs, or paths
  --out <file>             HTML output path (default: a file in your temp directory)
  --no-open                don't open the report in a browser
  --json                   print findings and metrics as JSON, no HTML
  --pricing <file>         override the pricing table (JSON, same shape as the bundled one)
  --min-confidence <lvl>   low | medium | high (default: medium; low with --label)
  --label                  add TP/FP buttons to findings and an "Export labels" download for npm run eval
  --verbose                show parse warnings
  --version, --help

Fully local: reads ~/.claude/projects, makes no network requests, writes only the report file.`;

class UsageError extends Error {}

const options = {
  redact: { type: "boolean" },
  out: { type: "string" },
  "no-open": { type: "boolean" },
  json: { type: "boolean" },
  pricing: { type: "string" },
  "min-confidence": { type: "string" },
  verbose: { type: "boolean" },
  label: { type: "boolean" },
  since: { type: "string" },
  project: { type: "string" },
  limit: { type: "string" },
  demo: { type: "boolean" },
  version: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof options; allowPositionals: true }>>["values"];

function loadPricing(file?: string): PricingTable | undefined {
  if (!file) return undefined;
  const p = JSON.parse(fs.readFileSync(file, "utf8")) as PricingTable;
  if (!p || typeof p.models !== "object") throw new UsageError(`${file} is not a pricing table (needs a "models" object).`);
  return { pricingAsOf: p.pricingAsOf ?? "custom", source: p.source ?? file, models: p.models };
}

function minConfidence(v?: string): Confidence {
  if (v === undefined) return "medium";
  if (v === "low" || v === "medium" || v === "high") return v;
  throw new UsageError(`--min-confidence must be low, medium, or high (got "${v}").`);
}

function openInBrowser(file: string): void {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [file]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", file]] : ["xdg-open", [file]];
  try {
    spawn(cmd, args as string[], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
  } catch {
    // no browser available; the path is printed anyway
  }
}

function demoJsonl(): string {
  if (typeof __DEMO_GZ_B64__ !== "undefined") return gunzipSync(Buffer.from(__DEMO_GZ_B64__, "base64")).toString("utf8");
  return fs.readFileSync(new URL("../../fixtures/demo/demo.jsonl", import.meta.url), "utf8");
}

/** The report renderer: inlined by the build; bundled on the fly when running from source (dev only). */
async function clientJs(): Promise<string> {
  if (typeof __CLIENT_JS__ !== "undefined") return __CLIENT_JS__;
  const { build } = await import("esbuild");
  const r = await build({ entryPoints: [new URL("../report/client.ts", import.meta.url).pathname], bundle: true, minify: true, format: "iife", write: false });
  return r.outputFiles[0]!.text;
}

async function report(text: { main: string; sidechains: string[] }, v: Values, synthetic: boolean): Promise<void> {
  const session = parse(text.main, { sidechains: text.sidechains });
  const a = analyze(session, { pricing: loadPricing(v.pricing), minConfidence: minConfidence(v["min-confidence"] ?? (v.label ? "low" : undefined)), redact: v.redact });
  const model = buildReportModel(a, { version: VERSION, synthetic, label: v.label });
  if (v.json) {
    process.stdout.write(JSON.stringify(model, null, 2) + "\n");
    return;
  }
  const out = path.resolve(v.out ?? path.join(os.tmpdir(), "agent-tailspin", `report-${model.session.id.slice(0, 8)}${v.redact ? "-redacted" : ""}.html`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buildHtml(model, await clientJs()));
  console.log(summary(model, v.verbose) + linkLine(out));
  if (!v["no-open"]) openInBrowser(out);
}

function parseSince(s?: string): number | undefined {
  if (!s) return undefined;
  const m = /^(\d+)([hdw])$/.exec(s);
  if (!m) throw new UsageError(`--since takes a duration like 12h, 7d, or 2w (got "${s}").`);
  return Number(m[1]) * { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2] as "h" | "d" | "w"];
}

function list(v: Values): number {
  const since = parseSince(v.since);
  const limit = v.limit ? Number(v.limit) : 20;
  if (!Number.isInteger(limit) || limit <= 0) throw new UsageError(`--limit must be a positive integer.`);
  const now = Date.now();
  const refs = discover({ project: v.project }).filter((r) => since === undefined || now - r.mtimeMs <= since);
  if (!refs.length) {
    console.error("No Claude Code sessions found" + (v.project ? ` for ${v.project}` : "") + (v.since ? ` in the last ${v.since}` : "") + ".");
    return 2;
  }
  const rows = refs.map((ref) => {
    const text = readSession(ref);
    const a = analyze(parse(text.main, { sidechains: text.sidechains }), { minConfidence: minConfidence(v["min-confidence"]) });
    const high = a.findings.filter((f) => f.severity === "high").length;
    return { ref, a, high, warn: a.findings.length - high };
  });
  rows.sort((x, y) => y.high - x.high || y.warn - x.warn || (y.a.session.totals.estCostUsd ?? 0) - (x.a.session.totals.estCostUsd ?? 0));
  const table = rows.slice(0, limit).map(({ ref, a, high, warn }) => {
    const s = a.session;
    const dur = Math.max(0, Date.parse(s.endedAt) - Date.parse(s.startedAt)) || 0;
    return [
      ref.id.slice(0, 8),
      (s.startedAt || new Date(ref.mtimeMs).toISOString()).slice(0, 16).replace("T", " "),
      fmtDuration(dur),
      (s.cwd ? path.basename(s.cwd) : path.basename(ref.projectDir)).slice(0, 24),
      String(s.steps.length),
      fmtTokens(s.totals.usage.inputTokens + s.totals.usage.outputTokens + s.totals.usage.cacheReadTokens + s.totals.usage.cacheWriteTokens),
      s.totals.estCostUsd !== undefined ? fmtUsd(s.totals.estCostUsd) : "?",
      high ? red(`${high} high`) + (warn ? ` ${warn} warn` : "") : warn ? yellow(`${warn} warn`) : dim("none"),
    ];
  });
  const head = ["SESSION", "STARTED", "DUR", "PROJECT", "STEPS", "TOKENS", "COST*", "FINDINGS"];
   
  const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
  const widths = head.map((h, i) => Math.max(h.length, ...table.map((r) => visible(r[i]!))));
  const fmt = (r: string[]) => r.map((c, i) => c + " ".repeat(widths[i]! - visible(c))).join("  ");
  console.log(bold(fmt(head)));
  for (const r of table) console.log(fmt(r));
  console.log(dim(`\n* API-equivalent estimate. Analyze one: agent-tailspin analyze <SESSION>`));
  return 0;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (e) {
    console.error(`${(e as Error).message}\n\nRun agent-tailspin --help for usage.`);
    return 2;
  }
  const { values: v, positionals } = parsed;
  try {
    if (v.help) return console.log(HELP), 0;
    if (v.version) return console.log(VERSION), 0;
    if (v.demo) return await report({ main: demoJsonl(), sidechains: [] }, v, true), 0;
    const [cmd, arg, ...extra] = positionals;
    if (cmd === "list") return list(v);
    let ref: SessionRef | undefined;
    if (cmd === "analyze") {
      if (!arg || extra.length) throw new UsageError("analyze takes exactly one session id (or prefix) or .jsonl path.");
      const r = resolveSession(arg);
      if ("error" in r) return console.error(r.error), 2;
      ref = r;
    } else if (cmd === undefined) {
      ref = discover({ project: process.cwd() })[0];
      if (!ref) {
        console.error(`No Claude Code sessions found for ${process.cwd()}.\nTry: agent-tailspin list, or agent-tailspin --demo`);
        return 2;
      }
    } else throw new UsageError(`Unknown command "${cmd}".`);
    await report(readSession(ref), v, false);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(e.message);
      return 2;
    }
    console.error(red("agent-tailspin hit an unexpected error:"), (e as Error).stack ?? e);
    return 1;
  }
}

process.exitCode = await main();
