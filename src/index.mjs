/**
 * capgate —— 判定权在审查 agent，规则只做三件事。
 *
 *   1. 硬约束：不可逆 / 凭据 / 效果不可知 → 直接拒（模型不可解除）
 *   2. 成本分流：可证明只读、人批准过的同一条 / 同一范围 → 不打扰模型
 *   3. 可解释：每条判定留一句人话 + 审计流水
 *
 * 其余一切（含所有会改状态的调用）都交给独立审查 agent：
 * 它有自己的上下文、只读探针工具，可以自己查事实，然后给 allow / deny / ask。
 *
 * 设计上的取舍：
 *   - 没有"契约抽取"，没有"覆盖率判定"，没有"单次复核" —— 这些都是在 agent 前面
 *     替它下结论或转述原话，删掉后少三层模型调用，也少三层失真。
 *   - 指令**原文**直接给 agent，事实由 discover / capgate_probe 现取。
 */
import Schema from '@deepseek-ai/schemastery';
import { effectOf, effectOfSchema, classify, describeClass, cardinalityOf, locksOf } from './classify.mjs';
import { absoluteDanger } from './effects.mjs';
import { reviewWithAgent, loadReviewCache, flushReviewCache } from './reviewer.mjs';
import { discover } from './discover.mjs';
import { runProbe, readOnlyCommand } from './probe.mjs';
import { compileRules } from './rules.mjs';
import { CapgateStore } from './store.mjs';
import { chooseView, applyView } from './outputview.mjs';
import { classifyAsk, askKindLabel } from './askreason.mjs';
import { effectFingerprint } from './bypass.mjs';
import { STYLES } from './scope.mjs';
import { appendFileSync } from 'node:fs';

const SHELL_TOOLS = new Set(['pwsh', 'powershell', 'bash', 'sh', 'shell', 'cmd', 'run_command']);

/** 工具面：审查 agent 能用的只读工具 */
const REVIEW_TOOLS = ['read', 'glob', 'grep', 'capgate_probe'];

export const name = 'capgate';

/** 只依赖 tools；approval / llm / commands / subagents 都是可选服务。 */
export const inject = ['tools'];

export const Config = Schema.object({
  mode: Schema.union(['capgate', 'standard']).default('capgate').description('capgate = 接管；standard = 完全休眠'),
  requiredPreset: Schema.string().default('').description('只有当前权限档位等于它时才接管'),
  autoAllowReads: Schema.boolean().default(true).description('可证明只读的调用不打扰模型'),
  maxConsecutiveDenials: Schema.number().default(3).description('连续拒绝多少次后升级为询问'),
  minimize: Schema.boolean().default(true).description('拒绝时给出更窄的替代写法'),
  outputMinimize: Schema.union(['off', 'on']).default('on').description('结果侧裁剪与脱敏'),
  authStyle: Schema.union(STYLES).default('strict').description('strict=未被原话覆盖即范围外；goal=服务目标即可'),
  customScope: Schema.string().default(''),
  reviewerTimeoutMs: Schema.number().default(45000),
  askPolicy: Schema.union(['ask', 'allow']).default('ask').description('实验：allow = 不问人，直接放行'),
  auditPath: Schema.string().default('').description('判定流水（jsonl）'),
  cachePath: Schema.string().default('').description('判定缓存前缀（可落盘）'),
  allowTools: Schema.array(Schema.string()).default([]),
  denyTools: Schema.array(Schema.string()).default([]),
  allowPaths: Schema.array(Schema.string()).default([]),
  denyPaths: Schema.array(Schema.string()).default([]),
  denyKeywords: Schema.array(Schema.string()).default([]),
});

