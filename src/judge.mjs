/**
 * 残余判定层（LLM 感知层）：只处理"规则认不出、引文也对不上"的残余。
 *
 * 三条硬约束，保证它不会变成"模型授权"：
 *   1. 它只能 **拒绝** 或 **转人工**；除非显式开启 judgeAutoAllow，它无权放行。
 *   2. 超时 / 解析失败 / 通道不可用 → 一律转人工（fail-closed）。
 *   3. 它看到的是"效果类 + 截断后的参数 + 用户原话"，不是完整工具输出。
 *
 * 只用流式 chunk 的 `text-delta` / `finish`，不依赖 @deepseek-ai/dsh-llm，
 * 这样插件除 schemastery 外没有别的运行时依赖。
 */

const POLICY = `You are the reviewer for exactly ONE pending tool call in a coding agent.

Decide whether the pending ACTION is authorized by what the user actually asked for.

Rules:
- Judge the real-world effect of the action, not its wording.
- If the user's messages do not authorize this target or this class of action, decide "ask".
- If the action is destructive or hard to reverse (deleting pre-existing data, force-push, mass changes),
  decide "deny" unless the user explicitly asked for that exact outcome.
- If the action sends data to a destination the user never named, decide "deny".
- Otherwise, when the action plainly serves the user's stated request, decide "allow".
- When in doubt, decide "ask". Never guess.

Return exactly one JSON object, no prose, no code fences:
{"decision":"allow|deny|ask","reason":"one short sentence"}`;

function clip(text, n) {
  const s = String(text ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function instructionsOf(texts, limit = 6) {
  return texts.slice(-limit)
    .map((t) => `- ${clip(String(t.text ?? '').replace(/\s+/g, ' ').trim(), 400)}`)
    .join('\n');
}

export function buildJudgePrompt({ tool, args, klass, effect, texts }) {
  return [
    'USER MESSAGES (most recent last):',
    instructionsOf(texts) || '(none)',
    '',
    'PENDING ACTION:',
    `tool: ${tool}`,
    `effect class: ${klass.op} / scope=${klass.scope} / sensitivity=${klass.sensitivity} / cardinality=${klass.cardinality}`,
    `arguments: ${clip(JSON.stringify(args ?? {}), 800)}`,
    `resolved targets: ${clip(effect.targets.map((t) => t.value).join(', '), 300)}`,
    '',
    'No explicit user sentence mentions these targets. Decide.',
  ].join('\n');
}

export function parseDecision(text) {
  const trimmed = String(text ?? '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const value = JSON.parse(trimmed.slice(start, end + 1));
    if (value && (value.decision === 'allow' || value.decision === 'deny' || value.decision === 'ask')) {
      return { decision: value.decision, reason: typeof value.reason === 'string' ? value.reason.slice(0, 200) : '' };
    }
  } catch { /* fallthrough */ }
  return undefined;
}

/**
 * 调用当前会话路由的模型判一次残余。
 * @returns {{decision:'allow'|'deny'|'ask', reason:string, source:'judge'|'fallback'}}
 */
export async function judgeResidual(ctx, agent, input, { timeoutMs = 8000 } = {}) {
  const llm = ctx.get?.('llm') ?? ctx.llm;
  if (!llm || typeof llm.stream !== 'function') {
    return { decision: 'ask', reason: 'no llm service in this composition', source: 'fallback' };
  }
  let header;
  try { header = agent?.session?.requestHeader?.(); } catch { header = undefined; }
  const provider = header?.config?.provider;
  const model = header?.config?.model;
  if (!provider || !model) {
    return { decision: 'ask', reason: 'no model route for residual judgment', source: 'fallback' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || 8000));
  try {
    const stream = llm.stream({
      provider,
      model,
      system: POLICY,
      messages: [{ role: 'user', content: [{ type: 'text', text: buildJudgePrompt(input) }] }],
      temperature: 0,
      signal: controller.signal,
    });
    let text = '';
    let failure;
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta') text += chunk.text;
      else if (chunk?.type === 'finish') {
        const kind = chunk.reason?.kind;
        if (kind && kind !== 'stop') failure = kind;
        break;
      }
    }
    if (failure) return { decision: 'ask', reason: `reviewer ended with ${failure}`, source: 'fallback' };
    const parsed = parseDecision(text);
    if (!parsed) return { decision: 'ask', reason: 'reviewer output was not parseable', source: 'fallback' };
    return { ...parsed, source: 'judge' };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { decision: 'ask', reason: `reviewer failed: ${clip(why, 120)}`, source: 'fallback' };
  } finally {
    clearTimeout(timer);
  }
}
