/**
 * 会话级状态：已授予的效果类、拒绝计数、待审批调用、审计。
 *
 * 三个刻意的设计选择：
 *   1. 按 session 隔离 —— 不用模块级单例，A 会话的授权绝不外溢到 B；
 *   2. 不落盘复用到别的任务 —— 每个任务的授权只对该任务有效（跨任务复用 = 预授权）；
 *   3. 拒绝计数在内存里 —— 连续 N 次拒绝后升级为"问人"，防止 agent 死循环重试。
 */
import { appendFileSync } from 'node:fs';

const now = () => Date.now();

/** 简单的秘密脱敏：审计里不出现密钥/令牌。 */
export function redact(value, maxLen = 300) {
  const s = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  if (!s) return '';
  return s
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9._-]+)/g, '[redacted]')
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s"',}]+/gi, '$1[redacted]')
    .slice(0, maxLen);
}

export class CapgateStore {
  constructor({ auditPath, grantTtlMs = 8 * 60 * 60 * 1000 } = {}) {
    this.auditPath = auditPath;
    this.grantTtlMs = grantTtlMs;
    this.sessions = new Map();
  }

  session(id) {
    let s = this.sessions.get(id);
    if (!s) {
      s = {
        grants: new Map(), denials: new Map(), pending: new Map(), entities: [],
        repeats: new Map(), counters: { allow: 0, ask: 0, deny: 0, grant: 0, judge: 0 },
        approvals: new Map(),
        createdAt: now(),
      };
      this.sessions.set(id, s);
    }
    return s;
  }

  bump(sessionId, kind) {
    const c = this.session(sessionId).counters;
    if (kind in c) c[kind] += 1;
  }

  /** 同一 (tool, args) 的重复计数：用于"连续重试 → 转人工"的循环守卫。 */
  repeat(sessionId, identity) {
    const s = this.session(sessionId);
    const n = (s.repeats.get(identity) ?? 0) + 1;
    s.repeats.set(identity, n);
    return n;
  }

  statsOf(sessionId) {
    return { ...this.session(sessionId).counters };
  }

  isGranted(sessionId, key) {
    const g = this.session(sessionId).grants.get(key);
    if (!g) return false;
    if (now() - g.at > this.grantTtlMs) {
      this.session(sessionId).grants.delete(key);
      return false;
    }
    return true;
  }

  grant(sessionId, key, meta = {}) {
    const s = this.session(sessionId);
    s.grants.set(key, { at: now(), ...meta });
    s.denials.delete(key);
  }

  /** 记录一次拒绝；返回该类的累计拒绝次数。 */
  deny(sessionId, key) {
    const s = this.session(sessionId);
    const n = (s.denials.get(key) ?? 0) + 1;
    s.denials.set(key, n);
    return n;
  }

  /**
   * 一条具体的命令被人工批准过 → 记下来，同样的命令再来就不再打扰。
   * 只按「完全相同的 tool+args」复用，不做模式推广：
   * 批了 `rm Downloads/*.zip` 不代表同意 `rm Downloads/*.db`。
   */
  approveSignature(sessionId, signature) {
    this.session(sessionId).approvals.set(signature, { at: now() });
  }

  hasSignature(sessionId, signature) {
    const a = this.session(sessionId).approvals.get(signature);
    if (!a) return false;
    if (now() - a.at > this.grantTtlMs) {
      this.session(sessionId).approvals.delete(signature);
      return false;
    }
    return true;
  }

  dropSignature(sessionId, signature) {
    this.session(sessionId).approvals.delete(signature);
  }

  setEntities(sessionId, entities) {
    this.session(sessionId).entities = entities.slice(0, 50);
  }

  entitiesOf(sessionId) {
    return this.session(sessionId).entities;
  }

  rememberPending(sessionId, callId, payload) {
    this.session(sessionId).pending.set(String(callId), payload);
  }

  takePending(sessionId, callId) {
    const s = this.session(sessionId);
    const key = String(callId);
    const v = s.pending.get(key);
    if (v) s.pending.delete(key);
    return v;
  }

  audit(entry) {
    if (!this.auditPath) return;
    try {
      appendFileSync(this.auditPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
    } catch {
      // 审计写失败不影响判定（但上层会打一条 warn）
    }
  }

  snapshot(sessionId) {
    const s = this.session(sessionId);
    return {
      grants: [...s.grants.keys()],
      denials: Object.fromEntries(s.denials),
      pending: s.pending.size,
    };
  }
}
