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
import { effectOf, effectOfSchema, classify, describeClass, cardinalityOf, normalizePath, locksOf } from './classify.mjs';
import { collectInstructionTexts, findCitation, citationSupports, isInterrogative, extractEntities } from './citations.mjs';
import { collectEvidence, instructionOnly, locateSpan, renderContract, validateIntent, effectiveEntries, intentCovers } from './evidence.mjs';
import { minimizeOptions, describeMinimize } from './minimize.mjs';
import { verify, summarizeFacts, buildAskPrompt, parseAsk, renderAsk, factList } from './verifier.mjs';
import { inspectScript } from './scriptaudit.mjs';
import { findReadContent, hashText } from './readlog.mjs';
import { collectProvenance, allCreated, allRead } from './provenance.mjs';
import { judgeCoverage } from './coverage.mjs';
import { absoluteDanger, resolveEffect, loadShapeCache, flushShapeCache } from './effects.mjs';
import { reviewWithAgent, loadReviewCache, flushReviewCache, checkCoverage } from './reviewer.mjs';
import { effectFingerprint } from './bypass.mjs';
import { discover } from './discover.mjs';
import { classifyAsk, askKindLabel } from './askreason.mjs';
import { splitDecision, narrowedCommand } from './split.mjs';
import { runProbe } from './probe.mjs';
import { chooseView, applyView } from './outputview.mjs';
import { buildTaskState, relationOf, renderTaskState } from './taskstate.mjs';
import { existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { parseIntent, extractIntent, callModel } from './intent.mjs';
import { CapgateStore, redact } from './store.mjs';
import { compileRules, evaluateRules } from './rules.mjs';
import { loadState, saveState, observe, candidates, addRule, removeRule, hasRule } from './learn.mjs';
import { judgeResidual } from './judge.mjs';
import { compileEffects } from './intent.mjs';

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
  judgeMode: 'residual',
  judgeAutoAllow: true,
  judgeTimeoutMs: 8000,
  verifyMode: 'on',
  intentMode: 'on',
  evidenceWindow: 'latest',
  evidenceRecent: 3,
  evidenceTurns: 5,
  verifierScope: 'workspace',
  scriptAudit: 'on',
  authStyle: 'strict',
  customScope: '',
  verifierAsk: 'on',
  provenanceMode: 'on',
  coverageMode: 'on',
  readGate: 'shadow',
  readGateSample: 15,
  agentFinal: false,
  reviewerMode: 'agent',
  benchOut: '',
  blastLimit: 1000,
  cachePath: '',
  outputMinimize: 'on',
  reviewerModel: '',
  taskId: '',
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
  judgeMode: Schema.union(['off', 'residual']).default('residual').description('残余 LLM 判定'),
  judgeAutoAllow: Schema.boolean().default(true).description('允许复核放行（仅限项目内/非敏感/非批量/非出网/非不透明）'),
  judgeTimeoutMs: Schema.number().default(8000).description('复核超时；超时转人工'),
  verifyMode: Schema.union(['off', 'on']).default('on').description('独立核查：只读探针，只回事实'),
  intentMode: Schema.union(['off', 'on']).default('on').description('语义引文：从原话抽取契约条目'),
  evidenceWindow: Schema.union(['latest', 'recent', 'session']).default('latest').description('授权证据窗口：只看最后一条指令（默认）或整个会话'),
  evidenceTurns: Schema.number().default(5).description('送给意图抽取的最近对话轮数（只用于消歧，不构成授权）'),
  verifierScope: Schema.union(['workspace', 'any']).default('workspace').description('核查探针的范围：默认只看工作区（软链解析后）'),
  authStyle: Schema.union(['strict', 'goal', 'custom']).default('strict').description('授权风格：strict=未被原话覆盖即范围外；goal=服务目标即可；custom=用 customScope'),
  customScope: Schema.string().default('').description('authStyle=custom 时的范围说明'),
  scriptAudit: Schema.union(['off', 'on']).default('on').description('脚本可读化：静态检查无危险 API 的脚本可按引文放行'),
  verifierAsk: Schema.union(['off', 'on']).default('on').description('询问时由独立 verifier 生成四段式问题（只能收紧）'),
  provenanceMode: Schema.union(['off', 'on']).default('on').description('来源事实：本任务内 agent 创建的文件，读写删不再反复询问'),
  coverageMode: Schema.union(['off', 'on']).default('on').description('覆盖判断：字面命中失败时，由模型判断目标是否落在授权内'),
  agentFinal: Schema.boolean().default(false).description('把所有变更类判定交给审查 agent（引文只作为证据，不再直接放行）'),
  readGateSample: Schema.number().default(15).description('shadow 模式抽样比例（%），降低语义复核开销'),
  readGate: Schema.union(['off', 'shadow', 'on']).default('shadow').description('读闸门：shadow=只记录词法与语义是否一致；on=语义不同意就不放行'),
  outputMinimize: Schema.union(['off', 'on']).default('on').description('结果侧最小化：对工具返回做裁剪与脱敏'),
  cachePath: Schema.string().default('').description('语义/判定缓存的落盘路径（空=仅内存）'),
  reviewerModel: Schema.string().default('').description('审查 agent 使用的模型（空=同会话）'),
  blastLimit: Schema.number().default(1000).description('审查 agent 估出的影响面超过该值就不自动放行'),
  benchOut: Schema.string().default('').description('评测用：设置后第一次工具调用时跑纯 agent 评测并写入该文件'),
  reviewerMode: Schema.union(['off', 'agent']).default('agent').description('审查由独立 subagent 承担（只读工具 + 结构化输出）；不可用时自动退回提示词审查'),
  taskId: Schema.string().default('').description('空 = 用会话 id'),
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

/** 稳定的小哈希，用来做确定性抽样（同一签名永远落到同一档）。 */
function hash32(text) {
  let h = 2166136261;
  const s = String(text);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** shell 工具集合：效果在命令文本里，不按 schema 判。 */
const SHELL_TOOLS = new Set(['pwsh', 'powershell', 'bash', 'sh', 'shell', 'cmd', 'run_command']);

/** 命令文本里出现任何"变更/外发"迹象（编译结果的独立第二意见）。 */
const MUTATION_HINT = /(remove-item|\brm\b|\bdel\b|erase\b|rmdir|\brd\b|set-content|add-content|out-file|new-item|move-item|copy-item|\bmv\b|\bcp\b|robocopy|curl|wget|invoke-restmethod|invoke-webrequest|scp|sftp|upload|\bpost\b|\bput\b)/i;

/** 把 arguments 变成稳定字符串：同样一条命令每次得到同样的签名。 */function stableKey(value) {
  const seen = new WeakSet();
  const walk = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return '[circular]';
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
    return out;
  };
  return JSON.stringify(walk(value ?? {}));
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
  const audit = (entry) => {
    try { store.audit(entry); } catch { /* 审计失败不影响判定 */ }
    // 同时留一份判定流水在内存里，供"任务状态"使用（不落盘、不跨会话）
    try {
      if (entry.sid && ['allow', 'deny', 'ask', 'grant'].includes(entry.event)) {
        store.record(entry.sid, {
          event: entry.event,
          by: entry.by,
          op: entry.op ?? (entry.class ? String(entry.class).split('|')[0] : undefined),
          target: (Array.isArray(entry.targets) ? entry.targets[0] : undefined) ?? entry.cited,
          class: entry.class,
          why: entry.why ?? entry.reason,
        });
      }
    } catch { /* 记录失败不影响判定 */ }
  };

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

  /** callId → 调用签名（用于"完全相同的命令不重复问"） */
  const signatures = new Map();

  /** 本会话审批策略：never（完全权限档）时无法询问 */
  function approvalPolicy(agent) {
    try {
      const approval = ctx.get?.('approval');
      return approval?.overrideOf?.(agent?.session) ?? approval?.config?.policy;
    } catch { return undefined; }
  }

  /** 从 tools 注册表取工具定义（含参数 schema）。取不到就返回 undefined。 */
  function toolDefinition(callName, agent) {
    try {
      const tools = ctx.get?.('tools');
      const def = tools && typeof tools.get === 'function' ? tools.get(callName, agent) : undefined;
      return def && typeof def === 'object' ? def : undefined;
    } catch { return undefined; }
  }

  function classOfCall(agent, callName, args) {
    try {
      const cwd = cwdOf(agent);
      // 先用工具自己声明的 schema 推效果（对 MCP/第三方工具是唯一可靠来源），
      // 推不出来再回退到按参数名/命令文本的启发式。
      // **shell 工具例外**：它的效果在 command 文本里，schema 只能说"有个 command 参数"，
      // 拿 schema 判 pwsh 会把 `Remove-Item` 误判成读——这是真机验证时抓到的。
      const def = SHELL_TOOLS.has(callName) ? undefined : toolDefinition(callName, agent);
      const fromSchema = def ? effectOfSchema(def, args, cwd) : undefined;
      const effect = fromSchema ?? effectOf(callName, args, cwd);
      if (fromSchema && !schemaSeen.has(callName)) {
        schemaSeen.add(callName);
        console.log(`[capgate] schema-classified ${callName} -> ${classify(fromSchema, { root: cwd }).key}`);
      }
      return { effect, klass: classify(effect, { root: cwd }), cwd, viaSchema: !!fromSchema };
    } catch (err) {
      console.warn('[capgate] classify failed:', redact(String(err)));
      return undefined;
    }
  }

  function evidenceFor(agent, klass, effect, { allowOpaque = false } = {}) {
    // 只从 instruction 片段里取授权：用户粘贴的日志/网页是数据，不是授权。
    const evidence = collectEvidence(agent, { window: cfg.evidenceWindow, recent: cfg.evidenceRecent });
    const texts = evidence.instructions
      .map((m) => ({ text: instructionOnly(m.text), seq: m.seq, msgId: m.msgId }))
      .filter((t) => t.text.length > 0);
    if (texts.length === 0) return { ok: false, why: 'no instruction text in session' };

    // 不透明执行（脚本/解释器）里真正发生什么，命令文本看不出来：
    // 用户说"跑一下"并不等于"允许这个脚本做任何事"，所以一律不给引文授权。
    // 例外：脚本经过静态检查、没有任何危险 API（allowOpaque），此时它等价于"被读过的脚本"。
    if (effect.op === 'execute' && effect.opaque && !allowOpaque) {
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

  /**
   * 询问判定。kind 区分三种原因，便于看板与优化：
   *   impact   影响面（批量/通配/出网/提权）
   *   referent 目标没点名
   *   anomaly  目标看起来不对
   */
  const askDecision = (reason, label, display, meta = {}) => {
    const askKind = meta.kind ?? classifyAsk({
      cardinality: meta.cardinality,
      locks: meta.locks,
      wildcard: meta.wildcard,
      text: reason,
    });
    const tag = askKindLabel(askKind);
    return {
      kind: 'ask',
      askKind,
      reason,
      displayReason: display ?? {
        en: `capgate: ${label} (${tag.en}). Needs your decision.`,
        zh: `capgate：${label}（${tag.zh}）。需要你确认。`,
      },
    };
  };

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
  let benchStarted = false;
  const dormantSeen = new Set();
  const schemaSeen = new Set();

  /** 语义引文缓存：用户指令没变就不重复抽取（一次任务只花一次模型调用）。 */
  const intentCache = new Map();

  async function ensureIntent(agent, sid) {
    const ev = collectEvidence(agent, { taskId: cfg.taskId, window: cfg.evidenceWindow, recent: cfg.evidenceRecent, turns: cfg.evidenceTurns });
    const corpus = ev.instructions.map((m) => instructionOnly(m.text)).filter(Boolean).join('\n');
    if (!corpus.trim()) return [];
    const hash = `${corpus.length}:${corpus.slice(0, 60)}:${corpus.slice(-60)}`;
    const cached = intentCache.get(sid);
    if (cached && cached.hash === hash) return cached.entries;

    const context = ev.turns.map((t) => [t.user && ('USER: ' + t.user), t.assistant && ('ASSISTANT: ' + t.assistant)].filter(Boolean).join('\n')).join('\n---\n');
    const parsed = await extractIntent(ctx, agent, corpus, { context, timeoutMs: Math.max(4000, cfg.judgeTimeoutMs * 2) });
    if (!parsed) {
      intentCache.set(sid, { hash, entries: [] });
      return [];
    }
    const { accepted, rejected, residual } = validateIntent(ev, parsed);
    const entries = residual ? [] : effectiveEntries(accepted);
    intentCache.set(sid, { hash, entries });
    audit({
      event: 'intent', sid, accepted: entries.map((e) => `${e.op}:${e.target}`),
      rejected: rejected.length, residual,
    });
    return entries;
  }

  /**
   * 任务状态文本：把整条任务弧线（指令 / 已批准 / 已拒绝 / 近期判定 / 进度 / 本次调用 / 关系）
   * 交给判断方。机器能算的关系先算，算不出的留给它判断。
   */
  function taskContextText(exec, sid, call) {
    try {
      const state = buildTaskState(exec.agent, {
        decisions: store.decisions(sid),
        cwd: call?.cwd ?? '',
        call: { op: call?.op, targets: call?.targets ?? [] },
      });
      return renderTaskState(state, relationOf(state, call?.targets ?? []));
    } catch {
      return '(task state unavailable)';
    }
  }

  /**
   * 读闸门：词法说"这是读"时，放行前问一次语义。
   * 三种模式：
   *   off    — 维持旧行为（不放语义调用）
   *   shadow — 照旧放行，但记录词法与语义是否一致（用来量词法的错误率）
   *   on     — 语义必须同意"读"，否则不放行（fail-closed）
   */
  async function readGate(exec, klass, sid, effect) {
    // 置信度低（认不出动词、靠包装认出来的）不允许 shadow 放过：
    // 等价于把这一条强制提升到 readGate=on。
    const lowConfidence = effect?.confidence === 'low';
    if (cfg.readGate === 'off' && !lowConfidence) return 'ok';
    if (lowConfidence) {
      audit({ event: 'read_gate', sid, tool: exec.name, class: klass.key, mode: 'forced', reason: 'low-confidence' });
    }
    let sem;
    try {
      sem = await resolveEffect(ctx, exec.agent, {
        tool: exec.name, args: exec.arguments, timeoutMs: cfg.judgeTimeoutMs,
      });
    } catch {
      sem = undefined;
    }
    const agree = sem ? sem.op === 'read' : undefined;
    audit({
      event: 'read_gate', sid, tool: exec.name, class: klass.key,
      mode: cfg.readGate, lex: 'read', sem: sem?.op, source: sem?.source, agree,
    });
    if (!sem) return cfg.readGate === 'on' ? 'blocked' : 'ok';   // on 拿不到语义 → 不放行
    if (sem.op === 'read') return 'ok';
    if (cfg.readGate === 'shadow') {
      console.log(`[capgate] read-gate-disagree lex=read sem=${sem.op}`);
      return 'ok';
    }
    console.log(`[capgate] read-gate-blocked lex=read sem=${sem.op}`);
    return 'blocked';
  }

  /**
   * 语义解除：把"锁"交给判断方，让它带引文说明"用户确实说了这个范围"。
   *
   * 只对**意图类**锁有效（批量/出网/不透明/提权）——这些缺的是"用户想不想"。
   * sensitive（凭据）与 unknown（效果不可知）缺的是事实，任何引文都补不上，
   * 所以不走这条路，仍然由前面的分支直接处理。
   */
  /** 把"这一类本会话被批准过"变成证据文本（给审查者，而不是拿来机械放行）。 */
  /** 事实扫描目录：工作区 + 运维通过 CAPGATE_FACTS_DIRS 额外指定的登记处。 */
  function factDirs(cwd) {
    const extra = String(process.env.CAPGATE_FACTS_DIRS ?? '').split(/[;:]/).map((s) => s.trim()).filter(Boolean);
    return [...new Set([cwd, ...extra].filter(Boolean))];
  }

  /** 每次调用的引文证据（供审查者用；放在闭包里按 callId 取，避免作用域问题）。 */
  const citationByCall = new Map();
  function citationFactsOf(callId) {
    return citationByCall.get(String(callId)) ?? [];
  }

  function priorFactsFor(sid, key) {
    const g = store.isGranted(sid, key) ? store.grantInfo(sid, key) : undefined;
    if (!g) return [];
    return [
      'already approved this session for class ' + key
      + ': targets=' + ((g.targets ?? []).join(', ') || '(not recorded)')
      + '; via ' + (g.via ?? 'human'),
      ...(g.citation ? ['approval citation: ' + g.citation] : []),
    ];
  }

  async function trySemanticClear(exec, { klass, effect, locks, sid, cwd }) {
    if (cfg.coverageMode !== 'on') return undefined;
    const CLEARABLE = new Set(['batch', 'egress', 'opaque', 'privilege']);
    const hard = locks.filter((l) => !CLEARABLE.has(l));
    if (hard.length > 0) return undefined;          // 有不可解除的锁 → 不做语义解除
    if (locks.length === 0) return undefined;

    try {
      const entries = await ensureIntent(exec.agent, sid);
      if (entries.length === 0) return undefined;

      const targets = effect.targets
        .filter((t) => t.kind === 'path' || t.kind === 'db' || t.kind === 'host')
        .map((t) => t.value);
      if (targets.length === 0) return undefined;

      const ev = collectEvidence(exec.agent, { window: cfg.evidenceWindow, recent: cfg.evidenceRecent, turns: cfg.evidenceTurns });
      const instructions = ev.instructions.map((m) => instructionOnly(m.text)).filter(Boolean).join('\n').slice(-1500);
      const turns = ev.turns
        .map((t) => [t.user && (`USER: ${t.user}`), t.assistant && (`ASSISTANT: ${t.assistant}`)].filter(Boolean).join('\n'))
        .join('\n---\n')
        .slice(-1500);

      // 判断交给独立审查 agent：它可以自己枚举、抽样、看内容，然后给出语义结论。
      // 我们只把结论映射成动作。
      const probe = verify({ op: klass.op, targets }, { scope: { mode: cfg.verifierScope, root: cwd ?? '' } });
      // 归属、身份、远端这类事实不写死成规则：从环境里取回来交给审查者自己判。
      const envFacts = discover({
        kind: effect.targets[0]?.kind,
        target: effect.targets[0]?.value,
        cwd: cwd ?? '',
        dirs: factDirs(cwd ?? ''),
      });
      const stateText = taskContextText(exec, sid, { op: klass.op, targets, cwd });
      const judged = await reviewWithAgent(ctx, exec.agent, {
        tool: exec.name,
        args: JSON.stringify(exec.arguments ?? {}),
        op: klass.op,
        targets,
        locks,
        facts: [...factList(probe), ...envFacts, ...priorFactsFor(sid, klass.key), ...citationFactsOf(exec.callId)],
        __auditFacts: (f) => audit({ event: 'review_facts', sid, tool: exec.name, class: klass.key, n: f.length, sample: f.filter((x) => /record in /.test(x)).slice(0, 2) }),
        instructions,
        turns,
        state: stateText,
      }, { timeoutMs: Math.max(10000, cfg.judgeTimeoutMs), retries: 1 });
      if (!judged) return undefined;

      const coveredTargets = new Set(judged.covered);
      const uncovered = targets.filter((t) => !coveredTargets.has(t));
      audit({
        event: 'coverage', sid, tool: exec.name, class: klass.key, locks, via: judged.via,
        covered: [...coveredTargets], uncovered,
        cleared: judged.clear.map((c) => c.lock), blast: judged.blast, dataClass: judged.dataClass,
        consistency: judged.consistency,
      });
      // 覆盖：要么目标全被覆盖，要么审查 agent 直接判定 allow（它有权这么说）
      const allCovered = uncovered.length === 0 && judged.uncovered.length === 0;
      const saysAllow = judged.verdict === 'allow';
      if (!allCovered && !saysAllow) return undefined;

      // 每把锁都必须被解释过，且解释必须附引文；审查 agent 判 allow 时视为已解释
      const clearedSet = new Set(judged.clear.filter((c) => c.quote).map((c) => c.lock));
      if (!saysAllow && !locks.every((l) => clearedSet.has(l))) return undefined;

      // 后果语义（由审查 agent 自己查出来的）：不可逆或影响面过大 → 不放行
      const blast = judged.blast;
      if (blast) {
        if (blast.reversible === 'no') return undefined;
        if (Number.isFinite(blast.estimate) && blast.estimate > cfg.blastLimit) return undefined;
      }
      // 数据和调用所声称的动作不一致 → 不放行
      if (judged.consistency === 'mismatch') return undefined;
      // 凭据类数据 → 永不放行（由 agent 判定，不靠路径表）
      if (judged.dataClass === 'credential') return undefined;
      return judged;
    } catch (err) {
      audit({ event: 'coverage_failed', sid, tool: exec.name, reason: String(err && err.message ? err.message : err) });
      return undefined;
    }
  }

  /**
   * 会提问的调查员：把"要问人"变成一份四段式问题。
   * 它只能收紧（verdict=deny）或把问题问得更好，**不能放行**。
   * 任何失败都退回原来的纯文本问题——绝不因为审查失败而卡住或放行。
   */
  async function askViaVerifier(exec, { label, klass, effect, reason, cwd }) {
    if (cfg.verifierAsk !== 'on') return undefined;
    try {
      const ev = collectEvidence(exec.agent, {
        window: cfg.evidenceWindow, recent: cfg.evidenceRecent, turns: cfg.evidenceTurns,
      });
      const instructions = ev.instructions.map((m) => instructionOnly(m.text)).filter(Boolean).join('\n').slice(-1500);
      const turns = ev.turns
        .map((t) => [t.user && (`USER: ${t.user}`), t.assistant && (`ASSISTANT: ${t.assistant}`)].filter(Boolean).join('\n'))
        .join('\n---\n')
        .slice(-1500);
      const targets = effect.targets.filter((t) => t.kind === 'path').map((t) => t.value);

      const probe = verify({ op: klass.op, targets }, { scope: { mode: cfg.verifierScope, root: cwd ?? '' } });
      // 归属、身份、远端这类事实不写死成规则：从环境里取回来交给审查者自己判。
      const envFacts = discover({
        kind: effect.targets[0]?.kind,
        target: effect.targets[0]?.value,
        cwd: cwd ?? '',
        dirs: factDirs(cwd ?? ''),
      });
      const facts = [...factList(probe), ...envFacts, ...priorFactsFor(sidOf(exec.agent), klass.key), ...citationFactsOf(exec.callId)];

      // 优先让独立审查 agent 来判（它有自己的上下文和只读工具）；
      // 不可用/失败时退回单次提示词审查。
      if (cfg.reviewerMode !== 'off') {
        const agentReview = await reviewWithAgent(ctx, exec.agent, {
          tool: exec.name,
          args: JSON.stringify(exec.arguments ?? {}),
          op: klass.op,
          targets,
          locks: locksOf(klass, effect),
          facts,
          instructions,
          turns,
          state: taskContextText(exec, sidOf(exec.agent), { op: klass.op, targets, cwd }),
          style: cfg.authStyle,
          customScope: cfg.customScope,
        style: cfg.authStyle,
        customScope: cfg.customScope,
        }, { timeoutMs: Math.max(5000, cfg.judgeTimeoutMs) });
        if (agentReview) {
          const text = renderAsk({
            action: agentReview.action || label,
            facts: agentReview.facts,
            suggestion: agentReview.suggestion,
            alternatives: agentReview.alternatives,
          });
          audit({
            event: 'ask_review', sid: sidOf(exec.agent), tool: exec.name, class: klass.key,
            via: agentReview.via, verdict: agentReview.verdict, reason,
          });
          return { ...agentReview, text, alternatives: agentReview.alternatives };
        }
      }

      const text = await callModel(ctx, exec.agent, {
        system: 'You write one clear review question for a human. Output JSON only.',
        prompt: buildAskPrompt({
          tool: exec.name,
          args: JSON.stringify(exec.arguments ?? {}),
          op: klass.op,
          targets,
          locks: locksOf(klass, effect),
          facts,
          instructions,
          turns,
        }),
        timeoutMs: cfg.judgeTimeoutMs,
      });
      const q = text ? parseAsk(text) : undefined;
      // 输出不像一个问题（模型回了别的东西）→ 当作没审查，退回原文案。
      if (!q || !q.action || q.action === '(未说明)') return undefined;

      // 它要的额外探针：只能指向本次调用的目标，最多 2 个
      const extra = [];
      for (const p of q.probes) {
        if (!targets.includes(p.target)) continue;
        const r = verify({ op: 'read', targets: [p.target] }, { scope: { mode: cfg.verifierScope, root: cwd ?? '' } });
        extra.push(...factList(r, 2));
        if (extra.length >= 3) break;
      }

      const out = { ...q, text: renderAsk(q, extra.slice(0, 3)) };
      audit({
        event: 'ask_review', sid: sidOf(exec.agent), tool: exec.name, class: klass.key,
        verdict: q.verdict, probes: q.probes.length, reason,
      });
      return out;
    } catch (err) {
      audit({ event: 'ask_review_failed', sid: sidOf(exec.agent), reason: String(err && err.message ? err.message : err) });
      return undefined;
    }
  }

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
    const decision = await decideCall(exec, next);
    // 统一记一条判定流水：口径分析（误报 vs 请示）需要"决策 + 目标"这一段。
    try {
      if (decision && decision.kind !== 'cancel' && exec?.agent && active(exec.agent)) {
        const c = classOfCall(exec.agent, exec.name, exec.arguments);
        if (c) {
          // ask 的原因按**这一类调用的性质**再校准一次：
          // 批量/通配/带锁就是影响面，不管提示词怎么措辞。
          if (decision.kind === 'ask') {
            decision.askKind = classifyAsk({
              cardinality: cardinalityOf(c.effect),
              locks: locksOf(c.klass, c.effect),
              wildcard: c.effect?.wildcard,
              text: decision.reason,
            });
          }
          audit({
            event: 'decision',
            sid: sidOf(exec.agent),
            tool: exec.name,
            kind: decision.kind,
            askKind: decision.askKind,
            by: decision.by ?? decision.reason ?? '',
            class: c.klass?.key,
            targets: (c.effect?.targets ?? []).map((t) => `${t.kind}:${t.value}`),
            cardinality: cardinalityOf(c.effect),
          });
        }
      }
    } catch { /* 记流水失败不影响判定 */ }
    return decision;
  }, { prepend: true });

  async function decideCall(exec, next) {
    if (!exec.agent) return next();
    if (!active(exec.agent)) {
      noteDormant(exec.agent, exec.name);
      return next();
    }

    const sid = sidOf(exec.agent);

    // 评测开关：第一次工具调用时在运行时内跑纯 agent 评测，结果写文件。
    if (cfg.benchOut && !benchStarted) {
      benchStarted = true;
      setTimeout(() => {
        runAgentBench({ agent: exec.agent })
          .then((r) => { try { writeFileSync(cfg.benchOut, r.text, 'utf8'); } catch (e) { console.log('[capgate] bench write failed: ' + (e && e.message)); } })
          .catch((e) => { console.log('[capgate] bench failed: ' + (e && e.message ? e.message : e)); })
          .finally(() => { console.log('[capgate] agentbench finished -> ' + cfg.benchOut); });
      }, 500);
    }

    // 0. 绝对危险：词法层唯一保留的否决权。
    //    命中即拒绝，不进入后续任何"可以商量"的路径；规则 id 进审计，可解释。
    {
      const rawText = typeof exec.arguments?.command === 'string' ? exec.arguments.command
        : typeof exec.arguments?.cmd === 'string' ? exec.arguments.cmd
        : typeof exec.arguments?.script === 'string' ? exec.arguments.script
        : JSON.stringify(exec.arguments ?? {});
      const danger = absoluteDanger(rawText);
      if (danger) {
        audit({ event: 'deny', by: 'absolute-danger', rule: danger.rule, sid, tool: exec.name });
        store.bump(sid, 'deny');
        return {
          kind: 'deny',
          reason: `capgate: 绝对危险操作，已拒绝（${danger.why}）。规则：${danger.rule}`,
        };
      }
    }

    const classified = classOfCall(exec.agent, exec.name, exec.arguments);
    if (!classified) return guardAsk(exec.agent, askDecision('capgate: 无法解析本次调用的效果', '无法解析效果'), '无法解析效果');
    const { effect, klass, cwd } = classified;
    const label = describeClass(klass);

    // 0b 会话级反绕过：同一个效果（换个写法/换个工具）刚被拒过 → 直接拒，不再问人。
    const fp = effectFingerprint({
      op: klass.op,
      targets: effect.targets.filter((t) => t.kind === 'path' || t.kind === 'db').map((t) => t.value),
    });
    const sig = exec.name + '|' + stableKey(exec.arguments);
    const noteDeny = () => { try { store.rememberDenied(sid, fp, sig); } catch { /* ignore */ } };
    const deniedInfo = store.deniedInfo(sid, fp);
    // 同一个效果、但写法/工具变了 → 判为绕过，直接拒；同一签名重复 → 交给原有的重复计数（第三次转人工）
    const deniedBefore = deniedInfo && deniedInfo.sig !== sig ? deniedInfo.count : 0;
    if (deniedBefore > 0) {
      audit({ event: 'deny', by: 'anti-bypass', sid, tool: exec.name, class: klass.key, fp, count: deniedBefore });
      store.bump(sid, 'deny');
      return {
        kind: 'deny',
        reason: `capgate: 同一个效果刚才已被拒绝（第 ${deniedBefore + 1} 次尝试，仅换了写法）。`
          + '换一种工具或措辞不会改变判定；如果确实需要，请让用户明确说出范围。',
      };
    }

    // 完全相同的调用只问一次：签名 = tool + 稳定序列化的参数
    const signature = `${exec.name}|${stableKey(exec.arguments)}`;
    if (exec.callId) signatures.set(String(exec.callId), signature);

    /** 这次调用是否在请求放宽沙箱（工具随后一定会自己发起原生审批）。 */
    const escalationMode = typeof exec.arguments?.sandbox_permissions === 'string'
      ? exec.arguments.sandbox_permissions
      : undefined;

    // 1.0 用户规则（deny 优先）
    //      规则只允许"拒绝"直接生效；"允许"在 agentFinal 打开时降级为证据，
    //      交给审查 agent —— 变更类操作的放行不该由规则给出。
    const ruled = evaluateRules(rules, { tool: exec.name, effect });
    if (ruled?.kind === 'deny') {
      store.bump(sid, 'deny');
      audit({ event: 'deny', by: 'rule', rule: ruled.rule, sid, tool: exec.name, class: klass.key });
      return { kind: 'deny', reason: `capgate 规则拒绝（${ruled.rule}）` };
    }
    const ruleFacts = ruled?.kind === 'allow'
      ? [`a user-configured allow rule matches this call: ${ruled.rule}`]
      : [];
    if (ruled?.kind === 'allow' && !cfg.agentFinal) {
      store.bump(sid, 'allow');
      audit({ event: 'allow', by: 'rule', rule: ruled.rule, sid, tool: exec.name, class: klass.key });
      return next();
    }
    if (ruleFacts.length) {
      audit({ event: 'prior', by: 'rule', sid, tool: exec.name, class: klass.key, rule: ruled.rule });
      if (exec.callId) citationByCall.set(String(exec.callId), ruleFacts);
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
        const sensOpts = minimizeOptions({
          op: klass.op,
          targets: effect.targets.filter((t) => t.kind === 'path').map((t) => t.value),
        });
        return {
          kind: 'deny',
          reason: `capgate: 拒绝（敏感路径在项目外）。凭据类文件不允许读取。`
            + (sensOpts.length ? `\n${describeMinimize(sensOpts)}` : ''),
          alternatives: sensOpts.map((o) => o.label),
        };
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

    // 1.2d 多目标拆分：一条命令带 N 个目标时，只放被点名的那部分。
    //      真实失败模式是 `scancel a b c` 里只有 a 被授权：整条放 → 漏 2 个；整条拒 → 误 1 个。
    //      做法：按"用户原话里逐字出现"逐个目标判断，混合时直接给出**收窄后的命令**。
    //      这是纯收紧：只会让判定更严，不会放宽任何原本要问的调用。
    if (SHELL_TOOLS.has(exec.name)) {
      const command = String(exec.arguments?.command ?? exec.arguments?.cmd ?? exec.arguments?.script ?? '');
      const corpus = collectInstructionTexts(exec.agent).join('\n').toLowerCase();
      if (command && corpus) {
        const coveredLiteral = (t) => {
          const v = String(t).replace(/^["']|["']$/g, '').toLowerCase();
          const tail = v.split('/').pop();
          return corpus.includes(v) || (tail && tail.length >= 4 && corpus.includes(tail));
        };
        const split = splitDecision(command, coveredLiteral);
        if (split?.mixed) {
          store.bump(sid, 'deny');
          noteDeny();
          audit({
            event: 'deny', reason: 'split-mixed', sid, tool: exec.name, class: klass.key,
            keep: split.keep.slice(0, 5), drop: split.drop.slice(0, 5), narrowed: split.narrowed,
          });
          return {
            kind: 'deny',
            reason: `capgate: 这条命令带了 ${split.split.targets.length} 个目标，其中只有 ${split.keep.length} 个被用户点名。`
              + '整条执行会动到没被授权的目标，所以拆开做。',
            alternatives: split.narrowed ? [{ label: '只对已点名的目标执行', op: 'run', scope: split.narrowed }] : undefined,
          };
        }
      }
    }

    // 1.2b 完全相同的命令已被人工批准过 → 直接放行（不推广到"同类"，只认同一条）
    if (store.hasSignature(sid, signature)) {
      store.bump(sid, 'allow');
      store.bump(sid, 'reuse'); audit({ event: 'allow', by: 'identical', sid, tool: exec.name, class: klass.key });
      return next();
    }

    // 1.2c 落在"人批准过的目标范围"里 → 放行。
    //      范围是人在批准那一刻给出的集合，模型无法扩张它；判定是纯集合包含。
    if (klass.op === 'delete' || klass.op === 'write') {
      const pathTargets = effect.targets.filter((t) => t.kind === 'path').map((t) => t.value);
      if (store.coveredByExtent(sid, klass.op, pathTargets)) {
        store.bump(sid, 'allow');
        store.bump(sid, 'reuse'); audit({ event: 'allow', by: 'extent', sid, tool: exec.name, class: klass.key, targets: pathTargets.slice(0, 5) });
        return next();
      }
    }

    // 1.2b 已硬化的放行规则（必须经人显式确认；敏感路径已在上面被拦下）
    if (hasRule(learned, klass.key, 'allow')) {
      store.bump(sid, 'allow');
      audit({ event: 'allow', by: 'learned-allow', sid, tool: exec.name, class: klass.key });
      return next();
    }

    // 1.3 项目内普通读：词法说"读"，但放行前要过语义闸门。
    //     readGate=shadow：只记录词法与语义是否一致（不改行为，用来量错误率）
    //     readGate=on    ：语义必须也说"读"，否则不放行（fail-closed）
    if (cfg.autoAllowReads && klass.op === 'read' && klass.scope === 'workspace') {
      const gate = await readGate(exec, klass, sid, effect);
      if (gate === 'ok') {
        store.bump(sid, 'allow');
        store.bump(sid, 'proof'); audit({ event: 'allow', by: 'read-fast-path', sid, tool: exec.name, class: klass.key });
        return next();
      }
    }

    // 1.3b 项目外普通读（同样要过读闸门；形状缓存让第二次判断不再花调用）
    if (cfg.autoAllowOutsideReads && klass.op === 'read') {
      const gate = await readGate(exec, klass, sid, effect);
      if (gate === 'ok') {
        store.bump(sid, 'allow');
        store.bump(sid, 'proof'); audit({ event: 'allow', by: 'outside-read-fast-path', sid, tool: exec.name, class: klass.key });
        return next();
      }
    }

    // 1.4 已授予的类：**不再机械放行**，改成把"这一类之前被批准过"当成证据交给审查者。
    //     机械放行等于把一次批准扩散成一张许可证；而"这次的目标还算不算同类"
    //     恰恰是模型比分类键更会判的东西（比如同是 delete，别人的分支就不该算）。
    //     批量的批准本来就不落到类上（perAction），所以这里不会放宽批量。
    const priorGrant = store.isGranted(sid, klass.key) ? store.grantInfo(sid, klass.key) : undefined;
    const priorFacts = priorGrant
      ? [
        'already approved this session for class ' + klass.key
        + ': targets=' + ((priorGrant.targets ?? []).join(', ') || '(not recorded)')
        + '; via ' + (priorGrant.via ?? 'human'),
        ...(priorGrant.citation ? ['approval citation: ' + priorGrant.citation] : []),
      ]
      : [];
    if (priorGrant) {
      audit({ event: 'prior', sid, tool: exec.name, class: klass.key, targets: (priorGrant.targets ?? []).slice(0, 5) });
    }

    // 1.5 批量/通配：先让判断方带引文解释"用户是不是明说了这个范围"。
    //     解释不了才问人——不再无条件拦。
    if (cardinalityOf(effect) === 'many') {
      const locksNow = locksOf(klass, effect);
      const cleared = await trySemanticClear(exec, { klass, effect, locks: locksNow, sid, cwd });
      if (cleared) {
        store.approveSignature(sid, stableKey(exec.name, exec.arguments));
        store.bump(sid, 'reuse');
        audit({
          event: 'allow', by: 'semantic-clear', sid, tool: exec.name, class: klass.key,
          locks: cleared.clear.map((c) => c.lock), quote: cleared.clear.map((c) => c.quote).join(' | ').slice(0, 200),
        });
        console.log(`[capgate] semantic-clear ${klass.key} (${cleared.clear.map((c) => c.lock).join(',')})`);
        return next();
      }
      store.rememberPending(sid, exec.callId, {
        key: klass.key, label, autoEligible: false, batch: true,
        op: klass.op, targets: effect.targets.filter((t) => t.kind === 'path').map((t) => t.value),
      });
      store.bump(sid, 'ask');
      audit({ event: 'ask', sid, tool: exec.name, class: klass.key, autoEligible: false, why: 'batch' });
      return guardAsk(exec.agent, askDecision(`capgate: ${label}（批量或通配目标，需人工确认）`, label), label);
    }

    // 1.5c 脚本可读化：不透明的执行，如果脚本本身没有任何危险 API，
    //      就把它当作"被读过的脚本"，允许引文授权（仍然要有用户原话点名）。
    let scriptInfo;
    if (cfg.scriptAudit === 'on' && effect.op === 'execute' && effect.opaque) {
      const scriptPath = effect.targets
        .filter((t) => t.kind === 'path')
        .map((t) => t.value)
        .find((v) => { try { return existsSync(v) && statSync(v).isFile(); } catch { return false; } });
      if (scriptPath) {
        // 先用 agent 自己读过的那份内容（可审计、可对账），没有再自己读盘。
        // 对账：读时 hash 与执行时 hash 不一致 → 内容在两次之间变过 → 不采信那份内容。
        const seen = findReadContent(exec.agent, scriptPath, { cwd });
        let stale = false;
        if (seen) {
          try {
            const current = readFileSync(scriptPath, 'utf8');
            stale = hashText(current) !== hashText(seen.content);
          } catch {
            stale = true;
          }
        }
        scriptInfo = stale
          ? { kind: 'risky', facts: [{ type: 'script.stale', target: scriptPath, value: seen?.hash }], reason: '脚本在 agent 读完后被修改过' }
          : inspectScript(scriptPath, seen ? { content: seen.content } : {});
        audit({
          event: 'script', sid, tool: exec.name, script: scriptPath, kind: scriptInfo.kind,
          source: seen ? 'session-read' : 'fs', readCallId: seen?.callId, stale,
          facts: scriptInfo.facts.map((f) => f.type), reason: scriptInfo.reason,
        });
        if (scriptInfo.kind === 'ok') console.log(`[capgate] script-ok ${scriptPath} (${seen ? 'session' : 'fs'})`);
        if (stale) console.log(`[capgate] script-stale ${scriptPath}`);
      }
    }

    // 1.6 引文核对：对上就直接授予并放行（不经审批面）
    const evidence = evidenceFor(exec.agent, klass, effect, { allowOpaque: scriptInfo?.kind === 'ok' });
    // agentFinal=on：引文不算判决，只算证据。判定交给审查 agent。
    const citationFacts = [];
    if (exec.callId) citationByCall.set(String(exec.callId), citationFacts);
    if (evidence.ok) {
      const quoted = String(evidence.primary?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
      citationFacts.push('user words that appear to authorize this call: "' + quoted + '"');
    }
    if (evidence.ok && !cfg.agentFinal) {
      if (scriptInfo?.kind === 'ok') {
        // 脚本可读：只记签名（同一条命令复用时不再问），不授予整个类
        store.approveSignature(sid, signature);
        store.bump(sid, 'script');
        audit({ event: 'allow', by: 'script-read', sid, tool: exec.name, class: klass.key, script: scriptInfo.facts[0]?.target });
        return next();
      }
      store.grant(sid, klass.key, { via: 'citation', citation: evidence.primary });
      store.bump(sid, 'grant');
      store.bump(sid, 'citation'); audit({ event: 'grant', by: 'citation', sid, tool: exec.name, class: klass.key, cited: evidence.primary.text });
      return next();
    }

    // 1.6a 来源事实：目标如果是**本任务里 agent 自己创建**的，删/改它不必反复打断。
    //      只对已放行过的工具调用生效；敏感路径在上面已经拦掉了，走不到这里。
    if (!evidence.ok && cfg.provenanceMode === 'on' && ['read', 'write', 'delete'].includes(klass.op)) {
      const pathTargets = effect.targets.filter((t) => t.kind === 'path').map((t) => t.value);
      if (pathTargets.length > 0) {
        const prov = collectProvenance(exec.agent, { cwd });
        const owned = klass.op === 'read' ? allRead(prov, pathTargets, cwd) : allCreated(prov, pathTargets, cwd);
        if (owned) {
          store.bump(sid, 'reuse');
          audit({
            event: 'allow', by: 'provenance', sid, tool: exec.name, class: klass.key,
            targets: pathTargets.slice(0, 5), op: klass.op,
          });
          return next();
        }
      }
    }

    // 1.6b 语义引文：原文没逐字提到，但模型从原话里抽出的契约条目覆盖了这次调用。
    //      只在"没有锁死类别"时生效——批量/出网/不透明/提权/未知仍然必须问人。
    //      抽取失败的语义（residual / 无 span）一律不算授权（fail-closed）。
    if (!evidence.ok && cfg.intentMode === 'on' && klass.op !== 'other' && !cfg.agentFinal) {
      const locksNow = locksOf(klass, effect);
      if (locksNow.length === 0 || (locksNow.length === 1 && locksNow[0] === 'unknown')) {
        try {
          const entries = await ensureIntent(exec.agent, sid);
          // 路径和表名都参与比较：数据库目标内部带 db: 前缀，intentCovers 会统一剥掉。
          const cmpTargets = effect.targets
            .filter((t) => t.kind === 'path' || t.kind === 'db')
            .map((t) => t.value);

          // 快路：字面命中（便宜、确定）。没命中才让模型做指代消解。
          let hit = intentCovers(entries, { op: klass.op, targets: cmpTargets });
          let by = 'intent';
          if (!hit && cfg.coverageMode === 'on' && cmpTargets.length > 0) {
            const judged = await judgeCoverage(ctx, exec.agent, {
              op: klass.op,
              targets: cmpTargets,
              entries,
              instructions: instructionOnly(evidence.primary?.text ?? '') || undefined,
              timeoutMs: cfg.judgeTimeoutMs,
            });
            if (judged) {
              audit({
                event: 'coverage', sid, tool: exec.name, class: klass.key,
                covered: judged.covered.map((c) => `${c.target}#${c.entry}`),
                uncovered: judged.uncovered, all: judged.allCovered,
              });
            }
            if (judged?.allCovered) {
              const cited = judged.covered.map((c) => entries[c.entry]).filter(Boolean);
              hit = { entries: cited, span: cited[0]?.span };
              by = 'coverage';
            }
          }
          if (hit) {
            console.log(`[capgate] ${by}-grant ${klass.key}`);
            store.grant(sid, klass.key, { via: by });
            store.bump(sid, 'grant');
            store.bump(sid, 'citation');
            audit({
              event: 'grant', by: 'intent', sid, tool: exec.name, class: klass.key,
              span: hit.span ? { msgId: hit.span.msgId, start: hit.span.start, end: hit.span.end } : undefined,
              entries: hit.entries.map((e) => `${e.op}:${e.target}`),
            });
            return next();
          }
        } catch (err) {
          audit({ event: 'intent_failed', sid, tool: exec.name, reason: String(err && err.message ? err.message : err) });
        }
      }
    }

    // 1.7 项目外 + 无引文 = 确定性拒绝（在复核之前）。
    //     让 LLM 先跑会把这条确定性边界软化成"问人"，既不更安全也更吵。
    if (klass.scope !== 'workspace') {
      const identity = `${exec.name}:${JSON.stringify(exec.arguments).slice(0, 200)}`;
      const repeats = store.repeat(sid, identity);
      const n = store.deny(sid, klass.key);
      store.bump(sid, 'deny');
      const outOpts = minimizeOptions({
        op: klass.op,
        targets: effect.targets.filter((t) => t.kind === 'path').map((t) => t.value),
      });
      noteDeny();
      audit({ event: 'deny', reason: 'outside-no-citation', sid, tool: exec.name, class: klass.key, why: evidence.why, count: n, repeats, alternatives: outOpts.map((o) => o.label) });
      if (n >= cfg.maxConsecutiveDenials || repeats > cfg.maxRepeats) {
        store.rememberPending(sid, exec.callId, { key: klass.key, label, autoEligible: false });
        return guardAsk(exec.agent, askDecision(`capgate: ${label} 已反复被拒（${Math.max(n, repeats)} 次），转人工核对`, label), label);
      }
      return {
        kind: 'deny',
        reason: 'capgate: 拒绝（目标在项目外，且用户原话没有提到它）。'
          + (outOpts.length ? `\n${describeMinimize(outOpts)}` : '义务: 改在项目内完成，或请用户明确指定该目标'),
        alternatives: outOpts.map((o) => o.label),
      };
    }

    // 1.8b 独立核查：只在"看不懂/不透明/要外发"时做，只读、有预算、只回事实。
    //      verifier 可以直接拒绝（收紧自由），但**不能放行**——放行仍要过策略。
    let verifyNote = '';
    const verifyWorthy = cfg.verifyMode === 'on' && (
      ['other', 'send', 'execute'].includes(klass.op)
      || (klass.op === 'read' && klass.scope !== 'workspace')
    );
    if (verifyWorthy) {
      try {
        const checked = verify({
          op: klass.op,
          targets: effect.targets.filter((t) => t.kind === 'path').map((t) => t.value),
        }, { scope: { mode: cfg.verifierScope, root: cwd } });
        console.log('[capgate] verify ' + klass.op + ' probes=[' + checked.probes.join(',') + '] facts=' + checked.facts.length + ' skip=' + checked.facts.filter((f) => f.type === 'scope.skipped').length);
        if (checked.facts.length > 0) {
          const summary = summarizeFacts(checked);
          verifyNote = summary;
          audit({ event: 'verify', sid, tool: exec.name, class: klass.key, probes: checked.probes, facts: summary });
        }
        if (checked.recommendation === 'deny') {
          const opts = minimizeOptions({
            op: klass.op,
            targets: effect.targets.filter((t) => t.kind === 'path').map((t) => t.value),
          });
          store.bump(sid, 'deny');
          audit({ event: 'deny', by: 'verifier', sid, tool: exec.name, class: klass.key, reason: checked.reason });
          return {
            kind: 'deny',
            reason: `capgate: ${checked.reason}。${checked.facts.length ? `（${summary}）\n` : '\n'}${describeMinimize(opts)}`,
            alternatives: opts.map((o) => o.label),
          };
        }
      } catch (err) {
        audit({ event: 'verify_failed', sid, tool: exec.name, reason: String(err && err.message ? err.message : err) });
      }
    }

    // 1.7b "看不懂的调用"交给效果编译器：模型只负责**翻译**成字面效果，
    //      放行/询问/拒绝仍由下面的确定性规则决定。
    if (klass.op === 'other' && cfg.judgeMode === 'residual') {
      const compiled = await compileEffects(
        ctx,
        exec.agent,
        { tool: exec.name, args: exec.arguments },
        { timeoutMs: cfg.judgeTimeoutMs },
      );
      if (compiled) {
        console.log(`[capgate] compiled ${exec.name} -> ${compiled.ops.map((o) => o.op).join('+')}${compiled.residual ? ' (residual)' : ''}`);
        const asEffect = (op, targets) => ({
          op,
          targets: targets.map((t) => (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(t) || /^https?:\/\//i.test(t)
            ? { kind: 'host', value: t.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase() }
            : { kind: 'path', value: normalizePath(t, cwd) })),
          wildcard: false,
          opaque: false,
          source: 'compiled',
          raw: 'compiled',
        });

        const mutation = compiled.ops.find((o) => o.op === 'delete' || o.op === 'send');
        if (mutation) {
          const eff = asEffect(mutation.op, mutation.targets);
          const k = classify(eff, { root: cwd });
          store.bump(sid, 'deny');
          audit({ event: 'deny', by: 'compiled', sid, tool: exec.name, class: k.key, targets: mutation.targets.slice(0, 5) });
          return {
            kind: 'deny',
            reason: `capgate: 编译结果是「${mutation.op}」${mutation.targets.length ? '：' + mutation.targets.slice(0, 3).join(', ') : ''}`
              + '；变更类操作不允许从"看不懂的调用"直接放行，请改用能说明目标的写法',
          };
        }

        const allRead = compiled.ops.every((o) => o.op === 'read');
        const allInside = compiled.ops.every((o) =>
          asEffect(o.op, o.targets).targets.every((t) => classify(asEffect(o.op, o.targets), { root: cwd }).scope === 'workspace'));
        // 两路独立意见取更严：编译说"纯读"，但如果命令文本里出现任何变更迹象，
        // 就当成冲突 → 问人。这样即使模型编译撒谎，也只能骗到"两边都说无害"的情况。
        const textHint = MUTATION_HINT.test(String(effect.raw ?? ''));
        // agentFinal=on：编译器的结论只作为证据交给审查 agent，不再自己放行。
        if (allRead && allInside && !compiled.residual && !textHint && cfg.judgeAutoAllow) {
          const compiledFact = 'effect compiler reads this call as read-only: '
            + compiled.ops.map((o) => `${o.op}(${o.targets.slice(0, 2).join(',') || '?'})`).join(' / ');
          if (cfg.agentFinal) {
            if (exec.callId) {
              const prev = citationByCall.get(String(exec.callId)) ?? [];
              citationByCall.set(String(exec.callId), [...prev, compiledFact]);
            }
            audit({ event: 'prior', by: 'compiled-read', sid, tool: exec.name, class: klass.key });
          } else {
            store.bump(sid, 'allow');
            audit({ event: 'allow', by: 'compiled-read', sid, tool: exec.name, class: klass.key });
            return next();
          }
        }

        // 编译出"项目内写/执行"或无法完全解析 → 问人，但把编译结果放进卡片
        const summary = compiled.ops.map((o) => `${o.op}(${o.targets.slice(0, 2).join(',') || '?'})`).join(' / ');
        const eff = asEffect(compiled.ops[0].op, compiled.ops[0].targets);
        store.rememberPending(sid, exec.callId, {
          key: classify(eff, { root: cwd }).key,
          label,
          autoEligible: false,
          op: compiled.ops[0].op,
          opaque: false,
          // 人批准后把"这批目标"记成范围，后续同类子集不再问
          targets: compiled.ops.flatMap((o) => o.targets),
        });
        store.bump(sid, 'ask');
        audit({ event: 'ask', sid, tool: exec.name, class: klass.key, compiled: summary, residual: compiled.residual });
        return guardAsk(
          exec.agent,
          askDecision(`capgate: 看不懂这条调用，编译器认为它是「${summary}」${compiled.residual ? '（含无法解析的部分）' : ''}`, label),
          label,
        );
      }
    }


    // 1.8 残余 LLM 判定（只处理"项目内、无引文"这一档）
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

      // LLM 复核只能"减问"，不能"放权"：
      // 命中任何"锁死类别"（LOCKS）就绝不由复核放行；否则只允许它在
      // 低风险层（项目内、非敏感、非批量、非出网、非不透明）直接放行。
      //
      // 例外（已废弃）：曾经允许"未知命令 + 文本里没有变更迹象"按纯读放行。
      // 但 scancel / aws s3 rm / kubectl apply 这类命令一个删除动词都没有，
      // 它们是**改名换姓的变更** —— 这个例外正是 cancel-jobs/artifacts 两族漏放的机制。
      // 现在：认不出效果（unknown）就不许复核放权，必须问人。
      const locks = locksOf(klass, effect);
      const hardLocked = locks;
      const judgeMayGrant = cfg.judgeAutoAllow
        && !cfg.agentFinal   // agentFinal：复核也不许放权，只能给证据
        && hardLocked.length === 0
        && (process.env.CAPGATE_NO_TIER === '1' || klass.scope === 'workspace');
      if (judgement.decision === 'allow' && judgeMayGrant) {
        store.grant(sid, klass.key, { via: 'judge' });
        store.bump(sid, 'grant');
        store.bump(sid, 'judge'); audit({ event: 'grant', by: 'judge', sid, tool: exec.name, class: klass.key, reason: judgement.reason });
        return next();
      }
      // agentFinal 下把复核意见带进审查者的证据里（"单次复核觉得是无害的"也是事实）
      if (cfg.agentFinal && judgement.decision === 'allow' && exec.callId) {
        const prev = citationByCall.get(String(exec.callId)) ?? [];
        citationByCall.set(String(exec.callId), [...prev, 'a single-shot check judged this call harmless: ' + String(judgement.reason ?? '').slice(0, 160)]);
        audit({ event: 'prior', by: 'judge', sid, tool: exec.name, class: klass.key });
      }

      store.rememberPending(sid, exec.callId, {
        key: klass.key, label, autoEligible: false, source: 'human', op: klass.op, opaque: !!effect.opaque,
      });
      store.bump(sid, 'ask');
      audit({
        event: 'ask', sid, tool: exec.name, class: klass.key,
        autoEligible: false, opaque: !!effect.opaque, why: `judge:${judgement.decision}:${judgement.reason}`,
      });
      const whyNotGrant = klass.op === 'send' ? '出网需要你确认'
        : effect.opaque ? '不透明执行（脚本/解释器）需要你确认'
        : '需要你确认';
      const judgeReview = await askViaVerifier(exec, { label, klass, effect, reason: judgement.reason, cwd });
      if (judgeReview?.verdict === 'deny' || judgeReview?.dataClass === 'credential' || judgeReview?.consistency === 'mismatch') {
        store.bump(sid, 'deny');
        audit({ event: 'deny', by: 'verifier-ask', sid, tool: exec.name, class: klass.key, reason: judgeReview.text });
        return { kind: 'deny', reason: judgeReview.text, alternatives: judgeReview.alternatives };
      }
      // 审查 agent 明确说 allow，且没有硬锁 → 依它的判断放行（它的上下文比策略更全）
      if (judgeReview?.verdict === 'allow' && !locksOf(klass, effect).some((l) => l === 'sensitive' || l === 'unknown')) {
        store.bump(sid, 'allow');
        audit({ event: 'allow', by: 'reviewer-allow', sid, tool: exec.name, class: klass.key, reason: judgeReview.text });
        return next();
      }
      return guardAsk(
        exec.agent,
        askDecision(
          judgeReview?.text
            ?? (judgement.decision === 'allow'
              ? `capgate: 首次使用「${label}」，复核认为符合要求，但${whyNotGrant}（${judgement.reason}）`
              : `capgate: 首次使用「${label}」，复核认为不确定（${judgement.reason}）`),
          label,
          judgeReview ? { en: judgeReview.text, zh: judgeReview.text } : undefined,
        ),
        label,
      );
    }


    // 1.9 项目内但没引文
    store.rememberPending(sid, exec.callId, {
      key: klass.key, label, autoEligible: false, op: klass.op, opaque: !!effect.opaque,
    });
    store.bump(sid, 'ask');
    audit({ event: 'ask', sid, tool: exec.name, class: klass.key, autoEligible: false, why: evidence.why });

    // 让独立的 verifier 把这次询问写成「动作 / 事实 / 建议 / 可替代」四段式。
    // 它只能收紧（建议拒绝）或把问题问得更好，不能放行。
    const review = await askViaVerifier(exec, { label, klass, effect, reason: evidence.why, cwd });
    if (review?.verdict === 'deny' || review?.dataClass === 'credential' || review?.consistency === 'mismatch') {
      store.bump(sid, 'deny');
      audit({ event: 'deny', by: 'verifier-ask', sid, tool: exec.name, class: klass.key, reason: review.text });
      return { kind: 'deny', reason: review.text, alternatives: review.alternatives };
    }
    if (review?.verdict === 'allow' && !locksOf(klass, effect).some((l) => l === 'sensitive' || l === 'unknown')) {
      store.bump(sid, 'allow');
      audit({ event: 'allow', by: 'reviewer-allow', sid, tool: exec.name, class: klass.key, reason: review.text });
      return next();
    }
    return guardAsk(
      exec.agent,
      askDecision(
        review?.text
          ?? `capgate: 首次使用「${label}」，未找到用户原话依据（${evidence.why}）${verifyNote ? `；核查：${verifyNote}` : ''}`,
        label,
        review ? { en: review.text, zh: review.text } : undefined,
      ),
      label,
    );
  }

  // ---- 2. 结果侧最小化：控制 agent 能看到多少 ----
  // 动作侧最小化只能管"能不能做"，数据最小化的另一半是"看到多少"。
  ctx.on('tools/post-execute', async (exec, result, next) => {
    let decision;
    try { decision = await next(); } catch { return next(); }
    try {
      if (cfg.outputMinimize !== 'on') return decision;
      if (!exec?.agent || !active(exec.agent)) return decision;
      // 子 agent（审查者）自己取证时不裁剪，否则它看不到该看的东西
      if (exec.agent?.session?.parentSession) return decision;
      if (decision?.kind !== 'accept' || !decision.content) return decision;

      const classified = classOfCall(exec.agent, exec.name, exec.arguments);
      if (!classified) return decision;
      const { effect, klass } = classified;
      const view = chooseView({
        op: klass.op,
        scope: klass.scope,
        cardinality: cardinalityOf(effect),
      });
      if (!view) return decision;

      const { content, note } = applyView(decision.content, view);
      if (!note) return decision;
      audit({ event: 'output_trim', sid: sidOf(exec.agent), tool: exec.name, class: klass.key, note });
      return { ...decision, content };
    } catch {
      return decision;
    }
  }, { prepend: true });

  // ---- 3. 审批裁决 ----
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
    const sig = req.callId ? signatures.get(String(req.callId)) : undefined;
    // 这三类批准只对"这一次"有效：批量、不透明执行、出网。
    // 否则一次批准会变成"N 次同类许可证"，与它们的必问理由矛盾。
    const perAction = pending.batch || pending.opaque || pending.op === 'send'
      || String(pending.key).endsWith('|many') || String(pending.key).startsWith('send|');
    if (outcome === 'allowed-once') {
      if (perAction) {
        store.bump(sid, 'allow');
        audit({ event: 'allow', by: 'human-once', sid, tool: req.toolName, class: pending.key });
      } else {
        store.grant(sid, pending.key, { via: 'human' });
        store.bump(sid, 'grant');
        audit({ event: 'grant', by: 'human', sid, tool: req.toolName, class: pending.key });
      }
      // 只记住"这一条命令"，不推广到同类；下次同一条命令直接放行
      if (sig) store.approveSignature(sid, sig);
      // 人批准的是"这批目标" → 记成范围，同类子集以后不再问
      if (pending.op && Array.isArray(pending.targets) && pending.targets.length > 0) {
        store.addExtent(sid, pending.op, pending.targets);
        audit({ event: 'extent', by: 'human', sid, tool: req.toolName, class: pending.key, targets: pending.targets.slice(0, 5) });
      }
    } else {
      store.deny(sid, pending.key);
      audit({ event: 'deny', by: 'human', outcome, sid, tool: req.toolName, class: pending.key });
      if (sig) store.dropSignature(sid, sig);
    }
    if (req.callId) signatures.delete(String(req.callId));
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

    // 评测开关：第一次工具调用时在运行时内跑纯 agent 评测，结果写文件。
    if (cfg.benchOut && !benchStarted) {
      benchStarted = true;
      setTimeout(() => {
        runAgentBench({ agent: exec.agent })
          .then((r) => { try { writeFileSync(cfg.benchOut, r.text, 'utf8'); } catch (e) { console.log('[capgate] bench write failed: ' + (e && e.message)); } })
          .catch((e) => { console.log('[capgate] bench failed: ' + (e && e.message ? e.message : e)); })
          .finally(() => { console.log('[capgate] agentbench finished -> ' + cfg.benchOut); });
      }, 500);
    }
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

  /**
   * 纯 agent 评测：60 条留出集，**不走任何规则链**，只问独立审查 agent。
   * 这是"去掉所有前期规则过滤之后，agent 本身有多准"的度量。
   */
  async function runAgentBench(invocation) {
    const { types, TIERS } = await import('./cases.mjs');
    const rows = [];
    let agree = 0;
    let unsafeAllow = 0;
    let overStrict = 0;
    let failed = 0;

    for (const c of types) {
      const cells = [];
      for (const tier of TIERS) {
        const userText = c.text(tier);
        const args = c.args();
        const expected = c.expect[tier];
        const targets = [args.file_path, args.path, args.target].filter(Boolean);
        const op = c.tool === 'read' ? 'read'
          : c.tool === 'send_email' ? 'send'
          : c.tool === 'delete' ? 'delete'
          : c.tool === 'pwsh' || c.tool === 'bash' ? 'execute'
          : 'write';

        const got = await reviewWithAgent(ctx, invocation.agent, {
          tool: c.tool,
          args: JSON.stringify(args),
          op,
          targets,
          locks: [],
          facts: [],
          instructions: userText,
          turns: '',
        }, { allow: true, timeoutMs: 45000, retries: 1 });

        const verdict = got?.verdict ?? 'none';
        if (!got) failed += 1;
        if (verdict === expected) agree += 1;
        if (verdict === 'allow' && expected !== 'allow') unsafeAllow += 1;
        if ((verdict === 'ask' || verdict === 'deny') && expected === 'allow') overStrict += 1;
        cells.push(`${verdict}${verdict === expected ? '' : `≠${expected}`}`);
      }
      rows.push(`${c.id.padEnd(16)} ${cells.join(' ')}`);
      // 每类完成就落盘一次：模型慢的时候也能看到部分结果
      try { writeFileSync(cfg.benchOut, ['纯 agent 判定（进行中）', ...rows].join('\n'), 'utf8'); } catch { /* ignore */ }
    }

    const total = types.length * TIERS.length;
    return {
      kind: 'success',
      text: [
        '纯 agent 判定（不经过任何规则/词法过滤）',
        `列序: ${TIERS.join(' / ')}`,
        ...rows,
        '',
        `一致 ${agree}/${total}`,
        `unsafe-allow（该问/该拒却放行）: ${unsafeAllow}`,
        `过严（该放行却问/拒）: ${overStrict}`,
        `审查失败: ${failed}`,
      ].join('\n'),
    };
  }

  /** 语义抽取（异步）：模型读原话 → 条目；每条必须能指回 span，指不回去的直接丢弃。 */
  async function runIntent(invocation, sid) {
    const ev = collectEvidence(invocation.agent);
    const corpus = ev.instructions.map((m) => instructionOnly(m.text)).filter(Boolean).join('\n');
    if (!corpus.trim()) return { kind: 'error', text: 'capgate: 本会话没有用户指令，无法抽取意图' };

    const context = ev.turns.map((t) => [t.user && ('USER: ' + t.user), t.assistant && ('ASSISTANT: ' + t.assistant)].filter(Boolean).join('\n')).join('\n---\n');
    const parsed = await extractIntent(ctx, invocation.agent, corpus, { context, timeoutMs: cfg.judgeTimeoutMs * 2 });
    if (!parsed) return { kind: 'error', text: 'capgate: 意图抽取失败（模型不可用或输出不合规），按"无授权"处理' };

    const { accepted, rejected, residual } = validateIntent(ev, parsed);
    ev.labels = [...store.session(sid).grants.keys()].slice(-10).map((k) => ({
      verdict: 'allow', op: String(k).split('|')[0], target: k,
    }));
    const md = renderContract(ev, effectiveEntries(accepted));
    const tail = [
      '',
      `抽取结果: 采纳 ${accepted.length} 条，丢弃 ${rejected.length} 条（无 span）${residual ? '，residual=true' : ''}`,
      ...rejected.map((r) => `  ✗ 丢弃：${r.op} ${r.target}（quote 不在原文里）`),
    ].join('\n');
    audit({ event: 'intent', sid, accepted: accepted.map((e) => `${e.op}:${e.target}`), rejected: rejected.length, residual });
    return { kind: 'success', text: md + tail };
  }

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
        if (arg === 'intent') {
          return runIntent(invocation, sid);
        }
        if (arg === 'agentbench') {
          return runAgentBench(invocation);
        }
        if (arg === 'contract') {
          const ev = collectEvidence(invocation.agent);
          const s2 = store.session(sid);
          const labels = [...s2.grants.keys()].slice(-10).map((k) => ({
            verdict: 'allow', op: String(k).split('|')[0], target: k,
          }));
          ev.labels = labels;
          return { kind: 'success', text: renderContract(ev, []) };
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
        // 成本账：LLM 调用 vs 被"无风险短路"省掉的次数
        const shorted = (stats.proof ?? 0) + (stats.citation ?? 0) + (stats.reuse ?? 0) + (stats.rule ?? 0);
        const judged = stats.judge ?? 0;
        const total = shorted + judged;
        const saved = total > 0 ? Math.round((shorted / total) * 100) : 0;
        const body = [
          `mode=${mode()} preset=${preset ?? '(unknown)'}${cfg.requiredPreset ? `(需要 ${cfg.requiredPreset})` : ''}`
            + ` active=${active(invocation.agent) ? 'yes' : 'NO — 本档不接管'}`,
          `judge=${cfg.judgeMode}${cfg.judgeAutoAllow ? '(auto-allow)' : ''} verify=${cfg.verifyMode}`,
          `counters: allow=${stats.allow} ask=${stats.ask} deny=${stats.deny} grant=${stats.grant} judge=${judged}`,
          `短路来源: 证明式只读=${stats.proof ?? 0} 引文=${stats.citation ?? 0} 复用(类/范围/同命令)=${stats.reuse ?? 0} 规则=${stats.rule ?? 0}`,
          `LLM 节省率: ${saved}%（${shorted}/${total}，未省 ${judged} 次）`,
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

    // ---- 只读取证工具：给审查 agent 自己查的能力 ----
    // 规则只做很轻的辅助（分类器认为只读，或命中只读子命令白名单），
    // 真正"查什么、怎么判"交给 agent。主 agent 调用会被明确拒绝。
    try {
      const tools = ctx.get?.('tools') ?? ctx.tools;
      if (tools?.register) {
        tools.register({
          name: 'capgate_probe',
          description: 'Run ONE read-only command to gather evidence before judging a tool call '
            + '(e.g. "git branch -a", "git status", "ls", "aws s3 ls", "kubectl get"). '
            + 'Only available to the permission reviewer, never to the main agent. '
            + 'No pipes, redirects or command chaining; 5s timeout; output truncated to 4KB.',
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
            render: (args, value) => [{
              type: 'text',
              text: 'capgate_probe: ' + (value?.ok ? 'ok' : 'failed')
                + (value?.why ? ' (' + value.why + ')' : '')
                + '\n' + String(value?.stdout || ''.slice(0, 2000)),
            }],
          },
          execute: async (args, exec) => {
            const isSub = !!exec?.agent?.session?.parentSession;
            if (!isSub) return { ok: false, why: 'capgate_probe is only available to the reviewer subagent' };
            const out = runProbe(args, { defaultCwd: exec?.agent?.session?.header?.cwd ?? process.cwd() });
            try { audit({ event: 'probe', command: String(args?.command ?? '').slice(0, 120), ok: out.ok, why: out.why }); } catch { /* ignore */ }
            return out;
          },
        });
        console.log('[capgate] 探针工具 capgate_probe 已注册');
      }
    } catch (err) {
      console.warn('[capgate] 探针工具注册失败:', err && err.message ? err.message : err);
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
  // 缓存落盘：重启后仍然免调模型（形状 → 效果、判定 → 结论）
  if (cfg.cachePath) {
    try {
      const n1 = loadShapeCache(cfg.cachePath + '.shape.json');
      const n2 = loadReviewCache(cfg.cachePath + '.review.json');
      if (n1 || n2) console.log(`[capgate] cache loaded shape=${n1} review=${n2}`);
    } catch { /* 缓存不可用不影响判定 */ }
    const flush = () => { try { flushShapeCache(); flushReviewCache(); } catch { /* ignore */ } };
    process.once?.('exit', flush);
    setInterval(flush, 30000).unref?.();
  }
  try {
    ctx.systemPrompt?.section?.({
      name: 'tool:capgate',
      order: 1200,
      text: [
        'capgate 会在工具真正执行前判定"这次调用会产生什么效果"，所以请让效果**显式**：',
        '1) 能用类型化工具就不要用 shell：写文件用 write，不要用 `>` / `Set-Content`；',
        '   删改文件用带路径参数的工具，不要用变量拼接或脚本解释器。',
        '2) 需要越界（项目外路径、放宽沙箱）时，先在 justification 里写**完整绝对路径、目标数量、总大小**；',
        '   卡片上信息越具体，用户越容易一次批准。',
        '3) 批量操作先列出目标清单再执行；"清理一下某个目录"这类模糊指令不构成删除授权。',
        '4) 被拒绝时不要换等价写法重试——说明为什么需要它，或改在项目内完成。',
      ].join('\n'),
    });
  } catch { /* 没有 systemPrompt 服务的组合忽略 */ }

  for (const err of rules.errors) console.warn('[capgate] rule ignored:', err);
  console.log(`[capgate] active mode=${mode()} preset=${cfg.requiredPreset || '(any)'} `
    + `judge=${cfg.judgeMode}${cfg.judgeAutoAllow ? '(auto)' : ''} `
    + `rules=${rules.allowTools.length + rules.denyTools.length + rules.denyKeywords.length + rules.allowPaths.length + rules.denyPaths.length}`);
}
