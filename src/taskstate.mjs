/**
 * 任务状态：把"这条任务到现在发生了什么"整理成一份判决方可以直接用的上下文。
 *
 * 为什么不是计数器：
 *   判断"这次调用是否越界"需要的不是数量，而是**弧线**——
 *   用户先后说过什么、已经确立了什么范围、哪些做过、哪些被拒、这次和它们什么关系。
 *
 * 三档信息，逐级展开：
 *   1. 摘要（始终给，几百 token）：目标 / 范围 / 最近判定 / 拒绝 / 进度 / 本次调用 / 环境
 *   2. 明细（按需）：最近 N 次判定的原样记录（谁批的、依据是什么）
 *   3. 原文（权威）：用户指令逐字、带 span
 *
 * 所有字段都是派生的，不落盘、不含模型写的总结——源头永远是原文与工具记录。
 */
import { instructionOnly } from './evidence.mjs';

const MAX_GOAL = 200;
const MAX_INSTRUCTION = 160;
const MAX_DECISIONS = 8;

/**
 * 从会话 + 判定记录拼任务状态。
 * @param {object} agent
 * @param {{ decisions?: object[], cwd?: string, call?: object, limits?: object }} opts
 */
export function buildTaskState(agent, { decisions = [], cwd = '', call, limits = {} } = {}) {
  const maxInst = limits.instructions ?? 6;
  const maxDec = limits.decisions ?? MAX_DECISIONS;

  const instructions = [];
  const executions = [];
  try {
    const session = agent?.session;
    const nodes = session?.surface?.nodes ?? [];
    const events = session?.snapshotEvents?.() ?? [];
    const calls = new Map();
    for (const seq of nodes) {
      const ev = events[seq];
      if (!ev) continue;
      if (ev.type === 'user/message') {
        const src = ev.data?.source ?? {};
        if (src.kind !== 'user' && src.kind !== 'agent-message') continue;
        const text = (ev.data?.content ?? [])
          .filter((b) => b && b.type === 'text')
          .map((b) => b.text).join('\n');
        const only = instructionOnly(text);
        if (only) instructions.push({ msgId: String(src.rpcId ?? `seq-${seq}`), text: only });
      } else if (ev.type === 'tool/call') {
        calls.set(ev.data?.callId, ev.data);
      } else if (ev.type === 'tool/result') {
        const c = calls.get(ev.data?.callId);
        if (!c) continue;
        executions.push({
          tool: String(c.name ?? ''),
          ok: ev.data?.isError !== true,
          args: c.arguments,
        });
      }
    }
  } catch { /* 会话不可读 → 只给判定记录 */ }

  const state = {
    goal: (instructions.at(-1)?.text ?? '').slice(0, MAX_GOAL),
    instructions: instructions.slice(-maxInst).map((i) => ({
      id: i.msgId, text: i.text.slice(0, MAX_INSTRUCTION),
    })),
    decisions: decisions.slice(-maxDec).map((d) => ({
      seq: d.seq, event: d.event, by: d.by, op: d.op, target: d.target,
      class: d.class, why: d.why ? String(d.why).slice(0, 80) : undefined,
    })),
    refused: decisions.filter((d) => d.event === 'deny').slice(-6).map((d) => ({
      op: d.op, target: d.target, by: d.by,
    })),
    progress: countProgress(decisions),
    executions: executions.slice(-6).map((e) => ({ tool: e.tool, ok: e.ok })),
    call: call ? { op: call.op, targets: call.targets ?? [] } : undefined,
    cwd,
  };
  return state;
}

function countProgress(decisions) {
  const out = {};
  for (const d of decisions) {
    if (d.event !== 'allow') continue;
    const key = d.op ?? 'other';
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/** 机器能算的关系先算，算不出的留 undefined 让审查 agent 判断。 */
export function relationOf(state, targets = []) {
  if (!state?.call) return undefined;
  const scope = [];
  for (const d of state.decisions) {
    if (d.event !== 'allow' || !d.target) continue;
    scope.push(String(d.target).toLowerCase());
  }
  const norm = (s) => String(s).toLowerCase().replace(/\\/g, '/');
  const inside = targets.length > 0 && targets.every((t) => {
    const v = norm(t);
    return scope.some((p) => v === p || v.startsWith(p.endsWith('/') ? p : `${p}/`));
  });
  const refusedHit = (state.refused ?? []).some((r) => r.target && targets.some((t) => norm(t) === norm(r.target)));
  return { covered_by_past_approval: inside, contradicts_refusal: refusedHit };
}

/** 渲染成给模型看的紧凑文本（几百 token）。 */
export function renderTaskState(state, relation) {
  if (!state) return '(no task state)';
  const lines = [];
  lines.push('TASK STATE (derived from the session; user words are the only authorization)');
  lines.push(`goal: ${state.goal || '(none)'}`);
  if (state.instructions.length > 0) {
    lines.push('instructions (oldest → newest, verbatim):');
    for (const i of state.instructions) lines.push(`  [${i.id}] ${i.text}`);
  }
  const scope = state.decisions.filter((d) => d.event === 'allow' && d.target).slice(-6);
  if (scope.length > 0) {
    lines.push('already allowed in this task:');
    for (const d of scope) lines.push(`  ${d.op ?? '?'} ${d.target}${d.by ? `  (${d.by})` : ''}`);
  }
  if (state.refused.length > 0) {
    lines.push('refused in this task:');
    for (const r of state.refused) lines.push(`  ${r.op ?? '?'} ${r.target}${r.by ? `  (${r.by})` : ''}`);
  }
  if (state.decisions.length > 0) {
    lines.push('recent decisions:');
    for (const d of state.decisions.slice(-5)) {
      lines.push(`  #${d.seq ?? '?'} ${d.event}${d.op ? ` ${d.op}` : ''}${d.target ? ` ${d.target}` : ''}${d.by ? ` by ${d.by}` : ''}`);
    }
  }
  const p = Object.entries(state.progress ?? {});
  if (p.length > 0) lines.push(`progress: ${p.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  if (state.executions.length > 0) {
    lines.push(`executions: ${state.executions.map((e) => `${e.tool}${e.ok ? '' : '(failed)'}`).join(', ')}`);
  }
  if (relation) {
    lines.push(`relation to this task: covered_by_past_approval=${relation.covered_by_past_approval}, contradicts_refusal=${relation.contradicts_refusal}`);
  }
  return lines.join('\n');
}
