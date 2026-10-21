import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectScript } from '../src/scriptaudit.mjs';

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'capgate-s-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('只有 console.log 的脚本 → 判为只读', () => withTmp((dir) => {
  const f = join(dir, 'demo.mjs');
  writeFileSync(f, "console.log('hello')\n");
  const r = inspectScript(f);
  assert.equal(r.kind, 'ok');
  assert.ok(r.facts.some((x) => x.type === 'script.no_severe_api'));
}));

test('写文件的脚本 → 判为 risky', () => withTmp((dir) => {
  const f = join(dir, 'gen.mjs');
  writeFileSync(f, "import { writeFileSync } from 'node:fs'\nwriteFileSync('x', 'y')\n");
  const r = inspectScript(f);
  assert.equal(r.kind, 'risky');
  assert.ok(r.facts.some((x) => x.type === 'script.risky_apis'));
}));

test('起子进程的脚本 → risky', () => withTmp((dir) => {
  const f = join(dir, 'run.mjs');
  writeFileSync(f, "import { execSync } from 'node:child_process'\nexecSync('ls')\n");
  assert.equal(inspectScript(f).kind, 'risky');
}));

test('联网的脚本 → risky', () => withTmp((dir) => {
  const f = join(dir, 'net.mjs');
  writeFileSync(f, "await fetch('https://example.com')\n");
  assert.equal(inspectScript(f).kind, 'risky');
}));

test('eval / 动态 import → risky', () => withTmp((dir) => {
  const a = join(dir, 'a.mjs');
  writeFileSync(a, "eval('1+1')\n");
  assert.equal(inspectScript(a).kind, 'risky');
  const b = join(dir, 'b.mjs');
  writeFileSync(b, "const m = await import('./x.mjs')\n");
  assert.equal(inspectScript(b).kind, 'risky');
}));

test('文件不存在 / 非文件 / 过大 → 不判只读', () => withTmp((dir) => {
  assert.equal(inspectScript(join(dir, 'nope.mjs')).kind, 'unreadable');
  assert.equal(inspectScript(dir).kind, 'not-a-file');
  const big = join(dir, 'big.mjs');
  writeFileSync(big, 'x'.repeat(2048));
  assert.equal(inspectScript(big, { maxBytes: 1024 }).kind, 'risky');
}));

test('只读文件的脚本 → 不否决，只记录"会读文件"', () => withTmp((dir) => {
  const f = join(dir, 'check.mjs');
  writeFileSync(f, "import { readFileSync } from 'node:fs'\nconsole.log(readFileSync('data.json','utf8'))\n");
  const r = inspectScript(f);
  assert.equal(r.kind, 'ok');
  assert.ok(r.facts.some((x) => x.type === 'script.reads_files'));
  assert.ok(!r.facts.some((x) => x.type === 'script.risky_apis'));
}));

test('既读又写 → 仍然否决', () => withTmp((dir) => {
  const f = join(dir, 'mix.mjs');
  writeFileSync(f, "import { readFileSync, writeFileSync } from 'node:fs'\nwriteFileSync('o', readFileSync('i'))\n");
  assert.equal(inspectScript(f).kind, 'risky');
}));

test('非 JS/TS 脚本 → 不分析，保持不透明', () => withTmp((dir) => {
  const f = join(dir, 'build.sh');
  writeFileSync(f, 'rm -rf build\n');
  const r = inspectScript(f);
  assert.equal(r.kind, 'risky');
  assert.ok(r.facts.some((x) => x.type === 'script.unsupported_language'));
}));
