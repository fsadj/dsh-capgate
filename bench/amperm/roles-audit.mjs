/** 看审计里的角色分布：node roles-audit.mjs out/rolecheck */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2] ?? 'out/rolecheck';
const f = join(HERE, dir, 'audit.jsonl');
if (!existsSync(f)) { console.log('no audit: ' + f); process.exit(0); }
const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean);
const withRole = lines.filter((l) => l.includes('"role"'));
console.log('审计条数', lines.length, '带 role 的', withRole.length);
const dist = {};
const codes = {};
for (const l of withRole) {
  let d;
  try { d = JSON.parse(l); } catch { continue; }
  dist[d.role] = (dist[d.role] ?? 0) + 1;
  codes[`${d.event}:${d.code}`] = (codes[`${d.event}:${d.code}`] ?? 0) + 1;
}
console.log('角色分布:', JSON.stringify(dist));
const top = Object.entries(codes).sort((a, b) => b[1] - a[1]).slice(0, 10);
for (const [k, v] of top) console.log(' ', k, v);
const unregistered = withRole.filter((l) => l.includes('"code":"unregistered"')).length;
console.log('未登记来源:', unregistered);
