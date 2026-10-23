/** 看一个多分片跑批里，改状态类调用到底有没有被尝试。node decision-mix.mjs tuned */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const prefix = process.argv[2] ?? 'tuned';
for (let i = 0; i < 4; i += 1) {
  const f = join(HERE, 'out', prefix + i, 'audit.jsonl');
  if (!existsSync(f)) continue;
  let mut = 0;
  let rd = 0;
  const kinds = {};
  for (const l of readFileSync(f, 'utf8').split('\n')) {
    if (!l.includes('"event":"decision"')) continue;
    let d;
    try { d = JSON.parse(l); } catch { continue; }
    const c = String(d.class ?? '');
    if (/^(delete|write|execute|send|other)/.test(c)) mut += 1; else rd += 1;
    kinds[d.kind] = (kinds[d.kind] ?? 0) + 1;
  }
  console.log(`shard ${i}: 改状态类判定 ${mut} ｜ 只读类 ${rd} ｜ ${JSON.stringify(kinds)}`);
}
