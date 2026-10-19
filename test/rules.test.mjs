import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileRules, evaluateRules } from '../src/rules.mjs';
import { effectOf, parseShell } from '../src/classify.mjs';

const ROOT = 'C:/repo';
const eff = (cmd) => parseShell(cmd, ROOT);

test('denyTools 优先于 allowTools', () => {
  const r = compileRules({ allowTools: ['pwsh'], denyTools: ['pwsh'] });
  assert.deepEqual(evaluateRules(r, { tool: 'pwsh', effect: eff('npm test') }), { kind: 'deny', rule: 'denyTools:pwsh' });
});

test('工具名支持通配', () => {
  const r = compileRules({ denyTools: ['mcp__*'] });
  assert.equal(evaluateRules(r, { tool: 'mcp__github', effect: eff('x') })?.kind, 'deny');
  assert.equal(evaluateRules(r, { tool: 'read', effect: eff('x') }), undefined);
});

test('denyKeywords 命中命令即拒绝', () => {
  const r = compileRules({ denyKeywords: ['\\bforce\\b', 'rm\\s+-rf\\s+/'] });
  assert.equal(evaluateRules(r, { tool: 'pwsh', effect: eff('git push --force origin main') })?.kind, 'deny');
  assert.equal(evaluateRules(r, { tool: 'pwsh', effect: eff('npm run build') }), undefined);
});

test('非法正则被丢弃并记录，不炸插件', () => {
  const r = compileRules({ denyKeywords: ['([unclosed'] });
  assert.equal(r.denyKeywords.length, 0);
  assert.equal(r.errors.length, 1);
});

test('denyPaths 前缀匹配', () => {
  const r = compileRules({ denyPaths: ['C:/Windows'] });
  assert.equal(evaluateRules(r, { tool: 'write', effect: effectOf('write', { path: 'C:/Windows/x.dll' }, ROOT) })?.kind, 'deny');
  assert.equal(evaluateRules(r, { tool: 'write', effect: effectOf('write', { path: 'src/a.js' }, ROOT) }), undefined);
});

test('allowPaths 要求全部目标落在范围内', () => {
  const r = compileRules({ allowPaths: ['C:/repo/build'] });
  const one = effectOf('write', { path: 'build/out.js' }, ROOT);
  assert.equal(evaluateRules(r, { tool: 'write', effect: one })?.kind, 'allow');
  const mixed = parseShell('Set-Content C:/repo/build/a.js C:/repo/src/b.js', ROOT);
  assert.equal(evaluateRules(r, { tool: 'pwsh', effect: mixed }), undefined, '混入范围外目标不应整体放行');
});
