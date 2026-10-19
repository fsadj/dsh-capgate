/**
 * 用户可配置规则（对齐 @quill507/dsh-auto-approval-llm 的 allow/deny/humanOnly 与
 * dsh-approval-gate 的 allowRules/denyRules/denyKeywords）。
 *
 * 约定：**deny 优先于 allow**，且规则只在"类判定"之前跑。
 * 规则是给人用的逃生口，不是授权来源——真正的授权仍然只能来自用户原话的引文。
 */

const GLOB = /[*?]/;

function toRegex(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function pathMatches(target, prefix) {
  const t = String(target).toLowerCase().replace(/\\/g, '/');
  const p = String(prefix).toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
  return t === p || t.startsWith(p + '/');
}

/** 把配置里的字符串规则编译成可执行形式（非法正则会被丢弃并记录）。 */
export function compileRules(raw = {}) {
  const compiled = {
    allowTools: [], denyTools: [], denyKeywords: [], allowPaths: [], denyPaths: [], errors: [],
  };
  for (const name of raw.allowTools ?? []) compiled.allowTools.push(GLOB.test(name) ? toRegex(name) : name.toLowerCase());
  for (const name of raw.denyTools ?? []) compiled.denyTools.push(GLOB.test(name) ? toRegex(name) : name.toLowerCase());
  for (const pattern of raw.denyKeywords ?? []) {
    try { compiled.denyKeywords.push(new RegExp(pattern, 'i')); }
    catch (err) { compiled.errors.push(`denyKeywords /${pattern}/ ${String(err).slice(0, 60)}`); }
  }
  for (const p of raw.allowPaths ?? []) compiled.allowPaths.push(String(p));
  for (const p of raw.denyPaths ?? []) compiled.denyPaths.push(String(p));
  return compiled;
}

function toolHits(list, tool) {
  const name = String(tool).toLowerCase();
  return list.some((entry) => (typeof entry === 'string' ? entry === name : entry.test(name)));
}

/** 规则序列化文本（供 denyKeywords 匹配）。 */
export function ruleHaystack(effect) {
  const targets = effect.targets.map((t) => t.value).join(' ');
  return `${effect.raw ?? ''} ${targets}`.trim();
}

/**
 * 跑一遍用户规则。
 * @returns {{kind:'deny'|'allow', rule:string}|undefined}
 */
export function evaluateRules(compiled, { tool, effect }) {
  if (!compiled) return undefined;
  const hay = ruleHaystack(effect);
  const paths = effect.targets.filter((t) => t.kind === 'path').map((t) => t.value);

  // 1) deny 侧
  if (toolHits(compiled.denyTools, tool)) return { kind: 'deny', rule: `denyTools:${tool}` };
  for (const re of compiled.denyKeywords) {
    if (re.test(hay)) return { kind: 'deny', rule: `denyKeywords:/${re.source}/` };
  }
  for (const prefix of compiled.denyPaths) {
    if (paths.some((p) => pathMatches(p, prefix))) return { kind: 'deny', rule: `denyPaths:${prefix}` };
  }

  // 2) allow 侧（工具整体放行，或全部目标落在 allowPaths 内）
  if (toolHits(compiled.allowTools, tool)) return { kind: 'allow', rule: `allowTools:${tool}` };
  if (compiled.allowPaths.length > 0 && paths.length > 0 && paths.every((p) => compiled.allowPaths.some((prefix) => pathMatches(p, prefix)))) {
    return { kind: 'allow', rule: `allowPaths:${paths.length}` };
  }
  return undefined;
}
