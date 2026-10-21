/**
 * 证据模型：用户原话是不可变权威，其余一切都是可重建的投影。
 *
 * 三条硬规则（决定后面所有设计）：
 *   1. 原文不可变：只追加，不摘要、不改写；
 *   2. instruction / quoted 必须分开：用户粘贴的日志、网页、报错是"数据"，不是"授权"；
 *   3. 派生出来的每一条判断，都必须能指回原文的 span；指不回去的只能收紧，不能放宽。
 */

/** 围栏代码块 + 引用块 = 粘贴内容（数据）；行内代码不算（通常就是路径本身）。 */
const QUOTED_PATTERNS = [
  /```[\s\S]*?```/g,          // 围栏代码块
  /^(?:>[^\n]*\n?)+/gm,       // 引用块
];

/**
 * 把一条用户消息切成 instruction / quoted 片段（带偏移）。
 * @returns {{kind:'instruction'|'quoted', start:number, end:number, text:string}[]}
 */
export function splitSegments(text) {
  const src = String(text ?? '');
  if (!src) return [];

  const marks = [];
  for (const re of QUOTED_PATTERNS) {
    re.lastIndex = 0;
    for (const m of src.matchAll(re)) {
      marks.push({ start: m.index, end: m.index + m[0].length });
    }
  }
  marks.sort((a, b) => a.start - b.start);

  const out = [];
  let cursor = 0;
  for (const m of marks) {
    if (m.start > cursor) out.push({ kind: 'instruction', start: cursor, end: m.start, text: src.slice(cursor, m.start) });
    out.push({ kind: 'quoted', start: m.start, end: m.end, text: src.slice(m.start, m.end) });
    cursor = Math.max(cursor, m.end);
  }
  if (cursor < src.length) out.push({ kind: 'instruction', start: cursor, end: src.length, text: src.slice(cursor) });
  return out.filter((s) => s.text.trim().length > 0);
}

/** 只保留 instruction 片段（授权只从这里来）。 */
export function instructionOnly(text) {
  const segs = splitSegments(text).filter((s) => s.kind === 'instruction');
  return segs.map((s) => s.text).join('\n').trim();
}

/**
 * 采集任务证据：原文 + 切分 + 人给的标签 + 最近若干轮"指令→回复"对。
 *
 * 回复（assistant）只用来**消除指代**，永远不能当授权：
 * 授权条目的 quote 只能在 user 的 instruction span 里定位。
 */
export function collectEvidence(agent, { labels = [], taskId = '', window = 'latest', turns = 5 } = {}) {
  const sessionId = String(agent?.session?.id ?? 'anonymous');
  const out = { taskId: taskId || sessionId, instructions: [], labels: [], turns: [] };
  const pendingTurns = [];
  try {
    const session = agent?.session;
    if (!session) return out;
    const nodes = session.surface?.nodes ?? [];
    const events = session.snapshotEvents();
    for (const seq of nodes) {
      const ev = events[seq];
      if (!ev) continue;

      const textOf = (content) => (content ?? [])
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n');

      // 模型对用户的回复：只进入上下文，不进入授权
      if (ev.type === 'assistant/message') {
        const reply = textOf(ev.data?.content);
        if (reply.trim()) {
          if (pendingTurns.length > 0) pendingTurns[pendingTurns.length - 1].assistant = reply;
          else pendingTurns.push({ user: '', assistant: reply });
        }
        continue;
      }

      if (ev.type !== 'user/message') continue;
      const src = ev.data?.source ?? {};
      if (src.kind !== 'user' && src.kind !== 'agent-message') continue;
      const text = textOf(ev.data?.content);
      if (!text.trim()) continue;
      out.instructions.push({
        msgId: String(src.rpcId ?? `seq-${seq}`),
        seq,
        at: typeof ev.at === 'string' ? ev.at : undefined,
        text,
        segments: splitSegments(text),
      });
      pendingTurns.push({ user: text, assistant: '' });
    }
  } catch {
    // 会话面不可读 → 证据为空 → 后续一律转人工，绝不因此放行
  }

  out.turns = pendingTurns.filter((t) => t.user || t.assistant).slice(-Math.max(1, Number(turns) || 5));
  // 任务边界：默认只看最后一条用户指令。
  // 不加这条，上一个任务的授权会漏到下一个任务里（真机上已经发生过一次）。
  if (window === 'latest' && out.instructions.length > 1) {
    out.instructions = out.instructions.slice(-1);
  }
  out.labels = labels.slice(-200);
  return out;
}

