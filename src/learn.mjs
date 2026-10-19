/**
 * 规则硬化（hardening）：把"人做过的判断"沉淀成可复用的规则。
 *
 * 刻意分成两个方向，风险不对称：
 *   - **拒绝侧可以自动硬化**：拒绝只会让边界更紧，错了最多是多问一次；
 *   - **放行侧必须显式确认**：放行等于预授权，绝不能因为"批过几次"就自动放开。
 *
 * 规则以效果类为键（op|scope|sensitivity|cardinality），与摊销单位一致；
 * 存放位置由插件决定（默认与 audit 同目录的 capgate-learn.json），**不写 profile、
 * 不写仓库**——写进仓库就等于把预授权交给了一次 git checkout。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function emptyState() {
  return { version: 1, rules: { allow: [], deny: [] }, stats: {} };
}

export function loadState(path) {
  if (!path || !existsSync(path)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const base = emptyState();
    return {
      version: parsed.version ?? 1,
      rules: {
        allow: Array.isArray(parsed.rules?.allow) ? parsed.rules.allow : [],
        deny: Array.isArray(parsed.rules?.deny) ? parsed.rules.deny : [],
      },
      stats: parsed.stats && typeof parsed.stats === 'object' ? parsed.stats : base.stats,
    };
  } catch {
    return emptyState();
  }
}

export function saveState(path, state) {
  if (!path) return false;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2));
    return true;
  } catch {
    return false;
  }
}

/** 记一次人的选择（approve / reject）。 */
export function observe(state, key, decision) {
  const entry = state.stats[key] ?? { approve: 0, reject: 0 };
  if (decision === 'approve') entry.approve += 1;
  else entry.reject += 1;
  entry.lastAt = new Date().toISOString();
  state.stats[key] = entry;
  return entry;
}

export function hasRule(state, key, kind) {
  return state.rules[kind].some((r) => r.key === key);
}

/**
 * 候选规则：反复批准 → 建议 allow；反复拒绝 → 建议 deny（拒绝侧可以直接应用）。
 * @returns {{key:string, kind:'allow'|'deny', approve:number, reject:number, reason:string}[]}
 */
export function candidates(state, { approveAt = 3, rejectAt = 2 } = {}) {
  const out = [];
  for (const [key, s] of Object.entries(state.stats)) {
    if (s.reject >= rejectAt && !hasRule(state, key, 'deny')) {
      out.push({ key, kind: 'deny', approve: s.approve, reject: s.reject, reason: `拒绝 ${s.reject} 次` });
    } else if (s.approve >= approveAt && s.reject === 0 && !hasRule(state, key, 'allow')) {
      out.push({ key, kind: 'allow', approve: s.approve, reject: s.reject, reason: `批准 ${s.approve} 次且从未拒绝` });
    }
  }
  return out.sort((a, b) => (b.approve + b.reject) - (a.approve + a.reject));
}

/** 把一条候选写成规则。 */
export function addRule(state, key, kind, note = '') {
  if (kind !== 'allow' && kind !== 'deny') throw new Error(`unknown rule kind: ${kind}`);
  if (hasRule(state, key, kind)) return false;
  state.rules[kind].push({ key, createdAt: new Date().toISOString(), note, source: 'hardening' });
  return true;
}

export function removeRule(state, key, kind) {
  const list = state.rules[kind];
  const i = list.findIndex((r) => r.key === key);
  if (i < 0) return false;
  list.splice(i, 1);
  return true;
}
