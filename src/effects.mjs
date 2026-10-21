/**
 * 语义效果解析器：让 LLM 成为"这条命令到底做什么"的主张者。
 *
 * 词法层只保留三种作用：
 *   1. 降低开销 —— 按**命令形状**缓存语义结论（`rm a.txt` 与 `rm b.txt` 共用一个形状）
 *   2. 拦截绝对危险 —— ABSOLUTE_DANGER 里那一小组（不是"看起来像读"，而是"确定会毁东西"）
 *   3. 可审计 —— 每次判定都记：语义结论从哪来、词法有没有收紧
 *
 * 设计要点：形状缓存缓存的是 **op**（读/写/删/发/执行），不是结果。
 * 目标仍然从本次调用的参数里取，所以不会把上次的路径带到这次。
 */
import { compileEffects } from './intent.mjs';

/**
 * 绝对危险：命中的不是"可疑"，而是"确定会造成不可逆损害"。
 * 这是词法层唯一保留的**否决**权，而且刻意保持很小。
 */
export const ABSOLUTE_DANGER = [
  [/\brm\s+(-[a-z]*\s+)*-?[rf]{2,}\s+\/(?:\s|$)/i, 'rm-rf-root', '删除根目录'],
  [/\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+(?:\/|\$HOME|~)(?:\s|$)/i, 'rm-rf-home', '递归删除家目录'],
  [/\bmkfs(\.\w+)?\b/i, 'mkfs', '格式化文件系统'],
  [/\bdd\b[^;|&]*\bof=\/dev\/(?:sd|nvme|disk)/i, 'dd-disk', '直接写块设备'],
  [/\b(?:format|Format-Volume)\b\s+[a-z]:/i, 'format-volume', '格式化卷'],
  [/\b(?:shutdown|Stop-Computer)\b[^;|&]*\/(?:s|r)\b/i, 'shutdown', '关机/重启'],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/, 'fork-bomb', 'fork 炸弹'],
  [/\bRemove-Item\b[^;|&]*-Recurse[^;|&]*(?:\s[C-Z]:\\?(?:\s|$)|\s\/\s)/i, 'rm-root-win', '递归删除盘符根'],
  [/\bdrop\s+database\b/i, 'drop-database', '删除整个数据库'],
  [/\btruncate\s+table\b(?![\s\S]*\bwhere\b)/i, 'truncate-table', '清空整表'],
];

/** 命中绝对危险 → 返回规则；否则 undefined。 */
export function absoluteDanger(text) {
  const s = String(text ?? '');
  if (!s.trim()) return undefined;
  for (const [re, rule, why] of ABSOLUTE_DANGER) {
    if (re.test(s)) return { rule, why };
  }
  return undefined;
}

/**
 * 命令形状：把字面量换成占位符，让"同一种做法"共用一个语义结论。
 *  `rm -rf /tmp/a` 与 `rm -rf /home/b` → 同一个形状 → 只编译一次。
 */
export function shapeOf(text) {
  let s = String(text ?? '');
  s = s.replace(/'(?:[^'\\]|\\.)*'/g, "'<S>'");
  s = s.replace(/"(?:[^"\\]|\\.)*"/g, '"<S>"');
  s = s.replace(/\b(?:[A-Za-z]:)?[\\/][^\s'"]*/g, '<P>');
  s = s.replace(/\b\d+(?:\.\d+)?\b/g, '<N>');
  s = s.replace(/\s+/g, ' ').trim().toLowerCase();
  return s.slice(0, 400);
}

/** 形状 → op 的缓存（进程内）。 */
const shapeCache = new Map();

export function cacheStats() {
  return { size: shapeCache.size };
}

export function clearShapeCache() {
  shapeCache.clear();
}

/**
 * 解析这次调用的效果。
 * @returns {Promise<{op:string, source:'cache'|'llm'}|undefined>}
 */
export async function resolveEffect(ctx, agent, { tool, args, timeoutMs = 8000 } = {}) {
  const text = typeof args?.command === 'string' ? args.command
    : typeof args?.cmd === 'string' ? args.cmd
    : typeof args?.script === 'string' ? args.script
    : JSON.stringify(args ?? {});
  const shape = shapeOf(text);
  if (!shape) return undefined;

  const hit = shapeCache.get(shape);
  if (hit) return { op: hit, source: 'cache' };

  const compiled = await compileEffects(ctx, agent, { tool, args }, { timeoutMs });
  if (!compiled || !Array.isArray(compiled.ops) || compiled.ops.length === 0) return undefined;

  // 一条命令可能分解成多个效果：取"最严重"的那个作为主张。
  const order = ['send', 'delete', 'write', 'execute', 'read'];
  let op = 'read';
  for (const o of order) {
    if (compiled.ops.some((x) => x.op === o)) { op = o; break; }
  }
  shapeCache.set(shape, op);
  return { op, source: 'llm' };
}
