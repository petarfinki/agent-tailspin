import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "../src/adapters/claude-code/parse.js";
import { analyze } from "../src/analyze.js";
import { buildHtml, embedJson } from "../src/report/build-html.js";
import { buildReportModel } from "../src/report/model.js";
import { bash, read, session } from "../fixtures/builder/index.js";
import { buildDemo } from "../fixtures/demo/build.js";

let clientJs = "";
beforeAll(async () => {
  const r = await build({ entryPoints: ["src/report/client.ts"], bundle: true, minify: true, format: "iife", write: false });
  clientJs = r.outputFiles[0]!.text;
});

const html = (jsonl: string, redact = false) =>
  buildHtml(buildReportModel(analyze(parse(jsonl), { redact, minConfidence: "low" }), { version: "test" }), clientJs);

const XSS = `</script><img src=x onerror=alert(1)>`;

describe("html report", () => {
  it("contains no network references and locks them down with CSP", () => {
    const out = html(buildDemo().jsonl);
    // The SVG namespace is an identifier, not a fetch; any other URL fails the test.
    expect(out.replaceAll("http://www.w3.org/2000/svg", "")).not.toMatch(/https?:\/\//);
    expect(out).not.toMatch(/\bsrc=["']?(?!x)/); // no external script/img sources
    expect(out).toContain(`content="default-src 'none'`);
  });

  it("stays within size budgets", () => {
    const out = html(buildDemo().jsonl);
    expect(clientJs.length).toBeLessThan(40_000);
    expect(out.length).toBeLessThan(500_000);
  });

  it("embeds hostile transcript text inertly", () => {
    const jsonl = session({ cwd: `/w/${XSS}` })
      .user(`please ${XSS} \u2028 & thanks`)
      .read(`/w/${XSS}.ts`, { tokens: 2000 })
      .read(`/w/${XSS}.ts`, { tokens: 2000 })
      .read(`/w/${XSS}.ts`, { tokens: 2000 })
      .bash(`echo '${XSS}'`, { fail: XSS, tokens: 100 })
      .text()
      .build().jsonl;
    const out = html(jsonl);
    const data = out.slice(out.indexOf('id="tailspin-data">') + 'id="tailspin-data">'.length, out.indexOf("</script>", out.indexOf('id="tailspin-data">')));
    expect(data).toContain("\\u003c/script\\u003e"); // the payload is there, escaped
    expect(data).not.toMatch(/[<>\u2028\u2029]/);
    expect(out.match(/<\/script>/g)).toHaveLength(2); // only our own two script tags close
    expect(out).not.toContain("<img");
  });

  it("refuses to build a report without the renderer script", () => {
    const m = buildReportModel(analyze(parse(buildDemo().jsonl)), { version: "t" });
    expect(() => buildHtml(m, "")).toThrow(/client script missing/);
  });

  it("escapes every dangerous character in embedded JSON", () => {
    expect(embedJson({ a: "<>&\u2028\u2029" })).toBe('{"a":"\\u003c\\u003e\\u0026\\u2028\\u2029"}');
  });

  it("client never uses innerHTML or other HTML sinks", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/report/client.ts", "utf8");
    expect(src).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  });

  it("reports zero findings plainly", () => {
    const out = buildReportModel(analyze(parse(session().user("hi").read("/w/a.ts", { tokens: 100 }).text().build().jsonl)), { version: "t" });
    expect(out.findings).toEqual([]);
  });

  it("uses the same token for a path in findings and the top-outputs table when redacted", () => {
    const b = session().user("x");
    for (let i = 0; i < 3; i++) b.read("/w/src/secret-name.ts", { tokens: 6000 });
    for (let i = 0; i < 30; i++) b.step([read(`/w/m${i}.ts`, { tokens: 200 })]);
    b.step([bash("ls")]);
    const m = buildReportModel(analyze(parse(b.text().build().jsonl), { redact: true }), { version: "t" });
    expect(m.findings.find((f) => f.detector === "repeated-reads")!.title).toContain("file_01.ts");
    expect(m.topOutputs[0]!.label).toBe("file_01.ts");
  });
});
