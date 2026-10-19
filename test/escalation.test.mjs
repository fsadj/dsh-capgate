import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/index.mjs';

const ROOT = 'C:/repo';

function makeAgent(userText) {
  return {
    session: {
      id: 'sess-esc',
      header: { cwd: ROOT },
      surface: { nodes: [0] },
      requestHeader: () => ({ config: { provider: 'fake', model: 'fake' } }),
      snapshotEvents: () => ([
        { type: 'user/message', data: { source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: userText }] } },
      ]),
    },
  };
}

function setup({ approvalOutcome = 'allowed-once', cfg = {} } = {}) {
  const handlers = new Map();
  const asked = [];
  const approval = {
    overrideOf: () => undefined,
    async request(req) { asked.push(req); return approvalOutcome; },
  };
  const ctx = {
    on(ev, fn) { handlers.set(ev, fn); return () => {}; },
    systemPrompt: { section() {} },
    get: (name) => (name === 'approval' ? approval : undefined),
  };
  apply(ctx, { mode: 'capgate', workspaceRoot: ROOT, ...cfg });
  const agent = makeAgent('把 C:/Users/me/Downloads/a.zip 删掉');
  let n = 0;
  return {
    agent,
    asked,
    async pre(args) {
      const callId = `e${(n += 1)}`;
      const decision = await handlers.get('tools/pre-execute')(
        { name: 'pwsh', arguments: args, agent, callId },
        async () => ({ kind: 'allow' }),
      );
      return { decision, callId };
    },
    async approve(reason, callId, downstream = 'rejected') {
      return handlers.get('approval/request')({ agent, toolName: 'pwsh', callId, reason }, async () => downstream);
    },
  };
}

const escReason = 'escalate sandbox to danger-full-access: 用户要求删除安装包，路径在工作区外';

test('沙箱升级请求被 capgate 接管：用 capgate 的文案问人', async () => {
  const h = setup({ approvalOutcome: 'allowed-once' });
  const { decision, callId } = await h.pre({
    command: 'Remove-Item -LiteralPath C:/Users/me/Downloads/a.zip -Force',
    sandbox_permissions: 'danger-full-access',
    justification: '用户要求删除安装包',
  });
  assert.equal(decision.kind, 'allow', '预执行放行，交给升级审批阶段');

  const outcome = await h.approve(escReason, callId);
  assert.equal(outcome, 'allowed-once', '人批准后把结果回给工具');
  assert.equal(h.asked.length, 1, '应该由 capgate 发起一次询问');
  assert.match(h.asked[0].reason, /^capgate:/, '询问文案是 capgate 的，不是模型写的');
});

test('人拒绝：升级请求返回 rejected', async () => {
  const h = setup({ approvalOutcome: 'rejected' });
  const { callId } = await h.pre({
    command: 'Remove-Item -LiteralPath C:/Users/me/Downloads/a.zip -Force',
    sandbox_permissions: 'danger-full-access',
    justification: '需要放宽',
  });
  const outcome = await h.approve(escReason, callId);
  assert.equal(outcome, 'rejected');
});

test('嵌套询问不会被自己再次接管（防递归）', async () => {
  const h = setup();
  const outcome = await h.approve('capgate: 项目内 · 写；本次需要放宽到 danger-full-access', 'none');
  assert.equal(outcome, 'rejected', '嵌套请求应直接交给下游 answerer');
  assert.equal(h.asked.length, 0, '不应再发起一次询问');
});

test('没见过的 callId：交还原生处理', async () => {
  const h = setup();
  const outcome = await h.approve(escReason, 'unknown-call');
  assert.equal(outcome, 'rejected');
  assert.equal(h.asked.length, 0);
});
