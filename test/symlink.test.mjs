import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, effectOf } from '../src/classify.mjs';

test('工作区里的软链指向外面 → 不算项目内（符号链接逃逸）', () => {
  const base = mkdtempSync(join(tmpdir(), 'capgate-link-'));
  const ws = join(base, 'ws');
  const out = join(base, 'outside');
  mkdirSync(ws, { recursive: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'secret.txt'), 'x');

  const link = join(ws, 'escape');
  let linked = true;
  try {
    symlinkSync(out, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    linked = false; // 没有建链权限就跳过（CI 环境常见）
  }

  try {
    if (!linked) return;
    const effect = effectOf('pwsh', { command: `Remove-Item '${link.replace(/\\/g, '/')}/secret.txt' -Force` }, ws);
    const klass = classify(effect, { root: ws });
    assert.equal(klass.scope, 'outside:symlink', '软链指向工作区外时必须判成项目外');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('普通工作区内路径仍然是项目内', () => {
  const effect = effectOf('write', { file_path: 'notes.md' }, 'C:/repo');
  assert.equal(classify(effect, { root: 'C:/repo' }).scope, 'workspace');
});
