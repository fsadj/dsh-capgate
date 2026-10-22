import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seededOp, seedCount } from '../src/speedups.mjs';
import { resolveEffect, loadShapeCache, flushShapeCache, clearShapeCache } from '../src/effects.mjs';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('种子规则命中常见只读命令', () => {
  for (const cmd of ['ls', 'pwd', 'whoami', 'git status', 'git log', 'node --version', 'Get-ChildItem']) {
    assert.equal(seededOp(cmd), 'read', cmd);
  }
});

test('带管道/重定向/串联的一律不命中', () => {
  for (const cmd of ['ls | rm -rf build', 'cat a > b', 'git status && rm x', 'echo $(rm -rf /)']) {
    assert.equal(seededOp(cmd), undefined, cmd);
  }
});

test('看起来像但不是只读的不命中', () => {
  for (const cmd of ['git push', 'git commit -m x', 'node build.mjs', 'Get-ChildItem | Remove-Item']) {
    assert.equal(seededOp(cmd), undefined, cmd);
  }
});

test('不调模型就能得到 seed 来源的结论', async () => {
  clearShapeCache();
  let llmCalls = 0;
  const ctx = {
    get: (n) => (n === 'llm' ? {
      stream: async function* () { llmCalls += 1; yield { type: 'text-delta', text: '{"ops":[{"op":"read","targets":[]}]}' }; yield { type: 'finish' }; },
    } : undefined),
  };
  const agent = { session: { requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } };
  const r = await resolveEffect(ctx, agent, { tool: 'pwsh', args: { command: 'git status' } });
  assert.equal(r.op, 'read');
  assert.equal(r.source, 'seed');
  assert.equal(llmCalls, 0, '种子命中不应该调用模型');
});

test('形状缓存可以落盘再载入（重启后免调用）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capgate-cache-'));
  const file = join(dir, 'shape.json');
  try {
    clearShapeCache();
    loadShapeCache(file);
    const agent = { session: { requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } };
    // 直接写一条，落盘，再在新进程模拟里载入
    return (async () => {
      await resolveEffect({ get: () => undefined }, agent, { tool: 'pwsh', args: { command: 'git status' } });
      flushShapeCache();
      assert.ok(existsSync(file), '应写出缓存文件');
      clearShapeCache();
      const n = loadShapeCache(file);
      assert.ok(n >= 1, '应载入至少一条');
    })();
  } finally {
    setTimeout(() => rmSync(dir, { recursive: true, force: true }), 100);
  }
});

test('种子数量保持很小（这是加速，不是规则库）', () => {
  assert.ok(seedCount() <= 10, `seed=${seedCount()}`);
});
