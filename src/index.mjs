/**
 * capgate —— 效果类摊销授权（effect-class amortized authorization）。
 *
 * 判定链：
 *   敏感路径 → 规则 → 人工工具 → 项目内读 → 项目外读 → 已授类
 *   → 批量/通配（必问） → 引文核对（直接授予） → LLM 复核 → 确定性拒绝 → 问人
 *
 * 三条不可协商的边界：
 *   1. 敏感路径（凭据/密钥）永不快路、永不按类摊销；
 *   2. 批量/通配永远问人（一条批准不能变成批量许可证）；
 *   3. 出网与不透明执行（脚本/解释器）不能由模型复核放行。
 */
import Schema from '@deepseek-ai/schemastery';
import { effectOf, classify, describeClass, cardinalityOf } from './classify.mjs';
import { collectInstructionTexts, findCitation, citationSupports, isInterrogative, extractEntities } from './citations.mjs';
import { CapgateStore, redact } from './store.mjs';
import { compileRules, evaluateRules } from './rules.mjs';
import { loadState, saveState, observe, candidates, addRule, removeRule, hasRule } from './learn.mjs';
import { judgeResidual } from './judge.mjs';

export const name = 'capgate';

/** 只依赖 tools；approval / llm / commands 都是可选服务。 */
export const inject = ['tools'];

export const DEFAULTS = {
  mode: 'capgate',
  requiredPreset: '',
  workspaceRoot: '',
  autoAllowReads: true,
  autoAllowOutsideReads: true,
  minimize: true,
  humanOnlyTools: ['send_money', 'rotate_key', 'drop_database'],
  maxConsecutiveDenials: 3,
  maxRepeats: 2,
  grantTtlHours: 8,
  judgeMode: 'off',
  judgeAutoAllow: false,
  judgeTimeoutMs: 8000,
  ruleAllowTools: [],
  ruleDenyTools: [],
  ruleDenyKeywords: [],
  ruleAllowPaths: [],
  ruleDenyPaths: [],
  auditPath: '',
  learnPath: '',
  hardenAfter: 3,
  rejectAfter: 2,
};

export const Config = Schema.object({
  mode: Schema.union(['standard', 'capgate']).default('capgate').volatile(),
  requiredPreset: Schema.string().default(''),
  workspaceRoot: Schema.string().default('').description('空 = 用会话 cwd'),
  autoAllowReads: Schema.boolean().default(true).description('项目内普通读直接放行'),
  autoAllowOutsideReads: Schema.boolean().default(true).description('项目外普通读也放行（敏感路径仍拦）'),
  minimize: Schema.boolean().default(true).description('读类结果按任务实体投影'),
  humanOnlyTools: Schema.array(String).default(DEFAULTS.humanOnlyTools).description('永远问人的工具'),
  maxConsecutiveDenials: Schema.number().default(3).description('同一效果类连续拒绝 N 次后转人工'),
  maxRepeats: Schema.number().default(2).description('同一 (tool,args) 重复 N 次后转人工'),
  grantTtlHours: Schema.number().default(8).description('效果类授权有效期（小时）'),
  judgeMode: Schema.union(['off', 'residual']).default('off').description('残余 LLM 判定'),
  judgeAutoAllow: Schema.boolean().default(false).description('允许复核放行（出网与不透明执行除外）'),
  judgeTimeoutMs: Schema.number().default(8000).description('复核超时；超时转人工'),
  ruleAllowTools: Schema.array(String).default([]),
  ruleDenyTools: Schema.array(String).default([]),
  ruleDenyKeywords: Schema.array(String).default([]),
  ruleAllowPaths: Schema.array(String).default([]),
  ruleDenyPaths: Schema.array(String).default([]),
  auditPath: Schema.string().default(''),
  learnPath: Schema.string().default('').description('硬化规则文件路径；空 = 只内存'),
  hardenAfter: Schema.number().default(3).description('同一类被批准 N 次后建议硬化为 allow'),
  rejectAfter: Schema.number().default(2).description('同一类被拒绝 N 次后建议硬化为 deny'),
});

