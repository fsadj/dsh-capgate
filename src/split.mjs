/**
 * 多目标拆分：一条命令带 N 个目标时，别整条放/整条拒。
 *
 * 真实失败模式（AmPermBench 上 16 条漏报里 14 条是这个）：
 *   scancel job-a job-b job-c        ← 只有 a 被授权
 *   git branch -D a b c              ← 只有 a 被授权
 *   aws s3 rm s3://b/k1 s3://b/k2    ← 只有 k1 被授权
 *
 * 整条放 → 漏 2 个；整条拒 → 误 1 个。
 * 正确做法：把命令**收窄到被授权的子集**，把这个命令交给 agent 重跑。
 * （宿主没有 rewrite 裁决，所以以"拒绝 + 可直接执行的收窄命令"的形式给出。）
 */

/** 支持拆分的命令形态：动词 + 一串目标 */
const SPLITTERS = [
  { name: 'scancel', re: /^(\s*scancel\s+)(.+)$/i, sep: /\s+/ },
  { name: 'git-branch-del', re: /^(\s*git\s+branch\s+(?:-[a-zA-Z]*[dD][a-zA-Z]*|--delete)\s+)(.+)$/i, sep: /\s+/ },
  { name: 'git-push-del', re: /^(\s*git\s+push\s+\S+\s+--delete\s+)(.+)$/i, sep: /\s+/ },
  { name: 'aws-s3-rm', re: /^(\s*aws\s+s3\s+rm\s+(?:[^\s]*\s+)*?)((?:s3:\/\/|\.\/|\/)?\S+(?:\s+(?:s3:\/\/|\.\/|\/)?\S+)*)\s*$/i, sep: /\s+/ },
  { name: 'rm', re: /^(\s*(?:rm|del|erase|Remove-Item)\s+(?:-[a-zA-Z-]+\s+)*)(.+)$/i, sep: /\s+/ },
  { name: 'kubectl-delete', re: /^(\s*kubectl\s+delete\s+(?:[a-z]+\s+)?)(.+)$/i, sep: /\s+/ },
];

/**
 * 把命令拆成"动词前缀 + 目标列表"。拆不了返回 undefined。
 * @returns {{name:string, prefix:string, targets:string[]} | undefined}
 */
export function splitCommand(command) {
  const text = String(command ?? '').trim();
  if (!text) return undefined;
  // 有管道/重定向/串联就不拆：拆了语义会变
  if (/[|;&<>`]|\$\(/.test(text)) return undefined;
  for (const s of SPLITTERS) {
    const m = s.re.exec(text);
    if (!m) continue;
    const prefix = m[1];
    const rest = m[2].trim();
    const targets = rest.split(s.sep).map((t) => t.replace(/^["']|["']$/g, '')).filter(Boolean);
    if (targets.length < 2) return undefined;
    return { name: s.name, prefix, targets };
  }
  return undefined;
}

/** 用被保留的目标重建命令 */
export function narrowedCommand(split, keep) {
  if (!split) return undefined;
  const quoted = keep.map((t) => (/[\s*?]/.test(t) ? `"${t}"` : t));
  return `${split.prefix.trim()} ${quoted.join(' ')}`;
}

/**
 * 依据"每个目标是否被授权"给出拆分结论。
 * @param {string[]} targets 命令里的目标（原文形态）
 * @param {(t:string)=>boolean} isCovered
 */
export function splitDecision(command, isCovered) {
  const split = splitCommand(command);
  if (!split) return undefined;
  const keep = split.targets.filter((t) => isCovered(t));
  const drop = split.targets.filter((t) => !isCovered(t));
  if (keep.length === 0 || drop.length === 0) return { split, keep, drop, mixed: false };
  return { split, keep, drop, mixed: true, narrowed: narrowedCommand(split, keep) };
}
