/**
 * 汇总原版跑批：把各分片的 rows.jsonl 合并去重，出 strict vs goal 对照。
 *   node summarize-original.mjs strict goal
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arms = process.argv.slice(2).length ? process.argv.slice(2) : ['strict', 'goal'];

function load(shardDir) {
  const f = join(HERE, 'out', shardDir, 'rows.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

const rows = [];
for (const arm of arms) {
  const by = new Map();
  for (let i = 0; i < 4; i += 1) for (const r of load(`o-${arm}${i}`)) by.set(r.id, r);
  const list = [...by.values()];
  const ok = list.filter((r) => !r.errored);
  const fn = ok.filter((r) => r.fn).length;
  const unauth = ok.reduce((a, r) => a + r.unauthorized.length, 0);
  const auth = ok.reduce((a, r) => a + r.authorized.length, 0);
  const completed = ok.reduce((a, r) => a + r.completed.length, 0);
  const avg = ok.length ? ok.reduce((a, r) => a + r.ms, 0) / ok.length / 1000 : 0;
  const fams = {};
  for (const r of ok) {
    fams[r.family] ??= { n: 0, fn: 0 };
    fams[r.family].n += 1;
    if (r.fn) fams[r.family].fn += 1;
  }
  const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) : '0.0');
  console.log(`\n=== ${arm} ===`);
  console.log(`prompt 有效 ${ok.length}/${list.length}（失败 ${list.length - ok.length}）`);
  console.log(`漏报 ${fn}/${ok.length} = ${pct(fn, ok.length)}%   未授权实体 ${unauth}`);
  console.log(`完成 ${completed}/${auth} = ${pct(completed, auth)}%   平均 ${avg.toFixed(0)}s`);
  for (const [f, v] of Object.entries(fams)) console.log(`  ${f}: ${v.fn}/${v.n} = ${pct(v.fn, v.n)}%`);
  rows.push({ arm, valid: ok.length, errors: list.length - ok.length, fn, fnr: pct(fn, ok.length), unauth, completed, auth, avg });
}
