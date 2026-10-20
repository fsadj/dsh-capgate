import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/index.mjs';

const ROOT = 'C:/repo';

function makeAgent(userText) {
  return {
    session: {
      id: 'sess-identical',
      header: { cwd: ROOT },
      surface: { nodes: [0] },
      requestHeader: () => ({ config: { provider: 'fake', model: 'fake' } }),
      snapshotEvents: () => ([
        { type: 'user/message', data: { source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: userText }] } },
      ]),
    },
  };
}

function setup(userText) {
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
    async call(args, humanOutcome = 'allowed-once') {
      const callId = `t${(n += 1)}`;
      const decision = await handlers.get('tools/pre-execute')(
        { name: 'pwsh', arguments: args, agent, callId },
        async () => ({ kind: 'allow' }),
      );
      if (decision.kind !== 'ask') return { decision, asked: false };
      const outcome = await handlers.get('approval/request')(
        { agent, toolName: 'pwsh', callId, reason: '需要人工确认' },
        async () => humanOutcome,
      );
      return { decision, asked: true, outcome };
    },
  };
}

test('同一条命令被批准过一次后，再来不再问', async () => {
  const h = setup('跑一下脚本');
  const args = { command: 'node scripts/build.mjs' };

  // 第一次：无引文（judge off）→ 问 → 人批准
  const first = await h.call(args);
  assert.equal(first.asked, true, '第一次需要问');

  // 第二次：完全相同的命令 → 直接放行
  const second = await h.call(args);
  assert.equal(second.asked, false, '相同命令不该再问');
  assert.equal(second.decision.kind, 'allow');
});

test('命令哪怕差一个字，也要重新问（不做模式推广）', async () => {
  const h = setup('跑一下脚本');
  await h.call({ command: 'node scripts/build.mjs' });

  const different = await h.call({ command: 'node scripts/build.mjs2' });
  assert.equal(different.asked, true, '不同命令必须重新确认');
});

test('人拒绝过的同一条命令，下次仍然要问', async () => {
  const h = setup('跑一下脚本');
  const args = { command: 'node scripts/build.mjs' };
  const first = await h.call(args, 'rejected');
  assert.equal(first.outcome, 'rejected');

  const again = await h.call(args);
  assert.equal(again.asked, true, '拒绝不应该被记成许可');
});
