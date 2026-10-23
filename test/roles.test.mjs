import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ROLE, REASONS, roleOf, explainReason, selfCheck, annotate } from '../src/roles.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

test('三种角色齐全，且每条原因都有中英说明', () => {
  assert.deepEqual(Object.values(ROLE).sort(), ['agent', 'cost', 'explain', 'hard']);
  for (const [key, meta] of Object.entries(REASONS)) {
    assert.ok(meta.zh, key + ' 缺中文说明');
    assert.ok(meta.en, key + ' 缺英文说明');
  }
});

test('硬约束不能被当作放行来源', () => {
  for (const r of ['absolute-danger', 'sensitive', 'unknown-effect']) {
    assert.equal(roleOf(r), ROLE.HARD);
  }
  const { violating } = selfCheck(Object.keys(REASONS));
  assert.deepEqual(violating, [], '不应有硬约束被登记成放行角色');
});

test('成本分流只包含"可证明不改状态"的来源', () => {
  for (const r of ['read-fast-path', 'identical', 'extent', 'script-read', 'provenance']) {
    assert.equal(roleOf(r), ROLE.COST, r);
  }
});

test('代码里出现的每个 by:"..." 都在表里登记过', () => {
  const src = readFileSync(join(HERE, '..', 'src', 'index.mjs'), 'utf8');
  const used = new Set();
  for (const m of src.matchAll(/by:\s*'([a-z][a-z-]*)'/g)) used.add(m[1]);
  const unknown = [...used].filter((r) => !REASONS[r]);
  assert.deepEqual(unknown, [], '未登记的原因码: ' + unknown.join(', '));
});

test('审计注解：已知来源带 role/code，未知来源标 unregistered', () => {
  const a = annotate({ event: 'allow', by: 'read-fast-path' });
  assert.equal(a.role, ROLE.COST);
  assert.equal(a.code, 'read-fast-path');

  // 事件本身有角色时，未知 by 会回落到事件角色
  const b = annotate({ event: 'allow', by: 'something-new' });
  assert.equal(b.role, ROLE.EXPLAIN);
  assert.equal(b.code, 'allow');
  // 既没有登记来源、事件也不认识 → unregistered
  const c = annotate({ event: 'weird-event' });
  assert.equal(c.code, 'unregistered');
});

test('解释文本可直接给人看', () => {
  assert.match(explainReason('absolute-danger', 'zh'), /绝对危险/);
  assert.match(explainReason('read-fast-path', 'en'), /provable read/);
});
