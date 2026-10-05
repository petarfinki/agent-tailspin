// Finds Claude Code transcripts on disk. Node-only (the parser next to it is pure).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionRef } from "../../core/types.js";

/** Claude Code's project directory name for a cwd: every non-alphanumeric char becomes `-`. */
export const encodeCwd = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, "-");

export function projectRoots(env = process.env): string[] {
  const roots = [
    env.CLAUDE_CONFIG_DIR && path.join(env.CLAUDE_CONFIG_DIR, "projects"),
    path.join(os.homedir(), ".claude", "projects"),
    path.join(os.homedir(), ".config", "claude", "projects"),
  ].filter((r): r is string => !!r);
  return [...new Set(roots)].filter((r) => fs.existsSync(r));
}

function sessionsIn(projectDir: string): SessionRef[] {
  let names: string[];
  try {
    names = fs.readdirSync(projectDir);
  } catch {
    return [];
  }
  const out: SessionRef[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const p = path.join(projectDir, name);
    const id = name.slice(0, -".jsonl".length);
    const subDir = path.join(projectDir, id, "subagents");
    let sidechainPaths: string[] = [];
    try {
      sidechainPaths = fs.readdirSync(subDir).filter((f) => f.endsWith(".jsonl")).sort().map((f) => path.join(subDir, f));
    } catch {
      // no subagents
    }
    try {
      out.push({ id, path: p, projectDir, mtimeMs: fs.statSync(p).mtimeMs, sidechainPaths });
    } catch {
      // vanished between readdir and stat
    }
  }
  return out;
}

/** All sessions, newest first. `project` limits to one cwd. */
export function discover(opts: { project?: string; roots?: string[] } = {}): SessionRef[] {
  const roots = opts.roots ?? projectRoots();
  const dirs: string[] = [];
  for (const root of roots) {
    if (opts.project) dirs.push(path.join(root, encodeCwd(path.resolve(opts.project))));
    else
      for (const d of fs.readdirSync(root, { withFileTypes: true })) if (d.isDirectory()) dirs.push(path.join(root, d.name));
  }
  return dirs.flatMap(sessionsIn).sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : 1));
}

/** A session by file path or (unique) id prefix. */
export function resolveSession(arg: string, roots?: string[]): SessionRef | { error: string } {
  if (arg.endsWith(".jsonl") && fs.existsSync(arg)) {
    const p = path.resolve(arg);
    const id = path.basename(p, ".jsonl");
    const subDir = path.join(path.dirname(p), id, "subagents");
    const sidechainPaths = fs.existsSync(subDir) ? fs.readdirSync(subDir).filter((f) => f.endsWith(".jsonl")).sort().map((f) => path.join(subDir, f)) : [];
    return { id, path: p, projectDir: path.dirname(p), mtimeMs: fs.statSync(p).mtimeMs, sidechainPaths };
  }
  const matches = discover({ roots }).filter((s) => s.id.startsWith(arg));
  if (matches.length === 1) return matches[0]!;
  return { error: matches.length ? `"${arg}" matches ${matches.length} sessions; use a longer prefix.` : `No session or .jsonl file matches "${arg}".` };
}

export function readSession(ref: SessionRef): { main: string; sidechains: string[] } {
  return {
    main: fs.readFileSync(ref.path, "utf8"),
    sidechains: ref.sidechainPaths.map((p) => fs.readFileSync(p, "utf8")),
  };
}
