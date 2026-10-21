import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findReadContent } from '../src/readlog.mjs';

function agentWithEvents(events) {
  return {
    session: {
      id: 'sess-readlog',
      header: { cwd: 'C:/repo' },
      surface: { nodes: events.map((_, i) => i) },
      snapshotEvents: () => events,
    },
  };
}

const call = (id, path) => ({
  type: 'tool/call',
  data: { callId: id, name: 'read', arguments: { file_path: path } },
});
const result = (id, text) => ({
  type: 'tool/result',
  data: { callId: id, content: [{ type: 'text', text }] },
});

test('能从会话里找回 agent 读过的脚本内容', () => {
  const agent = agentWithEvents([
    call('c1', 'C:/repo/scripts/demo.mjs'),
    result('c1', "console.log('hi')"),
  ]);
  const hit = findReadContent(agent, 'C:/repo/scripts/demo.mjs', { cwd: 'C:/repo' });
  assert.ok(hit);
  assert.equal(hit.content, "console.log('hi')");
  assert.equal(hit.callId, 'c1');
});

test('路径不一致时不返回（读 A 跑 B 不能当依据）', () => {
  const agent = agentWithEvents([
    call('c1', 'C:/repo/scripts/a.mjs'),
    result('c1', "console.log('a')"),
  ]);
  assert.equal(findReadContent(agent, 'C:/repo/scripts/b.mjs', { cwd: 'C:/repo' }), undefined);
});

test('同一次读的多次结果：取最后一次（模型可能重读过）', () => {
  const agent = agentWithEvents([
    call('c1', 'C:/repo/x.mjs'),
    result('c1', 'old content'),
    call('c2', 'C:/repo/x.mjs'),
    result('c2', 'new content'),
  ]);
  const hit = findReadContent(agent, 'C:/repo/x.mjs', { cwd: 'C:/repo' });
  assert.equal(hit.content, 'new content');
});

test('相路径写法（反斜杠）也能对上', () => {
  const agent = agentWithEvents([
    call('c1', 'C:\\repo\\x.mjs'),
    result('c1', "console.log(1)"),
  ]);
  assert.ok(findReadContent(agent, 'C:/repo/x.mjs', { cwd: 'C:/repo' }));
});

test('没有会话时返回 undefined（调用方退回自己读盘）', () => {
  assert.equal(findReadContent(undefined, 'x'), undefined);
  assert.equal(findReadContent({ session: { surface: { nodes: [] }, snapshotEvents: () => [] } }, 'x'), undefined);
});
