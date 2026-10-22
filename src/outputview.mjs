/**
 * 结果侧最小化：不只是"能不能做"，还有"agent 能看到多少"。
 *
 * 之前的实现只在动作侧做最小化（放行/拒绝/替代），结果原样返回——
 * 读 3 万行就返回 3 万行，扫到 PII 只是"发现"而不是"遮住"。
 *
 * 这里补上另一半：在 tools/post-execute 里对**返回内容**做投影与脱敏，
 * 并把"被遮掉了什么"写进审计，供人事后复核。
 *
 * 设计原则：
 *   - 只裁**文本**，不改结构化的 value；
 *   - 宁可少给，不可多给：默认"给够判断的最小片段"；
 *   - 任何裁剪都要留痕（省略了多少行/多少字节、脱敏了多少处）。
 */

const PII_RULES = [
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
  [/\b\d{17}[\dXx]\b/g, '[id]'],
  [/\b1[3-9]\d{9}\b/g, '[phone]'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[key]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[aws-key]'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '[private-key]'],
  [/\bBearer\s+[A-Za-z0-9._-]{20,}/g, 'Bearer [token]'],
];

/** 该给这次调用的返回多少内容：多条规定取**最严**的那条。 */
export function chooseView({ op, scope, cardinality } = {}) {
  let headLines = 0;
  let redact = false;
  const why = [];
  if (op === 'read') { headLines = 120; redact = true; why.push('读类只给前 120 行并脱敏'); }
  if (cardinality === 'many') {
    headLines = headLines ? Math.min(headLines, 60) : 60;
    why.push('批量只给前 60 行');
  }
  if (op === 'read' && typeof scope === 'string' && scope.startsWith('outside:')) {
    headLines = headLines ? Math.min(headLines, 40) : 40;
    why.push('项目外只给前 40 行');
  }
  if (!headLines && !redact) return undefined;
  return { headLines, redact, why: why.join('；') };
}

/** 对一段文本做脱敏。 */
export function redactText(text) {
  let out = String(text);
  let hits = 0;
  for (const [re, repl] of PII_RULES) {
    out = out.replace(re, () => { hits += 1; return repl; });
  }
  return { text: out, hits };
}

/**
 * 把 content blocks 按视图裁剪/脱敏。
 * @returns {{content:any[], note:string}}
 */
export function applyView(content, view) {
  if (!Array.isArray(content) || !view) return { content, note: '' };
  const notes = [];
  let out = content.map((b) => ({ ...b }));

  if (view.headLines > 0) {
    let kept = 0;
    let dropped = 0;
    out = out.map((b) => {
      if (b?.type !== 'text' || typeof b.text !== 'string') return b;
      const lines = b.text.split('\n');
      if (kept >= view.headLines) { dropped += lines.length; return { ...b, text: '' }; }
      const take = Math.min(lines.length, view.headLines - kept);
      kept += take;
      dropped += lines.length - take;
      return take === lines.length ? b : { ...b, text: lines.slice(0, take).join('\n') };
    }).filter((b) => b?.type !== 'text' || b.text !== '');
    if (dropped > 0) notes.push(`${view.why}（省略 ${dropped} 行）`);
  }
  if (view.redact) {
    let hits = 0;
    out = out.map((b) => {
      if (b?.type !== 'text' || typeof b.text !== 'string') return b;
      const r = redactText(b.text);
      hits += r.hits;
      return r.hits ? { ...b, text: r.text } : b;
    });
    if (hits > 0) notes.push(`已脱敏 ${hits} 处（邮箱/证件/手机/密钥）`);
  }
  return { content: out, note: notes.join('；') };
}
