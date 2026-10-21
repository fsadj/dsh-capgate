import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/index.mjs';
import { parseCompiled } from '../src/intent.mjs';

const ROOT = 'C:/repo';
const HOME = 'C:/Users/me';

test('parseCompiled 只接受结构化结果', () => {
  assert.deepEqual(
    parseCompiled('```json\n{"ops":[{"op":"read","targets":["a.txt"]}],"residual":false}\n```'),
    { ops: [{ op: 'read', targets: ['a.txt'] }], residual: false },
  );
  assert.equal(parseCompiled('{"decision":"allow"}'), undefined, '判定式输出不是编译结果');
  assert.equal(parseCompiled('not json'), undefined);
  assert.equal(parseCompiled('{"ops":[]}'), undefined);
});

function makeAgent(text) {
  return {
    session: {
      id: 'sess-intent',
      header: { cwd: ROOT },
      surface: { nodes: [0] },
      requestHeader: () => ({ config: { provider: 'fake', model: 'fake' } }),
      snapshotEvents: () => ([
        { type: 'user/message', data: { source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text }] } },
      ]),
    },
  };
}

/** 假"编译器模型"：把给定 JSON 原样吐出来 */
function compilerLlm(json) {
  return {
    stream: async function* () {
      yield { type: 'text-delta', index: 0, text: json };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
}

function harness(userText, llm, cfg = {}) {
  const handlers = new Map();
  const ctx = {
    on(ev, fn) { handlers.set(ev, fn); return () => {}; },
    systemPrompt: { section() {} },
    get: (name) => (name === 'llm' ? llm : undefined),
    llm,
  };
  apply(ctx, { mode: 'capgate', workspaceRoot: ROOT, ...cfg });
  const agent = makeAgent(userText);
  return async (tool, args) => handlers.get('tools/pre-execute')(
    { name: tool, arguments: args, agent, callId: 'c1' },
    async () => ({ kind: 'allow' }),
  );
}

const UNKNOWN = { command: 'Run-LegacyCleanup -Force' }; // 词法完全认不出的调用

test('编译出变更 → 拒绝（比"问人"更严）', async () => {
  const call = harness('看看这个项目', compilerLlm(
    '{"ops":[{"op":"delete","targets":["C:/Users/me/Downloads/a.zip"]}],"residual":false}',
  ));
  const d = await call('pwsh', UNKNOWN);
  assert.equal(d.kind, 'deny');
  assert.match(d.reason, /delete|删除/);
});

test('编译出纯读且全在项目内 → 放行（省掉这次询问）', async () => {
  const call = harness('看看这个项目', compilerLlm(
    '{"ops":[{"op":"read","targets":["src/a.mjs"]}],"residual":false}',
  ), { judgeAutoAllow: true });
  const d = await call('pwsh', UNKNOWN);
  assert.equal(d.kind, 'allow');
});

test('编译结果含无法解析部分 → 问人（不猜）', async () => {
  const call = harness('看看这个项目', compilerLlm(
    '{"ops":[{"op":"read","targets":["src/a.mjs"]}],"residual":true}',
  ), { judgeAutoAllow: true });
  const d = await call('pwsh', UNKNOWN);
  assert.equal(d.kind, 'ask');
});

test('编译器不可用 → 仍然问人（fail-closed）', async () => {
  const call = harness('看看这个项目', undefined);
  const d = await call('pwsh', UNKNOWN);
  assert.equal(d.kind, 'ask');
});

test('编译出"项目内写"不会被自动放行（只省读类的询问）', async () => {
  const call = harness('看看这个项目', compilerLlm(
    '{"ops":[{"op":"write","targets":["src/a.mjs"]}],"residual":false}',
  ), { judgeAutoAllow: true });
  const d = await call('pwsh', UNKNOWN);
  assert.equal(d.kind, 'ask', '写类即使编译清楚也要问');
});
