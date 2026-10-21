import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAskPrompt, parseAsk, renderAsk, factList } from '../src/verifier.mjs';

const base = {
  tool: 'pwsh',
  args: '{"command":"node scripts/demo.mjs"}',
  op: 'execute',
  targets: ['C:/repo/scripts/demo.mjs'],
  locks: ['opaque'],
  facts: ['C:/repo/scripts/demo.mjs 存在', '大小 120B'],
  instructions: '跑一下演示脚本',
  turns: 'USER: 跑一下演示脚本\nASSISTANT: 好的',
};

test('提示词包含必要的四类信息，且明确禁止编造', () => {
  const p = buildAskPrompt(base);
  assert.match(p, /TOOL: pwsh/);
  assert.match(p, /EFFECT: execute/);
  assert.match(p, /LOCKS: opaque/);
  assert.match(p, /PROBED FACTS/);
  assert.match(p, /USER INSTRUCTIONS/);
  assert.match(p, /RECENT CONTEXT/);
  assert.match(p, /Do not invent/);
});

test('解析四元组，并限制探针数量与类型', () => {
  const q = parseAsk(JSON.stringify({
    probes: [
      { kind: 'scan', target: 'C:/repo/scripts/demo.mjs' },
      { kind: 'delete', target: 'C:/repo/scripts/demo.mjs' },
      { kind: 'stat', target: 'C:/repo/scripts/demo.mjs' },
      { kind: 'list', target: 'C:/repo/scripts/demo.mjs' },
      { kind: 'sample', target: 'C:/repo/scripts/demo.mjs' },
    ],
    verdict: 'ask',
    action: '执行演示脚本',
    facts: ['脚本存在', '大小 120B'],
    suggestion: '看起来只打印日志，可以放行',
    alternatives: ['只读脚本内容'],
  }));
  assert.equal(q.probes.length, 3, '最多 3 个探针');
  assert.ok(q.probes.every((p) => ['stat', 'list', 'scan', 'sample'].includes(p.kind)), '非法探针类型被丢弃');
  assert.equal(q.action, '执行演示脚本');
  assert.equal(q.verdict, 'ask');
});

test('verdict 只有 deny 才被采纳，其它一律按 ask', () => {
  assert.equal(parseAsk('{"verdict":"allow"}').verdict, 'ask');
  assert.equal(parseAsk('{"verdict":"deny"}').verdict, 'deny');
  assert.equal(parseAsk('{"verdict":"whatever"}').verdict, 'ask');
});

test('非 JSON / 空输出 → undefined（调用方退回纯文本问题）', () => {
  assert.equal(parseAsk('抱歉我不能'), undefined);
  assert.equal(parseAsk(''), undefined);
  assert.equal(parseAsk('{}').action, '(未说明)');
});

test('渲染成卡片文字：动作 / 事实 / 建议 / 可替代', () => {
  const text = renderAsk({
    action: '执行演示脚本',
    facts: ['脚本存在'],
    suggestion: '可以放行',
    alternatives: ['只读脚本内容'],
  }, ['目录内 3 项']);
  assert.match(text, /^capgate: 执行演示脚本/);
  assert.match(text, /事实: 脚本存在；目录内 3 项/);
  assert.match(text, /建议: 可以放行/);
  assert.match(text, /可替代: 只读脚本内容/);
});

test('事实列表可读', () => {
  const lines = factList({ facts: [
    { type: 'fs.exists', target: 'a', value: true },
    { type: 'dir.entries', target: 'b', value: 5 },
    { type: 'content.pii', target: 'c', value: { email: 2 } },
    { type: 'scope.skipped', target: 'd' },
  ] });
  assert.equal(lines.length, 4);
  assert.match(lines[0], /存在/);
  assert.match(lines[1], /目录内 5 项/);
  assert.match(lines[2], /email×2/);
  assert.match(lines[3], /工作区外/);
});
