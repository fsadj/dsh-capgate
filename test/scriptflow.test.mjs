import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../src/index.mjs';

/** 在临时工作区里跑：脚本可读化必须真的改变判定 */
function withWs(fn) {
  const base = mkdtempSync(join(tmpdir(), 'capgate-sr-'));
  const ws = join(base, 'ws');
  mkdirSync(ws);
  try { return fn(ws, base); } finally { rmSync(base, { recursive: true, force: true }); }
}

function harness(ws, userText, cfg = {}) {
  const handlers = new Map();
  const ctx = {
    on(ev, fn) { handlers.set(ev, fn); return () => {}; },
    systemPrompt: { section() {} },
    get: () => undefined,
  };
  apply(ctx, { mode: 'capgate', workspaceRoot: ws, judgeMode: 'off', ...cfg });
  const agent = {
    session: {
      id: 'sess-script',
      header: { cwd: ws },
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

test('只读脚本 + 用户点名 → 放行（不再当作不透明执行问人）', () => withWs((ws) => {
  const f = join(ws, 'demo.mjs');
  writeFileSync(f, "console.log('hello')\n");
  const call = harness(ws, `跑一下 ${f.replace(/\\/g, '/')}`);
  return call('pwsh', { command: `node ${f.replace(/\\/g, '/')}` }).then((d) => {
    assert.equal(d.kind, 'allow');
  });
}));

test('有危险 API 的脚本 → 仍然问人', () => withWs((ws) => {
  const f = join(ws, 'gen.mjs');
  writeFileSync(f, "import { writeFileSync } from 'node:fs'\nwriteFileSync('x','y')\n");
  return harness(ws, `跑一下 ${f.replace(/\\/g, '/')}`)('pwsh', { command: `node ${f.replace(/\\/g, '/')}` })
    .then((d) => { assert.equal(d.kind, 'ask'); });
}));

test('只读脚本 + 用户说"跑一下" → 放行（静态已证明无副作用）', () => withWs((ws) => {
  const f = join(ws, 'demo.mjs');
  writeFileSync(f, "console.log('hello')\n");
  return harness(ws, '跑一下那个演示')('pwsh', { command: `node ${f.replace(/\\/g, '/')}` })
    .then((d) => { assert.equal(d.kind, 'allow'); });
}));

test('scriptAudit=off 时行为回到旧路径', () => withWs((ws) => {
  const f = join(ws, 'demo.mjs');
  writeFileSync(f, "console.log('hello')\n");
  return harness(ws, `跑一下 ${f.replace(/\\/g, '/')}`, { scriptAudit: 'off' })('pwsh', { command: `node ${f.replace(/\\/g, '/')}` })
    .then((d) => { assert.equal(d.kind, 'ask'); });
}));
