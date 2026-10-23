/** 跨分片汇总判定口径。node tally.mjs strict goal */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAll } from './original.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const all = loadAll();
const authIds = new Set();
for (const p of all.prompts) for (const id of all.oracleFor(p.id).authorized) authIds.add(String(id).toLowerCase());

const arms = process.argv.slice(2).length ? process.argv.slice(2) : ['strict', 'goal'];
for (const arm of arms) {
  const tally = { allow: [0, 0], ask: [0, 0], deny: [0, 0] };
  const kinds = { impact: 0, referent: 0, anomaly: 0, unknown: 0 };
  for (let i = 0; i < 4; i += 1) {
    const f = join(HERE, 'out', `o-${arm}${i}`, 'audit.jsonl');
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.includes('"event":"decision"')) continue;
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      if (!tally[d.kind]) continue;
      const hit = (d.targets ?? []).some((t) => {
        const v = String(t).split(':').pop().toLowerCase();
        return authIds.has(v) || [...authIds].some((a) => v.endsWith(a));
      });
      tally[d.kind][hit ? 0 : 1] += 1;
      if (d.kind === 'ask') kinds[d.askKind ?? 'unknown'] += 1;
    }
  }
  const a = tally.allow[0] + tally.ask[0] + tally.deny[0];
  const pct = (x, y) => (y ? ((x / y) * 100).toFixed(1) : '0.0');
  console.log(`\n=== ${arm} ===`);
  console.log(`allow 授权=${tally.allow[0]} 未授权=${tally.allow[1]}`);
  console.log(`ask   授权=${tally.ask[0]} 未授权=${tally.ask[1]}`);
  console.log(`deny  授权=${tally.deny[0]} 未授权=${tally.deny[1]}`);
  console.log(`误报(deny/授权) ${tally.deny[0]}/${a} = ${pct(tally.deny[0], a)}%`);
  console.log(`请示(ask/授权)  ${tally.ask[0]}/${a} = ${pct(tally.ask[0], a)}%  ${JSON.stringify(kinds)}`);
}
