/**
 * 覆盖判断：这次调用的目标，是不是用户那句话授权的那个东西。
 *
 * 为什么不建名单/不做归一化：
 *   路径、表名、主机名、环境变量各有一套写法；"用户表" vs `users`、
 *   "下载目录" vs `~/Downloads` 这种指称差异永远列不完。
 *   这本来就是一个**指代消解**问题，交给模型判断，机器只负责：
 *     - 条目必须能指回原文 span（不许凭空授权）；
 *     - op 必须一致（读不能被当成删）；
 *     - 模型说"不确定"就按未覆盖处理（fail-closed）。
 *
 * 模型在这里做的是"这句话是不是指这个东西"，不是"能不能放行"——
 * 放行仍然要过锁和策略。
 */
import { callModel } from './intent.mjs';

export function buildCoveragePrompt({ op, targets, entries, instructions, locks = [] }) {
  const list = entries.map((e, i) => `${i}. op=${e.op} target=${e.target || '(unspecified)'} quote=${JSON.stringify(e.quote)}`);
  const lockBlock = locks.length
    ? [
      '',
      'LOCKED ASPECTS (these block the call unless you clear them):',
      locks.join(', '),
      'To clear one, cite the exact user quote that makes the intent unambiguous.',
      'Do not clear a lock when the user did not address it — a lock you cannot justify stays.',
    ]
    : [];
  return [
    'You decide whether a concrete tool call is covered by what the user asked for.',
    'Return ONLY JSON: {"covered":[{"target":"<one of the call targets>","entry":<entry index>,"why":"<short>"}],"uncovered":["<target>"],"clear":[{"lock":"<lock>","quote":"<exact user quote>","why":"<short>"}]}',
    '',
    'Rules:',
    '- An entry covers a target only if, reading the quoted user words, a reasonable person would say "yes, that is what I asked for".',
    '- The operation must match: a quote about reading does not cover deleting.',
    '- Different naming still counts when it refers to the same thing: "用户表" covers table `users`, "下载目录" covers ~/Downloads.',
    '- If you are not sure, put the target in uncovered. Never guess in the user\'s favour.',
    '- Every target must appear in exactly one of the two lists.',
    '- If the user stated the scope explicitly (all/every/每个/全部 + the thing), that is enough to clear the "batch" lock.',
    '- If the user named both the destination and the data, that is enough to clear "egress".',
    ...lockBlock,
    '',
    'USER INSTRUCTIONS (authorization source):',
    instructions || '(none)',
    '',
    'AUTHORIZED ENTRIES (each derived from a verbatim quote):',
    list.length ? list.join('\n') : '(none)',
    '',
    `CALL: op=${op} targets=${targets.join(', ') || '(none)'}`,
    'NOTE: a target starting with "ref:" is a git ref (branch/tag), not a file path.',
    '      Ownership must be settled by evidence in the facts, not assumed from the name alone.',
  ].join('\n');
}

export function parseCoverage(text, targets) {
  const raw = String(text ?? '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  let obj;
  try { obj = JSON.parse(raw.slice(start, end + 1)); } catch { return undefined; }
  if (!obj || typeof obj !== 'object') return undefined;

  const want = (targets ?? []).filter(Boolean);
  const coveredMap = new Map();
  for (const c of Array.isArray(obj.covered) ? obj.covered : []) {
    const t = typeof c?.target === 'string' ? c.target : '';
    if (!want.includes(t)) continue;
    const idx = Number.isInteger(c?.entry) ? c.entry : -1;
    if (idx < 0) continue;
    coveredMap.set(t, { target: t, entry: idx, why: typeof c.why === 'string' ? c.why.slice(0, 60) : '' });
  }
  const all = want.length > 0 && want.every((t) => coveredMap.has(t));

  const clear = [];
  for (const c of Array.isArray(obj.clear) ? obj.clear : []) {
    const lock = typeof c?.lock === 'string' ? c.lock.trim() : '';
    if (!lock) continue;
    clear.push({
      lock,
      quote: typeof c.quote === 'string' ? c.quote.trim().slice(0, 200) : '',
      why: typeof c.why === 'string' ? c.why.slice(0, 60) : '',
    });
  }

  return {
    covered: [...coveredMap.values()],
    uncovered: want.filter((t) => !coveredMap.has(t)),
    allCovered: all,
    clear,
  };
}

/**
 * 调模型判断覆盖关系。任何异常/不合规输出 → undefined（调用方按"未覆盖"处理）。
 * @param {{op:string, targets:string[], entries:{op:string,target:string,quote:string}[], instructions:string, timeoutMs?:number}} input
 */
export async function judgeCoverage(ctx, agent, input) {
  if (!input || (input.targets ?? []).length === 0) return undefined;
  if ((input.entries ?? []).length === 0) return undefined;
  const text = await callModel(ctx, agent, {
    system: 'You decide whether a tool call is covered by the user\'s request. Output JSON only.',
    prompt: buildCoveragePrompt(input),
    timeoutMs: Math.max(3000, Number(input.timeoutMs) || 8000),
  });
  return text === undefined ? undefined : parseCoverage(text, input.targets);
}