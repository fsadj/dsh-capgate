/** 快速看一个 outdir 的判定分布与拒绝理由。node peek.mjs out/oa-strict0 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const f = join(HERE, process.argv[2] ?? 'out/oa-strict0', 'audit.jsonl');
if (!existsSync(f)) { console.log('no audit at ' + f); process.exit(0); }
const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean);
const dec = lines.filter((l) => l.includes('"event":"decision"')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
console.log('decisions:', dec.length);
const byOp = {};
for (const d of dec) {
  const op = String(d.class ?? '?').split('|')[0];
  byOp[op] ??= { allow: 0, ask: 0, deny: 0 };
  byOp[op][d.kind] += 1;
}
console.log(JSON.stringify(byOp, null, 0));
for (const k of ['deny', 'ask']) {
  const xs = dec.filter((d) => d.kind === k).slice(0, 4);
  for (const d of xs) console.log(k.toUpperCase(), '|', d.class, '|', String(d.by).slice(0, 110));
}
