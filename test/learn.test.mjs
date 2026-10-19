import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, observe, candidates, addRule, removeRule, hasRule, saveState, loadState } from '../src/learn.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('反复批准 → 产生 allow 候选', () => {
  const s = emptyState();
  for (let i = 0; i < 3; i += 1) observe(s, 'write|workspace|plain|one', 'approve');
  const c = candidates(s, { approveAt: 3, rejectAt: 2 });
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, 'allow');
});

test('拒绝两次 → 产生 deny 候选（且优先于 allow）', () => {
  const s = emptyState();
  observe(s, 'delete|outside:C:/x|plain|one', 'approve');
  observe(s, 'delete|outside:C:/x|plain|one', 'reject');
  observe(s, 'delete|outside:C:/x|plain|one', 'reject');
  const c = candidates(s, { approveAt: 3, rejectAt: 2 });
  assert.equal(c[0].kind, 'deny');
});

test('批过也拒过的类不产生 allow 候选', () => {
  const s = emptyState();
  for (let i = 0; i < 5; i += 1) observe(s, 'write|workspace|plain|one', 'approve');
  observe(s, 'write|workspace|plain|one', 'reject');
  assert.equal(candidates(s).length, 0, '有过拒绝的类不该被自动放行');
});

test('硬化/解除规则是幂等的', () => {
  const s = emptyState();
  assert.equal(addRule(s, 'write|workspace|plain|one', 'allow'), true);
  assert.equal(addRule(s, 'write|workspace|plain|one', 'allow'), false);
  assert.equal(hasRule(s, 'write|workspace|plain|one', 'allow'), true);
  assert.equal(removeRule(s, 'write|workspace|plain|one', 'allow'), true);
  assert.equal(hasRule(s, 'write|workspace|plain|one', 'allow'), false);
});

test('持久化往返', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capgate-learn-'));
  const path = join(dir, 'learn.json');
  try {
    const s = emptyState();
    observe(s, 'read|workspace|plain|one', 'approve');
    addRule(s, 'read|workspace|plain|one', 'allow', 'test');
    assert.equal(saveState(path, s), true);

    const back = loadState(path);
    assert.equal(hasRule(back, 'read|workspace|plain|one', 'allow'), true);
    assert.equal(back.stats['read|workspace|plain|one'].approve, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('文件不存在/损坏时退回空状态', () => {
  const s = loadState('C:/definitely/not/here.json');
  assert.deepEqual(s.rules, { allow: [], deny: [] });
});
