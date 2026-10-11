/**
 * capgate-dsh:审批模式重构插件(生产形态)。
 *
 * 挂载后,dsh 的审批模式从"逐调用弹窗/allowlist"重构为:
 *   任务时铸造(capability_mint,策略∩计划)→ 运行时守卫确定性复核(µs,零 LLM)
 *   → 未覆盖调用走一次性批准(answerer,策略内 auto/策略外拒)
 *   → 规则文档回喂(learned deny 落盘,同模式下次直判;重铸自动失效)
 *   → Minimize:读类结果投影到任务实体(最小充分视图)
 *
 * 配置(cordis.patch.yml 的 plugin config):
 *   mode                               : 'capgate'(默认,审批管线激活)| 'standard'(休眠,走 dsh 原生审批)
 *                                        volatile 字段,可在 Web UI 设置里直接切换(Settings → Agent presets →
 *                                        工具审批),写入落在 profile 的 cordis.patch.yml 并原位生效,无需重启
 *   protectedTools / protectedPrefixes : 受保护面(默认写类 + 全部 MCP)
 *   memberTools                        : 可走一次性批准的工具集
 *   minimizeReads                      : 读类结果投影开关与工具列表
 *   approvalMode                       : auto(一次批准自动授) | deny(一律拒)
 *   rulesPath                          : 规则文档落盘路径
 */
import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import Schema from '@deepseek-ai/schemastery'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import { mint, verify, newRid, type Macaroon } from './macaroon.ts'

export const name = 'capgate'

const DEFAULTS: Required<CapgateConfig> = {
  mode: 'capgate',
  protectedTools: ['write', 'edit', 'bash', 'send_email', 'send_money',
    'rotate_key', 'fs_write', 'drop_database'],
  protectedPrefixes: ['mcp__'],
  memberTools: ['write', 'edit', 'bash', 'send_email', 'send_money',
    'read_logs', 'read_file', 'get_iban', 'get_balance',
    'get_most_recent_transactions', 'get_user_info'],
  minimizeReads: ['read', 'read_logs', 'read_file', 'get_most_recent_transactions'],
  approvalMode: 'auto',
  rulesPath: new URL('./rules_doc.json', import.meta.url).pathname,
  ttlMinutes: 480,
}

// ---- Macaroon 侧(TS,HMAC-SHA1 第一方链;与 pymacaroons 第一方语义一致) ----
interface Mac { identifier: string; caveats: string[]; signature: string }
function _mint(id: string, key: string, caveats: string[]): Mac {
  let sig = createHmac('sha1', key).update(id).digest()
  const saved: string[] = []
  for (const c of caveats) { sig = createHmac('sha1', sig).update(c).digest(); saved.push(c) }
  return { identifier: id, caveats: saved, signature: sig.toString('hex') }
}
function _verifyChain(mac: Mac, key: string): boolean {
  let sig = createHmac('sha1', key).update(mac.identifier).digest()
  for (const c of mac.caveats) sig = createHmac('sha1', sig).update(c).digest()
  return sig.toString('hex') === mac.signature
}
function _rid(): string { return randomBytes(9).toString('base64url') }

// ---- 会话状态 ----
// 消融旋钮(数据重跑 A/B 用):CAPGATE_MINIMIZE=0 关投影;CAPGATE_LEARN=0 关规则学习
const ABL_DISABLED = process.env.CAPGATE_DISABLED === '1'
const ABL_MINIMIZE = process.env.CAPGATE_MINIMIZE !== '0'
const ABL_LEARN = process.env.CAPGATE_LEARN !== '0'

const state: {
  key: string
  current: Mac | null
  entities: Set<string>
  learned: Array<{ fn: string; effect: 'allow' | 'deny'; reason: string; from: string; at: string }>
  cfg: Required<CapgateConfig>
} = {
  key: 'capgate-local-key-v1',
  current: null,
  entities: new Set<string>(),
  learned: [],
  cfg: { ...DEFAULTS },
}

