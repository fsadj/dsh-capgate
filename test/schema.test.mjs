import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/index.mjs';

const ROOT = 'C:/repo';
const HOME = 'C:/Users/me';

function makeAgent(text) {
  return {
    session: {
      id: 'sess-schema',
      header: { cwd: ROOT },
      surface: { nodes: [0] },
      requestHeader: () => ({ config: { provider: 'fake', model: 'fake' } }),
      snapshotEvents: () => ([
        { type: 'user/message', data: { source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text }] } },
      ]),
    },
  };
}

/** 注入一个假的 tools 注册表，验证"schema 优先于启发式"这条链路真的接通了 */
function harness(userText, definitions) {
  const handlers = new Map();
  const ctx = {
    on(ev, fn) { handlers.set(ev, fn); return () => {}; },
    systemPrompt: { section() {} },
    get: (name) => {
      if (name !== 'tools') return undefined;
      return { get: (n) => definitions[n] };
    },
  };
  apply(ctx, { mode: 'capgate', workspaceRoot: ROOT, judgeMode: 'off' });
  const agent = makeAgent(userText);
  return async (tool, args) => handlers.get('tools/pre-execute')(
    { name: tool, arguments: args, agent, callId: 'c1' },
    async () => ({ kind: 'allow' }),
  );
}

test('第三方删除工具：靠参数 schema 判成删除，越界即拒绝', async () => {
  const call = harness('看看这个项目', {
    mcp__fs__deleteFile: {
      name: 'mcp__fs__deleteFile',
      description: 'Delete a file',
      parameters: { properties: { paths: { type: 'array' } } },
    },
  });
  const d = await call('mcp__fs__deleteFile', { paths: [`${HOME}/Downloads/a.zip`] });
  assert.equal(d.kind, 'deny', 'schema 说是删除，就不该落到"未知工具→问人"');
  assert.match(d.reason, /项目外|敏感|拒绝/);
});

test('第三方查询工具：schema 说是读 → 不再一律问人', async () => {
  const call = harness('看看这个项目', {
    mcp__db__query: {
      name: 'mcp__db__query',
      description: 'Run a read-only query',
      parameters: { properties: { sql: {} } },
    },
  });
  const d = await call('mcp__db__query', { sql: 'select 1' });
  assert.equal(d.kind, 'allow', '读类第三方工具不该被当成未知工具拦住');
});

test('没有 schema 的工具仍然走保守路径（问人）', async () => {
  const call = harness('看看这个项目', {});
  const d = await call('mcp__misc__do', { foo: 1 });
  assert.equal(d.kind, 'ask');
});

test('shell 工具永远不走 schema 分类（真机验证时抓到的坑）', async () => {
  // 真机上 pwsh 的 schema 被误读成"读"，把 `Remove-Item` 判成了 allow。
  const call = harness('看看这个项目', {
    pwsh: {
      name: 'pwsh',
      description: 'Run a PowerShell command',
      parameters: { properties: { command: {}, cwd: {} } },
    },
  });
  const d = await call('pwsh', { command: `Remove-Item '${HOME}/Downloads/a.zip' -Force` });
  assert.equal(d.kind, 'deny', 'shell 必须按命令文本判，不能被 schema 降级成读');
});
