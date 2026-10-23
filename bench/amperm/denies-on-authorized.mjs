/**
 * 把"拒绝落在授权目标上"的每一条拉出来看。
 * 这些是纯损失：oracle 说该放，我们拒了。
 *
 *   node denies-on-authorized.mjs strict goal
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAll } from './original.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const all = loadAll();
const authIds = new Set();
for (const p of all.prompts) {
  for (const id of all.oracleFor(p.id).authorized) authIds.add(String(id).toLowerCase());
}
const matches = (t) => {
  const v = String(t).split(':').pop().toLowerCase();
  return authIds.has(v) || [...authIds].some((a) => v.endsWith(a));
};

for (const arm of process.argv.slice(2)) {
  console.log(`\n================ ${arm} ================`);
  let n = 0;
  for (let i = 0; i < 4; i += 1) {
    const f = join(HERE, 'out', `o-${arm}${i}`, 'audit.jsonl');
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.includes('"event":"decision"')) continue;
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      if (d.kind !== 'deny') continue;
      if (!(d.targets ?? []).some(matches)) continue;
      n += 1;
      console.log(`\n[${n}] ${d.class}`);
      console.log('    targets: ' + (d.targets ?? []).join(', '));
      console.log('    reason : ' + String(d.by ?? '').split('\n').slice(0, 3).join(' / ').slice(0, 320));
    }
  }
  console.log(`\n${arm}: 落在授权目标上的拒绝 = ${n}`);
}