function permitsOf(mac: Mac | null): Set<string> {
  const out = new Set<string>()
  for (const c of (mac?.caveats ?? [])) {
    if (c.startsWith('permits = ')) {
      try { for (const t of JSON.parse(c.slice(10)) as string[]) out.add(t) } catch {}
    }
  }
  return out
}
function verifyCurrent(): { ok: boolean; why: string; permits: Set<string> } {
  if (state.current === null) return { ok: false, why: 'no minted capability', permits: new Set() }
  if (!_verifyChain(state.current, state.key)) {
    return { ok: false, why: 'capability signature invalid', permits: new Set() }
  }
  const now = Date.now()
  for (const c of state.current.caveats) {
    if (c.startsWith('not_after = ') && now > Date.parse(c.slice(11))) {
      return { ok: false, why: 'capability expired', permits: new Set() }
    }
  }
  return { ok: true, why: 'ok', permits: permitsOf(state.current) }
}
function expandPermit(tool: string, ttlMinutes = 5): void {
  const permits = new Set([...permitsOf(state.current), tool])
  const notAfter = new Date(Date.now() + ttlMinutes * 60_000).toISOString()
  state.current = _mint(_rid(), state.key, [
    'permits = ' + JSON.stringify([...permits].sort()),
    `not_after = ${notAfter}`,
  ])
}
function mintBaseline(plan: Set<string>, purpose: string): Mac {
  const notAfter = new Date(Date.now() + state.cfg.ttlMinutes * 60_000).toISOString()
  return _mint(_rid(), state.key, [
    'permits = ' + JSON.stringify([...plan].sort()),
    `not_after = ${notAfter}`,
    ...(purpose ? [`purpose = ${purpose}`] : []),
  ])
}

// ---- 规则文档(ask/deny 之后更新,辅助下一次判断;落盘) ----
interface LearnedRule { fn: string; effect: 'allow' | 'deny'; reason: string; from: string; at: string }
function loadRules(): void {
  try { state.learned = JSON.parse(readFileSync(state.cfg.rulesPath, 'utf8')) } catch { state.learned = [] }
}
function learn(rule: LearnedRule): void {
  if (!ABL_LEARN) return
  learn(rule)
}
function saveRules(): void {
  try { writeFileSync(state.cfg.rulesPath, JSON.stringify(state.learned, null, 1)) }
  catch (e) { console.error('[capgate] rules save failed:', String(e).slice(0, 120)) }
}
function learnedDenyFor(fn: string): LearnedRule | undefined {
  return state.learned.find(r => r.fn === fn && r.effect === 'deny')
}
function invalidateLearnedDeny(fn: string): void {
  const n = state.learned.length
  state.learned = state.learned.filter(r => !(r.fn === fn && r.effect === 'deny'))
  if (state.learned.length !== n) saveRules()
}


export const inject = ['tools'] as const

/**
 * 插件配置。审批模式选项(与 标准模式/PTC 模式 并列的第三模式):
 *   mode: 'standard' → 插件休眠,工具走 dsh 原生审批
 *         'capgate'  → 工具执行经本插件审批管线
 *                      (铸造→守卫→Ask 升级→Minimize 投影→规则文档)
 *
 * mode 是 volatile 字段:cordis 经 resolveConfig 交给 apply 时是只读 ref
 * (Volatile),Web 设置写入原位提交 ref 值;运行时经 readMode() 解出当前值。
 */
export interface CapgateConfig {
  mode: Volatile<'standard' | 'capgate'> | 'standard' | 'capgate'
  protectedTools: string[]
  protectedPrefixes: string[]
  memberTools: string[]
  minimizeReads: string[]
  approvalMode: 'auto' | 'manual' | 'deny'
  ttlMinutes: number
  rulesPath: string
}

// Schema 面不标注 Schema<CapgateConfig>:volatile 字段的 schema 推断面与
// 已解析面(含 Volatile ref)不同,cordis 按 resolvedConfig 调用 apply。
export const Config = Schema.object({
  // volatile:Web UI 的设置写入(经 settings → configEditor → profile 的
  // cordis.patch.yml)只接受 volatile 字段;写入会原位提交到运行中的 fiber
  // (loader/volatile-update),不重挂载,因此管线常驻注册、按 live mode 分流。
  mode: Schema.union(['standard', 'capgate']).default('capgate').volatile(),
  protectedTools: Schema.array(String).default([
    'write', 'edit', 'bash', 'send_email', 'send_money', 'rotate_key',
  ]),
  protectedPrefixes: Schema.array(String).default(['mcp__']),
  memberTools: Schema.array(String).default([
    'write', 'edit', 'bash', 'send_email', 'send_money',
    'read', 'read_logs', 'read_file', 'get_iban', 'get_balance',
    'get_most_recent_transactions', 'get_user_info',
  ]),
  minimizeReads: Schema.array(String).default([
    'read', 'read_logs', 'read_file', 'get_most_recent_transactions',
  ]),
  approvalMode: Schema.union(['auto', 'manual', 'deny']).default('auto'),
  ttlMinutes: Schema.number().default(480),
  rulesPath: Schema.string().default(
    new URL('./rules_doc.json', import.meta.url).pathname),
})

