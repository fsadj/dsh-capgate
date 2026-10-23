/**
 * 粗略体检：每个模块被 import 的符号，在 index.mjs 里实际用了几次。
 * 用来找"导入了但从没被用到"的东西。 node usage.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const srcDir = join(HERE, '..', 'src');
const idx = readFileSync(join(srcDir, 'index.mjs'), 'utf8');
const files = readdirSync(srcDir).filter((f) => f.endsWith('.mjs'));

const rows = [];
for (const f of files) {
  if (f === 'index.mjs') continue;
  const base = f.replace(/\.mjs$/, '');
  const re = new RegExp("import \\{([^}]*)\\} from '\\./" + base + "\\.mjs'");
  const m = idx.match(re);
  if (!m) { rows.push({ mod: base, names: '(未被 index 导入)', used: '' }); continue; }
  const names = m[1].split(',').map((s) => s.trim()).filter(Boolean);
  const used = names.map((n) => {
    const clean = n.split(' as ').pop().trim();
    const count = (idx.match(new RegExp('\\b' + clean.replace(/[$]/g, '\\$') + '\\b', 'g')) ?? []).length - 1;
    return clean + ':' + count;
  });
  const dead = used.filter((u) => u.endsWith(':0')).map((u) => u.split(':')[0]);
  rows.push({ mod: base, names: names.length, used: used.join(' '), dead: dead.join(',') });
}
for (const r of rows) {
  console.log(String(r.mod).padEnd(14), String(r.names).padStart(2), '|', r.used, r.dead ? '  DEAD: ' + r.dead : '');
}
