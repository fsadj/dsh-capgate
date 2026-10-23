import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { discover, identityFacts, refFacts, remoteFacts } from '../src/discover.mjs';

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'capgate-discover-'));
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Me');
  git('config', 'user.email', 'me@example.com');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  git('branch', 'alice/topic');
  return dir;
}

test('身份事实：取到 git user.name / email', () => {
  const dir = repo();
  const facts = identityFacts(dir).join('\n');
  assert.match(facts, /git user\.name = Me/);
  assert.match(facts, /git user\.email = me@example\.com/);
});

test('引用事实：列出分支及其作者，不是猜的', () => {
  const dir = repo();
  const facts = refFacts(dir).join('\n');
  assert.match(facts, /refs \(name \| author \| email \| last commit\)/);
  assert.match(facts, /alice\/topic/);
  assert.match(facts, /Me/);
});

test('远程事实：没有远端时为空，不编造', () => {
  const dir = repo();
  assert.deepEqual(remoteFacts(dir), []);
});

test('ref 目标：同时给出身份、远端、引用作者（归属交给模型判）', () => {
  const dir = repo();
  const facts = discover({ kind: 'ref', target: 'alice/topic', cwd: dir }).join('\n');
  assert.match(facts, /git user\.name/);
  assert.match(facts, /alice\/topic/);
});

test('非仓库目录：明说"不是 git 仓库"，而不是给空事实', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capgate-norepo-'));
  writeFileSync(join(dir, 'a.txt'), 'x');
  const facts = discover({ kind: 'ref', target: 'alice/topic', cwd: dir }).join('\n');
  assert.match(facts, /not a git repository/);
});

test('未知目标种类不报错，只给通用事实', () => {
  const dir = repo();
  const facts = discover({ kind: 'unknown-kind', target: 'x', cwd: dir });
  assert.ok(Array.isArray(facts));
});