/** 测试钩子:预置/查询规则文档(仅 selftest 使用) */
export const capgateTestHooks = {
  seedLearned(rule: { fn: string; effect: 'allow' | 'deny'; reason: string }): void {
    state.learned.push({ ...rule, from: 'seed', at: new Date().toISOString() })
    saveRules()
  },
}

/** volatile 字段经 resolveConfig 后是只读 ref;这里统一解出当前值(Web 切换原位生效)。 */
function readMode(value: CapgateConfig['mode']): CapgateConfig['mode'] | undefined {
  return typeof value === 'object' && value !== null ? value.get() : value
}

export function apply(ctx: Context, config: CapgateConfig) {
  state.cfg = { ...DEFAULTS, ...config }
  const mode = (): CapgateConfig['mode'] => readMode(state.cfg.mode) ?? 'capgate'
  if (ABL_DISABLED) {
    console.log('[capgate] disabled (CAPGATE_DISABLED=1): 裸 dsh 对照臂')
    return
  }
  if (process.env.CAPGATE_APPROVAL) {
    state.cfg.approvalMode = (process.env.CAPGATE_APPROVAL as CapgateConfig['approvalMode'])
  }
  // deny 姿态联动:一概拒的姿态下,自服务铸造必须一并禁用(否则 mint 绕过拒绝)
  if (state.cfg.approvalMode === 'deny') {
    ctx.tools.restrict({ deny: ['capability_mint'] })
  }
  if (mode() === 'standard') {
    console.log('[capgate] dormant (mode=standard): 工具走 dsh 原生审批')
  } else {
    if (existsSync(state.cfg.rulesPath)) loadRules()
    console.log(`[capgate] active: protected=${state.cfg.protectedTools.length} tools`
      + ` + prefixes [${state.cfg.protectedPrefixes.join(',')}]`
      + `, approval=${state.cfg.approvalMode}, rules=${state.cfg.rulesPath}`)
  }
  // 管线常驻注册:mode 是 volatile 字段,Web UI 切换后原位生效;standard 时
  // 各环节直接放行/委托,等价于休眠(capability_mint 会应答休眠提示)。

  const short = (n: string): string | undefined => {
    if (state.cfg.protectedTools.includes(n)) return n
    for (const pfx of state.cfg.protectedPrefixes) {
      if (n.startsWith(pfx)) return n.slice(pfx.length)
    }
    return undefined
  }
  const isRead = (n: string): boolean => state.cfg.minimizeReads.includes(n)

  // ---- 四态之 Ask:能力缺失的 member 工具 → 一次性批准(答案人:本插件策略) ----
  ctx.on('tools/pre-execute', (exec, _next) => {
    if (mode() === 'standard') return { kind: 'allow' as const }   // 休眠:全部放行
    const sName = short(exec.name)
    if (sName === undefined) return { kind: 'allow' as const }   // 非受保护 → 守卫外的面
    // 规则文档先行:learned deny 直接确定性拒(零 LLM、零弹窗、不进审批面)
    const lr = learnedDenyFor(sName)
    if (lr) {
      return { kind: 'deny' as const,
               reason: `capgate(learned ${lr.at.slice(11, 19)}): ${lr.reason}` }
    }
    const st = verifyCurrent()
    if (st.ok && st.permits.has(sName)) return { kind: 'allow' as const }
    if (state.cfg.approvalMode === 'deny') {
      return { kind: 'deny' as const,
               reason: `capgate: '${exec.name}' 需要能力令牌(approvalMode=deny)` }
    }
    return {
      kind: 'ask' as const,
      reason: st.ok
        ? `capgate: '${exec.name}' 不在当前能力集;一次性批准仅授本次`
        : `capgate: 尚无能力令牌;批准将为 '${exec.name}' 铸造短时基线`,
    }
  })

  // ---- 审批 answerer:auto → 短时扩权(allowed-once);否则拒并落规则文档 ----
  ctx.on('approval/request', async (req, next) => {
    // 休眠/manual 模式:本插件不裁决,委托 UI 人工 answerer(网页审批卡片)
    if (mode() === 'standard' || state.cfg.approvalMode === 'manual') return next()
    const sName = short(req.toolName)
    if (sName === undefined || state.cfg.approvalMode !== 'auto') {
      learn({ fn: sName ?? req.toolName, effect: 'deny',
        reason: 'approvalMode=deny 或策略外', from: 'approval-rejected',
        at: new Date().toISOString() })
      console.log(`[capgate-approval] rejected ${req.toolName} (learned)`)
      return 'rejected' as const
    }
    if (state.current === null) {
      // 冷启动:为该工具铸短时基线(一次批准=一次基线,不产生持久存量)
      state.current = _mint(_rid(), state.key, [
        'permits = ' + JSON.stringify([sName]),
        `not_after = ${new Date(Date.now() + 5 * 60_000).toISOString()}`,
      ])
      saveRules()
      console.log(`[capgate-approval] allowed-once ${req.toolName} `
        + `(cold-start baseline 5m)`)
      return 'allowed-once' as const
    }
    expandPermit(sName)
    invalidateLearnedDeny(sName)
    learn({ fn: sName, effect: 'allow',
      reason: 'policy-allowed, approved once', from: 'approval-allowed',
      at: new Date().toISOString() })
    console.log(`[capgate-approval] allowed-once ${req.toolName} `
      + `(permits now: ${[...permitsOf(state.current)].sort().join(',')})`)
    return 'allowed-once' as const
  })

  // ---- 单调守卫(终审):令牌无效/permits 外 → 确定性拒,带最小修复义务 ----
  ctx.tools.guard((execution) => {
    if (mode() === 'standard') return undefined   // 休眠:不做确定性终审
    const sName = short(execution.name)
    if (sName === undefined) return undefined
    const st = verifyCurrent()
    if (!st.ok) {
      return `capgate: ${st.why}。修复:调用 capability_mint(在 plan_tools 中`
             + `声明 '${sName}' 与用途)铸造能力,或放弃该操作`
    }
    if (!st.permits.has(sName)) {
      return `capgate: tool '${execution.name}' not in minted capability permits; `
             + `义务:请调用 capability_mint 扩权(把 '${sName}' 写进 plan_tools)`
             + `,或改用任务已授权的工具完成同一目的`
    }
    return undefined
  })

  // ---- 铸造工具:任务时一次;plan ∩ member → permits;entities → Minimize 源 ----
  ctx.tools.register(defineTool({
    name: 'capability_mint',
    description: 'Mint the task capability token. Call this at task start with '
      + 'the tools the task needs (plan_tools) and the task entities; expires '
      + 'after the configured TTL.',
    parameters: {
      plan_tools: {
        type: 'array', required: true,
        description: 'Tool names the task needs',
      },
      entities: {
        type: 'array', required: true,
        description: 'Task entities (Minimize projects read results to these)',
      },
      purpose: { type: 'string', description: 'Why' },
    },
    output: {
      schema: { type: 'string' },
      render: (_a: unknown, value: string) => [{ type: 'text', text: value }],
    },
    async execute(args: {
      plan_tools: string[]; entities?: string[]; purpose?: string
    }) {
      if (mode() === 'standard') {
        return 'capgate dormant (mode=standard): capability minting unavailable'
      }
      state.entities = new Set(args.entities ?? [])
      const member = new Set(state.cfg.memberTools)
      const plan = new Set(args.plan_tools
        .map(t => short(t) ?? t)
        .filter(t => member.has(t)))
      if (plan.size === 0) {
        return 'mint rejected: plan∩member = ∅(计划未选中任何可授工具)'
      }
      for (const t of plan) invalidateLearnedDeny(t)
      state.current = mintBaseline(plan, args.purpose ?? '')
      return `minted: permits=${[...plan].sort().join(',')} `
        + `ttl=${state.cfg.ttlMinutes}m entities=${[...state.entities].sort().join(',') || '-'}`
    },
  }))

  // ---- Minimize:读类结果投影到任务实体(post-execute replace) ----
  ctx.on('tools/post-execute', (exec, result, next) => {
    if (mode() === 'standard' || !ABL_MINIMIZE || !isRead(exec.name) || state.entities.size === 0) return next()
    const blocks = (result as { content?: Array<{ type: string; text?: string }> }).content ?? []
    const text = blocks.map(b => b.text ?? '').join('\n')
    if (!text) return next()
    const lines = text.split('\n')
    const kept = lines.filter(line =>
      [...state.entities].some(e => line.includes(e)))
    if (kept.length === lines.length) return next()
    const minimized = kept.length > 0 ? kept.join('\n') : '(no task-relevant lines)'
    return {
      kind: 'accept',
      content: [{ type: 'text', text: minimized
        + `\n[capgate-minimized: projected to ${[...state.entities].sort().join(',')}]` }],
    }
  })
}
