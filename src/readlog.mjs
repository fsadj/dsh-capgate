/**
 * 从会话里找回"agent 自己读过的脚本内容"。
 *
 * 为什么用它而不是自己再读一遍：
 *   - 那次读是我们放行的，也在会话里留了记录（可审计）；
 *   - 可以直接对账"读的是不是它现在要跑的那个文件"；
 *   - 省一次磁盘读，也避免"我们看到的内容"和"agent 看到的内容"不一致。
 */
import { normalizePath } from './classify.mjs';

function textOf(content) {
  return (content ?? [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

function samePath(a, b, cwd) {
  try {
    return normalizePath(a, cwd).toLowerCase() === normalizePath(b, cwd).toLowerCase();
  } catch {
    return String(a) === String(b);
  }
}

/**
 * @returns {{ content:string, callId:string, path:string } | undefined}
 */
export function findReadContent(agent, scriptPath, { cwd = '' } = {}) {
  try {
    const session = agent?.session;
    if (!session) return undefined;
    const nodes = session.surface?.nodes ?? [];
    const events = session.snapshotEvents();
    const calls = new Map();
    let hit;

    for (const seq of nodes) {
      const ev = events[seq];
      if (!ev) continue;
      if (ev.type === 'tool/call') {
        calls.set(ev.data?.callId, ev.data);
        continue;
      }
      if (ev.type !== 'tool/result') continue;
      const call = calls.get(ev.data?.callId);
      if (!call) continue;
      const args = call.arguments ?? {};
      const target = args.file_path ?? args.path ?? args.target;
      if (!target || !scriptPath) continue;
      if (!samePath(target, scriptPath, cwd)) continue;
      const content = textOf(ev.data?.content);
      if (!content) continue;
      hit = { content, callId: String(ev.data?.callId ?? ''), path: String(target) };
    }
    return hit;
  } catch {
    return undefined;
  }
}
