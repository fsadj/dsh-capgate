import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseView, applyView, redactText } from '../src/outputview.mjs';
import { effectFingerprint } from '../src/bypass.mjs';
import { classifyFailure, shouldRetry, FailureKind } from '../src/failures.mjs';
import { checkCoverage } from '../src/reviewer.mjs';
import { apply } from '../src/index.mjs';

/* ── 结果侧最小化 ── */

test('读类默认裁剪 + 脱敏；批量给更短', () => {
  const v1 = chooseView({ op: 'read', scope: 'workspace', cardinality: 'one' });
  assert.equal(v1.headLines, 120);
  assert.equal(v1.redact, true);

  const v2 = chooseView({ op: 'read', scope: 'workspace', cardinality: 'many' });
  assert.ok(v2.headLines <= 60, '批量结果应更短');

  const v3 = chooseView({ op: 'read', scope: 'outside:C:/x', cardinality: 'one' });
  assert.ok(v3.headLines <= 40, '项目外应更短');

  assert.equal(chooseView({ op: 'write' }), undefined, '写类不裁剪返回');
});

test('裁剪保留前 N 行并写明省略了多少', () => {
  const content = [{ type: 'text', text: Array.from({ length: 200 }, (_, i) => `line${i}`).join('\n') }];
  const { content: out, note } = applyView(content, { headLines: 10, redact: false, why: 'test' });
  assert.equal(out[0].text.split('\n').length, 10);
  assert.match(note, /省略 190 行/);
});

test('脱敏覆盖邮箱/证件/手机/密钥', () => {
  const r = redactText('mail a@b.com id 110101199001011234 phone 13800138000 key sk-abcdefghijklmnopqrst');
  assert.match(r.text, /\[email\]/);
  assert.match(r.text, /\[id\]/);
  assert.match(r.text, /\[phone\]/);
  assert.match(r.text, /\[key\]/);
  assert.equal(r.hits, 4);
});

/* ── 反绕过 ── */

test('效果指纹与写法无关：同一 op + 同一目标 → 同指纹', () => {
  const a = effectFingerprint({ op: 'delete', targets: ['C:/repo/a.txt'] });
  const b = effectFingerprint({ op: 'delete', targets: ['c:\\repo\\a.txt'] });
  assert.equal(a, b, '路径分隔符/大小写不影响指纹');
  const c = effectFingerprint({ op: 'delete', targets: ['C:/repo/b.txt'] });
  assert.notEqual(a, c);
});

test('同一效果换个写法 → 直接拒绝（不再问人）', async () => {
  const handlers = new Map();
  const ctx = {
    on(e, f) { handlers.set(e, f); return () => {}; },
    systemPrompt: { section() {} },
    get: () => undefined,
  };
  apply(ctx, { mode: 'capgate', workspaceRoot: 'C:/repo', judgeMode: 'off', readGate: 'off', autoAllowReads: false });
  const agent = {
    session: {
      id: 'sess-bypass', header: { cwd: 'C:/repo' }, surface: { nodes: [0] },
      requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
      snapshotEvents: () => [{ type: 'user/message', data: { source: { kind: 'user', rpcId: 'm0' }, content: [{ type: 'text', text: '整理一下项目' }] } }],
    },
  };
  const call = (args, id) => handlers.get('tools/pre-execute')(
    { name: 'pwsh', arguments: args, agent, callId: id },
    async () => ({ kind: 'allow' }),
  );
  const first = await call({ command: "Remove-Item 'C:/outside/a.txt'" }, 'c1');
  assert.equal(first.kind, 'deny');
  const second = await call({ command: "del 'C:\\outside\\a.txt'" }, 'c2');
  assert.equal(second.kind, 'deny', '同一效果换写法也要拒');
  assert.match(second.reason, /换了写法|同一个效果/);
});

/* ── 失败分类 ── */

test('失败分类与重试策略', () => {
  assert.equal(classifyFailure('QUOTA: Insufficient Balance'), FailureKind.QUOTA);
  assert.equal(classifyFailure('request timed out'), FailureKind.TIMEOUT);
  assert.equal(classifyFailure('MISSING_CREDENTIAL: no API key'), FailureKind.UNAVAILABLE);
  assert.equal(classifyFailure('unexpected token'), FailureKind.INTERNAL);
  assert.equal(classifyFailure(''), FailureKind.NONE);
  assert.equal(shouldRetry(FailureKind.TIMEOUT), true);
  assert.equal(shouldRetry(FailureKind.QUOTA), false, '额度问题重试没意义');
});

/* ── 覆盖守卫 ── */

test('覆盖守卫：allow 必须带证据；读/发必须有数据级别；批量必须有影响面', () => {
  assert.equal(checkCoverage({ verdict: 'allow', covered: ['x'] }, { op: 'write', locks: [] }).ok, true);
  assert.equal(checkCoverage({ verdict: 'allow' }, { op: 'write' }).ok, false, 'allow 不能空手');
  assert.equal(checkCoverage({ verdict: 'ask' }, { op: 'write' }).ok, true, 'ask 不要求证据');

  const r = checkCoverage({ verdict: 'deny', action: 'x' }, { op: 'read', locks: [] });
  assert.deepEqual(r.missing, ['dataClass']);

  const b = checkCoverage({ verdict: 'deny', action: 'x' }, { op: 'delete', locks: ['batch'] });
  assert.deepEqual(b.missing, ['blast']);
});
