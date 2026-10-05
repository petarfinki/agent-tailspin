import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "../src/adapters/claude-code/parse.js";
import { analyze } from "../src/analyze.js";
import { buildHtml } from "../src/report/build-html.js";
import { buildReportModel, type ReportModel } from "../src/report/model.js";
import { SENTINELS, getFixture } from "../fixtures/synthetic/catalog.js";

let clientJs = "";
beforeAll(async () => {
  clientJs = (await build({ entryPoints: ["src/report/client.ts"], bundle: true, format: "iife", write: false })).outputFiles[0]!.text;
});

const model = (redact: boolean): ReportModel =>
  buildReportModel(analyze(parse(getFixture("sentinel-secrets").build().jsonl), { redact, minConfidence: "low" }), { version: "t" });

/** Structural shape: keys and value types, not values. */
const shape = (v: unknown): unknown =>
  Array.isArray(v) ? (v.length ? [shape(v[0])] : []) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : typeof v;

describe("--redact", () => {
  it("sanity: the unredacted output does contain the sentinels", () => {
    const out = JSON.stringify(model(false));
    expect(SENTINELS.some((s) => out.includes(s))).toBe(true);
  });

  it("removes every sentinel from the JSON and the HTML output", () => {
    const m = model(true);
    const json = JSON.stringify(m, null, 2);
    const html = buildHtml(m, clientJs);
    for (const s of SENTINELS) {
      expect(json, s).not.toContain(s);
      expect(html, s).not.toContain(s);
    }
  });

  it("keeps the findings visible (structure, counts, tokens)", () => {
    const m = model(true);
    expect(m.findings.map((f) => f.detector).sort()).toEqual(["failure-loops", "repeated-reads"]);
    expect(m.findings.find((f) => f.detector === "repeated-reads")!.title).toMatch(/^file_\d\d\.ts was read 3 times/);
    expect(m.timeline.length).toBeGreaterThan(0);
    expect(m.session.cwd).toBeUndefined();
    expect(m.session.gitBranch).toBeUndefined();
  });

  it("redacted model shape is stable", () => {
    expect(shape(model(true))).toMatchSnapshot();
  });
});
