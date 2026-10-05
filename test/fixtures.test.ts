import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDemo } from "../fixtures/demo/build.js";
import { fixtures } from "../fixtures/synthetic/catalog.js";

describe("committed fixtures", () => {
  it.each(fixtures.map((f) => [f.name, f]))("%s matches its builder (run `npm run fixtures`)", (name, f) => {
    const file = new URL(`../fixtures/synthetic/${name}.jsonl`, import.meta.url);
    expect(fs.readFileSync(file, "utf8")).toBe(f.build().jsonl);
  });

  it("demo.jsonl matches its builder", () => {
    expect(fs.readFileSync(new URL("../fixtures/demo/demo.jsonl", import.meta.url), "utf8")).toBe(buildDemo().jsonl);
  });
});

describe("synthetic eval labels", () => {
  it("cover exactly the findings the catalog produces (run `npm run fixtures`)", async () => {
    const { syntheticLabels } = await import("../scripts/label-synthetic.js");
    const committed = JSON.parse(fs.readFileSync(new URL("../eval/labels/synthetic.json", import.meta.url), "utf8"));
    expect(committed).toEqual(syntheticLabels());
  });
});
