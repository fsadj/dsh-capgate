/**
 * 引文核对：把"agent 说它被授权了"变成"agent 指出用户原话的哪一段，并且机器核对得上"。
 *
 * 这是整套架构的承重点：
 *   能力只能从 instruction span 里核出来，核不出来就不产生（不是问，是死）。
 * 已知攻击面（必须写在文档里）：agent 可能断章取义——"清理旧分支"被当作"删除所有分支"
 * 的引文。缓解靠 citationSupports 的动词匹配 + 目标必须逐字出现，但仍不是形式化证明。
 */

const VERB_BY_OP = {
  read: /(看|读|查|检查|查看|分析|找|搜索|read|view|check|inspect|show|grep|find|look)/i,
  write: /(写|改|修改|新建|添加|创建|更新|生成|重构|修复|write|edit|update|create|add|fix|refactor|generate)/i,
  delete: /(删|删除|清理|移除|清空|remove|delete|clean|drop|purge)/i,
  send: /(发|发送|上传|传|提交|同步|推送|send|upload|post|push|submit|share)/i,
  execute: /(跑|运行|执行|构建|测试|编译|run|build|test|exec|compile)/i,
  other: /./,
};

/** 收集会话里可见的用户/指令文本（人类指令优先，子 agent 取父指令）。 */
export function collectInstructionTexts(agent) {
  const human = [];
  const other = [];
  try {
    const session = agent?.session;
    if (!session) return human;
    const nodes = session.surface?.nodes ?? [];
    const events = session.snapshotEvents();
    for (const seq of nodes) {
      const ev = events[seq];
      if (!ev || ev.type !== 'user/message') continue;
      const src = ev.data?.source ?? {};
      const content = ev.data?.content ?? [];
      const text = content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n');
      if (!text.trim()) continue;
      const entry = { text, seq, source: src.kind };
      if (src.kind === 'user' && typeof src.rpcId === 'string') human.push(entry);
      else if (src.kind === 'user' || src.kind === 'agent-message') other.push(entry);
    }
  } catch {
    // 会话面不可读时退化为"无引文"（→ 全部转人工），绝不因此放行
  }
  return human.length > 0 ? human : other;
}

function isBoundaryChar(ch) {
  // '/' 与 ':' 算边界（主机名/URL 里出现目标就算提到过）；字母数字、下划线、点、连字符不算
  return ch === undefined || !/[A-Za-z0-9_.\-]/.test(ch);
}

/** 在一条文本里找 needle 的一次"成词"出现。 */
function findToken(text, needle) {
  if (!needle) return undefined;
  let from = 0;
  for (;;) {
    const i = text.indexOf(needle, from);
    if (i < 0) return undefined;
    const before = text[i - 1];
    const after = text[i + needle.length];
    if (isBoundaryChar(before) && isBoundaryChar(after)) return i;
    from = i + 1;
  }
}

function sentenceAround(text, index, length) {
  const stops = ['。', '！', '？', '\n', ';', '；'];
  let start = 0;
  for (let i = index - 1; i >= 0; i -= 1) if (stops.includes(text[i])) { start = i + 1; break; }
  let end = text.length;
  for (let i = index + length; i < text.length; i += 1) {
    if (stops.includes(text[i])) { end = i; break; }
  }
  return text.slice(start, end).trim().slice(0, 200);
}

/**
 * 为一个目标（路径或主机）找引文。
 * @returns {{text, sentence, start, end, seq, source}|undefined}
 */
export function findCitation(texts, target) {
  const candidates = [];
  const norm = String(target).replace(/\\/g, '/');
  candidates.push(norm);
  const segs = norm.split('/').filter(Boolean);
  if (segs.length >= 2) candidates.push(segs.slice(-2).join('/'));
  if (segs.length >= 1) candidates.push(segs[segs.length - 1]);
  // 兼容反斜杠写法
  candidates.push(norm.replace(/\//g, '\\'));

  for (const c of candidates) {
    if (!c || c.length < 2) continue;
    for (const t of texts) {
      const i = findToken(t.text, c);
      if (i !== undefined) {
        return {
          text: c,
          sentence: sentenceAround(t.text, i, c.length),
          start: i,
          end: i + c.length,
          seq: t.seq,
          source: t.source,
        };
      }
    }
  }
  return undefined;
}

/** 这句话是不是"疑问语气"（疑问本身不构成授权，除非同时带明确指令词）。 */
export function isInterrogative(hay) {
  const text = String(hay ?? '');
  const askWord = /(要不要|是不是该|是否|能不能|可不可以|行不行|should\s+(i|we)|can\s+(i|we)|would\s+you\s+like)/i.test(text);
  const questionMark = /[?？]\s*$/.test(text.trim());
  const imperative = /(请|帮我|麻烦|直接|立刻|马上|务必|please|go ahead|just)\b/i.test(text);
  return (askWord || questionMark) && !imperative;
}

/** 引文是否支持这个效果类（动词匹配；删/外发额外要求非疑问语气）。 */
export function citationSupports(citation, klass) {
  if (!citation) return false;
  const hay = citation.sentence || '';
  const verbs = VERB_BY_OP[klass.op] ?? VERB_BY_OP.other;
  if (!verbs.test(hay)) return false;

  // 疑问句不是授权："要不要删掉 src/app.js" 不构成删除授权
  if (isInterrogative(hay)) return false;

  const imperative = /(请|帮我|麻烦|直接|立刻|马上|务必|please|go ahead|just)\b/i.test(hay);
  if ((klass.op === 'delete' || klass.op === 'send') && /[?？]\s*$/.test(hay) && !imperative) return false;

  if (klass.scope.startsWith('outside') && klass.op !== 'send') {
    // 越界路径：要求引文里出现至少两级路径，避免只提了文件名就越界
    return citation.text.split('/').filter(Boolean).length >= 2;
  }
  return true;
}

/** 粗抽取任务实体（供 Minimize 投影使用）：路径、带扩展名的文件名、引号里的词。 */
export function extractEntities(texts) {
  const out = new Set();
  for (const t of texts) {
    for (const m of t.text.matchAll(/[A-Za-z0-9_\-/.]{3,}\.(?:js|mjs|ts|tsx|py|json|md|yaml|yml|txt|csv|sql|go|rs|java|sh)\b/g)) {
      out.add(m[0]);
    }
    for (const m of t.text.matchAll(/["'`]([^"'`\n]{2,40})["'`]/g)) out.add(m[1]);
    for (const m of t.text.matchAll(/[A-Za-z]:[\\/][^\s"'，。]+/g)) out.add(m[0].replace(/\\/g, '/'));
  }
  return [...out].slice(0, 50);
}
