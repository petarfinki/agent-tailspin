import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const cli = (...args: string[]) =>
  spawnSync(process.execPath, ["--import", "tsx", "src/cli/index.ts", ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", CLAUDE_CONFIG_DIR: path.join(os.tmpdir(), "tailspin-empty-config"), HOME: path.join(os.tmpdir(), "tailspin-empty-home") },
  });

describe("cli", () => {
  it("--demo --json prints a versioned model", () => {
    const r = cli("--demo", "--json");
    expect(r.status).toBe(0);
    const m = JSON.parse(r.stdout);
    expect(m.schemaVersion).toBe(1);
    expect(m.synthetic).toBe(true);
    expect(m.findings.length).toBeGreaterThanOrEqual(3);
  });

  it("--demo writes the HTML report to --out and prints the summary", () => {
    const out = path.join(os.tmpdir(), `tailspin-test-${process.pid}.html`);
    const r = cli("--demo", "--no-open", "--out", out);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("synthetic demo data");
    expect(r.stdout).toContain(out);
    expect(fs.readFileSync(out, "utf8")).toContain("tailspin-data");
    fs.rmSync(out);
  });

  it("analyzes a .jsonl path", () => {
    const r = cli("analyze", "fixtures/synthetic/failure-loop-edit-test.jsonl", "--json");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).findings[0].detector).toBe("failure-loops");
  });

  it("exits 2 on bad usage and when no sessions exist", () => {
    expect(cli("--bogus").status).toBe(2);
    expect(cli("--min-confidence", "maybe", "--demo").status).toBe(2);
    expect(cli("analyze").status).toBe(2);
    expect(cli("list").status).toBe(2);
    expect(cli().status).toBe(2);
  });

  it("--help and --version exit 0", () => {
    expect(cli("--help").stdout).toContain("Usage:");
    expect(cli("--version").status).toBe(0);
  });
});
