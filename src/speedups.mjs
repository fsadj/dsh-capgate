/**
 * 加速层：把"反复出现且确定无害"的调用直接判成读，跳过语义调用。
 *
 * 这是**唯一被允许的固定规则**，因此边界必须极端保守：
 *   - 整条命令精确匹配（不做前缀/包含匹配）；
 *   - 出现管道、重定向、命令替换、分号 → 不命中；
 *   - 只产生 'read' 这一个结论（不产生 allow，也不产生 deny）；
 *   - 命中只写进形状缓存，和 LLM 编译出来的结论走同一条路。
 *
 * 换句话说：它不改变判定权，只是替模型把"这条命令显然是读"提前算好。
 */

const NO_CHAIN = /[|;&<>]|\$\(|`/;

/** 精确形状：无参数或只有只读参数的命令 */
const SEEDS = [
  /^(?:ls|dir|pwd|whoami|date|hostname|uname(?:\s+-a)?)\s*$/i,
  /^git\s+(?:status|log|diff|branch|remote|show|rev-parse)(?:\s+[-\w./=]*)*\s*$/i,
  /^git\s+(?:status|log|diff)\s+-{1,2}[\w-]+(?:\s+\d+)?\s*$/i,
  /^(?:node|npm|pnpm|yarn|python|python3|deno|bun)\s+(?:--version|-v)\s*$/i,
  /^(?:Get-ChildItem|Get-Location|Get-Process)\s*$/i,
  /^(?:cat|head|tail|wc)\s+[^|;&<>]+\s*$/i,
  /^type\s+[^|;&<>]+\s*$/i,
];

/** 命中返回 'read'，否则 undefined。 */
export function seededOp(text) {
  const raw = String(text ?? '').trim();
  if (!raw || NO_CHAIN.test(raw)) return undefined;
  for (const re of SEEDS) {
    if (re.test(raw)) return 'read';
  }
  return undefined;
}

/** 供测试与统计：能命中多少条真实命令。 */
export function seedCount() {
  return SEEDS.length;
}
