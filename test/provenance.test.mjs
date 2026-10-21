import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../src/index.mjs';
import { collectProvenance, allCreated, allRead } from '../src/provenance.mjs';

function withWs(fn) {
  const base = mkdtempSync(join(tmpdir(), 'capgate-prov-'));
  const ws = join(base, 'ws');
  mkdirSync(ws);
  try { return fn(ws); } finally { rmSync(base, { recursive: true, force: true }); }
}

function agentWith(ws, events) {
  return {
    session: {
      id: 'sess-prov',
      header: { cwd: ws },
      surface: { nodes: events.map((_, i) => i) },
      requestHeader: () => ({ config: { provider: 'fake', model: 'fake' } }),
      snapshotEvents: () => events,
    },
  };
}

const userMsg = (text) => ({
  type: 'user/message',
  data: { source: { kind: 'user', rpcId: 'm0' }, content: [{ type: 'text', text }] },
});
const call = (id, name, args) => ({ type: 'tool/call', data: { callId: id, name, arguments: args } });
const ok = (id) => ({ type: 'tool/result', data: { callId: id, content: [{ type: 'text', text: 'ok' }] } });

function handler(agent) {
  const handlers = new Map();
  const ctx = {
    on(ev, fn) { handlers.set(ev, fn); return () => {}; },
    systemPrompt: { section() {} },
    get: () => undefined,
  };
  apply(ctx, { mode: 'capgate', workspaceRoot: agent.session.header.cwd, judgeMode: 'off' });
  return (tool, args) => handlers.get('tools/pre-execute')(
    { name: tool, arguments: args, agent, callId: 'c1' },
    async () => ({ kind: 'allow' }),
  );
}

test('collectProvenance 能认出"本任务创建"的文件', () => withWs((ws) => {
  const p = join(ws, 'tmp.txt').replace(/\\/g, '/');
  const agent = agentWith(ws, [userMsg('建个临时文件'), call('w1', 'write', { file_path: p }), ok('w1')]);
  const prov = collectProvenance(agent, { cwd: ws });
  assert.equal(prov.created.size, 1);
  assert.ok(allCreated(prov, [p], ws));
}));

test('失败的工具调用不算"产生过"', () => withWs((ws) => {
  const p = join(ws, 'x.txt').replace(/\\/g, '/');
  const agent = agentWith(ws, [
    userMsg('试试'),
    call('w1', 'write', { file_path: p }),
    { type: 'tool/result', data: { callId: 'w1', isError: true, content: [{ type: 'text', text: 'denied' }] } },
  ]);
  const prov = collectProvenance(agent, { cwd: ws });
  assert.equal(prov.created.size, 0);
  assert.equal(allCreated(prov, [p], ws), undefined);
}));

test('创建后删除：不再问人', () => withWs((ws) => {
  const p = join(ws, 'tmp.txt').replace(/\\/g, '/');
  writeFileSync(join(ws, 'tmp.txt'), 'x');
  const agent = agentWith(ws, [
    userMsg('建个临时文件然后删掉'),
    call('w1', 'write', { file_path: p }), ok('w1'),
  ]);
  return handler(agent)('pwsh', { command: `Remove-Item '${p}' -Force` }).then((d) => {
    assert.equal(d.kind, 'allow');
  });
}));

test('删除一个不是本任务创建的、也没被点名的文件 → 仍然拦', () => withWs((ws) => {
  const p = join(ws, 'other.txt').replace(/\\/g, '/');
  writeFileSync(join(ws, 'other.txt'), 'x');
  const agent = agentWith(ws, [userMsg('清理一下 workspace')]);
  return handler(agent)('pwsh', { command: `Remove-Item '${p}' -Force` }).then((d) => {
    assert.notEqual(d.kind, 'allow');
  });
}));

test('读过的文件再读 → 来源事实放行', () => withWs((ws) => {
  const p = join(ws, 'data.json').replace(/\\/g, '/');
  writeFileSync(join(ws, 'data.json'), '{}');
  const agent = agentWith(ws, [
    userMsg('看看项目里的配置'),
    call('r1', 'read', { file_path: p }), ok('r1'),
  ]);
  return handler(agent)('pwsh', { command: `Get-Content '${p}'` }).then((d) => {
    assert.equal(d.kind, 'allow');
  });
}));

test('provenanceMode=off 时回到旧行为', () => withWs((ws) => {
  const p = join(ws, 'tmp2.txt').replace(/\\/g, '/');
  writeFileSync(join(ws, 'tmp2.txt'), 'x');
  const agent = agentWith(ws, [
    userMsg('建个临时文件'),
    call('w1', 'write', { file_path: p }), ok('w1'),
  ]);
  const handlers = new Map();
  const ctx = {
    on(ev, fn) { handlers.set(ev, fn); return () => {}; },
    systemPrompt: { section() {} },
    get: () => undefined,
  };
  apply(ctx, { mode: 'capgate', workspaceRoot: ws, judgeMode: 'off', provenanceMode: 'off' });
  return handlers.get('tools/pre-execute')(
    { name: 'pwsh', arguments: { command: `Remove-Item '${p}' -Force` }, agent, callId: 'c1' },
    async () => ({ kind: 'allow' }),
  ).then((d) => { assert.notEqual(d.kind, 'allow'); });
}));
