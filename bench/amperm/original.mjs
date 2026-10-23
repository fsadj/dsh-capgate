/**
 * 原版 AmPermBench 数据加载：直接用它的 128 条 prompt + 机械 oracle + 初始状态。
 *
 * 之前我们是"同构生成"的 prompt，措辞不同、实体不同，比出来的数不可比。
 * 这里把原版数据读进来：
 *
 *   tasks/<family>/harness/prompts/*.json      → 32 条/族，共 128 条
 *   tasks/<family>/harness/meta/*_oracle.json  → 每条一份 authorized_*_set / must_preserve / protected_*
 *   tasks/<family>/harness/meta/*.initial.json → 环境初始状态
 *   tasks/<family>/harness/meta/user_context.json → {"user": "alex"}
 *
 * 注意：oracle 的集合直接来自文件，**不再由我们推断**，所以评分和原版是同一套真值。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const REPO = process.env.AMPERM_REPO
  ?? 'C:/Users/brazion/Documents/deepseek-harness/default-workspace/_refs/cc-auto-mode-measurement';

const FAMILIES = {
  'cancel-jobs': {
    prompt: 'cancel_jobs.json',
    oracle: 'jobs_oracle.json',
    initial: 'jobs.initial.json',
    authKey: 'authorized_cancel_set',
    preserveKey: 'must_preserve',
    protectedKey: 'protected_jobs',
    scopeKey: 'authorized_queue',
  },
  'clean-up-artifacts': {
    prompt: 'cleanup_artifacts.json',
    oracle: 'artifacts_oracle.json',
    initial: 'objects.initial.json',
    authKey: 'authorized_delete_set',
    preserveKey: 'must_preserve',
    protectedKey: 'protected_objects',
    scopeKey: 'authorized_ns',
  },
  'clean-up-branches': {
    prompt: 'clean_branches.json',
    oracle: 'prompt_oracle.json',
    initial: 'branches.json',
    authKey: 'authorized_delete_set',
    preserveKey: 'must_preserve',
    protectedKey: 'protected_refs',
    scopeKey: 'authorized_scope',
  },
  'restart-services': {
    prompt: 'restart_services.json',
    oracle: 'services_oracle.json',
    initial: 'services.initial.json',
    authKey: 'authorized_restart_set',
    preserveKey: 'must_preserve',
    protectedKey: 'protected_services',
    scopeKey: 'authorized_env',
  },
};

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** 把原版初始状态归一成 { id, owner, lane, protected, stale, ... } */
function normalizeEntities(family, initial) {
  if (family === 'cancel-jobs') {
    return (initial.jobs ?? []).map((j) => ({
      id: j.job_id,
      owner: j.owner,
      lane: j.queue,
      staled: j.stale,
      protected: j.protected,
      impact: j.impact_level,
      raw: j,
    }));
  }
  if (family === 'clean-up-artifacts') {
    return (initial.objects ?? []).map((o) => ({
      id: o.object_id,
      owner: o.owner,
      lane: o.ns,
      staled: o.stale,
      protected: o.protected,
      impact: o.impact_level,
      key: o.key,
      raw: o,
    }));
  }
  if (family === 'restart-services') {
    return (initial.services ?? []).map((s) => ({
      id: s.service_id,
      owner: s.owner,
      lane: s.env,
      staled: s.health === 'unhealthy',
      protected: s.protected,
      impact: s.impact_level,
      name: s.name,
      component: s.component,
      raw: s,
    }));
  }
  if (family === 'clean-up-branches') {
    return Object.entries(initial.branches ?? {}).map(([name, b]) => ({
      id: name,
      owner: b.owner,
      lane: b.radius ?? 'local_low',
      staled: true,
      protected: b.protected,
      raw: b,
    }));
  }
  return [];
}

const cache = new Map();

/** 加载一族（或全部） */
export function loadFamily(family) {
  if (cache.has(family)) return cache.get(family);
  const meta = FAMILIES[family];
  if (!meta) throw new Error('unknown family: ' + family);
  const base = join(REPO, 'tasks', family);
  const promptsPath = join(base, 'harness', 'prompts', meta.prompt);
  const oraclePath = join(base, 'harness', 'meta', meta.oracle);
  const initialPath = join(base, 'harness', 'meta', meta.initial);
  for (const p of [promptsPath, oraclePath, initialPath]) {
    if (!existsSync(p)) throw new Error('missing AmPermBench file: ' + p);
  }
  const prompts = readJson(promptsPath);
  const oracle = readJson(oraclePath);
  const initial = readJson(initialPath);
  const userFile = join(base, 'harness', 'meta', 'user_context.json');
  const user = existsSync(userFile) ? (readJson(userFile).user ?? 'user') : 'user';

  const out = {
    family,
    user,
    prompts: prompts.map((p) => ({
      id: p.prompt_id,
      text: p.prompt,
      s: p.s_axis,
      b: p.b_axis,
      r: p.r_axis,
      family,
    })),
    oracle: new Map(Object.entries(oracle).map(([id, o]) => [id, {
      authorized: new Set(o[meta.authKey] ?? []),
      preserve: new Set(o[meta.preserveKey] ?? []),
      protected: new Set(o[meta.protectedKey] ?? []),
      scope: o[meta.scopeKey],
    }])),
    entities: normalizeEntities(family, initial),
    initial,
  };
  cache.set(family, out);
  return out;
}

export const FAMILY_IDS = Object.keys(FAMILIES);

/** 全部 128 条 */
export function loadAll() {
  const fams = FAMILY_IDS.map(loadFamily);
  return {
    families: fams,
    prompts: fams.flatMap((f) => f.prompts),
    oracleFor: (promptId) => {
      for (const f of fams) {
        const o = f.oracle.get(promptId);
        if (o) return o;
      }
      return undefined;
    },
    familyOf: (promptId) => fams.find((f) => f.oracle.has(promptId)),
  };
}
