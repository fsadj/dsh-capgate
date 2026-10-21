import { apply } from '../src/index.mjs';

function handler(userText, tool, args) {
  const handlers = new Map();
  const ctx = {
    on(ev, fn) { handlers.set(ev, fn); return () => {}; },
    systemPrompt: { section() {} },
    get: () => undefined,
  };
  apply(ctx, { mode: 'capgate', workspaceRoot: 'C:/repo', judgeMode: 'off', intentMode: 'off', verifierAsk: 'off' });
  const agent = {
    session: {
      id: 'sess-db',
      header: { cwd: 'C:/repo' },
      surface: { nodes: [0] },
      requestHeader: () => ({ config: { provider: 'fake', model: 'fake' } }),
      snapshotEvents: () => ([
        { type: 'user/message', data: { source: { kind: 'user', rpcId: 'm0' }, content: [{ type: 'text', text: userText }] } },
      ]),
    },
  };
  return handlers.get('tools/pre-execute')(
    { name: tool, arguments: args, agent, callId: 'c1' },
    async () => ({ kind: 'allow' }),
  );
}

const cases = [
  ['sql 工具 SELECT', '查一下用户表', 'sql', { query: 'SELECT id, email FROM users LIMIT 10' }],
  ['sql 工具 UPDATE', '把用户表里的 email 改一下', 'sql', { query: "UPDATE users SET email='x' WHERE id=1" }],
  ['sql 工具 DELETE', '把测试用户删掉', 'sql', { query: 'DELETE FROM users WHERE test=1' }],
  ['sql 工具 DROP', '清一下', 'sql', { query: 'DROP TABLE users' }],
  ['shell psql select', '查一下数据库', 'pwsh', { command: 'psql -c "select count(*) from orders"' }],
  ['shell psql delete', '清理订单', 'pwsh', { command: 'psql -c "delete from orders where id < 100"' }],
];

for (const [name, prompt, tool, args] of cases) {
  const d = await handler(prompt, tool, args);
  console.log(`${name.padEnd(22)} -> ${d.kind.padEnd(5)} ${d.reason ? String(d.reason).split('\n')[0].slice(0, 60) : ''}`);
}
