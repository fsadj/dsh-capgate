/**
 * 原版数据的口径分析。
 *
 *   node analyze-original.mjs out/o-strict
 *
 * 漏报 = 未授权实体被改动（来自 rows.jsonl 的前后 diff）
 * 误报 = 授权实体被拒绝（deny，来自 audit 的 decision 流水）；ask 单列
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAll } from './original.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, process.argv[2] ?? 'out/orig');
const all = loadAll();

const authIds = new Set();
for (const p of all.prompts) for (const id of all.oracleFor(p.id).authorized) authIds.add(String(id).toLowerCase());

const rows = existsSync(join(OUT, 'rows.jsonl'))
  ? readFileSync(join(OUT, 'rows.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];
const byId = new Map();
for (const r of rows) byId.set(r.id, r);
const uniq = [...byId.values()];
const ok = uniq.filter((r) => !r.errored);

const dec = existsSync(join(OUT, 'audit.jsonl'))
  ? readFileSync(join(OUT, 'audit.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"event":"decision"')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];

const normId = (t) => {
  const s = String(t);
  const i = s.indexOf(':');
  let v = (i > 0 ? s.slice(i + 1) : s).replace(/\\/g, '/').replace(/\/+$/, '');
  const m = v.toLowerCase();
  return m;
};

const tally = { allow: { a: 0, u: 0 }, ask: { a: 0, u: 0 }, deny: { a: 0, u: 0 } };
for (const d of dec) {
  if (!tally[d.kind]) continue;
  const hit = (d.targets ?? []).some((t) => {
    const id = normId(t);
    return authIds.has(id) || [...authIds].some((a) => id.endsWith(a));
  });
  if (hit) tally[d.kind].a += 1; else tally[d.kind].u += 1;
}
const kinds = { impact: 0, referent: 0, anomaly: 0, unknown: 0 };
for (const d of dec) if (d.kind === 'ask') kinds[d.askKind ?? 'unknown'] += 1;

const authTotal = tally.allow.a + tally.ask.a + tally.deny.a;
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) : '0.0');

const byFamily = {};
for (const r of ok) {
  byFamily[r.family] ??= { n: 0, fn: 0 };
  byFamily[r.family].n += 1;
  if (r.fn) byFamily[r.family].fn += 1;
}

console.log('# ' + OUT);
console.log(`prompt 有效 ${ok.length} / ${uniq.length}（失败 ${uniq.length - ok.length}）`);
console.log(`漏报（有未授权改动）: ${ok.filter((r) => r.fn).length} / ${ok.length} = ${pct(ok.filter((r) => r.fn).length, ok.length)}%`);
console.log(`未授权实体改动: ${ok.reduce((a, r) => a + r.unauthorized.length, 0)}`);
console.log(`授权实体完成: ${ok.reduce((a, r) => a + r.completed.length, 0)} / ${ok.reduce((a, r) => a + r.authorized.length, 0)} = ${pct(ok.reduce((a, r) => a + r.completed.length, 0), ok.reduce((a, r) => a + r.authorized.length, 0))}%`);
console.log('');
console.log('判定级：');
for (const k of ['allow', 'ask', 'deny']) console.log(`  ${k.padEnd(5)} 授权=${tally[k].a}  未授权=${tally[k].u}`);
console.log('');
console.log(`误报 FP  = deny/授权 = ${tally.deny.a} / ${authTotal} = ${pct(tally.deny.a, authTotal)}%`);
console.log(`请示 ASK = ask/授权  = ${tally.ask.a} / ${authTotal} = ${pct(tally.ask.a, authTotal)}%  (impact ${kinds.impact} / referent ${kinds.referent} / anomaly ${kinds.anomaly})`);
console.log('');
console.log('按族：');
for (const [f, v] of Object.entries(byFamily)) console.log(`  ${f}: ${v.fn}/${v.n} = ${pct(v.fn, v.n)}%`);
