import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/index.mjs';
import { clearReviewCache } from '../src/reviewer.mjs';

/** 假 subagent：按给定结构化结果返回 */
function fakeSubagent(structured) {
  const calls = [];
  return {
    calls,
    get(name) {
      if (name !== 'subagents') return undefined;
      return {
        list: () => ['in-process'],
        start: async (provider, req) => {
          calls.push(req);
          return {
            id: 'run',
            result: Promise.resolve({ structured }),
            dispose: async () => {},
          };
        },
      };
    },
  };
}

function harness(userText, structured, cfg = {}) {
  const handlers = new Map();
  const ctx = {
    on(ev, fn) { handlers.set(ev, fn); return () => {}; },
    systemPrompt: { section() {} },
    get: (n) => {
      if (n === 'subagents' || n === 'subagent') return fakeSubagent(structured).get('subagents');
      return undefined;
    },
  };
  apply(ctx, { mode: 'capgate', workspaceRoot: 'C:/repo', judgeMode: 'off', readGate: 'off', ...cfg });
  const agent = {
    session: {
      id: `s-${Math.random()}`,
      header: { cwd: 'C:/repo' },
      surface: { nodes: [0] },
      requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
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

const BATCH_CMD = 'Remove-Item C:/repo/*.zip -Force';
const CLEAR_OK = {
  entries: [{ op: 'delete', target: 'C:/repo/*.zip', quote: '所有 zip' }],
  covered: ['C:/repo/*.zip'],
  uncovered: [],
  clear: [{ lock: 'batch', quote: '所有 zip' }],
  verdict: 'ask',
  action: '删除 zip',
  blast: { reversible: 'yes', estimate: 12 },
  consistency: 'match',
  dataClass: 'none',
};

function withLlm(entriesJson) {
  return {
    get(n) {
      if (n === 'llm') {
        return { stream: async function* () { yield { type: 'text-delta', text: entriesJson }; yield { type: 'finish' }; } };
      }
      return undefined;
    },
  };
}

/* 需要 LLM 提供意图条目；subagent 提供判断）——用一个组合 ctx */
function combo(userText, entriesJson, structured) {
  clearReviewCache();
  const handlers = new Map();
  const svc = fakeSubagent(structured);
  const ctx = {
    on(ev, fn) { handlers.set(ev, fn); return () => {}; },
    systemPrompt: { section() {} },
    get: (n) => {
      if (n === 'subagents' || n === 'subagent') return svc.get('subagents');
      if (n === 'llm') return { stream: async function* () { yield { type: 'text-delta', text: entriesJson }; yield { type: 'finish' }; } };
      return undefined;
    },
  };
  apply(ctx, { mode: 'capgate', workspaceRoot: 'C:/repo', judgeMode: 'off', readGate: 'off' });
  const agent = {
    session: {
      id: `s-${Math.random()}`,
      header: { cwd: 'C:/repo' },
      surface: { nodes: [0] },
      requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
      snapshotEvents: () => ([
        { type: 'user/message', data: { source: { kind: 'user', rpcId: 'm0' }, content: [{ type: 'text', text: userText }] } },
      ]),
    },
  };
  return handlers.get('tools/pre-execute')(
    { name: 'pwsh', arguments: { command: BATCH_CMD }, agent, callId: 'c1' },
    async () => ({ kind: 'allow' }),
  );
}

const ENTRIES = JSON.stringify({ entries: [{ op: 'delete', target: 'C:/repo/*.zip', quote: '所有 zip' }], residual: false });

test('影响面过大（超 blastLimit）→ 不自动放行', async () => {
  const d = await combo('把 repo 里所有 zip 都删掉', ENTRIES, { ...CLEAR_OK, blast: { reversible: 'yes', estimate: 5000 } });
  assert.equal(d.kind, 'ask');
});

test('不可逆 → 不自动放行', async () => {
  const d = await combo('把 repo 里所有 zip 都删掉', ENTRIES, { ...CLEAR_OK, blast: { reversible: 'no', estimate: 3 } });
  assert.equal(d.kind, 'ask');
});

test('数据里有凭据 → 不自动放行', async () => {
  const d = await combo('把 repo 里所有 zip 都删掉', ENTRIES, { ...CLEAR_OK, dataClass: 'credential' });
  assert.equal(d.kind, 'ask');
});

test('调用与承诺不一致 → 不自动放行', async () => {
  const d = await combo('把 repo 里所有 zip 都删掉', ENTRIES, { ...CLEAR_OK, consistency: 'mismatch' });
  assert.equal(d.kind, 'ask');
});

test('影响面小、可逆、无凭据、一致 → 放行', async () => {
  const d = await combo('把 repo 里所有 zip 都删掉', ENTRIES, CLEAR_OK);
  assert.equal(d.kind, 'allow');
});
