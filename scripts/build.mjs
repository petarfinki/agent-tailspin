// Bundles the report client (inlined into every report) and the CLI into dist/cli.js.
import { build } from "esbuild";
import fs from "node:fs";
import zlib from "node:zlib";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));

const client = await build({
  entryPoints: ["src/report/client.ts"],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2020",
  write: false,
});
const clientJs = client.outputFiles[0].text;

await build({
  entryPoints: ["src/cli/index.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
  define: {
    __CLIENT_JS__: JSON.stringify(clientJs),
    __VERSION__: JSON.stringify(pkg.version),
    // Gzipped: the synthetic demo is ~400 KB of repetitive text, ~10 KB compressed.
    __DEMO_GZ_B64__: JSON.stringify(zlib.gzipSync(fs.readFileSync("fixtures/demo/demo.jsonl")).toString("base64")),
  },
  legalComments: "none",
  // Only the from-source dev path imports esbuild (to bundle the client on the fly); never at runtime here.
  external: ["esbuild"],
});
fs.chmodSync("dist/cli.js", 0o755);
console.log(`dist/cli.js ${(fs.statSync("dist/cli.js").size / 1024).toFixed(0)} KB (client ${(clientJs.length / 1024).toFixed(1)} KB)`);
