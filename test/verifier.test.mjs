import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verify, summarizeFacts, DEFAULT_BUDGET } from '../src/verifier.mjs';

const ANY = { scope: { mode: 'any' } };

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'capgate-v-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('外发含密钥的文件 → verifier 建议拒绝', () => withTmp((dir) => {
  const f = join(dir, 'dump.txt');
  writeFileSync(f, 'AKIAABCDEFGHIJKLMNOP\nhello\n');
  const r = verify({ op: 'send', targets: [f] }, ANY);
  assert.equal(r.recommendation, 'deny');
  assert.match(r.reason, /敏感/);
}));

test('读含 PII 的文件 → 建议询问（不拒绝）', () => withTmp((dir) => {
  const f = join(dir, 'customers.csv');
  writeFileSync(f, 'a@b.com,13800138000\n');
  const r = verify({ op: 'read', targets: [f] }, ANY);
  assert.equal(r.recommendation, 'ask');
  assert.ok(r.facts.some((x) => x.type === 'content.pii'));
}));

test('干净文件 → 不给建议（交还策略）', () => withTmp((dir) => {
  const f = join(dir, 'notes.md');
  writeFileSync(f, '# hello\nnothing sensitive\n');
  const r = verify({ op: 'read', targets: [f] }, ANY);
  assert.equal(r.recommendation, undefined);
  assert.ok(r.facts.length > 0);
}));

test('目录 → 产出条目数事实（供批量判断）', () => withTmp((dir) => {
  const d = join(dir, 'folder');
  mkdirSync(d);
  writeFileSync(join(d, 'a.txt'), 'x');
  writeFileSync(join(d, 'b.txt'), 'x');
  const r = verify({ op: 'read', targets: [d] }, ANY);
  const entries = r.facts.find((f) => f.type === 'dir.entries');
  assert.equal(entries.value, 2);
}));

test('预算限制探针次数', () => withTmp((dir) => {
  const files = [];
  for (let i = 0; i < 5; i += 1) {
    const f = join(dir, `f${i}.txt`);
    writeFileSync(f, 'x');
    files.push(f);
  }
  const r = verify({ op: 'read', targets: files }, { ...ANY, budget: { ...DEFAULT_BUDGET, probes: 3 } });
  assert.ok(r.probes.length <= 3, `探针数 ${r.probes.length} 应 ≤ 3`);
}));

test('事实摘要可读', () => withTmp((dir) => {
  const f = join(dir, 'x.txt');
  writeFileSync(f, 'ok');
  const r = verify({ op: 'read', targets: [f] }, ANY);
  assert.match(summarizeFacts(r), /存在|大小|扫描/);
}));

test('工作区内目标：默认 scope=workspace 会探', () => withTmp((dir) => {
  const ws = join(dir, 'ws');
  mkdirSync(ws);
  const f = join(ws, 'a.txt');
  writeFileSync(f, 'a@b.com\n');
  const r = verify({ op: 'read', targets: [f] }, { scope: { mode: 'workspace', root: ws } });
  assert.ok(r.facts.some((x) => x.type === 'content.pii'), '工作区内应该扫得到');
}));

test('工作区外目标：scope=workspace 直接跳过', () => withTmp((dir) => {
  const ws = join(dir, 'ws');
  const outside = join(dir, 'outside');
  mkdirSync(ws);
  mkdirSync(outside);
  const f = join(outside, 'secret.txt');
  writeFileSync(f, 'a@b.com\n');
  const r = verify({ op: 'read', targets: [f] }, { scope: { mode: 'workspace', root: ws } });
  assert.ok(r.facts.some((x) => x.type === 'scope.skipped'), '工作区外必须跳过');
  assert.ok(!r.facts.some((x) => x.type === 'content.pii'), '跳过后不能产出内容事实');
}));

test('软链指向工作区外：解析后跳过（不跟随）', () => withTmp((dir) => {
  const ws = join(dir, 'ws');
  const outside = join(dir, 'outside');
  mkdirSync(ws);
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'AKIAABCDEFGHIJKLMNOP\n');
  let linked = true;
  try {
    symlinkSync(outside, join(ws, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch { linked = false; }
  if (!linked) return;

  const r = verify({ op: 'send', targets: [join(ws, 'escape', 'secret.txt')] }, { scope: { mode: 'workspace', root: ws } });
  assert.ok(r.facts.some((x) => x.type === 'scope.skipped'), '软链逃逸必须被跳过');
  assert.equal(r.recommendation, undefined, '跳过后不能给拒绝建议（也不该放行，交给策略）');
}));

test('没有 scope.root 时一律不探（fail-closed）', () => withTmp((dir) => {
  const f = join(dir, 'x.txt');
  writeFileSync(f, 'a@b.com');
  const r = verify({ op: 'read', targets: [f] });
  assert.ok(r.facts.some((x) => x.type === 'scope.skipped'));
}));
