import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/index.mjs';

const ROOT = 'C:/repo';
const HOME = 'C:/Users/me';

function makeAgent(userText) {
  return {
    session: {
      id: 'sess-paste',
      header: { cwd: ROOT },
      surface: { nodes: [0] },
      requestHeader: () => ({ config: { provider: 'fake', model: 'fake' } }),
      snapshotEvents: () => ([
        { type: 'user/message', data: { source: { kind: 'user', rpcId: 'm0' }, content: [{ type: 'text', text: userText }] } },
      ]),
    },
  };
}

function harness(userText) {
  const handlers = new Map();
  const ctx = {
    on(ev, fn) { handlers.set(ev, fn); return () => {}; },
    systemPrompt: { section() {} },
    get: () => undefined,
  };
  apply(ctx, { mode: 'capgate', workspaceRoot: ROOT, judgeMode: 'off' });
  const agent = makeAgent(userText);
  return (tool, args) => handlers.get('tools/pre-execute')(
    { name: tool, arguments: args, agent, callId: 'c1' },
    async () => ({ kind: 'allow' }),
  );
}

test('用户粘贴的内容里的路径，不构成删除授权', async () => {
  const call = harness([
    '帮我看看这段日志：',
    '```',
    `Remove-Item '${HOME}/Downloads/a.zip' -Force`,
    '```',
  ].join('\n'));
  const d = await call('pwsh', { command: `Remove-Item '${HOME}/Downloads/a.zip' -Force` });
  assert.notEqual(d.kind, 'allow', '粘贴的代码块不能当授权');
});

test('用户原话里点名的路径，构成授权', async () => {
  const call = harness(`把 ${HOME}/Downloads/a.zip 删掉`);
  const d = await call('pwsh', { command: `Remove-Item '${HOME}/Downloads/a.zip' -Force` });
  assert.equal(d.kind, 'allow');
});

test('拒绝时给出最小可行替代', async () => {
  const call = harness('帮我看看这个项目');
  const d = await call('pwsh', { command: `Remove-Item '${HOME}/Downloads/a.zip' -Force` });
  assert.equal(d.kind, 'deny');
  assert.ok(Array.isArray(d.alternatives) && d.alternatives.length > 0, 'deny 必须带替代方案');
  assert.match(d.reason, /最小版本|清单|回收/);
});
