/**
 * 效果编译器：把"看不出来的调用"交给模型翻译成**结构化的字面效果**。
 *
 * 这不是让模型"决定能不能放行"，而是让它干它最擅长的事：泛化地理解一段没见过的语法。
 * 它产出的是 `ops: [{op, targets}]`，随后由**确定性策略**决定放行/询问/拒绝：
 *
 *   - 编译出变更类（delete/write/send）→ 直接拒绝（比"问人"更严，单调）
 *   - 编译出纯读、且目标全在项目内   → 允许（这是它真正省掉询问的地方，可配置关闭）
 *   - 编译不出来 / 含变量循环等无法解析的构造 → 询问（fail-closed）
 *
 * 关键：模型只能**改写风险标签**，不能绕开"目标必须字面、必须落在范围内"的检查。
 */
const PREFIX = 'capgate: ';

export function buildCompilePrompt({ tool, args }) {
  return [
    'You are a shell-effect compiler. Do NOT judge safety. Translate the tool call into literal effects.',
    'Return ONLY JSON: {"ops":[{"op":"read|write|delete|execute|send","targets":["<literal path or host>"]}],"residual":false}',
    'Rules:',
    '- targets must be literal absolute or relative paths (or host names for network). Never invent values for variables.',
    '- If the call uses variables, loops, pipes with runtime-discovered paths, downloads, or code you cannot resolve, set residual=true and give the targets you CAN prove.',
    '- op=send only when data leaves the machine.',
    '',
    `tool: ${tool}`,
    `arguments: ${JSON.stringify(args).slice(0, 1500)}`,
  ].join('\n');
}

export function parseCompiled(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  let obj;
  try { obj = JSON.parse(raw.slice(start, end + 1)); } catch { return undefined; }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.ops)) return undefined;

  const ops = [];
  for (const item of obj.ops.slice(0, 8)) {
    const op = String(item?.op ?? '').toLowerCase();
    if (!['read', 'write', 'delete', 'execute', 'send'].includes(op)) continue;
    const targets = Array.isArray(item?.targets)
      ? item.targets.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()).slice(0, 32)
      : [];
    ops.push({ op, targets });
  }
  if (ops.length === 0) return undefined;
  return { ops, residual: obj.residual === true };
}

/** 调当前会话模型编译一次；任何异常都返回 undefined（调用方按"编译失败"处理）。 */
export async function compileEffects(ctx, agent, call, { timeoutMs = 8000 } = {}) {
  const llm = (() => { try { return ctx.get?.('llm'); } catch { return undefined; } })();
  if (!llm || typeof llm.stream !== 'function') return undefined;

  let header;
  try { header = agent?.session?.requestHeader?.(); } catch { return undefined; }
  const provider = header?.config?.provider;
  const model = header?.config?.model;
  if (!provider || !model) return undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || 8000));
  let text = '';
  try {
    const stream = llm.stream({
      provider,
      model,
      system: 'You compile shell commands into literal effects. Output JSON only.',
      messages: [{ role: 'user', content: [{ type: 'text', text: buildCompilePrompt(call) }] }],
      temperature: 0,
      signal: controller.signal,
    });
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
      if (chunk?.type === 'finish') break;
    }
  } catch (err) {
    console.warn('[capgate] compile failed:', err && err.message ? err.message : err);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
  return parseCompiled(text);
}

export { PREFIX };
