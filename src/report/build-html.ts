// ReportModel → one self-contained HTML file. Isomorphic. No network references of any kind.
import type { ReportModel } from "./model.js";
import { css } from "./style.js";

declare const __CLIENT_JS__: string | undefined;

/** JSON safe to embed in a <script> element: nothing in it can close the tag or break the parser. */
export function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function buildHtml(model: ReportModel, clientJs: string = typeof __CLIENT_JS__ !== "undefined" ? __CLIENT_JS__ : ""): string {
  const title = `Tailspin · ${model.session.id.slice(0, 8)}${model.synthetic ? " (demo)" : ""}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${css}</style>
</head>
<body>
<main id="app"><noscript>This report needs JavaScript to render (it runs locally; nothing is fetched).</noscript></main>
<script type="application/json" id="tailspin-data">${embedJson(model)}</script>
<script>${clientJs.replace(/<\/script/gi, "<\\/script")}</script>
</body>
</html>
`;
}
