/**
 * 规则的三种角色。除此之外，规则不该有别的用途。
 *
 *   HARD    硬约束：不可逆、不依赖上下文、模型不能解除（绝对危险、凭据外发）
 *   COST    成本分流：只用来"省一次模型调用"，前提是**它根本不会改状态**
 *   EXPLAIN 可解释性：不改变结论，只决定"必须说明什么、怎么给人看"
 *   AGENT   没有规则介入，判定由审查 agent 给出
 *
 * 不变量（由 selfCheck 检查）：
 *   1. 任何 allow 都不得来自 HARD（硬约束只能拦，不能放）
 *   2. 任何 allow 的 role 只能是 COST 或 AGENT
 *   3. 每个出现在代码里的 reason 都必须在这张表里（否则审计无法解释）
 */

export const ROLE = {
  HARD: 'hard',
  COST: 'cost',
  EXPLAIN: 'explain',
  AGENT: 'agent',
};

/** reason code → 角色 + 一句话解释 */
export const REASONS = {
  // ── 硬约束 ──
  'absolute-danger': { role: ROLE.HARD, zh: '命中绝对危险清单（不可逆）', en: 'absolute danger' },
  sensitive: { role: ROLE.HARD, zh: '凭据/密钥类目标（永不进对话）', en: 'credential target' },
  'unknown-effect': { role: ROLE.HARD, zh: '效果不可知（认不出要做什麼）', en: 'unknown effect' },

  // ── 成本分流（只能省调用，不能放宽） ──
  'read-fast-path': { role: ROLE.COST, zh: '可证明只读', en: 'provable read' },
  'outside-read-fast-path': { role: ROLE.COST, zh: '项目外只读', en: 'outside read' },
  identical: { role: ROLE.COST, zh: '同一条命令此前被批准过', en: 'identical command' },
  extent: { role: ROLE.COST, zh: '落在人批准过的目标集合里', en: 'human-approved extent' },
  'script-read': { role: ROLE.COST, zh: '脚本可读且已核对', en: 'script proven' },
  'compiled-read': { role: ROLE.COST, zh: '效果编译为只读', en: 'compiled as read' },
  provenance: { role: ROLE.COST, zh: '目标是本任务自己创建的', en: 'created by this task' },
  'learned-allow': { role: ROLE.COST, zh: '此前批准过的同类（学习）', en: 'learned allow' },

  // ── 交给 agent ──
  citation: { role: ROLE.AGENT, zh: '用户原话逐字覆盖（作为证据）', en: 'verbatim citation' },
  intent: { role: ROLE.AGENT, zh: '语义契约覆盖（作为证据）', en: 'intent coverage' },
  coverage: { role: ROLE.AGENT, zh: '覆盖率判定覆盖（作为证据）', en: 'coverage' },
  judge: { role: ROLE.AGENT, zh: '效果编译器/复核判定', en: 'judge' },
  'reviewer-allow': { role: ROLE.AGENT, zh: '审查 agent 放行', en: 'reviewer allow' },
  'semantic-clear': { role: ROLE.AGENT, zh: '复核带引文解除锁', en: 'cleared with quote' },
  'anti-bypass': { role: ROLE.AGENT, zh: '同一效果换写法（反绕过）', en: 'anti-bypass' },
  'split-mixed': { role: ROLE.AGENT, zh: '多目标里只有部分被授权（已收窄）', en: 'mixed targets' },

  // ── 人的决定 ──
  'human-once': { role: ROLE.AGENT, zh: '人批准了这一次', en: 'human approved once' },
  'escalation-auto': { role: ROLE.AGENT, zh: '已授予类下的沙箱升级', en: 'escalation under grant' },
  escalation: { role: ROLE.AGENT, zh: '沙箱升级经人确认', en: 'escalation approved' },
  human: { role: ROLE.AGENT, zh: '人的决定', en: 'human' },

  // ── 可解释性（只影响呈现） ──
  ask: { role: ROLE.EXPLAIN, zh: '向人询问', en: 'ask' },
  'output_trim': { role: ROLE.EXPLAIN, zh: '结果侧裁剪/脱敏', en: 'output trimmed' },
  decision: { role: ROLE.EXPLAIN, zh: '判定流水', en: 'decision log' },
  // ── 补齐：代码里实际使用、但之前没登记的来源 ──
  rule: { role: ROLE.COST, zh: '配置里的静态允许规则（只读类）', en: 'static allow rule' },
  learned: { role: ROLE.COST, zh: '从人的批准里学到的同类', en: 'learned from approvals' },
  'escalation-sensitive': { role: ROLE.AGENT, zh: '敏感路径下的沙箱升级', en: 'sensitive escalation' },
  capgate: { role: ROLE.EXPLAIN, zh: 'capgate 自身', en: 'capgate' },
  verifier: { role: ROLE.AGENT, zh: '核查探针给出的事实', en: 'verifier probes' },
  'verifier-ask': { role: ROLE.EXPLAIN, zh: '核查失败转问', en: 'verifier ask' },
  compiled: { role: ROLE.AGENT, zh: '效果编译结果', en: 'compiled effect' },
  judge: { role: ROLE.AGENT, zh: '单次复核判定', en: 'judge verdict' },
  unknown: { role: ROLE.EXPLAIN, zh: '未知来源', en: 'unknown source' },
};
/** 取角色；未知来源返回 undefined（selfCheck 会报警） */
export function roleOf(reason) {
  return REASONS[reason]?.role;
}

