// Writes eval/labels/synthetic.json: every finding the synthetic catalog produces, labeled TP
// (fixtures are built so that their findings are true). Run: npm run fixtures
import fs from "node:fs";
import { parse } from "../src/adapters/claude-code/parse.js";
import { analyze } from "../src/analyze.js";
import { fixtures } from "../fixtures/synthetic/catalog.js";
import { buildDemo } from "../fixtures/demo/build.js";

export function syntheticLabels() {
  const sets = [...fixtures.map((f) => ({ name: f.name, jsonl: f.build().jsonl })), { name: "demo", jsonl: buildDemo().jsonl }];
  return sets.flatMap(({ name, jsonl }) =>
    analyze(parse(jsonl)).findings.map((f) => ({ sessionHash: `synthetic:${name}`, findingId: f.id, label: "TP" as const })),
  );
}

if (process.argv[1]?.endsWith("label-synthetic.ts"))
  fs.writeFileSync(new URL("../eval/labels/synthetic.json", import.meta.url), JSON.stringify(syntheticLabels(), null, 2) + "\n");
