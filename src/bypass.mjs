/**
 * 会话级反绕过：同一个"破坏意图"换个措辞、换个工具再来一次，不应该重新开始。
 *
 * 现在的实现只认同一条命令的签名（signature），所以：
 *   Remove-Item a.txt  → 被拒
 *   del a.txt          → 全新的一条 → 再问一次
 *   python -c "os.remove('a.txt')" → 又是全新的一条
 *
 * 这里用一个**与工具无关的效果指纹**把它们归到一起：
 *   指纹 = hash(op + 规范化目标集合 + 目标类别)
 * 同指纹在 TTL 内再次出现，且上次是拒绝/询问未获批准 → 直接拒绝，不再打扰人。
 *
 * 借鉴 ClawSentry 的 AntiBypassRecord / DeniedEffectMemoryRecord，
 * 但只保留最小必要字段（我们不需要跨进程持久化）。
 */

const TTL_MS = 30 * 60 * 1000;

const norm = (s) => String(s).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');

/** 目标规范化：去掉引号、统一分隔符，只保留"看起来是同一个东西"的部分 */
function normTarget(t) {
  return norm(t).replace(/^['"]|['"]$/g, '');
}

/**
 * 效果指纹：同一 op + 同一目标集合 → 同指纹，与写法/工具无关。
 * @param {{op:string, targets:string[]}} effect
 */
export function effectFingerprint({ op, targets } = {}) {
  const t = [...new Set((targets ?? []).map(normTarget).filter(Boolean))].sort();
  return `${op}|${t.join(',')}`;
}

class BypassMemory {
  constructor() {
    this.map = new Map(); // sid -> Map(fp -> {decision, at, count})
  }

  #bucket(sid) {
    let m = this.map.get(sid);
    if (!m) { m = new Map(); this.map.set(sid, m); }
    return m;
  }

  /** 记一次判定 */
  remember(sid, fp, decision) {
    const m = this.#bucket(sid);
    const prev = m.get(fp);
    m.set(fp, { decision, at: Date.now(), count: (prev?.count ?? 0) + 1 });
  }

  /** 查：TTL 内是否有过拒绝/未获批 */
  check(sid, fp) {
    const m = this.map.get(sid);
    const rec = m?.get(fp);
    if (!rec) return undefined;
    if (Date.now() - rec.at > TTL_MS) { m.delete(fp); return undefined; }
    if (rec.decision !== 'deny') return undefined;
    return rec;
  }

  /** 该指纹被拒过几次（用于升级给"直接拒绝"而不是再问） */
  deniedCount(sid, fp) {
    return this.check(sid, fp)?.count ?? 0;
  }

  reset(sid) { this.map.delete(sid); }
}

export const bypass = new BypassMemory();
export { TTL_MS as BYPASS_TTL_MS };
