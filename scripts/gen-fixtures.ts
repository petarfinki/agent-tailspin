// Writes every synthetic fixture to fixtures/synthetic/<name>.jsonl. Run: npm run fixtures
import fs from "node:fs";
import { fixtures } from "../fixtures/synthetic/catalog.js";

for (const f of fixtures) fs.writeFileSync(new URL(`../fixtures/synthetic/${f.name}.jsonl`, import.meta.url), f.build().jsonl);
console.log(`wrote ${fixtures.length} fixtures`);
