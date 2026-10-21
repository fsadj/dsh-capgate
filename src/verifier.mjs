/**
 * Verifier：独立于主 agent 的"调查员 + 发言人"。
 *
 * 它能做两件事，**不能做第三件**：
 *   ✅ 调查（只读探针，有预算）→ 产出事实
 *   ✅ 拒绝 / 询问（收紧方向自由）
 *   ❌ 放行 —— 放行只能由确定性策略给出
 *
 * 设计约束：
 *   - 只读、无网络、有字节/次数/时间预算；
 *   - 只返回"事实"（命中数、大小、类型），不返回原文；
 *   - 调查失败 = 事实缺失 = 转人工，绝不静默。
 */
import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { basename } from 'node:path';

const PII_PATTERNS = {
  email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  cn_id: /\b\d{17}[\dXx]\b/g,
  cn_phone: /\b1[3-9]\d{9}\b/g,
  credit_card: /\b(?:\d[ -]*?){13,16}\b/g,
};

const SECRET_PATTERNS = {
  private_key: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  aws_key: /\bAKIA[0-9A-Z]{16}\b/,
  openai_key: /\bsk-[A-Za-z0-9_-]{20,}\b/,
  bearer: /\bBearer\s+[A-Za-z0-9._-]{20,}/,
};

export const DEFAULT_BUDGET = { probes: 5, bytes: 262144, ms: 2000 };

function redactLine(line) {
  return String(line)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\b\d{17}[\dXx]\b/g, '[id]')
    .replace(/\b1[3-9]\d{9}\b/g, '[phone]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[key]')
    .slice(0, 300);
}

/**
 * 一次核查：只产出事实，外加"拒绝/询问"的建议。
 * @returns {{facts:object[], probes:string[], recommendation?:'deny'|'ask', reason?:string, question?:object}}
 */
export function verify(call, { budget = DEFAULT_BUDGET } = {}) {
  const started = Date.now();
  const facts = [];
  const probes = [];
  let spent = 0;

  const canProbe = () => probes.length < budget.probes && spent < budget.bytes && Date.now() - started < budget.ms;

  const targets = (call?.targets ?? []).filter((t) => typeof t === 'string' && t);
  const op = String(call?.op ?? 'other');

  for (const target of targets.slice(0, 3)) {
    if (!canProbe()) break;

    // stat：存在性/大小/类型（最便宜）
    probes.push('stat');
    try {
      if (existsSync(target)) {
        const st = statSync(target);
        facts.push({ type: 'fs.exists', target, value: true });
        facts.push({ type: 'fs.is_dir', target, value: st.isDirectory() });
        facts.push({ type: 'fs.size', target, value: st.size });
      } else {
        facts.push({ type: 'fs.exists', target, value: false });
      }
    } catch {
      facts.push({ type: 'fs.stat_failed', target });
    }

    // list：目录条目数（判断批量）
    if (canProbe()) {
      probes.push('list');
      try {
        if (existsSync(target) && statSync(target).isDirectory()) {
          const entries = readdirSync(target);
          facts.push({ type: 'dir.entries', target, value: entries.length });
        }
      } catch { /* 目录读不到：不加事实 */ }
    }

    // scan：内容敏感度（只在需要"内容级"判断时做，且只回计数）
    const needContent = op === 'send' || op === 'read' || op === 'other';
    if (needContent && canProbe()) {
      probes.push('scan');
      try {
        if (existsSync(target) && statSync(target).isFile()) {
          const size = statSync(target).size;
          const readBytes = Math.min(size, Math.max(0, budget.bytes - spent));
          const buf = readFileSync(target, { encoding: 'utf8', flag: 'r' }).slice(0, readBytes);
          spent += readBytes;
          const pii = {};
          for (const [k, re] of Object.entries(PII_PATTERNS)) {
            const n = (buf.match(re) ?? []).length;
            if (n > 0) pii[k] = n;
          }
          const secrets = Object.entries(SECRET_PATTERNS)
            .filter(([, re]) => re.test(buf))
            .map(([k]) => k);
          if (Object.keys(pii).length > 0) facts.push({ type: 'content.pii', target, value: pii });
          if (secrets.length > 0) facts.push({ type: 'content.secret', target, value: secrets });
          facts.push({ type: 'content.scanned_bytes', target, value: readBytes });
        }
      } catch { facts.push({ type: 'content.scan_failed', target }); }
    }

    // sample：给人看的一小段（脱敏后）
    if (op === 'read' && canProbe()) {
      probes.push('sample');
      try {
        if (existsSync(target) && statSync(target).isFile()) {
          const head = readFileSync(target, 'utf8').split('\n').slice(0, 5).map(redactLine);
          facts.push({ type: 'content.sample_head', target, value: head });
        }
      } catch { /* 忽略 */ }
    }
  }

  const piiHits = facts.filter((f) => f.type === 'content.pii').length;
  const secretHits = facts.filter((f) => f.type === 'content.secret').length;

  // 唯一的"拒绝"建议：有敏感内容且数据要离开本机
  if (op === 'send' && (piiHits > 0 || secretHits > 0)) {
    return {
      facts,
      probes,
      recommendation: 'deny',
      reason: '待外发的内容里检测到敏感数据（PII/密钥），最小化要求先脱敏或只发摘要',
    };
  }

  // 有敏感内容但操作是读：不拒绝，交给人工看抽样
  if (piiHits > 0 || secretHits > 0) {
    return { facts, probes, recommendation: 'ask', reason: '内容里检测到敏感数据，请确认用途' };
  }

  return { facts, probes };
}

/** 把事实压成卡片上的一行摘要。 */
export function summarizeFacts(result, limit = 4) {
  const parts = (result?.facts ?? [])
    .slice(0, limit)
    .map((f) => {
      if (f.type === 'fs.exists') return `存在=${f.value}`;
      if (f.type === 'fs.is_dir') return f.value ? '是目录' : '是文件';
      if (f.type === 'fs.size') return `大小 ${f.value}B`;
      if (f.type === 'dir.entries') return `目录内 ${f.value} 项`;
      if (f.type === 'content.pii') return `PII ${Object.entries(f.value).map(([k, v]) => `${k}×${v}`).join(',')}`;
      if (f.type === 'content.secret') return `密钥迹象 ${f.value.join(',')}`;
      if (f.type === 'content.scanned_bytes') return `扫描 ${f.value}B`;
      return f.type;
    });
  return parts.join('；');
}

export { redactLine };
