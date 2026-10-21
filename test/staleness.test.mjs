import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../src/index.mjs';
import { hashText } from '../src/readlog.mjs';

function withWs(fn) {
  const base = mkdtempSync(join(tmpdir(), 'capgate-st-'));
  const ws = join(base, 'ws');
  mkdirSync(ws);
  try { return fn(ws); } finally { rmSync(base, { recursive: true, force: true }); }
}

function harness(ws, events) {
  const handlers = new Map();
  const ctx = {
    on(ev, fn) { handlers.set(ev, fn); return () => {}; },
    systemPrompt: { section() {} },
    get: () => undefined,
  };
  apply(ctx, { mode: 'capgate', workspaceRoot: ws, judgeMode: 'off' });
  const agent = {
    session: {
      id: 'sess-stale',
      header: { cwd: ws },
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

test('脚本在 agent 读完之后被改过 → 旧内容不采信，仍然问人', () => withWs((ws) => {
  const f = join(ws, 'demo.mjs');
  const path = f.replace(/\\/g, '/');
  const events = [
    { type: 'user/message', data: { source: { kind: 'user', rpcId: 'm0' }, content: [{ type: 'text', text: `跑一下 ${path}` }] } },
    { type: 'tool/call', data: { callId: 'r1', name: 'read', arguments: { file_path: path } } },
    { type: 'tool/result', data: { callId: 'r1', content: [{ type: 'text', text: "console.log('ok')" }] } },
  ];
  // 磁盘内容已经变成有副作用的
  writeFileSync(f, "import { writeFileSync } from 'node:fs'\nwriteFileSync('x','y')\n");
  return harness(ws, events)('pwsh', { command: `node ${path}` }).then((d) => {
    assert.equal(d.kind, 'ask', '内容变过就不能拿旧内容背书');
  });
}));

test('读完后没改 → 用会话里那份内容，允许', () => withWs((ws) => {
  const f = join(ws, 'demo2.mjs');
  const path = f.replace(/\\/g, '/');
  writeFileSync(f, "console.log('ok')\n");
  const events = [
    { type: 'user/message', data: { source: { kind: 'user', rpcId: 'm0' }, content: [{ type: 'text', text: `跑一下 ${path}` }] } },
    { type: 'tool/call', data: { callId: 'r1', name: 'read', arguments: { file_path: path } } },
    { type: 'tool/result', data: { callId: 'r1', content: [{ type: 'text', text: "console.log('ok')\n" }] } },
  ];
  return harness(ws, events)('pwsh', { command: `node ${path}` }).then((d) => {
    assert.equal(d.kind, 'allow');
  });
}));

test('hashText 一致性与差异', () => {
  assert.equal(hashText('a'), hashText('a'));
  assert.notEqual(hashText('a'), hashText('b'));
});
