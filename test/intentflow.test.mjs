import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/index.mjs';
import { intentCovers } from '../src/evidence.mjs';

const ROOT = 'C:/repo';
const HOME = 'C:/Users/me';

function fakeLlm(json) {
  return {
    stream: async function* () {
      yield { type: 'text-delta', index: 0, text: json };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
}

function makeAgent(userText) {
  return {
    session: {
      id: 'sess-intentflow',
      header: { cwd: ROOT },
      surface: { nodes: [0] },
      requestHeader: () => ({ config: { provider: 'fake', model: 'fake' } }),
      snapshotEvents: () => ([
        { type: 'user/message', data: { source: { kind: 'user', rpcId: 'm0' }, content: [{ type: 'text', text: userText }] } },
      ]),
    },
  };
}

function harness(userText, llmJson) {
  const handlers = new Map();
  const llm = llmJson ? fakeLlm(llmJson) : undefined;
  const ctx = {
    on(ev, fn) { handlers.set(ev, fn); return () => {}; },
    systemPrompt: { section() {} },
    get: (name) => (name === 'llm' ? llm : undefined),
    llm,
  };
  apply(ctx, { mode: 'capgate', workspaceRoot: ROOT, judgeMode: 'off' });
  const agent = makeAgent(userText);
  return (tool, args) => handlers.get('tools/pre-execute')(
    { name: tool, arguments: args, agent, callId: 'c1' },
    async () => ({ kind: 'allow' }),
  );
}

test('intentCovers：前缀/通配/多目标', () => {
  const entries = [{ op: 'delete', target: `${HOME}/Downloads/*.zip` }];
  assert.ok(intentCovers(entries, { op: 'delete', targets: [`${HOME}/Downloads/a.zip`] }));
  assert.ok(!intentCovers(entries, { op: 'delete', targets: [`${HOME}/Downloads/a.db`] }), '不同扩展名不覆盖');
  assert.ok(!intentCovers(entries, { op: 'read', targets: [`${HOME}/Downloads/a.zip`] }), 'op 不同不覆盖');
  assert.equal(intentCovers(entries, { op: 'delete', targets: [] }), undefined);
});

test('语义引文：原话没逐字出现路径，但抽取的条目覆盖 → 放行', async () => {
  const call = harness(
    '把下载目录里的 zip 清掉',
    JSON.stringify({ entries: [{ op: 'delete', target: `${HOME}/Downloads/*.zip`, quote: '下载目录里的 zip' }], residual: false }),
  );
  const d = await call('pwsh', { command: `Remove-Item '${HOME}/Downloads/a.zip' -Force` });
  assert.equal(d.kind, 'allow', '语义引文应能授权');
});

test('语义引文：quote 不在原文 → 条目被丢 → 仍然拒绝', async () => {
  const call = harness(
    '把下载目录里的 zip 清掉',
    JSON.stringify({ entries: [{ op: 'delete', target: `${HOME}/Downloads/*.zip`, quote: '整个磁盘都删掉' }], residual: false }),
  );
  const d = await call('pwsh', { command: `Remove-Item '${HOME}/Downloads/a.zip' -Force` });
  assert.equal(d.kind, 'deny', '无 span 的条目不能授权');
});

test('语义引文不能绕过批量锁', async () => {
  const call = harness(
    '把下载目录里的 zip 清掉',
    JSON.stringify({ entries: [{ op: 'delete', target: `${HOME}/Downloads`, quote: '下载目录里的 zip' }], residual: false }),
  );
  const d = await call('pwsh', { command: `Remove-Item '${HOME}/Downloads/*.zip' -Force` });
  assert.equal(d.kind, 'ask', '批量仍然必须问人');
});

test('residual=true 的抽取结果不授权', async () => {
  const call = harness(
    '把下载目录里的 zip 清掉',
    JSON.stringify({ entries: [{ op: 'delete', target: `${HOME}/Downloads/*.zip`, quote: '下载目录里的 zip' }], residual: true }),
  );
  const d = await call('pwsh', { command: `Remove-Item '${HOME}/Downloads/a.zip' -Force` });
  assert.equal(d.kind, 'deny');
});

/** 两条用户消息的会话（模拟"上一个任务 → 这个任务"） */
function harnessWithHistory(messages, cfg = {}) {
  const handlers = new Map();
  const ctx = {
    on(ev, fn) { handlers.set(ev, fn); return () => {}; },
    systemPrompt: { section() {} },
    get: () => undefined,
  };
  apply(ctx, { mode: 'capgate', workspaceRoot: ROOT, judgeMode: 'off', ...cfg });
  const events = messages.map((text, i) => ({
    type: 'user/message',
    data: { source: { kind: 'user', rpcId: `m${i}` }, content: [{ type: 'text', text }] },
  }));
  const agent = {
    session: {
      id: 'sess-history',
      header: { cwd: ROOT },
      surface: { nodes: events.map((_, i) => i) },
      requestHeader: () => ({ config: { provider: 'fake', model: 'fake' } }),
      snapshotEvents: () => events,
    },
  };
  return (tool, args) => handlers.get('tools/pre-execute')(
    { name: tool, arguments: args, agent, callId: 'c1' },
    async () => ({ kind: 'allow' }),
  );
}

test('上一个任务的授权不能漏到下一个任务（默认只看最后一条指令）', async () => {
  const call = harnessWithHistory([
    `把 ${HOME}/Downloads/a.zip 删掉`,   // 上一个任务
    '看看这个项目用了什么依赖',            // 当前任务，和下载目录无关
  ]);
  const d = await call('pwsh', { command: `Remove-Item '${HOME}/Downloads/a.zip' -Force` });
  assert.notEqual(d.kind, 'allow', '旧任务的授权必须失效');
});

test('显式配置 window=session 时才看整个会话', async () => {
  const call = harnessWithHistory([
    `把 ${HOME}/Downloads/a.zip 删掉`,
    '看看这个项目用了什么依赖',
  ], { evidenceWindow: 'session' });
  const d = await call('pwsh', { command: `Remove-Item '${HOME}/Downloads/a.zip' -Force` });
  assert.equal(d.kind, 'allow', 'window=session 时应保留原行为');
});
