import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCoveragePrompt, parseCoverage } from '../src/coverage.mjs';
import { apply } from '../src/index.mjs';

const entries = [{ op: 'write', target: 'users', quote: '用户表' }];

test('提示词把指代消解讲清楚，并禁止"往用户有利方向猜"', () => {
  const p = buildCoveragePrompt({
    op: 'write',
    targets: ['db:users'],
    entries,
    instructions: '把用户表里测试账号的邮箱改掉',
  });
  assert.match(p, /AUTHORIZED ENTRIES/);
  assert.match(p, /CALL: op=write targets=db:users/);
  assert.match(p, /用户表/);
  assert.match(p, /Never guess in the user/);
});

test('解析：全部覆盖才算覆盖', () => {
  const ok = parseCoverage(JSON.stringify({
    covered: [{ target: 'db:users', entry: 0, why: '用户表即 users' }], uncovered: [],
  }), ['db:users']);
  assert.equal(ok.allCovered, true);
  assert.equal(ok.covered[0].entry, 0);

  const partial = parseCoverage(JSON.stringify({
    covered: [{ target: 'db:users', entry: 0 }], uncovered: ['db:orders'],
  }), ['db:users', 'db:orders']);
  assert.equal(partial.allCovered, false);
  assert.deepEqual(partial.uncovered, ['db:orders']);
});

test('解析：模型偷加目标 / 条目越界 → 不算覆盖', () => {
  const extra = parseCoverage(JSON.stringify({ covered: [{ target: 'db:secret', entry: 0 }] }), ['db:users']);
  assert.equal(extra.allCovered, false);

  const badIdx = parseCoverage(JSON.stringify({ covered: [{ target: 'db:users', entry: -1 }] }), ['db:users']);
  assert.equal(badIdx.allCovered, false);
});

test('非 JSON → undefined', () => {
  assert.equal(parseCoverage('无法判断', ['x']), undefined);
});

/* ── 端到端：模型判断覆盖 → 放行；模型说不确定 → 问人 ── */

function fakeLlm(json) {
  return { stream: async function* () { yield { type: 'text-delta', text: json }; yield { type: 'finish' }; } };
}

function harness(userText, llmJson) {
  const handlers = new Map();
  const ctx = {
    on(ev, fn) { handlers.set(ev, fn); return () => {}; },
    systemPrompt: { section() {} },
    get: (n) => (n === 'llm' ? fakeLlm(llmJson) : undefined),
  };
  apply(ctx, { mode: 'capgate', workspaceRoot: 'C:/repo', judgeMode: 'off' });
  const agent = {
    session: {
      id: 'sess-cov',
      header: { cwd: 'C:/repo' },
      surface: { nodes: [0] },
      requestHeader: () => ({ config: { provider: 'fake', model: 'fake' } }),
      snapshotEvents: () => ([
        { type: 'user/message', data: { source: { kind: 'user', rpcId: 'm0' }, content: [{ type: 'text', text: userText }] } },
      ]),
    },
  };
  return (tool, args) => handlers.get('tools/pre-execute')(
    { name: tool, arguments: args, agent, callId: 'c1' },
    async () => ({ kind: 'allow' }),
  );
}

test('字面对不上、但模型判断是同一个东西 → 放行', async () => {
  // 第一次调用是意图抽取，第二次是覆盖判断；两者都给"覆盖"
  const call = harness('把用户表里测试账号的邮箱改掉', JSON.stringify({
    entries: [{ op: 'write', target: 'users', quote: '用户表' }],
    residual: false,
    covered: [{ target: 'db:users', entry: 0, why: '用户表=users' }],
    uncovered: [],
  }));
  const d = await call('sql', { query: "UPDATE users SET email='x' WHERE id=1" });
  assert.equal(d.kind, 'allow');
});

test('模型说未覆盖 → 仍然问人', async () => {
  const call = harness('把用户表里测试账号的邮箱改掉', JSON.stringify({
    entries: [{ op: 'write', target: 'users', quote: '用户表' }],
    residual: false,
    covered: [],
    uncovered: ['db:audit_log'],
  }));
  const d = await call('sql', { query: "UPDATE audit_log SET ok=1" });
  assert.notEqual(d.kind, 'allow');
});
