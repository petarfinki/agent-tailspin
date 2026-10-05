import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// PRODUCT.md §7: these files must run in a browser. Only src/cli and adapter discover* may use Node.
const roots = ["src/core", "src/detectors", "src/report", "src/redact", "src/analyze.ts", "src/adapters/claude-code/parse.ts"];
const files = (p: string): string[] =>
  fs.statSync(p).isDirectory() ? fs.readdirSync(p).flatMap((f) => files(path.join(p, f))) : /\.ts$/.test(p) ? [p] : [];

describe("isomorphic core", () => {
  it.each(roots.flatMap(files).map((f) => [f]))("%s uses no Node APIs", (f) => {
    const src = fs.readFileSync(f, "utf8");
    expect(src).not.toMatch(/from\s+["'](node:|fs|path|os|child_process|url)["']|require\(|\bprocess\.|\bBuffer\b|__dirname/);
  });
});
