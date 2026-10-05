// Format recon: prints JSON key paths, value types, and a few enum-like values.
// Never prints free-text string values. Usage: node scripts/format-recon.mjs <file.jsonl>...
import fs from 'node:fs';

const ENUM_KEYS = new Set(['type', 'role', 'subtype', 'stop_reason', 'name', 'level', 'userType', 'service_tier', 'version']);
const SKIP = /\.(input|toolUseResult)\.(?!file_path|offset|limit|command|pattern|path|type|exitCode|interrupted|stdout|stderr|is_error|numLines|startLine|totalLines)[^.]+/;
const paths = new Map();
const enums = new Map();
let bad = 0, lines = 0;
const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function walk(v, p, ctx) {
  const t = typeOf(v);
  if (SKIP.test(p)) return;
  bump(paths, `${ctx} ${p}:${t}`);
  const last = p.split('.').pop().replace(/\[.*\]$/, '');
  if (t === 'string' && ENUM_KEYS.has(last) && v.length < 40 && /^[\w.:-]+$/.test(v)) bump(enums, `${ctx} ${p}=${v}`);
  if (t === 'object') for (const [k, x] of Object.entries(v)) { const kk = /[/.]|^(toolu_|[0-9a-f]{8}-)|^\w{20,}$/.test(k) ? "<id>" : k; walk(x, p ? `${p}.${kk}` : kk, ctx); }
  if (t === 'array') for (const x of v) walk(x, `${p}[${x && typeof x === 'object' && typeof x.type === 'string' ? x.type : ''}]`, ctx);
}

for (const f of process.argv.slice(2)) {
  for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    lines++;
    try { const o = JSON.parse(l); walk(o, '', `[${o.type}]`); } catch { bad++; }
  }
}
console.log(`files ${process.argv.length - 2} lines ${lines} unparseable ${bad}`);
for (const [k, n] of [...paths].sort()) console.log(n, k);
console.log('--- enum values');
for (const [k, n] of [...enums].sort()) console.log(n, k);

// ---- Behavioral checks: counts only, no content. ----
const C = {};
const inc = (k, n = 1) => (C[k] = (C[k] || 0) + n);
for (const f of process.argv.slice(2)) {
  const objs = [];
  for (const l of fs.readFileSync(f, 'utf8').split('\n')) { try { if (l.trim()) objs.push(JSON.parse(l)); } catch {} }
  const byMsg = new Map(), children = new Map(), uuids = new Set(), toolNames = new Map();
  for (const o of objs) {
    if (o.uuid) uuids.add(o.uuid);
    for (const k of Object.keys(o)) if (k.length >= 20) inc(`topkey.${o.type}.${k}`);
    if (o.isSidechain) inc(`sidechain.${o.type}`);
    if (o.isCompactSummary !== undefined) inc('isCompactSummary.present');
    if (o.type === 'system') inc(`system.subtype.${o.subtype}`);
    if (o.parentUuid) children.set(o.parentUuid, (children.get(o.parentUuid) || 0) + 1);
    if (o.logicalParentUuid !== undefined) inc('logicalParentUuid.present');
    if (o.type === 'assistant' && o.message?.id) {
      const a = byMsg.get(o.message.id) || [];
      a.push(o);
      byMsg.set(o.message.id, a);
      for (const b of o.message.content || []) if (b.type === 'tool_use') toolNames.set(b.id, b.name);
      inc(`assistant.blocksPerLine.${(o.message.content || []).length}`);
    }
    if (o.type === 'user' && Array.isArray(o.message?.content)) {
      for (const b of o.message.content) {
        if (b.type !== 'tool_result') continue;
        const name = toolNames.get(b.tool_use_id) || '?';
        inc(`tool_result.${name}.is_error=${b.is_error}`);
        const text = typeof b.content === 'string' ? b.content : (b.content || []).map((x) => x.text || '').join('');
        if (b.is_error) {
          inc(`err.${name}.startsExitCode=${/^Exit code \d+/.test(text)}`);
          inc(`err.${name}.hasErrorTag=${/<tool_use_error>/.test(text)}`);
        } else if (name === 'Bash') inc(`ok.Bash.startsExitCode=${/^Exit code \d+/.test(text)}`);
        if (name === 'Read' && !b.is_error) inc(`read.lineNumberPrefix=${/^\s*\d+\t/.test(text)}`);
        if (/<persisted-output>/.test(text)) inc(`persistedOutput.${name}`);
        if (o.toolUseResult && typeof o.toolUseResult === 'object' && name === 'Bash') inc(`bash.tur.keys=${Object.keys(o.toolUseResult).filter(k=>!/Diff|Async|background|outputFile|canRead/.test(k)).sort().join(',')}`);
      }
    }
  }
  for (const [, lines] of byMsg) {
    inc(`msg.linesPerId.${Math.min(lines.length, 5)}`);
    if (lines.length > 1) {
      const u0 = JSON.stringify(lines[0].message.usage);
      inc(`msg.split.usageIdentical=${lines.every((l) => JSON.stringify(l.message.usage) === u0)}`);
      const o0 = lines[0].message.usage.output_tokens;
      inc(`msg.split.lastHasMaxOutput=${lines.at(-1).message.usage.output_tokens >= Math.max(...lines.map((l) => l.message.usage.output_tokens))}`);
      inc(`msg.split.firstOutputLessThanLast=${o0 < lines.at(-1).message.usage.output_tokens}`);
      inc(`msg.split.chained=${lines.slice(1).every((l, i) => l.parentUuid === lines[i].uuid)}`);
      inc(`msg.split.sameRequestId=${lines.every((l) => l.requestId === lines[0].requestId)}`);
    }
  }
  for (const [, n] of children) if (n > 1) inc('tree.nodesWithMultipleChildren');
  let dangling = 0; for (const o of objs) if (o.parentUuid && !uuids.has(o.parentUuid)) dangling++;
  inc('tree.danglingParent', dangling);
  const lp = objs.filter((o) => o.type === 'last-prompt').at(-1);
  if (lp) inc(`lastPrompt.leafExists=${uuids.has(lp.leafUuid)}`);
}
console.log('--- checks');
for (const k of Object.keys(C).sort()) console.log(C[k], k);