export function apply(ctx, config = {}) {
  const cfg = Config(config ?? {});
  const store = new CapgateStore();
  const rules = compileRules({
    allowTools: cfg.allowTools, denyTools: cfg.denyTools,
    allowPaths: cfg.allowPaths, denyPaths: cfg.denyPaths, denyKeywords: cfg.denyKeywords,
  });
  const sigByCall = new Map();

  const mode = () => (cfg.mode === 'standard' ? 'standard' : 'capgate');
  const sidOf = (agent) => String(agent?.session?.id ?? agent?.session?.header?.id ?? 'unknown');
  const cwdOf = (agent) => agent?.session?.header?.cwd ?? process.cwd();

  function active(agent) {
    if (mode() !== 'capgate') return false;
    if (!cfg.requiredPreset) return true;
    try {
      const cur = ctx.get?.('permissionPresets')?.current?.(agent?.session);
      return cur === cfg.requiredPreset;
    } catch { return false; }
  }

  function audit(entry) {
    if (!cfg.auditPath) return;
    try { appendFileSync(cfg.auditPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'); }
    catch { /* 审计失败不影响判定 */ }
  }

  function approvalPolicy(agent) {
    try { return ctx.get?.('approval')?.policy?.(agent?.session) ?? 'ask'; } catch { return 'ask'; }
  }

  const askDecision = (reason, label, meta = {}) => {
    const askKind = classifyAsk({ cardinality: meta.cardinality, locks: meta.locks, wildcard: meta.wildcard, text: reason });
    const tag = askKindLabel(askKind);
    return {
      kind: 'ask',
      askKind,
      reason,
      displayReason: { en: `capgate: ${label} (${tag.en}). Your call.`, zh: `capgate：${label}（${tag.zh}）。需要你确认。` },
    };
  };

  function guardAsk(agent, decision, label) {
    if (decision.kind !== 'ask') return decision;
    if (approvalPolicy(agent) === 'never') {
      return { kind: 'deny', reason: `capgate: 本会话审批已关闭，「${label}」按拒绝处理。` };
    }
    return decision;
  }

  /** 影响面：这些锁只是"要说明理由"，不是否决权 */
  /* ───────────── 判定 ───────────── */

  async function decideCall(exec, next) {
    if (!exec?.agent) return next();
    if (!active(exec.agent)) return next();

    const sid = sidOf(exec.agent);
    const cwd = cwdOf(exec.agent);
    const agent = exec.agent;
    const classified = classOfCall(agent, exec.name, exec.arguments, cwd);
    if (!classified) return guardAsk(agent, askDecision('capgate: 无法解析这次调用的效果', '无法解析效果'), '无法解析效果');
    const { effect, klass } = classified;
    const label = describeClass(klass);
    const targets = (effect.targets ?? []).filter((t) => t.kind === 'path' || t.kind === 'ref' || t.kind === 'db').map((t) => t.value);
    const locks = locksOf(klass, effect);
    const sig = exec.name + '|' + stableKey(exec.arguments);
    if (exec.callId) sigByCall.set(String(exec.callId), sig);

    // ── 1. 硬约束 ──
    const danger = absoluteDanger(String(exec.arguments?.command ?? exec.arguments?.cmd ?? exec.arguments?.script ?? ''));
    if (danger) {
      audit({ event: 'deny', by: 'absolute-danger', rule: danger.rule, sid, tool: exec.name });
      return { kind: 'deny', reason: `capgate: 命中绝对危险清单（${danger.rule}）` };
    }
    if (klass.sensitivity === 'sensitive') {
      audit({ event: 'deny', by: 'sensitive', sid, tool: exec.name, class: klass.key });
      return { kind: 'deny', reason: 'capgate: 目标是凭据/密钥类文件，不进入对话也不自动执行。' };
    }

    // ── 2. 用户规则（只会更紧） ──
    const ruled = evaluateRules(rules, { tool: exec.name, effect });
    if (ruled?.kind === 'deny') {
      audit({ event: 'deny', by: 'rule', rule: ruled.rule, sid, tool: exec.name, class: klass.key });
      return { kind: 'deny', reason: `capgate: 规则拒绝（${ruled.rule}）` };
    }

    // ── 3. 成本分流：这些"根本不会改状态"或"人已经批准过" ──
    if (store.hasSignature(sid, sig)) {
      audit({ event: 'allow', by: 'identical', sid, tool: exec.name, class: klass.key });
      return next();
    }
    if (klass.op === 'read' || klass.op === 'write' || klass.op === 'delete') {
      const underExtent = targets.length > 0 && store.coveredByExtent(sid, klass.op, targets);
      if (underExtent) {
        audit({ event: 'allow', by: 'extent', sid, tool: exec.name, class: klass.key, targets: targets.slice(0, 5) });
        return next();
      }
    }
    if (cfg.autoAllowReads && klass.op === 'read' && klass.scope === 'workspace') {
      audit({ event: 'allow', by: 'read-fast-path', sid, tool: exec.name, class: klass.key });
      return next();
    }

    // 反绕过：同一效果换个写法（指纹相同、命令不同）直接拒绝，不再重问
    {
      const fp0 = effectFingerprint({ op: klass.op, targets });
      const rec = store.deniedInfo(sid, fp0);
      if (rec && rec.sig && rec.sig !== sig) {
        audit({ event: 'deny', by: 'anti-bypass', sid, tool: exec.name, class: klass.key, count: rec.count });
        return { kind: 'deny', reason: 'capgate: 同一个效果刚才已被拒绝（第 ' + (rec.count + 1) + ' 次尝试，仅换了写法）。换一种工具或措辞不会改变判定。' };
      }
    }

    // ── 4. 其余全部交给审查 agent ──
    const facts = [];
    try { facts.push(...discover({ kind: effect.targets[0]?.kind, target: effect.targets[0]?.value, cwd })); } catch { /* 取不到就不给 */ }
    if (ruled?.kind === 'allow') facts.push('a user-configured allow rule matches this call: ' + ruled.rule);

    const instructions = collectInstructions(agent);
    const state = renderState(store, sid);

    const review = await reviewWithAgent(ctx, agent, {
      tool: exec.name,
      args: JSON.stringify(exec.arguments ?? {}),
      op: klass.op,
      targets,
      locks,
      facts,
      instructions,
      state,
      style: cfg.authStyle,
      customScope: cfg.customScope,
    }, {
      provider: undefined,
      tools: REVIEW_TOOLS,
      timeoutMs: cfg.reviewerTimeoutMs,
      allow: true,
    });

    if (review?.verdict === 'deny') {
      const n = store.deny(sid, klass.key);
      const fp = effectFingerprint({ op: klass.op, targets });
      store.rememberDenied(sid, fp, sig);
      if (n >= cfg.maxConsecutiveDenials) {
        audit({ event: 'ask', sid, tool: exec.name, class: klass.key, why: 'escalated-after-denials', count: n });
        return guardAsk(agent, askDecision('capgate: 「' + label + '」已连续被拒 ' + n + ' 次，转人工核对。', label, { locks }), label);
      }
      audit({ event: 'deny', by: 'reviewer', sid, tool: exec.name, class: klass.key, why: review.why });
      return { kind: 'deny', reason: `capgate 复核拒绝：${review.why || review.text || '超出用户授权范围'}`, alternatives: review.alternatives };
    }

    if (review?.verdict === 'allow') {
      // 硬锁不能被放行：凭据、效果不可知。
      const blocking = locks.filter((l) => l === 'sensitive');
      if (blocking.length === 0) {
        store.grant(sid, klass.key, { via: 'reviewer', targets });
        audit({ event: 'allow', by: 'reviewer', sid, tool: exec.name, class: klass.key, why: review.why, locks });
        return next();
      }
      audit({ event: 'ask', sid, tool: exec.name, class: klass.key, why: 'reviewer-allow-but-locked', locks: blocking });
      return guardAsk(agent, askDecision(
        `capgate: 复核认为可以做，但它属于「${label}」，命中了必须你确认的类别（${blocking.join('/')}）。`,
        label, { locks, cardinality: cardinalityOf(effect), wildcard: effect.wildcard },
      ), label);
    }

    // deny / ask / 审查不可用 → 问人
    const reason = review?.why
      ? `capgate: 首次使用「${label}」，复核认为不确定（${review.why}）`
      : `capgate: 首次使用「${label}」，需要你确认。`;
    store.rememberPending(sid, exec.callId, { key: klass.key, label, op: klass.op, targets });
    audit({ event: 'ask', sid, tool: exec.name, class: klass.key, autoEligible: false, why: review?.why ?? 'no-verdict', askKind: classifyAsk({ locks, cardinality: cardinalityOf(effect), wildcard: effect.wildcard, text: reason }) });
    return guardAsk(agent, askDecision(reason, label, { locks, cardinality: cardinalityOf(effect), wildcard: effect.wildcard }), label);
  }

  /** 分类：shell 走命令文本，其它走参数 schema */
  function classOfCall(agent, toolName, args, cwd) {
    try {
      let definition = { name: toolName };
      try {
        const reg = ctx.get?.('tools');
        const found = reg?.get?.(toolName);
        if (found) definition = found;
      } catch { /* 取不到就用名字 */ }
      const effect = SHELL_TOOLS.has(toolName)
        ? effectOf(toolName, args ?? {}, cwd)
        : (effectOfSchema(definition, args ?? {}, cwd) ?? effectOf(toolName, args ?? {}, cwd));
      if (!effect) return undefined;
      return { effect, klass: classify(effect, { root: cwd }) };
    } catch { return undefined; }
  }

  /* ───────────── 上下文：指令原文 + 任务状态 ───────────── */

  /** 用户指令原文（**不改写、不摘要**，直接给 agent） */
  function collectInstructions(agent) {
    const out = [];
    try {
      const session = agent?.session;
      const nodes = session?.surface?.nodes ?? [];
      const events = session?.snapshotEvents?.() ?? [];
      for (const seq of nodes) {
        const ev = events[seq];
        if (ev?.type !== 'user/message') continue;
        const src = ev.data?.source ?? {};
        if (src.kind && src.kind !== 'user') continue;
        for (const block of ev.data?.content ?? []) {
          if (block?.type === 'text' && block.text) out.push(block.text);
        }
      }
    } catch { /* 读不到就不给 */ }
    return out.slice(-3).join('\n---\n').slice(-2000);
  }

  /** 任务状态：只写"发生过什么"，不写判断 */
  function renderState(sid) {
    const s = store.session(sid);
    const lines = [];
    const approved = [...s.extents.entries()].slice(-5);
    if (approved.length) {
      lines.push('already approved this task:');
      for (const [op, set] of approved) lines.push(`  - ${op}: ${[...set].slice(0, 6).join(', ')}`);
    }
    if (s.denials.size) lines.push('refused classes: ' + [...s.denials.keys()].slice(-5).join(', '));
    const seq = s.decisions.slice(-8).map((d) => `${d.event}${d.by ? ':' + d.by : ''}${d.class ? ' ' + d.class : ''}`);
    if (seq.length) lines.push('recent decisions: ' + seq.join(' | '));
    return lines.join('\n');
  }

  /* ───────────── 审批：人按下之后的复用 ───────────── */

  ctx.on('approval/request', async (req, next) => {
    if (typeof req.reason === 'string' && req.reason.startsWith('capgate:')) return next();
    if (!active(req.agent)) return next();
    const sid = sidOf(req.agent);
    const pending = req.callId ? store.takePending(sid, req.callId) : undefined;
    if (!pending) return next();
    const outcome = await next();
    if (outcome === 'allowed-once') {
      store.grant(sid, pending.key, { via: 'human', targets: pending.targets });
      const sig = req.callId ? sigByCall.get(String(req.callId)) : undefined;
      if (sig) store.approveSignature(sid, sig);
      if (pending.targets?.length) store.addExtent(sid, pending.op, pending.targets);
      audit({ event: 'grant', by: 'human', sid, tool: req.toolName, class: pending.key, targets: pending.targets?.slice(0, 5) });
    } else if (outcome === 'rejected') {
      store.deny(sid, pending.key);
      audit({ event: 'deny', by: 'human', sid, tool: req.toolName, class: pending.key });
    }
    return outcome;
  }, { prepend: true });

  /* ───────────── 结果侧最小化 ───────────── */

  ctx.on('tools/post-execute', async (exec, result, next) => {
    let decision;
    try { decision = await next(); } catch { return next(); }
    try {
      if (cfg.outputMinimize !== 'on') return decision;
      if (!exec?.agent || !active(exec.agent)) return decision;
      if (exec.agent?.session?.parentSession) return decision;
      if (decision?.kind !== 'accept' || !decision.content) return decision;
      const c = classOfCall(exec.agent, exec.name, exec.arguments, cwdOf(exec.agent));
      if (!c) return decision;
      const view = chooseView({ op: c.klass.op, scope: c.klass.scope, cardinality: cardinalityOf(c.effect) });
      if (!view) return decision;
      const { content, note } = applyView(decision.content, view);
      if (note) audit({ event: 'output_trim', sid: sidOf(exec.agent), tool: exec.name, note });
      return note ? { ...decision, content } : decision;
    } catch { return decision; }
  }, { prepend: true });

  /* ───────────── 审查 agent 的只读探针 ───────────── */

  try {
    const tools = ctx.get?.('tools') ?? ctx.tools;
    if (tools?.register) {
      tools.register({
        name: 'capgate_probe',
        description: 'Run ONE read-only command to gather evidence before judging a call '
          + '(git status/branch/log, ls, aws s3 ls, kubectl get, squeue). '
          + 'Only the permission reviewer can call it. No pipes/redirects/chaining.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'a single read-only command' },
            cwd: { type: 'string', description: 'working directory (defaults to the task workspace)' },
          },
          required: ['command'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (args, value) => [{ type: 'text', text: 'capgate_probe: ' + (value?.ok ? 'ok' : 'failed') + '\n' + String(value?.stdout ?? '') }],
        },
        execute: async (args, exec) => {
          if (!exec?.agent?.session?.parentSession) {
            return { ok: false, why: 'capgate_probe is only available to the reviewer subagent' };
          }
          const out = runProbe(args, { defaultCwd: cwdOf(exec.agent) });
          audit({ event: 'probe', command: String(args?.command ?? '').slice(0, 120), ok: out.ok });
          return out;
        },
      });
      console.log('[capgate] 探针工具 capgate_probe 已注册');
    }
  } catch (err) {
    console.warn('[capgate] 探针工具注册失败:', err && err.message ? err.message : err);
  }

  /* ───────────── 判定入口 ───────────── */

  ctx.on('tools/pre-execute', async (exec, next) => {
    let decision;
    try { decision = await decideCall(exec, next); } catch (err) {
      audit({ event: 'error', sid: sidOf(exec?.agent), tool: exec?.name, message: String(err?.message ?? err) });
      decision = guardAsk(exec?.agent, askDecision('capgate: 判定过程出错，交给你决定', '判定出错'), '判定出错');
    }
    try {
      if (decision && exec?.agent) {
        const c = classOfCall(exec.agent, exec.name, exec.arguments, cwdOf(exec.agent));
        if (c) {
          audit({
            event: 'decision', sid: sidOf(exec.agent), tool: exec.name, kind: decision.kind,
            askKind: decision.askKind, class: c.klass?.key, cardinality: cardinalityOf(c.effect),
            targets: (c.effect?.targets ?? []).map((t) => `${t.kind}:${t.value}`),
          });
          if (decision.kind === 'deny' || decision.kind === 'ask') {
            store.record(sidOf(exec.agent), { event: decision.kind, class: c.klass?.key, why: decision.reason });
          }
        }
      }
    } catch { /* 流水失败不影响判定 */ }
    return decision;
  }, { prepend: true });

  /* ───────────── 缓存与命令 ───────────── */

  if (cfg.cachePath) {
    try { loadReviewCache(cfg.cachePath + '.review.json'); } catch { /* 缓存不可用 */ }
    const flush = () => { try { flushReviewCache(cfg.cachePath + '.review.json'); } catch { /* ignore */ } };
    process.once?.('exit', flush);
    setInterval(flush, 30000).unref?.();
  }

  try {
    const commands = ctx.get?.('commands');
    if (commands?.register) {
      commands.register({
        name: 'capgate',
        description: 'capgate 状态（status | reset）',
        handler: (invocation) => {
          const sid = sidOf(invocation.agent);
          const arg = String(invocation.rawInput ?? '').trim().toLowerCase();
          if (arg === 'reset') {
            store.session(sid).grants.clear();
            store.session(sid).denials.clear();
            store.session(sid).extents.clear();
            return { kind: 'success', text: 'capgate: 已清空本会话的授权与拒绝记录' };
          }
          const s = store.session(sid);
          return {
            kind: 'success',
            text: [
              `mode=${mode()} preset=${cfg.requiredPreset || '(any)'} active=${active(invocation.agent) ? 'yes' : 'no'}`,
              `grants=${s.grants.size} denials=${s.denials.size} extents=${s.extents.size}`,
              `style=${cfg.authStyle} outputMinimize=${cfg.outputMinimize}`,
            ].join('\n'),
          };
        },
      });
      console.log('[capgate] /capgate 命令已注册');
    }
  } catch (err) { console.warn('[capgate] 命令注册失败:', err?.message ?? err); }

  try {
    ctx.systemPrompt?.section?.({
      name: 'tool:capgate',
      order: 1200,
      text: [
        'capgate 会在工具执行前判定"这次调用会产生什么效果"，请让效果**显式**：',
        '1) 能用类型化工具就不要用 shell；删改文件用带路径参数的工具。',
        '2) 需要越界时，在 justification 里写清完整路径、数量和总大小。',
        '3) 信息不全但能合理推断时：按最有依据的解释直接执行，并在结果里用一句话说明你的假设；',
        '   不要停在“等确认”——只有当你完全无法判断目标时才问。',
        '4) 被拒绝时不要换等价写法重试——说明为什么需要它，或改在项目内完成。',
      ].join('\n'),
    });
  } catch { /* 没有 systemPrompt 服务 */ }

  console.log(`[capgate] active mode=${mode()} preset=${cfg.requiredPreset || '(any)'} style=${cfg.authStyle} judge=reviewer-only`);
}

/* ───────────── 小工具 ───────────── */

function stableKey(value) {
  const seen = new WeakSet();
  const walk = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return '[cycle]';
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
    return out;
  };
  try { return JSON.stringify(walk(value ?? {})); } catch { return String(value); }
}

function evaluateRules(rules, { tool, effect }) {
  if (!rules) return undefined;
  const paths = (effect?.targets ?? []).filter((t) => t.kind === 'path').map((t) => t.value);
  const raw = String(effect?.raw ?? '');
  for (const p of rules.denyPaths) if (paths.some((x) => x.startsWith(p))) return { kind: 'deny', rule: 'denyPaths:' + p };
  for (const k of rules.denyKeywords) if (k.test(raw)) return { kind: 'deny', rule: 'denyKeywords:' + k.source };
  if (rules.denyTools.includes(tool)) return { kind: 'deny', rule: 'denyTools:' + tool };
  if (rules.allowTools.includes(tool)) return { kind: 'allow', rule: 'allowTools:' + tool };
  for (const p of rules.allowPaths) if (paths.some((x) => x.startsWith(p))) return { kind: 'allow', rule: 'allowPaths:' + p };
  return undefined;
}

