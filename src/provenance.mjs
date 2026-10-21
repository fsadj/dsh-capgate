/**
 * 来源事实：这个路径是不是**本任务里 agent 自己产生或碰过**的。
 *
 * 为什么这是"信息层"的补强：
 *   "新建临时文件 → 改它 → 删它" 是 agent 最常见的动作序列，
 *   每一步单独看都像"首次使用某类操作"，于是每一步都要问人。
 *   但只要目标文件是本任务里 agent 自己创建的，删/改它的风险就是已知的。
 *
 * 严格边界：只认**工具调用记录**（tool/call + tool/result），不认模型的说法；
 * 只对已放行过的调用生效——那次调用本身是过了闸门的。
 */
import { normalizePath } from './classify.mjs';

const ACTION_BY_TOOL = [
  [/(delete|remove|rm|unlink|trash)/i, 'deleted'],
  [/(write|edit|create|mkdir|touch|save|apply|patch|append)/i, 'created'],
  [/(list|glob|find|ls|dir|search|grep)/i, 'listed'],
  [/(read|view|cat|open|show)/i, 'read'],
];

function actionOf(tool) {
  for (const [re, kind] of ACTION_BY_TOOL) if (re.test(String(tool ?? ''))) return kind;
  return undefined;
}

function pathsOf(args) {
  if (!args || typeof args !== 'object') return [];
  const out = [];
  for (const key of ['file_path', 'path', 'target', 'file', 'dir', 'directory', 'pattern']) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
  }
  return out;
}

/**
 * @returns {{ created:Set<string>, read:Set<string>, listed:Set<string>, deleted:Set<string>,
 *             events:{ tool:string, action:string, path:string, callId:string }[] }}
 */
export function collectProvenance(agent, { cwd = '', limit = 200 } = {}) {
  const created = new Set();
  const read = new Set();
  const listed = new Set();
  const deleted = new Set();
  const events = [];

  try {
    const session = agent?.session;
    if (!session) return { created, read, listed, deleted, events };
    const nodes = session.surface?.nodes ?? [];
    const snapshot = session.snapshotEvents();
    const calls = new Map();
    const done = new Set();

    for (const seq of nodes) {
      const ev = snapshot[seq];
      if (!ev) continue;
      if (ev.type !== 'tool/call') continue;
      const data = ev.data ?? {};
      const callId = String(data.callId ?? '');
      calls.set(callId, data);
    }

    for (const seq of nodes) {
      const ev = snapshot[seq];
      if (!ev || ev.type !== 'tool/result') continue;
      const callId = String(ev.data?.callId ?? '');
      const call = calls.get(callId);
      if (!call || done.has(callId)) continue;
      done.add(callId);
      // 失败的结果不算"产生过"
      if (ev.data?.isError === true) continue;

      const action = actionOf(call.name);
      if (!action) continue;
      for (const raw of pathsOf(call.arguments)) {
        let key;
        try { key = normalizePath(raw, cwd).toLowerCase(); } catch { key = String(raw).toLowerCase(); }
        if (!key) continue;
        if (action === 'created') created.add(key);
        if (action === 'read') read.add(key);
        if (action === 'listed') listed.add(key);
        if (action === 'deleted') deleted.add(key);
        events.push({ tool: String(call.name), action, path: key, callId });
      }
    }
  } catch {
    // 会话不可读 → 没有来源事实 → 判定退回原路径（不因此放行）
  }

  const trimmed = events.slice(-limit);
  return { created, read, listed, deleted, events: trimmed };
}

/** 目标是否全部由本任务创建（删/改自己造的临时文件不该反复打断）。 */
export function allCreated(prov, targets, cwd = '') {
  const pathTargets = (targets ?? []).filter(Boolean);
  if (pathTargets.length === 0) return undefined;
  for (const t of pathTargets) {
    let key;
    try { key = normalizePath(t, cwd).toLowerCase(); } catch { key = String(t).toLowerCase(); }
    if (!prov?.created?.has(key)) return undefined;
  }
  return pathTargets;
}

/** 目标是否已被本任务读过（读过的再读一次，不该再问）。 */
export function allRead(prov, targets, cwd = '') {
  const pathTargets = (targets ?? []).filter(Boolean);
  if (pathTargets.length === 0) return undefined;
  for (const t of pathTargets) {
    let key;
    try { key = normalizePath(t, cwd).toLowerCase(); } catch { key = String(t).toLowerCase(); }
    if (!prov?.read?.has(key) && !prov?.created?.has(key)) return undefined;
  }
  return pathTargets;
}
