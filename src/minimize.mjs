/**
 * minimize 通道：deny 不能只说"不行"，要给"你最多能拿这些"。
 *
 * 输出必须**可证明更窄**：目标集合不变或更小、范围更小、或加了投影/脱敏。
 * 不允许给出"换一种说法做同一件事"的替代——那是绕过，不是最小化。
 */

const within = (a, b) => {
  const x = String(a).replace(/\\/g, '/').toLowerCase();
  const y = String(b).replace(/\\/g, '/').toLowerCase();
  return x === y || x.startsWith(y.replace(/\/+$/, '') + '/');
};

function isStrictlyNarrower(alt, req) {
  if (!alt || !req) return false;
  try {
    return alt.targets.every((t) => req.targets.some((r) => within(t, r)));
  } catch {
    return false;
  }
}

/**
 * 针对一次被拒的操作，给出最小可行替代。
 * @param {{op:string, targets:string[], effect?:object}} req
 * @returns {{label:string, op:string, targets:string[], projection?:string, transform?:string}[]}
 */
export function minimizeOptions(req) {
  const op = String(req?.op ?? 'other');
  const targets = Array.isArray(req?.targets) ? req.targets.filter(Boolean) : [];
  const out = [];

  // 读：先给"少读"，再给"脱敏读"
  if (op === 'read') {
    for (const t of targets) {
      out.push({ label: `只读前 20 行：${t}`, op: 'read', targets: [t], projection: 'head:20' });
      out.push({ label: `只查元数据（大小/类型/时间）：${t}`, op: 'stat', targets: [t] });
      out.push({ label: `脱敏后读取（隐藏密钥/PII）：${t}`, op: 'read', targets: [t], transform: 'redact' });
    }
  }

  // 写：先给"写到工作区"
  if (op === 'write') {
    for (const t of targets) {
      out.push({ label: `改为写到工作区内的副本：${t}`, op: 'write', targets: [t], projection: 'workspace-copy' });
    }
  }

  // 删：不给"换个地方删"，只给"先看清单再决定"
  if (op === 'delete') {
    for (const t of targets) {
      out.push({ label: `先列出将被删除的清单（不执行）：${t}`, op: 'stat', targets: [t] });
      out.push({ label: `改为移入回收目录（可恢复）：${t}`, op: 'move', targets: [t], transform: 'to-trash' });
    }
  }

  // 外发：只给"脱敏/摘要"
  if (op === 'send') {
    out.push({ label: '只发送脱敏后的摘要', op: 'send', targets, transform: 'redact' });
    out.push({ label: '只发送前 20 行', op: 'send', targets, projection: 'head:20' });
  }

  // 执行：只给"只读试运行"
  if (op === 'execute') {
    out.push({ label: '先做只读试运行（dry-run）', op: 'execute', targets, transform: 'dry-run' });
  }

  return out.filter((alt) => isStrictlyNarrower(alt, { targets }));
}

/** 把替代项渲染成卡片上的一段文字。 */
export function describeMinimize(options, limit = 3) {
  if (!options || options.length === 0) return '';
  const shown = options.slice(0, limit).map((o) => `· ${o.label}`).join('\n');
  return `可以做的最小版本：\n${shown}`;
}
