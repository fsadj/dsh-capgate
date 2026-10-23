/**
 * 硬约束：一小部分**不可逆、且不依赖上下文**的命令。
 *
 * 这是规则唯一被允许"直接拒绝"的地方。除此之外，效果判断全部交给审查 agent。
 * 每条都必须是"没有合理解释"的动作：删根目录、格式化磁盘、写裸设备、fork 炸弹……
 */

export const ABSOLUTE_DANGER = [
  [/(^|[\s;|&])rm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)*\/\s*($|[;|&])/i, 'rm-rf-root', '删除根目录'],
  [/\brm\s+(-[a-zA-Z]+\s+)*--no-preserve-root\b/i, 'rm-no-preserve-root', '删除根目录'],
  [/\bmkfs(\.\w+)?\s+\/dev\//i, 'mkfs', '格式化设备'],
  [/\bdd\s+[^|;]*of=\/dev\/(sd|nvme|hd)/i, 'dd-to-disk', '写裸设备'],
  [/>\s*\/dev\/(sd|nvme|hd)/i, 'redirect-to-disk', '写裸设备'],
  [/\bFormat-Volume\b/i, 'format-volume', '格式化卷'],
  [/\bRemove-Item\b[^|;]*-C:\\\s*$/i, 'remove-drive-root', '删除盘符根目录'],
  [/\b(shutdown|reboot|halt|poweroff)\b/i, 'power', '关机/重启'],
  [/\(\)\s*\{\s*:\|:&\s*\};:/, 'fork-bomb', 'fork 炸弹'],
  [/\bchmod\s+-R\s+777\s+\/\s*($|[;|&])/i, 'chmod-root', '把根目录改成 777'],
];

/**
 * 判断一条命令是否命中硬约束。
 * @param {string} text 命令文本（不是 tool 名 + 参数）
 * @returns {{rule:string, why:string}|undefined}
 */
export function absoluteDanger(text) {
  const s = String(text ?? '');
  if (!s.trim()) return undefined;
  for (const [re, rule, why] of ABSOLUTE_DANGER) {
    if (re.test(s)) return { rule, why };
  }
  return undefined;
}
