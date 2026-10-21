import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REVIEW_SCHEMA, REVIEW_TOOLS, buildReviewPrompt, reviewWithAgent } from '../src/reviewer.mjs';

const input = {
  tool: 'pwsh',
  args: '{"command":"node build.mjs"}',
  op: 'execute',
  targets: ['C:/repo/build.mjs'],
  locks: ['opaque'],
  facts: ['build.mjs 存在', '大小 900B'],
  instructions: '跑一下构建脚本',
  turns: 'USER: 跑一下构建脚本',
};

test('审查提示词：明确"只读、不能放行、引文才能解除锁"', () => {
  const p = buildReviewPrompt(input);
  assert.match(p, /You have read-only tools/);
  assert.match(p, /You may NOT recommend allow/);
  assert.match(p, /quote the user words/);
  assert.match(p, /Authorization comes ONLY from the user instructions/);
});

test('工具面收窄到只读三个（dsh 没有 list 工具）', () => {
  assert.deepEqual([...REVIEW_TOOLS].sort(), ['glob', 'grep', 'read']);
  assert.ok(!REVIEW_TOOLS.includes('pwsh'));
  assert.ok(!REVIEW_TOOLS.includes('write'));
});

test('结构化输出契约里没有 allow 选项', () => {
  assert.deepEqual(REVIEW_SCHEMA.properties.verdict.enum, ['deny', 'ask']);
});

function fakeCtx(runResult, { providers = ['in-process'] } = {}) {
  const calls = [];
  return {
    calls,
    get(name) {
      if (name !== 'subagent') return undefined;
      return {
        list: () => providers,
        start: async (provider, req) => {
          calls.push({ provider, req });
          return {
            id: 'run-1',
            result: Promise.resolve(runResult),
            dispose: async () => { calls.push({ disposed: true }); },
          };
        },
      };
    },
  };
}

test('把请求交给独立 agent：只读工具 + 结构化 schema + 单层深度', async () => {
  const ctx = fakeCtx({ structured: { verdict: 'ask', action: '执行构建脚本', facts: ['脚本存在'] } });
  const out = await reviewWithAgent(ctx, { id: 'a' }, input);
  assert.equal(out.verdict, 'ask');
  assert.equal(out.via, 'agent');
  const req = ctx.calls[0].req;
  assert.deepEqual(req.toolFilter.allow, REVIEW_TOOLS);
  assert.equal(req.outputSchema, REVIEW_SCHEMA);
  assert.equal(req.maxDepth, 1);
  assert.ok(ctx.calls.some((c) => c.disposed), '必须释放 run');
});

test('agent 给 allow 也会被归一化成 ask（策略才决定放行）', async () => {
  const ctx = fakeCtx({ structured: { verdict: 'allow', action: 'x' } });
  const out = await reviewWithAgent(ctx, {}, input);
  assert.equal(out.verdict, 'ask');
});

test('没有 subagent 服务 → 返回 undefined（调用方退化）', async () => {
  const out = await reviewWithAgent({ get: () => undefined }, {}, input);
  assert.equal(out, undefined);
});

test('agent 抛错 → 返回 undefined，不阻塞', async () => {
  const ctx = {
    get: () => ({
      list: () => ['in-process'],
      start: async () => { throw new Error('boom'); },
    }),
  };
  assert.equal(await reviewWithAgent(ctx, {}, input), undefined);
});

test('没有结构化结果时，从文本里兜底解析', async () => {
  const ctx = fakeCtx({
    output: [{ type: 'text', text: '{"verdict":"deny","action":"越界删除","facts":["目标在用户没提的目录"]}' }],
  });
  const out = await reviewWithAgent(ctx, {}, input);
  assert.equal(out.verdict, 'deny');
  assert.equal(out.via, 'agent-text');
});
