import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/index.mjs';
import { buildCoveragePrompt, parseCoverage } from '../src/coverage.mjs';

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
      id: 'sess-clear',
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

const ENTRIES = { entries: [{ op: 'delete', target: 'C:/repo/*.zip', quote: '所有 zip' }], residual: false };

test('用户明说范围 + 判断方带引文解除 batch → 放行', async () => {
  const call = harness('把 repo 里的所有 zip 都删掉', JSON.stringify({
    ...ENTRIES,
    covered: [{ target: 'C:/repo/*.zip', entry: 0, why: '所有 zip' }],
    uncovered: [],
    clear: [{ lock: 'batch', quote: '所有 zip', why: '用户明说范围' }],
  }));
  const d = await call('pwsh', { command: "Remove-Item 'C:/repo/*.zip' -Force" });
  assert.equal(d.kind, 'allow');
});

test('判断方没解除锁 → 仍然问人', async () => {
  const call = harness('把 repo 里的所有 zip 都删掉', JSON.stringify({
    ...ENTRIES,
    covered: [{ target: 'C:/repo/*.zip', entry: 0 }],
    uncovered: [],
    clear: [],
  }));
  const d = await call('pwsh', { command: "Remove-Item 'C:/repo/*.zip' -Force" });
  assert.equal(d.kind, 'ask');
});

test('解除锁但没给引文 → 不算解除', async () => {
  const call = harness('把 repo 里的所有 zip 都删掉', JSON.stringify({
    ...ENTRIES,
    covered: [{ target: 'C:/repo/*.zip', entry: 0 }],
    uncovered: [],
    clear: [{ lock: 'batch', quote: '' }],
  }));
  const d = await call('pwsh', { command: "Remove-Item 'C:/repo/*.zip' -Force" });
  assert.equal(d.kind, 'ask');
});

test('目标未被覆盖 → 即使解了锁也不放行', async () => {
  const call = harness('把 repo 里的所有 zip 都删掉', JSON.stringify({
    ...ENTRIES,
    covered: [],
    uncovered: ['C:/repo/*.zip'],
    clear: [{ lock: 'batch', quote: '所有 zip' }],
  }));
  const d = await call('pwsh', { command: "Remove-Item 'C:/repo/*.zip' -Force" });
  assert.equal(d.kind, 'ask');
});

test('提示词里带上了锁与解除要求', () => {
  const p = buildCoveragePrompt({
    op: 'delete', targets: ['C:/repo/*.zip'], entries: ENTRIES.entries,
    instructions: '把 repo 里的所有 zip 都删掉', locks: ['batch'],
  });
  assert.match(p, /LOCKED ASPECTS/);
  assert.match(p, /batch/);
  assert.match(p, /cite the exact user quote/);
});

test('解析 clear：没有 lock 或没有 quote 的都保留，但由调用方过滤', () => {
  const r = parseCoverage(JSON.stringify({
    covered: [{ target: 't', entry: 0 }],
    clear: [{ lock: 'batch', quote: '所有' }, { lock: '', quote: 'x' }, { lock: 'egress' }],
  }), ['t']);
  assert.equal(r.clear.length, 2);
  assert.equal(r.clear[0].lock, 'batch');
  assert.equal(r.clear[1].quote, '');
});
