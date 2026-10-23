import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordFacts, discover } from '../src/discover.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'capgate-facts-'));
  writeFileSync(join(dir, 'registry.json'), JSON.stringify({
    jobs: [
      { job_id: 'job-dev-4812-a', queue: 'dev', owner: 'alex', protected: false },
      { job_id: 'job-prod-4812-a', queue: 'prod-batch', owner: 'alex', protected: true },
    ],
  }));
  mkdirSync(join(dir, 'nested'), { recursive: true });
  writeFileSync(join(dir, 'nested', 'services.json'), JSON.stringify({
    services: [{ service_id: 'svc-dev-auth-4812-a', env: 'dev', health: 'unhealthy' }],
  }));
  return dir;
}

test('从任意记录文件里找到目标的元数据（不看文件名）', () => {
  const dir = fixture();
  const facts = recordFacts({ target: 'job-dev-4812-a', dirs: [dir] }).join('\n');
  assert.match(facts, /queue=dev/);
  assert.match(facts, /owner=alex/);
  assert.match(facts, /protected=false/);
});

test('嵌套目录也能找到', () => {
  const dir = fixture();
  const facts = recordFacts({ target: 'svc-dev-auth-4812-a', dirs: [dir] }).join('\n');
  assert.match(facts, /env=dev/);
});

test('带前缀的目标也能匹配（path:/job:/ref:）', () => {
  const dir = fixture();
  const facts = recordFacts({ target: 'job:job-prod-4812-a', dirs: [dir] }).join('\n');
  assert.match(facts, /queue=prod-batch/);
});

test('找不到就是空，不编造', () => {
  const dir = fixture();
  assert.deepEqual(recordFacts({ target: 'job-dev-9999-x', dirs: [dir] }), []);
});

test('discover 会把记录事实带上（和其它事实合并）', () => {
  const dir = fixture();
  const facts = discover({ kind: 'other', target: 'job-dev-4812-a', cwd: dir });
  assert.ok(facts.some((f) => f.includes('queue=dev')), '应包含记录事实');
});

test('空目标/空目录不炸', () => {
  assert.deepEqual(recordFacts({ target: '', dirs: [] }), []);
  assert.doesNotThrow(() => recordFacts({ target: 'x', dirs: ['/definitely/not/here'] }));
});
