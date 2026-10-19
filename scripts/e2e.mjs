/**
 * 真机端到端验证：独立 DSH_HOME + 假模型 + 三种场景，全自动。
 *
 *   node scripts/e2e.mjs
 *   DSH_BIN=/path/to/dsh/lib/bin.js node scripts/e2e.mjs
 *
 * 不触碰你正在用的 profile —— 全程在 ./.e2e 下的临时 home 里进行。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const E2E = join(ROOT, '.e2e', `run-${STAMP}`);
const HOME = join(E2E, 'home');
const WS = join(E2E, 'ws');
const AUDIT = join(E2E, 'audit.jsonl');
const PORT = Number(process.env.FAKE_LLM_PORT ?? 18089);
const DSH_BIN = process.env.DSH_BIN
  ?? 'C:/Users/brazion/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js';
const FAKE = join(HERE, 'e2e-fake-llm.mjs');
const PLUGIN = join(ROOT, 'src', 'index.mjs').replace(/\\/g, '/');

if (!existsSync(DSH_BIN)) {
  console.error(`找不到 dsh：${DSH_BIN}\n用 DSH_BIN=<path to bin.js> 指定。`);
  process.exit(2);
}

let failures = 0;
const ok = (m) => console.log(`  PASS ${m}`);
const bad = (m) => { failures += 1; console.error(`  FAIL ${m}`); };

rmSync(E2E, { recursive: true, force: true });
mkdirSync(WS, { recursive: true });
mkdirSync(join(HOME, 'profiles'), { recursive: true });
const patch = join(E2E, 'capgate.patch.yml');
writeFileSync(patch, `- id: tool-pwsh
  disabled: true
- id: tool-bash
  disabled: true
- id: llm-pi-ai
  config:
    providers:
      fake:
        displayName: Fake
        api: openai-completions
        apiKeyEnv: FAKE_LLM_KEY
        baseURL: http://127.0.0.1:${PORT}/v1
        models:
          - id: fake
            name: Fake
- id: agent-default-model
  config:
    provider: fake
    model: fake
- insert:
    - id: capgate
      name: 'file:///${PLUGIN}'
      config:
        mode: capgate
        workspaceRoot: '${WS.replace(/\\/g, '/')}'
        auditPath: '${AUDIT.replace(/\\/g, '/')}'
`);

const env = { ...process.env, DSH_HOME: HOME, FAKE_LLM_KEY: 'dummy', FAKE_LLM_PORT: String(PORT) };

const dsh = (args, opts = {}) => spawnSync(process.execPath, [DSH_BIN, ...args], {
  env, cwd: WS, encoding: 'utf8', timeout: 180_000, ...opts,
});

// 1) 初始化 profile（只写配置，不启动）
const init = dsh(['capgate-e2e', '--from-default-profile', 'headless', '--dump-config']);
if (init.status !== 0) {
  console.error('初始化 profile 失败：', (init.stderr ?? '').slice(0, 400));
  process.exit(2);
}

async function waitForServer() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/v1/models`);
      if (r.ok) return true;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function withServer(scenario, fn) {
  const srv = spawn(process.execPath, [FAKE], { env: { ...env, SCENARIO: scenario }, stdio: 'ignore' });
  try {
    if (!(await waitForServer())) throw new Error('假模型没起来');
    return await fn();
  } finally {
    srv.kill();
    await new Promise((r) => setTimeout(r, 200));
  }
}

const run = (task) => dsh(['capgate-e2e', '--patch', patch, task]);

console.log('\n=== 1. cited：用户原话提到 a.txt → 引文授权 → 自动放行 ===');
await withServer('cited', async () => {
  const r = run('create a.txt with hello');
  const out = `${r.stdout}${r.stderr}`;
  if (/\[capgate\] active/.test(out)) ok('插件在真实 dsh 中加载');
  else bad(`插件未加载：${out.slice(0, 200)}`);
  if (/MISSING_CREDENTIAL|TRANSPORT/.test(out)) bad('模型通道未就绪');
  if (existsSync(join(WS, 'a.txt'))) ok('a.txt 已落盘（审批被引文自动放行）');
  else bad(`a.txt 不存在；输出：${out.slice(0, 300)}`);
});

console.log('\n=== 2. uncited：越界且未提及 → 确定性拒绝 ===');
await withServer('uncited', async () => {
  run('create a.txt with hello');
  const audit = existsSync(AUDIT) ? readFileSync(AUDIT, 'utf8') : '';
  if (/"reason":"outside-no-citation"/.test(audit)) ok('审计记录 outside-no-citation');
  else bad('审计里没有 outside-no-citation');
  if (!existsSync('C:/Windows/Temp/evil.txt')) ok('越界文件未被创建');
  else bad('越界文件被创建了');
});

console.log('\n=== 3. batch：通配 *.txt → 批量类 → 无通道 → fail-closed ===');
await withServer('batch', async () => {
  run('create a.txt with hello');
  const audit = existsSync(AUDIT) ? readFileSync(AUDIT, 'utf8') : '';
  if (/"class":"write\|workspace\|plain\|many"/.test(audit)) ok('归类为 many（批量）');
  else bad('未归类为 many');
});

console.log('\n=== 4. amortization：同一会话内两次同类写，只问一次 ===');
await withServer('twice', async () => {
  const before = existsSync(AUDIT) ? (readFileSync(AUDIT, 'utf8').match(/"event":"ask"/g) ?? []).length : 0;
  run('create a.txt and b.txt');
  const audit = readFileSync(AUDIT, 'utf8');
  const after = (audit.match(/"event":"ask"/g) ?? []).length;
  const added = after - before;
  if (added === 1) ok('两次同类写只产生 1 次 ask');
  else bad(`两次同类写产生了 ${added} 次 ask（应为 1）`);
  if (existsSync(join(WS, 'a.txt')) && existsSync(join(WS, 'b.txt'))) ok('a.txt 与 b.txt 都已落盘');
  else bad('有文件未落盘');
});

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
