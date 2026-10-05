import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { fixtures } from "../fixtures/synthetic/catalog.js";

describe("committed fixtures", () => {
  it.each(fixtures.map((f) => [f.name, f]))("%s matches its builder (run `npm run fixtures`)", (name, f) => {
    const file = new URL(`../fixtures/synthetic/${name}.jsonl`, import.meta.url);
    expect(fs.readFileSync(file, "utf8")).toBe(f.build().jsonl);
  });
});
