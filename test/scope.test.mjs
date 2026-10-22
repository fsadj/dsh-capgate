import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STYLES, STYLE_TEXT, styleText, allowsExploration } from '../src/scope.mjs';
import { buildReviewPrompt } from '../src/reviewer.mjs';

test('三种风格都有说明文本', () => {
  assert.deepEqual(STYLES, ['strict', 'goal', 'custom']);
  for (const s of STYLES) assert.ok(STYLE_TEXT[s].length > 40, s);
});

test('strict 强调"未被覆盖即范围外"，goal 允许探索', () => {
  assert.match(STYLE_TEXT.strict, /OUT OF SCOPE/);
  assert.match(STYLE_TEXT.goal, /Exploratory or supporting steps/);
  assert.equal(allowsExploration('strict'), false);
  assert.equal(allowsExploration('goal'), true);
});

test('custom 会带上自定义范围；没给就退化为 strict 语义', () => {
  const withText = styleText('custom', '只允许 us-east 区域的只读操作');
  assert.match(withText, /只允许 us-east/);
  const empty = styleText('custom', '');
  assert.match(empty, /none given/);
});

test('未知风格回落到 strict（不允许通过拼写放宽）', () => {
  assert.equal(styleText('goalish'), STYLE_TEXT.strict);
});

test('审查提示词里出现当前风格，且不同风格文本不同', () => {
  const base = {
    tool: 'pwsh', args: '{}', op: 'delete', targets: ['a'], locks: [], facts: [], instructions: 'x', turns: '',
  };
  const strict = buildReviewPrompt({ ...base, style: 'strict' });
  const goal = buildReviewPrompt({ ...base, style: 'goal' });
  assert.match(strict, /AUTHORIZATION STYLE: strict/);
  assert.match(goal, /AUTHORIZATION STYLE: goal-directed/);
  assert.notEqual(strict, goal);
});
