// Writes every synthetic fixture to fixtures/synthetic/<name>.jsonl. Run: npm run fixtures
import fs from "node:fs";
import { buildDemo } from "../fixtures/demo/build.js";
import { fixtures } from "../fixtures/synthetic/catalog.js";

for (const f of fixtures) fs.writeFileSync(new URL(`../fixtures/synthetic/${f.name}.jsonl`, import.meta.url), f.build().jsonl);
fs.writeFileSync(new URL("../fixtures/demo/demo.jsonl", import.meta.url), buildDemo().jsonl);
console.log(`wrote ${fixtures.length} fixtures + demo`);
