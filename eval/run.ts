// Precision per detector from hand labels (PRODUCT.md §15).
//
//   npm run eval                         precision table from eval/labels/*.json and eval/labels/private/*.json
//   npm run eval -- --gate               same, exit 1 if any detector with labels is below 80%
//   npm run eval -- --template <id|path> print a label template for one session's findings (stdout only)
//   (or label in the report: agent-tailspin analyze <id> --label, then "Export labels")
//
// Label files: [{ "sessionHash": "...", "findingId": "repeated-reads:1a2b3c4d", "label": "TP" | "FP" | "unclear", "note"?: "..." }]
// Real-session labels belong in eval/labels/private/ (gitignored). Commit only aggregate numbers.
import fs from "node:fs";
import path from "node:path";
import { readSession, resolveSession } from "../src/adapters/claude-code/discover.js";
import { parse } from "../src/adapters/claude-code/parse.js";
import { analyze } from "../src/analyze.js";
import { hash } from "../src/core/text.js";
import { detectors } from "../src/detectors/index.js";
import { exportLabels, type Label } from "../src/report/labels.js";

export const PRECISION_GATE = 0.8;

export function precisionTable(labels: Label[]) {
  return detectors.map((d) => {
    const mine = labels.filter((l) => l.findingId.startsWith(`${d.id}:`));
    const tp = mine.filter((l) => l.label === "TP").length;
    const fp = mine.filter((l) => l.label === "FP").length;
    return { detector: d.id, labeled: mine.length, tp, fp, unclear: mine.length - tp - fp, precision: tp + fp ? tp / (tp + fp) : undefined };
  });
}

function loadLabels(dir: string): Label[] {
  const files = (d: string) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => path.join(d, f)) : []);
  return [...files(dir), ...files(path.join(dir, "private"))].flatMap((f) => JSON.parse(fs.readFileSync(f, "utf8")) as Label[]);
}

function main(argv: string[]): number {
  const t = argv.indexOf("--template");
  if (t >= 0) {
    const ref = resolveSession(argv[t + 1] ?? "");
    if ("error" in ref) return console.error(ref.error), 2;
    const text = readSession(ref);
    const a = analyze(parse(text.main, { sidechains: text.sidechains }), { minConfidence: "low" });
    console.log(JSON.stringify(exportLabels(hash(a.session.id), a.findings, {}), null, 2));
    return 0;
  }
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "labels");
  const labels = loadLabels(dir);
  // Synthetic labels are TP by construction; never mix them into real-world precision.
  const real = labels.filter((l) => !l.sessionHash.startsWith("synthetic:"));
  const synthetic = labels.filter((l) => l.sessionHash.startsWith("synthetic:"));
  const print = (title: string, set: Label[]) => {
    console.log(`${title}: ${set.length} labels across ${new Set(set.map((l) => l.sessionHash)).size} sessions`);
    console.log("detector          labeled  TP  FP  unclear  precision");
    for (const r of precisionTable(set))
      console.log(
        `${r.detector.padEnd(18)}${String(r.labeled).padStart(7)}${String(r.tp).padStart(4)}${String(r.fp).padStart(4)}${String(r.unclear).padStart(9)}  ${r.precision === undefined ? "n/a" : `${(r.precision * 100).toFixed(0)}%`}`,
      );
    console.log("");
  };
  print("Real sessions", real);
  print("Synthetic fixtures (sanity only, TP by construction)", synthetic);
  if (argv.includes("--gate")) {
    const failing = precisionTable(real).filter((r) => r.precision !== undefined && r.precision < PRECISION_GATE);
    if (failing.length) {
      console.error(`Release gate: ${failing.map((r) => r.detector).join(", ")} below ${PRECISION_GATE * 100}% precision on real sessions.`);
      return 1;
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) process.exitCode = main(process.argv.slice(2));
