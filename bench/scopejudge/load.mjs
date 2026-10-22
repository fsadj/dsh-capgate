/**
 * ScopeJudge 数据加载：把官方的 ATIF 轨迹读成"逐调用评测点"。
 *
 * 数据：100 条轨迹 / 4,897 个工具调用 / 377 个越界（严格多数 5 专家）。
 * 每条 trajectory 的 extra.scopejudge 里带 user_intent 与逐调用 golden_label。
 *
 * 我们只做**读取与渲染**，不复制它的代码（MIT，见 THIRD_PARTY_NOTICES）。
 */
import { readFileSync } from 'node:fs';

/** 读整份 jsonl */
export function loadTrajectories(file) {
  const text = readFileSync(file, 'utf8');
  return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** ATIF：step.tool_calls[] = { tool_call_id, function_name, arguments } */
function toolCallsOf(step) {
  const list = Array.isArray(step?.tool_calls) ? step.tool_calls : [];
  return list.map((tc) => {
    let args = tc?.arguments ?? {};
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { /* 保留原样 */ }
    }
    return { id: String(tc?.tool_call_id ?? ''), name: tc?.function_name ?? tc?.name, args };
  }).filter((c) => c.id);
}

function summarizeObservation(step, maxChars = 600) {
  const obs = step?.observation ?? step?.tool_result;
  if (!obs) return '';
  const text = typeof obs === 'string' ? obs : JSON.stringify(obs);
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}

/**
 * 把一条轨迹展开成评测点。
 * @returns {{trajectoryId:string, family:string, intent:string, points:object[]}}
 */
export function expandTrajectory(doc) {
  const sj = doc?.extra?.scopejudge ?? {};
  const labels = new Map();
  for (const l of sj.labels ?? []) labels.set(String(l.tool_call_id), l);

  const points = [];
  const priorCalls = [];
  const steps = doc?.steps ?? [];
  for (const step of steps) {
    const calls = toolCallsOf(step);
    if (calls.length === 0) continue;
    const obs = summarizeObservation(step);
    for (const call of calls) {
      const label = labels.get(String(call.id));
      points.push({
        trajectoryId: sj.trajectory_id,
        family: sj.task_family,
        intent: sj.user_intent ?? '',
        callId: String(call.id),
        tool: call.name,
        args: call.args,
        priorCalls: priorCalls.slice(-8).map((c) => ({ tool: c.name, args: c.args })),
        observation: obs,
        golden: label?.golden_label,
        votes: label?.votes,
        labeled: !!label,
      });
      priorCalls.push(call);
    }
  }
  return { trajectoryId: sj.trajectory_id, family: sj.task_family, intent: sj.user_intent ?? '', points };
}

/** 全量展开 + 统计（用于校验读取是否正确） */
export function loadAll(file) {
  const docs = loadTrajectories(file);
  const trajs = docs.map(expandTrajectory);
  const points = trajs.flatMap((t) => t.points);
  const labeled = points.filter((p) => p.labeled);
  return {
    trajectories: trajs.length,
    calls: points.length,
    labeled: labeled.length,
    positives: labeled.filter((p) => p.golden === 'out_of_scope').length,
    trajs,
    points,
  };
}
