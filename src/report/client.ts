// Report renderer. Vanilla TS, bundled and inlined at build time.
// All transcript-derived text goes through text nodes; innerHTML is never used.
import type { ReportModel } from "./model.js";
import type { Finding } from "../core/types.js";

type Child = Node | string | number | null | undefined | false;
const SVG = "http://www.w3.org/2000/svg";

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(typeof c === "number" ? String(c) : c);
  return el;
}

function s(tag: string, attrs: Record<string, string | number> = {}, text?: string): SVGElement {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== undefined) el.textContent = text;
  return el;
}

const tok = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n));
const usd = (n?: number): string => (n === undefined ? "n/a" : n >= 0.01 ? `$${n.toFixed(2)}` : "<$0.01");
const dur = (ms: number): string => {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

const data = JSON.parse(document.getElementById("tailspin-data")!.textContent!) as ReportModel;
const app = document.getElementById("app")!;
app.textContent = "";

// ---------- header ----------
const S = data.session;
const header = h(
  "header",
  {},
  h("h1", {}, "Session ", h("span", { class: "mono" }, S.id.slice(0, 8)), data.synthetic ? h("span", { class: "demo" }, "synthetic demo data") : null),
  h(
    "div",
    { class: "meta" },
    h("span", {}, S.startedAt ? new Date(S.startedAt).toLocaleString() : "unknown start"),
    h("span", {}, dur(S.durationMs)),
    h("span", {}, `${S.stepCount} steps · ${S.exchangeCount} prompts`),
    S.models.length ? h("span", {}, S.models.join(", ")) : null,
    S.clientVersion ? h("span", {}, `Claude Code ${S.clientVersion}`) : null,
    S.cwd ? h("span", { class: "mono" }, S.cwd) : null,
    S.gitBranch ? h("span", { class: "mono" }, S.gitBranch) : null,
    data.redacted ? h("span", {}, "redacted") : null,
  ),
  h(
    "p",
    { class: "prov" },
    "Token counts and context sizes are measured (from the API usage Claude Code records). Per-output sizes and all dollar figures are estimates; dollars are API-equivalent list prices, not what a subscription bills.",
  ),
);
app.append(header);

// ---------- summary cards ----------
const T = data.totals;
const sev = (x: string) => data.findings.filter((f) => f.severity === x).length;
const card = (k: string, v: string, sub?: string) => h("div", { class: "card" }, h("div", { class: "k" }, k), h("div", { class: "v" }, v), sub ? h("div", { class: "s" }, sub) : null);
app.append(
  h(
    "section",
    { class: "cards", "aria-label": "Summary" },
    card("Peak context", tok(T.peakContext), "measured"),
    card("Total tokens", tok(T.totalTokens), `measured · ${tok(T.usage.cacheReadTokens)} cache reads`),
    card("Est. cost", T.estCostUsd !== undefined ? usd(T.estCostUsd) : "n/a", T.estCostUsd !== undefined ? "API-equivalent, estimated" : T.costNote),
    card("Compactions", String(S.compactions.length)),
    card("Findings", String(data.findings.length), `${sev("high")} high · ${sev("warn")} warn`),
  ),
);
if (S.abandoned.stepCount || S.sidechains.stepCount)
  app.append(
    h("p", { class: "impact" }, `Totals include ${S.abandoned.stepCount} steps on abandoned (rewound) branches (${tok(S.abandoned.totalTokens)} tokens) and ${S.sidechains.stepCount} subagent steps in ${S.sidechains.count} subagent(s) (${tok(S.sidechains.totalTokens)} tokens). The timeline and detectors cover the active branch only.`),
  );

// ---------- timeline ----------
app.append(h("h2", {}, "Context timeline"));
const chartBox = h("div", { class: "chart" });
app.append(chartBox);
const tl = data.timeline;
const W = 1000;
const H = 240;
const PAD = { l: 44, r: 8, t: 18, b: 22 };
const maxCtx = Math.max(1, ...tl.map((p) => p.ctx));
const x = (i: number) => PAD.l + (tl.length <= 1 ? 0 : (i / (tl.length - 1)) * (W - PAD.l - PAD.r));
const y = (v: number) => PAD.t + (1 - v / maxCtx) * (H - PAD.t - PAD.b);
const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", role: "img", "aria-label": `Context size per step, peaking at ${tok(maxCtx)} tokens over ${tl.length} steps` });
for (let k = 0; k <= 4; k++) {
  const v = (maxCtx * k) / 4;
  svg.append(s("line", { class: "grid", x1: PAD.l, x2: W - PAD.r, y1: y(v), y2: y(v) }));
  svg.append(s("text", { class: "axis", x: PAD.l - 6, y: y(v) + 3, "text-anchor": "end" }, tok(v)));
}
const bands = s("g");
svg.append(bands);
if (tl.length) {
  let d = `M${x(0)},${y(0)}`;
  tl.forEach((p, i) => (d += ` L${x(i)},${y(p.ctx)}`));
  d += ` L${x(tl.length - 1)},${y(0)} Z`;
  svg.append(s("path", { class: "area", d }));
}
for (const c of S.compactions) svg.append(s("line", { class: "compact", x1: x(c.atStepIndex), x2: x(c.atStepIndex), y1: PAD.t, y2: H - PAD.b }));
const markers = new Map<number, Finding["severity"]>();
const rank = { info: 0, warn: 1, high: 2 };
for (const f of data.findings)
  for (const e of f.evidence) {
    const prev = markers.get(e.stepIndex);
    if (!prev || rank[f.severity] > rank[prev]) markers.set(e.stepIndex, f.severity);
  }
for (const [i, sv] of [...markers].sort((a, b) => a[0] - b[0])) svg.append(s("circle", { class: `mk-${sv}`, cx: x(i), cy: PAD.t - 8, r: 3.5 }));
const ticks = Math.min(10, tl.length);
for (let k = 0; k < ticks; k++) {
  const i = Math.round((k / Math.max(1, ticks - 1)) * (tl.length - 1));
  svg.append(s("text", { class: "axis", x: x(i), y: H - 6, "text-anchor": "middle" }, String(i)));
}
const cursor = s("line", { class: "cursor", y1: PAD.t, y2: H - PAD.b, visibility: "hidden" });
svg.append(cursor);
chartBox.append(svg);
const tip = h("div", { class: "tip", role: "status" });
chartBox.append(tip);
chartBox.append(
  h(
    "div",
    { class: "legend" },
    h("span", {}, h("i", { style: "background:var(--accent)" }), "context size (measured)"),
    h("span", {}, h("i", { style: "background:var(--warn)" }), "compaction"),
    h("span", {}, h("i", { style: "background:var(--high)" }), "finding evidence (high)"),
    h("span", {}, h("i", { style: "background:var(--band)" }), "selected finding"),
  ),
);
svg.addEventListener("mousemove", (ev) => {
  if (!tl.length) return;
  const r = svg.getBoundingClientRect();
  const vx = ((ev.clientX - r.left) / r.width) * W;
  const i = Math.max(0, Math.min(tl.length - 1, Math.round(((vx - PAD.l) / (W - PAD.l - PAD.r)) * (tl.length - 1))));
  const p = tl[i]!;
  cursor.setAttribute("x1", String(x(i)));
  cursor.setAttribute("x2", String(x(i)));
  cursor.setAttribute("visibility", "visible");
  const counts = new Map<string, number>();
  for (const t of p.tools) counts.set(t, (counts.get(t) ?? 0) + 1);
  tip.textContent = `step ${i} · context ${tok(p.ctx)} (${p.delta >= 0 ? "+" : ""}${tok(p.delta)}) · out ${tok(p.out)}` + (counts.size ? ` · ${[...counts].map(([t, n]) => (n > 1 ? `${t}×${n}` : t)).join(", ")}` : "");
  tip.style.display = "block";
  tip.style.left = `${((x(i) / W) * r.width + 12).toFixed(0)}px`;
  tip.style.top = `${((y(p.ctx) / H) * r.height + 12).toFixed(0)}px`;
});
svg.addEventListener("mouseleave", () => {
  tip.style.display = "none";
  cursor.setAttribute("visibility", "hidden");
});

function highlight(f: Finding | null): void {
  bands.textContent = "";
  document.querySelectorAll(".finding.active").forEach((e) => e.classList.remove("active"));
  if (!f) return;
  const step = tl.length > 1 ? (W - PAD.l - PAD.r) / (tl.length - 1) : 10;
  for (const e of f.evidence) bands.append(s("rect", { class: "band", x: x(e.stepIndex) - Math.max(2, step / 2), y: PAD.t, width: Math.max(4, step), height: H - PAD.t - PAD.b }));
  document.getElementById(`f-${f.id}`)?.classList.add("active");
  chartBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---------- findings ----------
app.append(h("h2", {}, `Findings (${data.findings.length})`));
if (!data.findings.length)
  app.append(h("div", { class: "empty" }, "No findings. Nothing in this session matched a detector at the selected confidence level. That's a good sign, not a bug."));
let active: string | null = null;
for (const f of data.findings) {
  const btn = h("button", { type: "button", "aria-pressed": "false", title: "Highlight evidence on the timeline" }, f.title);
  btn.addEventListener("click", () => {
    active = active === f.id ? null : f.id;
    document.querySelectorAll(".finding h3 button").forEach((b) => b.setAttribute("aria-pressed", "false"));
    if (active) btn.setAttribute("aria-pressed", "true");
    highlight(active ? f : null);
  });
  const impact = [
    f.impact.estTokens !== undefined ? `~${tok(f.impact.estTokens)} tokens` : null,
    f.impact.estCostUsd !== undefined ? `est. ${usd(f.impact.estCostUsd)}` : null,
    f.impact.provenance,
  ]
    .filter(Boolean)
    .join(" · ");
  app.append(
    h(
      "article",
      { class: `finding ${f.severity}`, id: `f-${f.id}` },
      h("h3", {}, btn, h("span", { class: `badge ${f.severity}` }, f.severity), h("span", { class: "badge" }, `${f.confidence} confidence`)),
      h("p", {}, f.summary),
      h("p", { class: "impact" }, impact, " — ", f.impact.method),
      f.suggestion ? h("p", { class: "sugg" }, "Try: ", f.suggestion) : null,
      h(
        "details",
        {},
        h("summary", {}, `Evidence (${f.evidence.length})`),
        h("ol", {}, ...f.evidence.map((e) => h("li", {}, h("span", { class: "mono" }, `step ${e.stepIndex}`), " · ", e.note))),
      ),
    ),
  );
}
if (data.hiddenFindings) app.append(h("p", { class: "impact" }, `${data.hiddenFindings} lower-confidence finding(s) hidden. Re-run with --min-confidence low to include them.`));

// ---------- top outputs ----------
app.append(h("h2", {}, "Top tool outputs by lifetime cost"));
if (!data.topOutputs.length) app.append(h("div", { class: "empty" }, "No tool outputs."));
else
  app.append(
    h(
      "div",
      { class: "wrap" },
      h(
        "table",
        {},
        h("thead", {}, h("tr", {}, ...["Step", "Tool", "What", "Est. size", "Later steps", "Lifetime tokens", "Est. cost", "Method"].map((t, i) => h("th", i === 0 || (i >= 3 && i <= 6) ? { class: "n" } : {}, t)))),
        h(
          "tbody",
          {},
          ...data.topOutputs.map((o) =>
            h(
              "tr",
              {},
              h("td", { class: "n" }, o.step),
              h("td", {}, o.tool),
              h("td", { class: "mono" }, o.label),
              h("td", { class: "n" }, tok(o.tokens)),
              h("td", { class: "n" }, o.laterSteps),
              h("td", { class: "n" }, tok(o.lifetimeTokens)),
              h("td", { class: "n" }, usd(o.lifetimeCostUsd)),
              h("td", {}, o.estMethod),
            ),
          ),
        ),
      ),
    ),
  );

// ---------- tool usage ----------
app.append(h("h2", {}, "Tool usage"));
if (!data.toolUsage.length) app.append(h("div", { class: "empty" }, "No tool calls."));
else
  app.append(
    h(
      "div",
      { class: "wrap" },
      h(
        "table",
        {},
        h("thead", {}, h("tr", {}, h("th", {}, "Tool"), h("th", { class: "n" }, "Calls"), h("th", { class: "n" }, "Errors"), h("th", { class: "n" }, "Est. result tokens"), h("th", {}, "Share of tool output"))),
        h(
          "tbody",
          {},
          ...data.toolUsage.map((u) =>
            h(
              "tr",
              {},
              h("td", {}, u.tool),
              h("td", { class: "n" }, u.calls),
              h("td", { class: "n" }, u.errors),
              h("td", { class: "n" }, tok(u.estTokens)),
              h("td", {}, h("div", { class: "bar", style: `width:${(u.share * 100).toFixed(1)}%`, title: `${(u.share * 100).toFixed(1)}%` })),
            ),
          ),
        ),
      ),
    ),
  );

// ---------- methodology ----------
const dl = h("dl");
const term = (t: string, d: string) => dl.append(h("dt", {}, t), h("dd", {}, d));
term("Repeated reads", "The same file range was read again with no edit, file-changing command, external edit, subagent run, or compaction in between. Impact is the size of the redundant copies.");
term("Output lifetime", "A tool output is re-sent with every later step until a compaction. Lifetime tokens = estimated size × later steps, priced at each step's measured cache-read ratio.");
term("Failure loops", "The same action failed with the same normalized error at least 3 times, with an edit or an identical retry between attempts and no progress in between.");
term("Estimates", "Per-output size is measured from the growth in context between steps (context-delta) where unambiguous; otherwise chars ÷ 2.6 (char-heuristic), or 1,600 tokens per image. The method is shown next to every number.");
term("Pricing", `List prices as of ${data.pricing.asOf}. ${data.pricing.source}`);
app.append(
  h(
    "footer",
    {},
    h("h2", {}, "Methodology"),
    dl,
    h(
      "p",
      {},
      `${data.generator.name} ${data.generator.version} · schema v${data.schemaVersion} · ${S.warnings.count} parse warning(s)` +
        (S.warnings.count ? ` (${Object.entries(S.warnings.byKind).map(([k, n]) => `${k} ×${n}`).join(", ")})` : "") +
        " · Generated locally. This file makes no network requests.",
    ),
  ),
);
