/**
 * 把 dsh 自带的 schemastery 链进插件（插件运行期要用它定义 Config）。
 *
 *   node scripts/setup.mjs                  # 自动在全局 npm 目录里找 @deepseek-ai/dsh
 *   node scripts/setup.mjs --dsh <path>     # 指定 dsh 安装目录（含 package.json 的那层）
 *
 * 只创建一个符号链接，不改任何人的 node_modules 内容。
 */
import { existsSync, mkdirSync, symlinkSync, lstatSync, unlinkSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

function globalRoot() {
  // Windows 上 npm 是 .cmd，不能直接 execFile，必须经 cmd /c
  try {
    const out = process.platform === 'win32'
      ? execFileSync('cmd', ['/c', 'npm', 'root', '-g'], { encoding: 'utf8' })
      : execFileSync('npm', ['root', '-g'], { encoding: 'utf8' });
    return out.trim();
  } catch {
    const fallback = process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'node_modules') : '';
    return fallback && existsSync(fallback) ? fallback : '';
  }
}

function findDsh(explicit) {
  const candidates = [];
  if (explicit) candidates.push(resolve(explicit));
  if (process.env.DSH_ROOT) candidates.push(resolve(process.env.DSH_ROOT));
  const g = globalRoot();
  if (g) candidates.push(join(g, '@deepseek-ai', 'dsh'));
  for (const c of candidates) {
    if (existsSync(join(c, 'package.json'))) {
      try {
        const meta = JSON.parse(readFileSync(join(c, 'package.json'), 'utf8'));
        if (meta.name === '@deepseek-ai/dsh') return c;
      } catch { /* 继续找 */ }
    }
  }
  return '';
}

const argIdx = process.argv.indexOf('--dsh');
const dsh = findDsh(argIdx > 0 ? process.argv[argIdx + 1] : '');

if (!dsh) {
  console.error('找不到 @deepseek-ai/dsh。请用 --dsh <安装目录> 指定，或设置 DSH_ROOT。');
  process.exit(1);
}

const source = join(dsh, 'node_modules', '@deepseek-ai', 'schemastery');
if (!existsSync(source)) {
  console.error(`dsh 里没有 schemastery：${source}`);
  process.exit(1);
}

const targetDir = join(pkgRoot, 'node_modules', '@deepseek-ai');
const link = join(targetDir, 'schemastery');
mkdirSync(targetDir, { recursive: true });

try {
  if (lstatSync(link)) unlinkSync(link);
} catch { /* 不存在就新建 */ }

symlinkSync(source, link, process.platform === 'win32' ? 'junction' : 'dir');
console.log(`linked: ${link}`);
console.log(`     -> ${source}`);
console.log('完成。现在可以：dsh plugin --profile <name> add ' + pkgRoot);
