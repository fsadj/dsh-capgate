import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitCommand, narrowedCommand, splitDecision } from '../src/split.mjs';

test('拆得出：动词 + 多个目标', () => {
  const a = splitCommand('scancel job-a job-b');
  assert.equal(a.name, 'scancel');
  assert.deepEqual(a.targets, ['job-a', 'job-b']);

  const b = splitCommand('git branch -D alex/x bob/y');
  assert.equal(b.name, 'git-branch-del');
  assert.deepEqual(b.targets, ['alex/x', 'bob/y']);

  const c = splitCommand('aws s3 rm s3://b/k1 s3://b/k2');
  assert.equal(c.name, 'aws-s3-rm');
  assert.deepEqual(c.targets, ['s3://b/k1', 's3://b/k2']);
});

test('拆不出：单目标、有管道/重定向/串联', () => {
  assert.equal(splitCommand('scancel job-a'), undefined);
  assert.equal(splitCommand('scancel a b | tee log'), undefined);
  assert.equal(splitCommand('git branch -D a && rm x'), undefined);
  assert.equal(splitCommand('foreach ($b in $all) { git branch -D $b }'), undefined);
});

test('收窄后仍是一条可执行命令', () => {
  const s = splitCommand('git branch -D alex/x bob/y');
  assert.equal(narrowedCommand(s, ['alex/x']), 'git branch -D alex/x');
});

test('混合覆盖 → 给收窄命令；全覆盖/全不覆盖不算混合', () => {
  const mixed = splitDecision('scancel a b c', (t) => t === 'a');
  assert.equal(mixed.mixed, true);
  assert.equal(mixed.narrowed, 'scancel a');

  const all = splitDecision('scancel a b', () => true);
  assert.equal(all.mixed, false);

  const none = splitDecision('scancel a b', () => false);
  assert.equal(none.mixed, false);
});
