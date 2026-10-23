/**
 * 只读取证工具：把"查一下"的能力交给审查 agent，而不是由我们把事实喂到它嘴边。
 *
 * 设计约束（规则只做很轻的辅助）：
 *   - 分类器认为是读的命令 → 放行；
 *   - 或者命中**只读子命令白名单**（git status / aws s3 ls / kubectl get …），
 *     因为这些工具本身会被判成 execute，但它们有明确的只读子命令；
 *   - 拒绝管道/重定向/串联（一行里藏副作用）；
 *   - 有超时、有输出上限；
 *   - 只允许子 agent（审查者）调用，主 agent 拿到会得到明确拒绝。
 */
import { spawnSync } from 'node:child_process';
import { effectOf, classify } from './classify.mjs';

/** 只读子命令白名单：很轻的辅助，只为让探针能查系统状态。 */
const READONLY_SUBCOMMAND = new RegExp(
  '^('
  + 'git\\s+(status|branch\\s+(-a|-l|--list|--show-current)|log|show|for-each-ref|remote|rev-parse|ls-files|reflog|describe|diff|config\\s+--get)'
  + '|aws\\s+s3\\s+ls|aws\\s+s3api\\s+(list|head|get)'
  + '|kubectl\\s+(get|describe|version)'
  + '|squeue|sinfo'
  + ')\\s*',
  'i',
);

const TIMEOUT_MS = 5000;
const MAX_OUTPUT = 4000;

/** 这条命令是否命中"已知只读子命令"白名单（主判定链复用）。 */
export function readOnlyCommand(text) {
  return READONLY_SUBCOMMAND.test(String(text ?? "").trim());
}

/** 这条命令能不能当探针执行？返回 {ok, why} */
export function probeAllowed(command) {
  const text = String(command ?? '').trim();
  if (!text) return { ok: false, why: 'empty command' };
  if (text.length > 400) return { ok: false, why: 'command too long' };
  // 一行里只允许单条：管道/重定向/串联都可能藏副作用
  if (/[|;&<>`]|\$\(|\bthen\b|\bforeach\b/i.test(text)) {
    return { ok: false, why: 'compound command (pipe/redirect/sequence) is not allowed in a probe' };
  }
  let effect;
  let klass;
  try {
    effect = effectOf('pwsh', { command: text }, process.cwd());
    klass = classify(effect, { root: process.cwd() });
  } catch {
    return { ok: false, why: 'cannot classify command' };
  }
  const readonly = effect.op === 'read' && effect.confidence !== 'low';
  const whitelisted = READONLY_SUBCOMMAND.test(text);
  if (!readonly && !whitelisted) return { ok: false, why: 'effect is "' + effect.op + '"; not a read-only probe' };
  if (effect.wrapped || effect.opaque) return { ok: false, why: 'wrapped/opaque command' };
  return { ok: true, why: '', klassKey: klass?.key };
}

/**
 * 执行一条只读探针。永远返回结构化值，不抛。
 * @returns {{ok:boolean, why?:string, stdout?:string, stderr?:string, exit?:number}}
 */
export function runProbe({ command, cwd } = {}, { defaultCwd } = {}) {
  const verdict = probeAllowed(command);
  if (!verdict.ok) return { ok: false, why: verdict.why };
  const dir = cwd && String(cwd).trim() ? String(cwd) : (defaultCwd ?? process.cwd());
  const shell = process.platform === 'win32' ? 'powershell' : 'pwsh';
  const r = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', String(command)], {
    cwd: dir,
    timeout: TIMEOUT_MS,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  const out = String(r.stdout ?? '');
  const err = String(r.stderr ?? '');
  return {
    ok: r.status === 0,
    exit: r.status ?? -1,
    stdout: out.slice(0, MAX_OUTPUT),
    stderr: err.slice(0, MAX_OUTPUT),
    ...(out.length > MAX_OUTPUT || err.length > MAX_OUTPUT ? { truncated: true } : {}),
  };
}
