// Report CSS, inlined into the HTML. System fonts, light/dark via prefers-color-scheme.
export const css = String.raw`
:root{--bg:#f7f7f5;--card:#fff;--fg:#1d1d1f;--muted:#6b6b70;--line:#e3e3e0;--accent:#3d5afe;--area:#3d5afe22;--high:#d93025;--warn:#c77800;--ok:#188038;--band:#3d5afe1f;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#121214;--card:#1c1c1f;--fg:#ececee;--muted:#9a9aa2;--line:#2c2c31;--accent:#8c9eff;--area:#8c9eff26;--high:#ff6b5e;--warn:#f0a43a;--ok:#5bd17f;--band:#8c9eff2b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1080px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:20px;margin:0 0 4px;letter-spacing:-.01em}
h2{font-size:15px;margin:32px 0 10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.meta{color:var(--muted);font-size:13px;display:flex;flex-wrap:wrap;gap:4px 14px}
.prov{margin-top:10px;font-size:12.5px;color:var(--muted)}
.demo{display:inline-block;background:var(--warn);color:#000;font-size:11px;font-weight:600;padding:2px 8px;border-radius:99px;margin-left:8px;vertical-align:middle}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.card .k{font-size:12px;color:var(--muted)}.card .v{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums;margin-top:2px}
.card .s{font-size:11.5px;color:var(--muted)}
.chart{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 12px 6px;position:relative}
.chart svg{display:block;width:100%;height:260px;overflow:visible}
.chart .axis{fill:var(--muted);font-size:10.5px;font-variant-numeric:tabular-nums}
.chart .grid{stroke:var(--line);stroke-width:1}
.chart .area{fill:var(--area);stroke:var(--accent);stroke-width:1.5}
.chart .compact{stroke:var(--warn);stroke-dasharray:4 3;stroke-width:1.5}
.chart .band{fill:var(--band)}
.chart .cursor{stroke:var(--muted);stroke-width:1}
.chart .mk-high{fill:var(--high)}.chart .mk-warn{fill:var(--warn)}.chart .mk-info{fill:var(--muted)}
.tip{position:absolute;pointer-events:none;background:var(--fg);color:var(--bg);font-size:12px;padding:6px 8px;border-radius:6px;white-space:nowrap;transform:translate(-50%,-110%);display:none;font-variant-numeric:tabular-nums}
.legend{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:12px;color:var(--muted);padding:6px 4px 2px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.finding{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:10px 0;padding:12px 14px}
.finding.active{outline:2px solid var(--accent);outline-offset:1px}
.finding h3{font-size:15px;margin:0;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.finding h3 button{all:unset;cursor:pointer;flex:1;min-width:200px}
.finding h3 button:focus-visible{outline:2px solid var(--accent);border-radius:4px}
.badge{font-size:11px;font-weight:600;padding:1px 7px;border-radius:99px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
.badge.high{color:var(--high);border-color:currentColor}.badge.warn{color:var(--warn);border-color:currentColor}
.finding p{margin:6px 0}.impact{font-size:13px;color:var(--muted)}
.sugg{font-size:13px;background:var(--bg);border-radius:6px;padding:6px 10px}
details{margin-top:6px}summary{cursor:pointer;font-size:13px;color:var(--muted)}
details ol{margin:6px 0;padding-left:22px;font-size:13px}details li{margin:2px 0}
.mono{font-family:var(--mono);font-size:12.5px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:13px}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;color:var(--muted);font-size:12px}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:0}
.wrap{overflow-x:auto}
.bar{height:6px;background:var(--accent);border-radius:3px;min-width:1px}
.empty{background:var(--card);border:1px dashed var(--line);border-radius:10px;padding:18px;color:var(--muted)}
.labelbar{display:flex;gap:12px;align-items:center;justify-content:space-between;margin:6px 0}
.labels{display:flex;gap:6px;margin-top:8px}
.lbtn{font:inherit;font-size:12.5px;cursor:pointer;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:3px 10px}
.lbtn[aria-pressed=true]{background:var(--accent);border-color:var(--accent);color:var(--bg)}
.lbtn:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
footer{margin-top:40px;font-size:12.5px;color:var(--muted)}footer dt{font-weight:600;color:var(--fg);margin-top:10px}footer dd{margin:2px 0 0}
`;