/** 拼出"可用于授权"的文本（只有 instruction 片段）。 */
export function instructionCorpus(evidence) {
  return (evidence?.instructions ?? []).map((m) => instructionOnly(m.text)).join('\n');
}

/**
 * 在原文里定位一个 needle，返回精确 span。
 * 这是"防篡改"而不是"理解语义"：只回答"这句话/这个词真的在原文里吗、在哪个位置"。
 */
export function locateSpan(evidence, needle) {
  const target = String(needle ?? '');
  if (!target) return undefined;
  for (const msg of evidence?.instructions ?? []) {
    // 只在 instruction 片段里找：粘贴内容里的路径不算授权
    for (const seg of msg.segments) {
      if (seg.kind !== 'instruction') continue;
      const i = seg.text.indexOf(target);
      if (i >= 0) {
        return {
          msgId: msg.msgId,
          start: seg.start + i,
          end: seg.start + i + target.length,
          quote: seg.text.slice(Math.max(0, i - 20), Math.min(seg.text.length, i + target.length + 20)).trim(),
        };
      }
    }
  }
  return undefined;
}

/**
 * 校验模型抽出的意图：每一条都必须能指回原文 span，指不回去的直接丢弃。
 * 这是"语义交给模型、保真交给机器"的落点。
 */
export function validateIntent(evidence, parsed) {
  const accepted = [];
  const rejected = [];
  for (const e of parsed?.entries ?? []) {
    const span = locateSpan(evidence, e.quote);
    if (span) accepted.push({ ...e, span, source: 'user' });
    else rejected.push(e);
  }
  return { accepted, rejected, residual: parsed?.residual === true };
}

/** 后出现的条目覆盖先出现的同 (op,target) 条目（显式 supersession）。 */
export function effectiveEntries(entries = []) {
  const latest = new Map();
  for (const e of entries) latest.set(`${e.op}|${e.target}`, e);
  const keep = new Set([...latest.values()]);
  return entries.filter((e) => keep.has(e));
}

/** 契约条目是否覆盖这次调用（op 相同、目标被条目包含）。 */
export function intentCovers(entries, { op, targets } = {}) {
  const list = (entries ?? []).filter((e) => e.op === op);
  if (list.length === 0) return undefined;
  const norm = (s) => String(s).replace(/\\/g, '/').toLowerCase();
  const covered = (t) => list.find((e) => {
    const p = norm(e.target);
    const v = norm(t);
    if (!p) return false;
    if (p === v) return true;
    if (/[*?]/.test(p)) {
      const re = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
      return re.test(v);
    }
    return v.startsWith(p.endsWith('/') ? p : `${p}/`);
  });
  const pathTargets = (targets ?? []).filter(Boolean);
  if (pathTargets.length === 0) return undefined;
  const hits = pathTargets.map(covered);
  if (hits.some((h) => !h)) return undefined;   // 有一个目标没被覆盖就不算覆盖
  return { entries: hits, span: hits[0]?.span };
}

/**
 * 渲染"契约视图"——注意它是**投影**，不是状态：随时可以丢弃重建。
 * 每条都必须能指回 span；指不回去的标成 inferred（只可收紧）。
 */
export function renderContract(evidence, entries = []) {
  const lines = [`# 任务契约（投影）`, '', `task_id: ${evidence?.taskId ?? 'unknown'}`, ''];

  lines.push('## 原文（不可变，授权唯一来源）');
  for (const msg of evidence?.instructions ?? []) {
    const only = instructionOnly(msg.text);
    if (!only) continue;
    lines.push(`- \`${msg.msgId}\`  ${only.replace(/\n/g, ' ⏎ ').slice(0, 300)}`);
  }
  lines.push('');

  lines.push('## 派生条目');
  if (entries.length === 0) lines.push('- （暂无）');
  for (const e of entries) {
    const span = locateSpan(evidence, e.quote);
    const tag = span ? `[source: ${e.source ?? 'user'}] [span: ${span.msgId} ${span.start}-${span.end}]` : '[source: inferred] [no-span → 只能收紧]';
    lines.push(`- ${e.op} ${e.target ?? ''}  ${tag}`);
  }
  lines.push('');

  lines.push('## 人的标签');
  if ((evidence?.labels ?? []).length === 0) lines.push('- （暂无）');
  for (const l of evidence?.labels ?? []) {
    lines.push(`- ${l.at ?? ''} ${l.verdict} ${l.op ?? ''} ${l.target ?? ''}`.trim());
  }
  return lines.join('\n');
}