/** 一句话解释，给审计/看板用 */
export function explainReason(reason, lang = 'zh') {
  const r = REASONS[reason];
  if (!r) return String(reason ?? '');
  return lang === 'en' ? r.en : r.zh;
}

const ALLOW_ROLES = new Set([ROLE.COST, ROLE.AGENT]);

/**
 * 启动自检：把代码里用到的 reason 与表比对，并检查角色不变量。
 * @param {string[]} usedReasons 代码里出现过的 reason（由调用方扫描或手写）
 * @returns {{unknown:string[], violating:string[]}}
 */
export function selfCheck(usedReasons = []) {
  const unknown = usedReasons.filter((r) => r && !REASONS[r]);
  const violating = [];
  for (const [reason, meta] of Object.entries(REASONS)) {
    // 硬约束永远不能作为 allow 的来源
    if (reason === 'absolute-danger' || reason === 'sensitive' || reason === 'unknown-effect') {
      if (ALLOW_ROLES.has(meta.role)) violating.push(reason);
    }
  }
  return { unknown, violating };
}

/** 事件本身的角色（没有 by 字段时用它判断"这条记录属于哪种用途"）。 */
export const EVENT_ROLES = {
  decision: ROLE.EXPLAIN,
  allow: ROLE.EXPLAIN,
  deny: ROLE.EXPLAIN,
  ask: ROLE.EXPLAIN,
  grant: ROLE.AGENT,
  verify: ROLE.AGENT,
  read_gate: ROLE.AGENT,
  intent: ROLE.AGENT,
  coverage: ROLE.AGENT,
  coverage_failed: ROLE.AGENT,
  prior: ROLE.EXPLAIN,
  probe: ROLE.EXPLAIN,
  output_trim: ROLE.EXPLAIN,
  dormant: ROLE.EXPLAIN,
  escalation: ROLE.AGENT,
  ask_review: ROLE.EXPLAIN,
  ask_review_failed: ROLE.EXPLAIN,
  split_judged: ROLE.AGENT,
  review_facts: ROLE.EXPLAIN,
  extent: ROLE.COST,
};

/** 审计里给每条记录补一个 role（来源未登记时标 unregistered，便于发现漏登记） */
export function annotate(record) {
  const reason = record.by ?? record.reason;
  const meta = reason ? REASONS[reason] : undefined;
  if (meta) return { ...record, role: meta.role, code: reason };
  const eventRole = EVENT_ROLES[record.event];
  if (eventRole) return { ...record, role: eventRole, code: record.event };
  return { ...record, role: ROLE.EXPLAIN, code: 'unregistered' };
}