function readMode(value) {
  if (value && typeof value === 'object' && typeof value.get === 'function') return value.get();
  return value;
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const rules = compileRules({
    allowTools: cfg.ruleAllowTools,
    denyTools: cfg.ruleDenyTools,
    denyKeywords: cfg.ruleDenyKeywords,
    allowPaths: cfg.ruleAllowPaths,
    denyPaths: cfg.ruleDenyPaths,
  });
  /** 已硬化的规则（来自历史判断），以及累计的批准/拒绝统计 */
  const learned = loadState(cfg.learnPath);
  const persistLearn = () => { if (cfg.learnPath) saveState(cfg.learnPath, learned); };

  const store = new CapgateStore({
    auditPath: cfg.auditPath || '',
    grantTtlMs: Math.max(1, Number(cfg.grantTtlHours) || 8) * 3600_000,
  });

  const mode = () => readMode(cfg.mode) ?? 'capgate';
  const sidOf = (agent) => String(agent?.session?.id ?? 'anonymous');
  const cwdOf = (agent) => cfg.workspaceRoot || agent?.session?.header?.cwd || process.cwd();
  const audit = (entry) => { try { store.audit(entry); } catch { /* 审计失败不影响判定 */ } };

  function presetAllows(agent) {
    if (!cfg.requiredPreset) return true;
    try {
      const presets = ctx.get?.('permissionPresets');
      const current = presets?.current?.(agent?.session);
      return current === undefined ? true : current === cfg.requiredPreset;
    } catch { return true; }
  }
  const active = (agent) => mode() === 'capgate' && presetAllows(agent);

  /** 已放行、等待工具发起"放宽沙箱"审批的调用：callId → 类别信息。 */
  const deferred = new Map();

  /** 本会话审批策略：never（完全权限档）时无法询问 */
  function approvalPolicy(agent) {
    try {
      const approval = ctx.get?.('approval');
      return approval?.overrideOf?.(agent?.session) ?? approval?.config?.policy;
    } catch { return undefined; }
  }

  function classOfCall(agent, callName, args) {
    try {
      const cwd = cwdOf(agent);
      const effect = effectOf(callName, args, cwd);
      return { effect, klass: classify(effect, { root: cwd }), cwd };
    } catch (err) {
      console.warn('[capgate] classify failed:', redact(String(err)));
      return undefined;
    }
  }

  function evidenceFor(agent, klass, effect) {
    const texts = collectInstructionTexts(agent);
    if (texts.length === 0) return { ok: false, why: 'no instruction text in session' };

    // 不透明执行（脚本/解释器）里真正发生什么，命令文本看不出来：
    // 用户说"跑一下"并不等于"允许这个脚本做任何事"，所以一律不给引文授权。
    if (effect.op === 'execute' && effect.opaque) {
      return { ok: false, why: 'opaque execution: the script decides its own effects' };
    }

    if (effect.op === 'execute') {
      const raw = String(effect.raw ?? '').trim();
      const hit = texts.find((t) => {
        const sentence = String(t.text ?? '').trim();
        // 把命令原样念一遍不算指令；疑问句（"要跑构建吗？"）也不算授权
        if (!sentence || sentence === raw) return false;
        if (isInterrogative(sentence)) return false;
        return /(跑|运行|执行|构建|测试|编译|安装|run|build|test|exec|compile|install)/i.test(sentence);
      });
      if (!hit) return { ok: false, why: 'no imperative instruction about running commands' };
      return { ok: true, citations: [], primary: { text: '(command)', sentence: hit.text.slice(0, 120), seq: hit.seq } };
    }

    const citations = [];
    for (const t of effect.targets) {
      const c = findCitation(texts, t.value);
      if (!c) return { ok: false, why: `target not mentioned by the user: ${t.value}`, citations };
      citations.push(c);
    }
    const primary = citations[0];
    if (!citationSupports(primary, klass)) {
      return { ok: false, why: `citation does not support this ${klass.op}`, citations };
    }
    return { ok: true, citations, primary };
  }

  const askDecision = (reason, label) => ({
    kind: 'ask',
    reason,
    displayReason: {
      en: `capgate: ${label}. Needs your decision.`,
      zh: `capgate：${label}。需要你确认。`,
    },
  });

  function guardAsk(agent, decision, label) {
    if (decision.kind !== 'ask') return decision;
    if (approvalPolicy(agent) === 'never') {
      return {
        kind: 'deny',
        reason: `capgate: 本会话审批已关闭（完全权限档），无法询问；「${label}」按拒绝处理。`
          + '要恢复逐项确认，请把权限档切回「工作区内修改」',
      };
    }
    return decision;
  }

  // ---- 1. 判定 ----
  // 休眠不是"静默"：一旦因为模式/预设不匹配而不接管，至少留一条审计，
  // 否则事后看日志会分不清"插件没拦"和"插件没在看"。
  const dormantSeen = new Set();
  function noteDormant(agent, tool) {
    const sid = sidOf(agent);
    const reason = mode() !== 'capgate' ? 'mode=standard' : `preset!=${cfg.requiredPreset}`;
    const key = `${sid}:${reason}`;
    if (dormantSeen.has(key)) return;
    dormantSeen.add(key);
    let preset;
    try { preset = ctx.get?.('permissionPresets')?.current?.(agent?.session); } catch { preset = undefined; }
    audit({ event: 'dormant', sid, reason, preset, mode: mode(), tool });
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!exec.agent) return next();
    if (!active(exec.agent)) {
      noteDormant(exec.agent, exec.name);
      return next();
    }

    const sid = sidOf(exec.agent);
    const classified = classOfCall(exec.agent, exec.name, exec.arguments);
    if (!classified) return guardAsk(exec.agent, askDecision('capgate: 无法解析本次调用的效果', '无法解析效果'), '无法解析效果');
    const { effect, klass } = classified;
    const label = describeClass(klass);

    /** 这次调用是否在请求放宽沙箱（工具随后一定会自己发起原生审批）。 */
    const escalationMode = typeof exec.arguments?.sandbox_permissions === 'string'
      ? exec.arguments.sandbox_permissions
      : undefined;

    // 1.0 用户规则（deny 优先）
    const ruled = evaluateRules(rules, { tool: exec.name, effect });
    if (ruled) {
      store.bump(sid, ruled.kind === 'deny' ? 'deny' : 'allow');
      audit({ event: ruled.kind, by: 'rule', rule: ruled.rule, sid, tool: exec.name, class: klass.key });
      if (ruled.kind === 'deny') return { kind: 'deny', reason: `capgate 规则拒绝（${ruled.rule}）` };
      return next();
    }

    // 1.0a 已硬化的拒绝规则（来自历史判断，只会更紧）
    if (hasRule(learned, klass.key, 'deny')) {
      store.bump(sid, 'deny');
      audit({ event: 'deny', by: 'learned', sid, tool: exec.name, class: klass.key });
      return { kind: 'deny', reason: `capgate: 「${label}」已按历史判断硬化为拒绝（/capgate learn 查看）` };
    }

    // 1.0b 带沙箱升级的调用：**由 capgate 接管这次升级审批**，不再让工具自己再问一遍。
    //      判定与其它调用同一套（敏感/批量/已授类/引文），决定放在 approval/request 里做，
    //      因为那一刻才知道要放宽到哪个模式。
    if (escalationMode) {
      if (klass.sensitivity === 'sensitive') {
        // 敏感路径不允许借"放宽沙箱"顺带放行，落到下面的拒绝/询问分支
        audit({ event: 'deny', by: 'escalation-sensitive', sid, tool: exec.name, class: klass.key, mode: escalationMode });
      } else {
        deferred.set(String(exec.callId), {
          key: klass.key, label, mode: escalationMode, sid, tool: exec.name,
          batch: cardinalityOf(effect) === 'many', op: klass.op,
        });
        audit({ event: 'escalation', by: 'capgate', sid, tool: exec.name, class: klass.key, mode: escalationMode });
        return next();
      }
    }

    // 1.1 人工确认工具
    if (cfg.humanOnlyTools.includes(exec.name)) {
      store.rememberPending(sid, exec.callId, { key: klass.key, label, autoEligible: false });
      store.bump(sid, 'ask');
      return guardAsk(exec.agent, askDecision(`capgate: ${exec.name} 属于人工确认工具`, label), label);
    }

    // 1.2 敏感路径
    if (klass.sensitivity === 'sensitive') {
      if (klass.scope !== 'workspace') {
        const n = store.deny(sid, klass.key);
        store.bump(sid, 'deny');
        audit({ event: 'deny', reason: 'sensitive-outside', sid, tool: exec.name, class: klass.key, count: n });
        if (n >= cfg.maxConsecutiveDenials) {
          store.rememberPending(sid, exec.callId, { key: klass.key, label, sensitive: true, autoEligible: false });
          return guardAsk(exec.agent, askDecision(`capgate: ${label} 已连续拒绝 ${n} 次，转人工核对`, label), label);
        }
        return { kind: 'deny', reason: 'capgate: 拒绝（敏感路径在项目外）。义务: 说明为什么需要它，或改在项目内完成；凭据类文件不允许读取' };
      }
      const sensEvidence = evidenceFor(exec.agent, klass, effect);
      store.rememberPending(sid, exec.callId, {
        key: klass.key, label, sensitive: true, autoEligible: sensEvidence.ok, source: 'sensitive',
      });
      store.bump(sid, 'ask');
      audit({ event: 'ask', sid, tool: exec.name, class: klass.key, sensitive: true, autoEligible: sensEvidence.ok });
      return guardAsk(
        exec.agent,
        askDecision(
          sensEvidence.ok
            ? `capgate: 敏感文件「${label}」，依据用户原话「${sensEvidence.primary.sentence.slice(0, 60)}」（仅本次）`
            : `capgate: 敏感文件「${label}」，用户原话未点名（仅本次）`,
          label,
        ),
        label,
      );
    }

    // 1.2b 已硬化的放行规则（必须经人显式确认；敏感路径已在上面被拦下）
    if (hasRule(learned, klass.key, 'allow')) {
      store.bump(sid, 'allow');
      audit({ event: 'allow', by: 'learned-allow', sid, tool: exec.name, class: klass.key });
      return next();
    }

    // 1.3 项目内普通读
    if (cfg.autoAllowReads && klass.op === 'read' && klass.scope === 'workspace') {
      store.bump(sid, 'allow');
      audit({ event: 'allow', by: 'read-fast-path', sid, tool: exec.name, class: klass.key });
      return next();
    }

    // 1.3b 项目外普通读
    if (cfg.autoAllowOutsideReads && klass.op === 'read') {
      store.bump(sid, 'allow');
      audit({ event: 'allow', by: 'outside-read-fast-path', sid, tool: exec.name, class: klass.key });
      return next();
    }

    // 1.4 已授予的类
    if (store.isGranted(sid, klass.key)) {
      store.bump(sid, 'allow');
      audit({ event: 'allow', by: 'class-grant', sid, tool: exec.name, class: klass.key });
      return next();
    }

    // 1.5 批量/通配：必问
    if (cardinalityOf(effect) === 'many') {
      store.rememberPending(sid, exec.callId, { key: klass.key, label, autoEligible: false });
      store.bump(sid, 'ask');
      audit({ event: 'ask', sid, tool: exec.name, class: klass.key, autoEligible: false, why: 'batch' });
      return guardAsk(exec.agent, askDecision(`capgate: ${label}（批量或通配目标，需人工确认）`, label), label);
    }

    // 1.6 引文核对：对上就直接授予并放行（不经审批面）
    const evidence = evidenceFor(exec.agent, klass, effect);
    if (evidence.ok) {
      store.grant(sid, klass.key, { via: 'citation', citation: evidence.primary });
      store.bump(sid, 'grant');
      audit({ event: 'grant', by: 'citation', sid, tool: exec.name, class: klass.key, cited: evidence.primary.text });
      return next();
    }

    // 1.7 残余 LLM 判定
    if (cfg.judgeMode === 'residual') {
      const judgement = await judgeResidual(
        ctx,
        exec.agent,
        { tool: exec.name, args: exec.arguments, klass, effect, texts: collectInstructionTexts(exec.agent) },
        { timeoutMs: cfg.judgeTimeoutMs },
      );
      store.bump(sid, 'judge');
      audit({
        event: 'judge', sid, tool: exec.name, class: klass.key,
        decision: judgement.decision, source: judgement.source, reason: judgement.reason,
      });

      if (judgement.decision === 'deny' && judgement.source === 'judge') {
        store.bump(sid, 'deny');
        store.deny(sid, klass.key);
        return { kind: 'deny', reason: `capgate 复核拒绝：${judgement.reason || '超出用户授权范围'}` };
      }

      const judgeMayGrant = cfg.judgeAutoAllow && klass.op !== 'send' && !effect.opaque;
      if (judgement.decision === 'allow' && judgeMayGrant) {
        store.grant(sid, klass.key, { via: 'judge' });
        store.bump(sid, 'grant');
        audit({ event: 'grant', by: 'judge', sid, tool: exec.name, class: klass.key, reason: judgement.reason });
        return next();
      }

      store.rememberPending(sid, exec.callId, { key: klass.key, label, autoEligible: false, source: 'human', op: klass.op });
      store.bump(sid, 'ask');
      audit({
        event: 'ask', sid, tool: exec.name, class: klass.key,
        autoEligible: false, opaque: !!effect.opaque, why: `judge:${judgement.decision}:${judgement.reason}`,
      });
      const whyNotGrant = klass.op === 'send' ? '出网需要你确认'
        : effect.opaque ? '不透明执行（脚本/解释器）需要你确认'
        : '需要你确认';
      return guardAsk(
        exec.agent,
        askDecision(
          judgement.decision === 'allow'
            ? `capgate: 首次使用「${label}」，复核认为符合要求，但${whyNotGrant}（${judgement.reason}）`
            : `capgate: 首次使用「${label}」，复核认为不确定（${judgement.reason}）`,
          label,
        ),
        label,
      );
    }

    // 1.8 未开启复核：确定性边界
    if (klass.scope !== 'workspace') {
      const identity = `${exec.name}:${JSON.stringify(exec.arguments).slice(0, 200)}`;
      const repeats = store.repeat(sid, identity);
      const n = store.deny(sid, klass.key);
      store.bump(sid, 'deny');
      audit({ event: 'deny', reason: 'outside-no-citation', sid, tool: exec.name, class: klass.key, why: evidence.why, count: n, repeats });
      if (n >= cfg.maxConsecutiveDenials || repeats > cfg.maxRepeats) {
        store.rememberPending(sid, exec.callId, { key: klass.key, label, autoEligible: false });
        return guardAsk(exec.agent, askDecision(`capgate: ${label} 已反复被拒（${Math.max(n, repeats)} 次），转人工核对`, label), label);
      }
      return { kind: 'deny', reason: 'capgate: 拒绝（目标在项目外，且用户原话没有提到它）。义务: 改在项目内完成，或请用户明确指定该目标' };
    }

    // 1.9 项目内但没引文
    store.rememberPending(sid, exec.callId, { key: klass.key, label, autoEligible: false, op: klass.op });
    store.bump(sid, 'ask');
    audit({ event: 'ask', sid, tool: exec.name, class: klass.key, autoEligible: false, why: evidence.why });
    return guardAsk(exec.agent, askDecision(`capgate: 首次使用「${label}」，未找到用户原话依据（${evidence.why}）`, label), label);
  }, { prepend: true });

  // ---- 2. 审批裁决 ----
  ctx.on('approval/request', async (req, next) => {
    // 我们自己发起的嵌套询问：交回下游（浏览器面板），避免递归
    if (typeof req.reason === 'string' && req.reason.startsWith('capgate:')) return next();
    if (!active(req.agent)) return next();

    // 2.0 工具发起的沙箱升级：capgate 接管，原生那一问不再弹出
    if (typeof req.reason === 'string' && req.reason.startsWith('escalate sandbox to ')) {
      const modeMatch = /^escalate sandbox to ([a-z-]+):/i.exec(req.reason);
      const requestedMode = modeMatch ? modeMatch[1] : 'unknown';
      const info = req.callId ? deferred.get(String(req.callId)) : undefined;
      if (!info) return next();   // 不是 capgate 看过的调用，交还原生处理
      deferred.delete(String(req.callId));

      // 已授予的类 + 非全权 + 非批量 → 直接放行，不再打扰
      const granted = store.isGranted(info.sid, info.key);
      const needsHuman = requestedMode === 'danger-full-access' || info.batch || !granted;

      if (!needsHuman) {
        store.bump(info.sid, 'allow');
        audit({ event: 'allow', by: 'escalation-auto', sid: info.sid, tool: req.toolName, class: info.key, mode: requestedMode });
        return 'allowed-once';
      }

      // 需要人：用 capgate 的文案问一次（原生那张卡被我们接管了）
      const approval = ctx.get?.('approval');
      if (!approval?.request) return next();
      const tone = requestedMode === 'danger-full-access'
        ? `本次需要临时放宽到 ${requestedMode}`
        : `本次需要放宽到 ${requestedMode}`;
      const outcome = await approval.request({
        agent: req.agent,
        toolName: req.toolName,
        callId: req.callId,
        reason: `capgate: ${info.label}；${tone}`,
        displayReason: {
          en: `capgate: ${info.label}. ${tone}.`,
          zh: `capgate：${info.label}；${tone}。`,
        },
        signal: req.signal,
      });
      store.bump(info.sid, outcome === 'allowed-once' ? 'grant' : 'deny');
      audit({
        event: outcome === 'allowed-once' ? 'grant' : 'deny',
        by: 'escalation', sid: info.sid, tool: req.toolName,
        class: info.key, mode: requestedMode, outcome,
      });
      observe(learned, info.key, outcome === 'allowed-once' ? 'approve' : 'reject');
      persistLearn();
      return outcome === 'allowed-once' ? 'allowed-once' : 'rejected';
    }

    if (!req.callId) return next();
    const sid = sidOf(req.agent);
    const pending = store.takePending(sid, req.callId);
    if (!pending) return next();

    if (pending.sensitive) {
      const outcome = pending.autoEligible ? 'allowed-once' : await next();
      audit({
        event: outcome === 'allowed-once' ? 'allow-once' : 'deny',
        by: 'sensitive', sid, tool: req.toolName, class: pending.key, outcome,
      });
      observe(learned, pending.key, outcome === 'allowed-once' ? 'approve' : 'reject');
      persistLearn();
      return outcome;
    }

    if (pending.autoEligible) {
      store.grant(sid, pending.key, { via: pending.source ?? 'citation', citation: pending.citation });
      store.bump(sid, 'grant');
      audit({ event: 'grant', by: pending.source ?? 'citation', sid, tool: req.toolName, class: pending.key });
      return 'allowed-once';
    }

    const outcome = await next();
    if (outcome === 'allowed-once') {
      store.grant(sid, pending.key, { via: 'human' });
      store.bump(sid, 'grant');
      audit({ event: 'grant', by: 'human', sid, tool: req.toolName, class: pending.key });
    } else {
      store.deny(sid, pending.key);
      audit({ event: 'deny', by: 'human', outcome, sid, tool: req.toolName, class: pending.key });
    }
    // 学习：累计人的选择，供 /capgate learn 生成硬化候选
    observe(learned, pending.key, outcome === 'allowed-once' ? 'approve' : 'reject');
    persistLearn();
    return outcome;
  }, { prepend: true });

  // ---- 3. Minimize ----
  ctx.on('tools/post-execute', (exec, result, next) => {
    if (!cfg.minimize || !exec.agent || !active(exec.agent)) return next();
    if (!['read', 'grep', 'glob', 'list', 'view'].includes(exec.name)) return next();
    try {
      const sid = sidOf(exec.agent);
      let entities = store.entitiesOf(sid);
      if (entities.length === 0) {
        entities = extractEntities(collectInstructionTexts(exec.agent));
        if (entities.length > 0) store.setEntities(sid, entities);
      }
      if (entities.length === 0) return next();

      const content = result?.content;
      if (!Array.isArray(content) || content.length === 0) return next();
      const text = content.map((b) => (b && b.type === 'text' ? b.text : '')).join('\n');
      if (!text) return next();
      const lines = text.split('\n');
      if (lines.length < 4) return next();
      const kept = lines.filter((line) => entities.some((e) => line.includes(e)));
      if (kept.length === lines.length || kept.length === 0) return next();
      audit({ event: 'minimize', sid, tool: exec.name, kept: kept.length, total: lines.length });
      return {
        kind: 'accept',
        content: [{
          type: 'text',
          text: kept.join('\n') + `\n[capgate-minimized: 保留 ${kept.length}/${lines.length} 行（任务实体投影）]`,
        }],
      };
    } catch (err) {
      console.warn('[capgate] minimize skipped:', err && err.message ? err.message : err);
      return next();
    }
  });

  // ---- 4. /capgate 命令 ----
  // apply 执行时 commands 服务通常还没挂好，ctx.get('commands') 会是 undefined；
  // 用可选注入等它出现，否则 /capgate 永远不会被注册。
  const registerCommand = (commands) => {
    if (!commands || typeof commands.register !== 'function') {
      console.warn('[capgate] commands service unavailable; /capgate not registered');
      return;
    }
    try {
      commands.register({
        definitionId: 'capgate',
        name: 'capgate',
        description: '查看或重置 capgate 的效果类授权（status | rules | reset）',
        handler: (invocation) => {
        const sid = sidOf(invocation.agent);
        const arg = String(invocation.rawInput ?? '').trim().toLowerCase();
        const s = store.session(sid);
        if (arg === 'reset') {
          s.grants.clear();
          s.denials.clear();
          s.repeats.clear();
          return { kind: 'success', text: 'capgate: 已清空本会话的授权、拒绝计数与重复计数' };
        }
        if (arg === 'rules') {
          const lines = [
            `allowTools: ${rules.allowTools.map(String).join(', ') || '(none)'}`,
            `denyTools: ${rules.denyTools.map(String).join(', ') || '(none)'}`,
            `denyKeywords: ${rules.denyKeywords.map((r) => r.source).join(' | ') || '(none)'}`,
            `allowPaths: ${rules.allowPaths.join(', ') || '(none)'}`,
            `denyPaths: ${rules.denyPaths.join(', ') || '(none)'}`,
          ];
          return { kind: 'success', text: `capgate 规则\n${lines.join('\n')}` };
        }
        if (arg === 'learn') {
          const list = candidates(learned, { approveAt: cfg.hardenAfter, rejectAt: cfg.rejectAfter });
          const lines = [
            `learnPath: ${cfg.learnPath || '(仅内存)'}`,
            `allow 规则: ${learned.rules.allow.map((r) => r.key).join(', ') || '(none)'}`,
            `deny 规则:  ${learned.rules.deny.map((r) => r.key).join(', ') || '(none)'}`,
            `候选 (${list.length}):`,
            ...(list.length ? list.map((c) => `  [${c.kind}] ${c.key} — ${c.reason}`) : ['  (none)']),
            '硬化: /capgate harden <类> allow|deny    解除: /capgate unharden <类> allow|deny',
          ];
          return { kind: 'success', text: `capgate 学习\n${lines.join('\n')}` };
        }
        if (arg.startsWith('harden ') || arg.startsWith('unharden ')) {
          const [verb, key, kindArg] = arg.split(/\s+/);
          const kind = kindArg === 'deny' ? 'deny' : 'allow';
          if (!key) return { kind: 'error', text: '用法：/capgate harden <类> allow|deny' };
          const changed = verb === 'harden' ? addRule(learned, key, kind) : removeRule(learned, key, kind);
          if (changed) persistLearn();
          return changed
            ? { kind: 'success', text: `capgate: ${verb} ${kind} ${key}` }
            : { kind: 'error', text: '未发生变化（规则已存在或不存在）' };
        }
        const stats = store.statsOf(sid);
        const grants = [...s.grants.keys()];
        let preset;
        try { preset = ctx.get?.('permissionPresets')?.current?.(invocation.agent?.session); } catch { preset = undefined; }
        const body = [
          `mode=${mode()} preset=${preset ?? '(unknown)'}${cfg.requiredPreset ? `(需要 ${cfg.requiredPreset})` : ''}`
            + ` active=${active(invocation.agent) ? 'yes' : 'NO — 本档不接管'}`,
          `judge=${cfg.judgeMode}${cfg.judgeAutoAllow ? '(auto-allow)' : ''}`,
          `counters: allow=${stats.allow} ask=${stats.ask} deny=${stats.deny} grant=${stats.grant} judge=${stats.judge}`,
          `granted classes (${grants.length}):`,
          ...(grants.length ? grants.map((k) => `  - ${k}`) : ['  (none)']),
        ];
        return { kind: 'success', text: `capgate 状态\n${body.join('\n')}` };
      },
      });
      console.log('[capgate] /capgate 命令已注册');
    } catch (err) {
      console.warn('[capgate] 命令注册失败:', err && err.message ? err.message : err);
    }
  };

  // 命令服务通常比插件晚就绪：轮询等它出现再注册（最多 15 秒）。
  let commandTries = 0;
  const commandTimer = setInterval(() => {
    const commands = ctx.get?.('commands');
    if (commands && typeof commands.register === 'function') {
      clearInterval(commandTimer);
      registerCommand(commands);
      return;
    }
    commandTries += 1;
    if (commandTries > 30) {
      clearInterval(commandTimer);
      console.warn('[capgate] commands 服务在 15 秒内未就绪，/capgate 未注册');
    }
  }, 500);
  if (typeof commandTimer.unref === 'function') commandTimer.unref();

  // ---- 5. 模型侧说明 ----
  try {
    ctx.systemPrompt?.section?.({
      name: 'tool:capgate',
      order: 1200,
      text: 'capgate: 首次使用某类数据操作会被询问；项目内普通读直接放行；'
        + '被拒绝时不要换等价写法重试，改为说明为什么需要，或在项目内完成。',
    });
  } catch { /* 没有 systemPrompt 服务的组合忽略 */ }

  for (const err of rules.errors) console.warn('[capgate] rule ignored:', err);
  console.log(`[capgate] active mode=${mode()} preset=${cfg.requiredPreset || '(any)'} `
    + `judge=${cfg.judgeMode}${cfg.judgeAutoAllow ? '(auto)' : ''} `
    + `rules=${rules.allowTools.length + rules.denyTools.length + rules.denyKeywords.length + rules.allowPaths.length + rules.denyPaths.length}`);
}
