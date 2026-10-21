import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minimizeOptions, describeMinimize } from '../src/minimize.mjs';

test('读：只给更小范围的替代（前 N 行 / 元数据 / 脱敏）', () => {
  const opts = minimizeOptions({ op: 'read', targets: ['C:/Users/me/data.csv'] });
  const labels = opts.map((o) => o.label).join('|');
  assert.match(labels, /前 20 行/);
  assert.match(labels, /元数据/);
  assert.match(labels, /脱敏/);
  for (const o of opts) {
    assert.ok(o.targets.every((t) => 'C:/Users/me/data.csv'.startsWith(t) || t === 'C:/Users/me/data.csv'));
  }
});

test('删：不给"换个地方删"，只给"先看清单 / 移入回收"', () => {
  const opts = minimizeOptions({ op: 'delete', targets: ['C:/Users/me/Downloads'] });
  const labels = opts.map((o) => o.label).join('|');
  assert.match(labels, /清单/);
  assert.ok(!/再删|换个|绕过/.test(labels));
});

test('外发：只给脱敏摘要或截断', () => {
  const opts = minimizeOptions({ op: 'send', targets: ['paste.rs'] });
  const labels = opts.map((o) => o.label).join('|');
  assert.match(labels, /脱敏|前 20 行/);
});

test('执行：只给 dry-run', () => {
  const opts = minimizeOptions({ op: 'execute', targets: ['C:/repo'] });
  assert.equal(opts.length, 1);
  assert.match(opts[0].label, /dry-run/);
});

test('没有操作类型时不给替代（不能凭空造）', () => {
  assert.deepEqual(minimizeOptions({ op: 'other', targets: ['x'] }), []);
});

test('描述文本最多三条', () => {
  const opts = minimizeOptions({ op: 'read', targets: ['a', 'b', 'c'] });
  const text = describeMinimize(opts, 3);
  assert.equal((text.match(/·/g) ?? []).length, 3);
});
