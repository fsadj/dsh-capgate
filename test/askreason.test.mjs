import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAsk, askKindLabel, ASK_KINDS } from '../src/askreason.mjs';

test('三种问的原因都有标签', () => {
  assert.deepEqual(ASK_KINDS, ['impact', 'referent', 'anomaly']);
  for (const k of ASK_KINDS) {
    assert.ok(askKindLabel(k).zh);
    assert.ok(askKindLabel(k).en);
  }
});

test('批量/通配 → 影响面', () => {
  assert.equal(classifyAsk({ cardinality: 'many' }), 'impact');
  assert.equal(classifyAsk({ wildcard: true }), 'impact');
  assert.equal(classifyAsk({ locks: ['batch'] }), 'impact');
  assert.equal(classifyAsk({ locks: ['egress'] }), 'impact');
  assert.equal(classifyAsk({ locks: ['privilege'] }), 'impact');
  assert.equal(classifyAsk({ locks: ['opaque'] }), 'impact');
});

test('"没点名" → 目标确认', () => {
  assert.equal(classifyAsk({ cardinality: 'one', text: 'did not name this specific branch' }), 'referent');
  assert.equal(classifyAsk({ cardinality: 'one', text: '用户没点名这几个分支' }), 'referent');
});

test('"无关/不存在" → 目标异常', () => {
  assert.equal(classifyAsk({ cardinality: 'one', text: 'deletes an unrelated probe branch' }), 'anomaly');
  assert.equal(classifyAsk({ cardinality: 'one', text: 'refs/heads/nonexistent-probe-branch' }), 'anomaly');
});

test('影响面优先于文字：批量 + 无关 也先算影响面', () => {
  assert.equal(classifyAsk({ cardinality: 'many', text: 'unrelated target' }), 'impact');
});

test('说不清时兜底为目标确认（保守）', () => {
  assert.equal(classifyAsk({ cardinality: 'one', text: '' }), 'referent');
});
