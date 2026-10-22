import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskState, relationOf, renderTaskState } from '../src/taskstate.mjs';

function agentWith(events) {
  return {
    session: {
      id: 'sess-ts',
      header: { cwd: 'C:/repo' },
      surface: { nodes: events.map((_, i) => i) },
      snapshotEvents: () => events,
    },
  };
}

const user = (text, id = 'm0') => ({
  type: 'user/message',
  data: { source: { kind: 'user', rpcId: id }, content: [{ type: 'text', text }] },
});
const call = (id, name, args) => ({ type: 'tool/call', data: { callId: id, name, arguments: args } });
const result = (id, isError = false) => ({ type: 'tool/result', data: { callId: id, isError } });

test('任务状态包含：目标、指令、已批准、拒绝、进度、执行记录', () => {
  const agent = agentWith([
    user('把下载目录里的 zip 清掉'),
    call('c1', 'pwsh', { command: 'Remove-Item a.zip' }),
    result('c1'),
  ]);
  const decisions = [
    { event: 'allow', by: 'citation', op: 'delete', target: 'C:/Users/me/Downloads/a.zip' },
    { event: 'deny', by: 'human', op: 'delete', target: 'C:/Users/me/Downloads/photo.db' },
    { event: 'allow', by: 'class-grant', op: 'read', target: 'C:/repo/x' },
  ];
  const st = buildTaskState(agent, { decisions, cwd: 'C:/repo', call: { op: 'delete', targets: ['C:/Users/me/Downloads/b.zip'] } });
  assert.match(st.goal, /zip/);
  assert.equal(st.instructions.length, 1);
  assert.equal(st.refused.length, 1);
  assert.equal(st.refused[0].target, 'C:/Users/me/Downloads/photo.db');
  assert.equal(st.progress.delete, 1, '只有放行算进度，拒绝不算');
  assert.equal(st.progress.read, 1);
  assert.equal(st.executions.length, 1);
  assert.equal(st.executions[0].ok, true);

  const text = renderTaskState(st, relationOf(st, ['C:/Users/me/Downloads/a.zip']));
  assert.match(text, /TASK STATE/);
  assert.match(text, /already allowed/);
  assert.match(text, /refused in this task/);
  assert.match(text, /covered_by_past_approval=true/);
});

test('关系：目标在既往批准范围内 / 命中被拒的目标', () => {
  const decisions = [
    { event: 'allow', op: 'delete', target: 'C:/Users/me/Downloads' },
    { event: 'deny', op: 'delete', target: 'C:/Users/me/Downloads/photo.db' },
  ];
  const st = buildTaskState(agentWith([user('清理下载目录')]), { decisions, call: { op: 'delete', targets: ['C:/Users/me/Downloads/x.zip'] } });
  assert.equal(relationOf(st, ['C:/Users/me/Downloads/x.zip']).covered_by_past_approval, true);
  assert.equal(relationOf(st, ['C:/Users/me/Downloads/x.zip']).contradicts_refusal, false);

  const st2 = buildTaskState(agentWith([user('清理下载目录')]), {
    decisions,
    call: { op: 'delete', targets: ['C:/Users/me/Downloads/photo.db'] },
  });
  assert.equal(relationOf(st2, ['C:/Users/me/Downloads/photo.db']).contradicts_refusal, true);
});

test('指令顺序保留（最新在后），超长截断', () => {
  const agent = agentWith([
    user('第一步：清理下载目录', 'm0'),
    user('第二步：'.repeat(50), 'm1'),
  ]);
  const st = buildTaskState(agent, {});
  assert.equal(st.instructions.length, 2);
  assert.equal(st.instructions[0].id, 'm0');
  assert.equal(st.instructions[1].id, 'm1');
  assert.ok(st.instructions[1].text.length <= 160);
  assert.match(st.goal, /第二步/);
});

test('没有会话时只返回判定流水（不抛错）', () => {
  const st = buildTaskState(undefined, { decisions: [{ event: 'allow', op: 'read', target: 'x' }] });
  assert.equal(st.instructions.length, 0);
  assert.equal(st.decisions.length, 1);
  assert.match(renderTaskState(st), /TASK STATE/);
});
