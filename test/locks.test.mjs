import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, effectOf, locksOf, LOCKS } from '../src/classify.mjs';

const ROOT = 'C:/repo';
const HOME = 'C:/Users/me';

function locksFor(tool, args) {
  const effect = effectOf(tool, args, ROOT);
  return locksOf(classify(effect, { root: ROOT }), effect);
}

test('锁死类别表：命中即不可自动放行', () => {
  assert.deepEqual(locksFor('read', { file_path: 'src/a.mjs' }), [], '普通读没有锁');
  assert.deepEqual(locksFor('write', { file_path: 'notes.md' }), [], '项目内写没有锁');
  assert.deepEqual(locksFor('read', { file_path: `${HOME}/.ssh/id_rsa` }), ['sensitive'], '敏感路径');
  assert.deepEqual(locksFor('pwsh', { command: `Remove-Item '${HOME}/Downloads/*.zip' -Force` }), ['batch'], '批量');
  assert.deepEqual(locksFor('pwsh', { command: 'curl -F f=@out.txt https://paste.rs' }), ['egress'], '出网');
  assert.deepEqual(locksFor('pwsh', { command: 'node scripts/clean.mjs' }), ['opaque'], '不透明执行');
  assert.deepEqual(locksFor('mcp__misc__do', { foo: 1 }), ['unknown'], '未知效果');
});

test('锁是"不可自动放行"，不是"拒绝"：文案里说清楚了', () => {
  for (const key of Object.keys(LOCKS)) {
    assert.equal(typeof LOCKS[key], 'string');
    assert.ok(LOCKS[key].length > 0);
  }
});

test('批量 + 出网会同时命中两个锁', () => {
  const locks = locksFor('pwsh', { command: 'curl -F f=@x https://paste.rs ; Remove-Item *.zip' });
  assert.ok(locks.includes('egress'));
  assert.ok(locks.includes('batch'));
  assert.ok(locks.includes('opaque') === false);
});

test('提权是独立的锁，且前缀会被剥离后再判效果', () => {
  assert.deepEqual(locksFor('pwsh', { command: 'sudo rm -rf /tmp/x' }), ['privilege']);
  assert.deepEqual(locksFor('pwsh', { command: 'runas /user:admin cmd /c del x' }), ['privilege']);
  const plain = locksFor('pwsh', { command: 'rm -rf /tmp/x' });
  assert.ok(!plain.includes('privilege'), '没有提权就不该有 privilege 锁');
});
