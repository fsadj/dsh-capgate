import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/index.mjs';

const ROOT = 'C:/repo';
const HOME = 'C:/Users/me';

function makeAgent(text) {
  return {
    session: {
      id: 'sess-extent',
      header: { cwd: ROOT },
      surface: { nodes: [0] },
      requestHeader: () => ({ config: { provider: 'fake', model: 'fake' } }),
      snapshotEvents: () => ([
        { type: 'user/message', data: { source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text }] } },
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
  let n = 0;
  return {
    async call(command, outcome = 'allowed-once') {
      const callId = `e${(n += 1)}`;
      const decision = await handlers.get('tools/pre-execute')(
        { name: 'pwsh', arguments: { command }, agent, callId },
        async () => ({ kind: 'allow' }),
      );
      if (decision.kind !== 'ask') return { decision, asked: false };
      await handlers.get('approval/request')(
        { agent, toolName: 'pwsh', callId, reason: '需要人工确认' },
        async () => outcome,
      );
      return { decision, asked: true };
    },
  };
}

test('批准一批目标后，落在范围内的同类删除不再问', async () => {
  const h = harness(`把 ${HOME}/Downloads 下所有 zip 删掉`);

  const first = await h.call(`Remove-Item '${HOME}/Downloads/*.zip' -Force`);
  assert.equal(first.asked, true, '批量第一次必须问');

  const second = await h.call(`Remove-Item '${HOME}/Downloads/a.zip' -Force`);
  assert.equal(second.asked, false, '同一批里的目标不该再问');
  assert.equal(second.decision.kind, 'allow');

  const third = await h.call(`Remove-Item '${HOME}/Downloads/a.zip' -Force`);
  assert.equal(third.asked, false, '重复删除同一目标也不该再问');
});

test('范围之外的目标仍然要问', async () => {
  const h = harness(`把 ${HOME}/Downloads 下所有 zip 删掉`);
  await h.call(`Remove-Item '${HOME}/Downloads/*.zip' -Force`);

  const other = await h.call(`Remove-Item '${HOME}/Downloads/a.db' -Force`);
  assert.notEqual(other.decision.kind, 'allow', '*.zip 的批准不能覆盖 *.db');
});

test('人拒绝时不建立范围', async () => {
  const h = harness(`把 ${HOME}/Downloads 下所有 zip 删掉`);
  await h.call(`Remove-Item '${HOME}/Downloads/*.zip' -Force`, 'rejected');

  const next = await h.call(`Remove-Item '${HOME}/Downloads/a.zip' -Force`);
  assert.notEqual(next.decision.kind, 'allow', '拒绝不会产生任何范围');
});
