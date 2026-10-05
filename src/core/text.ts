// String helpers shared by adapters, detectors, and redaction. Isomorphic.

/** FNV-1a 32-bit, hex. Stable across runtimes; used for ids and signatures, not security. */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** String-only path normalization: resolve against cwd, collapse `.`/`..`/duplicate slashes. */
export function normalizePath(p: string, cwd?: string): string {
  let s = p.trim().replace(/\\/g, "/");
  if (!s.startsWith("/") && !/^[a-zA-Z]:\//.test(s) && cwd) s = cwd.replace(/\\/g, "/") + "/" + s;
  const out: string[] = [];
  for (const part of s.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return (s.startsWith("/") ? "/" : "") + out.join("/");
}

export const basename = (p: string): string => p.replace(/\/+$/, "").split("/").pop() ?? p;

export const extname = (p: string): string => {
  const m = /\.[A-Za-z0-9]{1,8}$/.exec(basename(p));
  return m ? m[0] : "";
};

// eslint-disable-next-line no-control-regex
export const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
