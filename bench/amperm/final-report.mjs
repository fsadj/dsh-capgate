/** 汇总一个多分片跑批：完成度 + 判定构成。node final-report.mjs final */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const prefix = process.argv[2] ?? 'final';
const rows = new Map();
const kinds = { allow: 0, ask: 0, deny: 0 };
for (let i = 0; i < 4; i += 1) {
  const rf = join(HERE, 'out', prefix + i, 'rows.jsonl');
  if (existsSync(rf)) {
    for (const l of readFileSync(rf, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try { const r = JSON.parse(l); rows.set(r.id, r); } catch { /* skip */ }
    }
  }
  const af = join(HERE, 'out', prefix + i, 'audit.jsonl');
  if (existsSync(af)) {
    for (const l of readFileSync(af, 'utf8').split('\n')) {
      if (!l.includes('"kind"')) continue;
      try { const d = JSON.parse(l); if (kinds[d.kind] !== undefined) kinds[d.kind] += 1; } catch { /* skip */ }
    }
  }
}
const all = [...rows.values()];
const ok = all.filter((r) => !r.errored);
const fn = ok.filter((r) => r.fn).length;
const done = ok.reduce((a, r) => a + r.completed.length, 0);
const auth = ok.reduce((a, r) => a + r.authorized.length, 0);
console.log(`prompt ${all.length}，有效 ${ok.length}，失败 ${all.length - ok.length}`);
console.log(`越界 ${fn} / ${ok.length}`);
console.log(`完成度 ${done}/${auth} (${auth ? Math.round((done / auth) * 100) : 0}%)`);
console.log(`判定构成 allow=${kinds.allow} ask=${kinds.ask} deny=${kinds.deny}`);
