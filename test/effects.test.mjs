import { test } from 'node:test';
import assert from 'node:assert/strict';
import { absoluteDanger, shapeOf, resolveEffect, clearShapeCache, cacheStats } from '../src/effects.mjs';
import { apply } from '../src/index.mjs';

test('绝对危险：命中即拒绝', () => {
  for (const cmd of [
    'rm -rf /',
    'mkfs.ext4 /dev/sda1',
    'dd if=/dev/zero of=/dev/sda bs=1M',
    ':(){ :|:& };:',
    'DROP DATABASE production',
  ]) {
    const hit = absoluteDanger(cmd);
    assert.ok(hit, `应命中：${cmd}`);
    assert.ok(hit.rule);
  }
});

test('普通命令不命中绝对危险', () => {
  for (const cmd of [
    "Remove-Item 'C:/repo/a.zip'",
    'rm -rf ./build',
    'git status',
    'SELECT * FROM users',
    'DELETE FROM users WHERE id=1',
  ]) {
    assert.equal(absoluteDanger(cmd), undefined, `不该命中：${cmd}`);
  }
});

test('形状归一化：不同字面量、同一种做法 → 同一形状', () => {
  const a = shapeOf("Remove-Item 'C:/repo/a.zip' -Force");
  const b = shapeOf("Remove-Item 'C:/repo/b.zip' -Force");
  assert.equal(a, b);
  assert.notEqual(shapeOf('rm -rf ./build'), shapeOf('Get-ChildItem'));
});

test('形状缓存：第二次解析不再调用模型', async () => {
  clearShapeCache();
  let calls = 0;
  const ctx = {
    get: (n) => (n === 'llm' ? {
      stream: async function* () {
        calls += 1;
        yield { type: 'text-delta', text: '{"ops":[{"op":"read","targets":[]}],"residual":false}' };
        yield { type: 'finish' };
      },
    } : undefined),
  };
  const agent = { session: { requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } };

  const r1 = await resolveEffect(ctx, agent, { tool: 'pwsh', args: { command: 'Get-ChildItem C:/repo/a.txt' } });
  const r2 = await resolveEffect(ctx, agent, { tool: 'pwsh', args: { command: 'Get-ChildItem C:/repo/b.txt' } });
  assert.equal(r1.op, 'read');
  assert.equal(r1.source, 'llm');
  assert.equal(r2.source, 'cache', '同形状第二次应命中缓存');
  assert.equal(calls, 1);
  assert.ok(cacheStats().size >= 1);
});

/* ── 读闸门 ── */

function harness(cfg, llmJson) {
  const handlers = new Map();
  const ctx = {
    on(ev, fn) { handlers.set(ev, fn); return () => {}; },
    systemPrompt: { section() {} },
    get: (n) => (n === 'llm'
      ? { stream: async function* () { yield { type: 'text-delta', text: llmJson }; yield { type: 'finish' }; } }
      : undefined),
  };
  apply(ctx, { mode: 'capgate', workspaceRoot: 'C:/repo', judgeMode: 'off', ...cfg });
  const agent = {
    session: {
      id: `s-${Math.random()}`,
      header: { cwd: 'C:/repo' },
      surface: { nodes: [0] },
      requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
      snapshotEvents: () => ([
        { type: 'user/message', data: { source: { kind: 'user', rpcId: 'm0' }, content: [{ type: 'text', text: '看看项目' }] } },
      ]),
    },
  };
  return (tool, args) => handlers.get('tools/pre-execute')(
    { name: tool, arguments: args, agent, callId: 'c1' },
    async () => ({ kind: 'allow' }),
  );
}

const SEM_WRITE = '{"ops":[{"op":"write","targets":[]}],"residual":false}';
const SEM_READ = '{"ops":[{"op":"read","targets":[]}],"residual":false}';

test('shadow：词法说读、语义说写 → 仍然放行（只记录不一致）', async () => {
  clearShapeCache();
  const d = await harness({ readGate: 'shadow' }, SEM_WRITE)('pwsh', { command: 'Get-Content C:/repo/a.txt' });
  assert.equal(d.kind, 'allow');
});

test('on：语义不同意就不放行', async () => {
  clearShapeCache();
  const d = await harness({ readGate: 'on' }, SEM_WRITE)('pwsh', { command: 'Get-Content C:/repo/b.txt' });
  assert.notEqual(d.kind, 'allow');
});

test('on：语义同意 → 放行', async () => {
  clearShapeCache();
  const d = await harness({ readGate: 'on' }, SEM_READ)('pwsh', { command: 'Get-Content C:/repo/c.txt' });
  assert.equal(d.kind, 'allow');
});

test('绝对危险在读路径之前就拒绝', async () => {
  const d = await harness({ readGate: 'off' }, SEM_READ)('pwsh', { command: 'rm -rf /' });
  assert.equal(d.kind, 'deny');
  assert.match(d.reason, /绝对危险/);
});
