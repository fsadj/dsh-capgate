/**
 * 问的种类：同样是 ask，原因完全不同，优化手法也不同。
 *
 *   impact    影响面确认 —— 动作和目标都清楚，只是范围大（批量/通配/出网/提权）。
 *             优化手法：类授权摊销、给更窄的默认范围。
 *   referent  指代确认 —— 目标没被用户点名，需要确认"是不是这几个"。
 *             优化手法：枚举后二次确认、任务状态里带上候选集合。
 *   anomaly   目标异常 —— 这次调用看起来不是用户要的（自己造的目标、无关资源）。
 *             优化手法：不该优化，问就是对的。
 */

export const ASK_KINDS = ['impact', 'referent', 'anomaly'];

const ANOMALY_HINT = /unrelated|not mentioned|never mentioned|does not appear|no such|probe|nonexistent|不属于|无关|没提/i;
const REFERENT_HINT = /did not name|not name|never named|specific target|which branch|ambiguous|unclear|没点名|不明确|具体/i;

/**
 * @param {{cardinality?:string, locks?:string[], wildcard?:boolean, verdict?:string, text?:string}} input
 * @returns {'impact'|'referent'|'anomaly'}
 */
export function classifyAsk({ cardinality, locks = [], wildcard, text = '' } = {}) {
  const t = String(text ?? '');
  // 影响面：批量/通配或带锁 —— 这类是策略性请示，不取决于模型能不能判断
  const impactLocks = locks.filter((l) => l === 'batch' || l === 'egress' || l === 'privilege' || l === 'opaque');
  if (cardinality === 'many' || wildcard || impactLocks.length > 0) return 'impact';
  // 目标异常：审查者明确说"这不像用户要的"
  if (ANOMALY_HINT.test(t)) return 'anomaly';
  // 指代不明：审查者说"没点名/不明确"
  if (REFERENT_HINT.test(t)) return 'referent';
  // 兜底：单个目标、没有锁、也说不出异常 → 多半是"要不要动这个"的确认
  return 'referent';
}

const LABEL = {
  impact: { zh: '影响面确认', en: 'scope check' },
  referent: { zh: '目标确认', en: 'target check' },
  anomaly: { zh: '异常目标', en: 'anomalous target' },
};

export function askKindLabel(kind) {
  return LABEL[kind] ?? LABEL.referent;
}
